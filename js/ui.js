// Body Garden — 画面レンダリング・画面遷移・モーダル基盤
// Tonight Garden の data-screen 属性パターンを踏襲（ハッシュルーティングなし）。

const SCREENS = ["home", "records", "injection", "composition", "settings"];
// ナビゲーションには出さないが switchScreen で遷移しうる内部画面
const INTERNAL_SCREENS = ["maintenance-prep"];

const UI = {
  state: null,
  graphRange: "30", // 体重グラフの表示期間: "7" | "30" | "all"
  _modalQueue: [],

  init(state) {
    this.state = state;
    this.bindNav();
    this.bindModalRoot();
    this.hydrateLineIcons();
    this.switchScreen(state.ui.lastScreen || "home");
  },

  // data-line-icon付きの静的プレースホルダ（Bottom Nav・体組成見出し等）へ
  // 線アイコンSVGを差し込む。動的に再描画されるカード見出し側は各自lineIcon()を呼ぶ
  hydrateLineIcons(root) {
    (root || document).querySelectorAll("[data-line-icon]").forEach((el) => {
      el.innerHTML = Icons.svg(el.dataset.lineIcon, el.dataset.iconClass || "title-icon-svg");
    });
  },

  // カード見出し用の線アイコンSVGを返す（達成エンブレム等の丸角タイルPNGとは別系統）
  lineIcon(name, className) {
    return Icons.svg(name, className || "title-icon-svg");
  },

  bindNav() {
    document.querySelectorAll("[data-nav-target]").forEach((btn) => {
      btn.addEventListener("click", () => this.switchScreen(btn.dataset.navTarget));
    });
  },

  switchScreen(screenName) {
    if (![...SCREENS, ...INTERNAL_SCREENS].includes(screenName)) screenName = "home";
    document.querySelectorAll("[data-screen]").forEach((el) => {
      el.hidden = el.dataset.screen !== screenName;
    });
    document.querySelectorAll("[data-nav-target]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.navTarget === screenName);
    });
    if (SCREENS.includes(screenName)) {
      this.state.ui.lastScreen = screenName;
      Storage.save(this.state);
    }
    this.renderScreen(screenName);
  },

  renderScreen(screenName) {
    if (screenName === "home") this.renderHome();
    if (screenName === "settings") SettingsUI.render(this.state);
    if (screenName === "records") RecordsUI.render(this.state);
    if (screenName === "maintenance-prep") this.renderMaintenancePrep();
    // injection / composition は Phase4〜5で実装
  },

  // ============ モーダル基盤 ============
  bindModalRoot() {
    const root = document.getElementById("modal-root");
    root.addEventListener("click", (e) => {
      if (e.target === root) return; // オーバーレイ自体のクリックでは閉じない（明示的な操作を必須にする）
      const actionEl = e.target.closest("[data-modal-action]");
      if (actionEl) this._handleModalAction(actionEl.dataset.modalAction);
    });
  },

  showModal(html) {
    const root = document.getElementById("modal-root");
    root.innerHTML = `<div class="modal-overlay"><div class="modal-card">${html}</div></div>`;
    root.hidden = false;
  },

  hideModal() {
    const root = document.getElementById("modal-root");
    root.hidden = true;
    root.innerHTML = "";
  },

  // 体重保存後に呼ぶ。ガードレールのモーダルキューを積んで先頭を表示する
  enqueueGuardrailModals(modals, record) {
    this._pendingRecord = record;
    this._modalQueue = modals.slice();
    this._showNextModal();
  },

  _showNextModal() {
    const next = this._modalQueue.shift();
    if (!next) {
      this.hideModal();
      return;
    }
    if (next.type === "bmi21Alert") this.showModal(this._bmi21ModalHtml());
    if (next.type === "bmi20Alert") this.showModal(this._bmi20ModalHtml());
  },

  _handleModalAction(action) {
    const record = this._pendingRecord;
    if (action === "bmi21-later") {
      Logic.resolveBmi21Alert(this.state, record, "later");
      Storage.save(this.state);
      this._showNextModal();
    } else if (action === "bmi21-view") {
      Logic.resolveBmi21Alert(this.state, record, "viewPrep");
      Storage.save(this.state);
      this._modalQueue = []; // 説明画面へ移るため残りのキューは打ち切る
      this.hideModal();
      this.switchScreen("maintenance-prep");
    } else if (action === "bmi20-close") {
      Logic.resolveBmi20Alert(this.state, "close");
      Storage.save(this.state);
      this._showNextModal();
    } else if (action === "bmi20-view") {
      Logic.resolveBmi20Alert(this.state, "viewPrep");
      Storage.save(this.state);
      this._modalQueue = [];
      this.hideModal();
      this.switchScreen("maintenance-prep");
    } else if (action === "goal-choice-next") {
      Logic.resolveGoalChoice(this.state, this._pendingGoalKey, "nextGoal");
      Storage.save(this.state);
      this.hideModal();
      this.renderHome();
    } else if (action === "goal-choice-maintain") {
      Logic.resolveGoalChoice(this.state, this._pendingGoalKey, "maintain");
      Storage.save(this.state);
      this.hideModal();
      this.renderHome();
    } else if (action === "profile-confirm-yes") {
      this.hideModal();
      if (this._pendingProfileConfirm) this._pendingProfileConfirm();
    } else if (action === "profile-confirm-no") {
      this.hideModal();
      SettingsUI.render(this.state); // 入力を編集前の状態に戻す
    } else if (action === "close-generic") {
      this.hideModal();
    } else if (action === "goto-protein-settings") {
      this.hideModal();
      this.switchScreen("settings");
    }
  },

  _bmi21ModalHtml() {
    return `
      <p class="modal-title">🌿 そろそろ、減らすより整える頃かも。</p>
      <p class="modal-body">
        BMIが21に達しました。<br />
        下限ライン（BMI20）が近づいています。<br />
        リバウンド対策をはじめましょう！
      </p>
      <div class="modal-actions">
        <button class="btn-secondary" data-modal-action="bmi21-later">あとで</button>
        <button class="btn-primary" data-modal-action="bmi21-view">リバウンド対策を見る</button>
      </div>`;
  },

  _bmi20ModalHtml() {
    return `
      <p class="modal-title">LOWER LINE</p>
      <p class="modal-body">
        下限ライン（BMI20）に到達しました。<br /><br />
        Body Gardenでは、これ以上の減量を新しい目標として扱いません。<br />
        現在の体重・体調を確認しながら、維持するフェーズを意識しましょう。
      </p>
      <div class="modal-actions">
        <button class="btn-secondary" data-modal-action="bmi20-close">閉じる</button>
        <button class="btn-primary" data-modal-action="bmi20-view">維持について見る</button>
      </div>`;
  },

  // Settings画面から呼ぶ：身長/開始日/開始体重の変更確認
  confirmProfileChange(onConfirm) {
    this._pendingProfileConfirm = onConfirm;
    this.showModal(`
      <p class="modal-title">開始条件の変更</p>
      <p class="modal-body">開始条件を変更すると、これまでの表示値も再計算されます。</p>
      <div class="modal-actions">
        <button class="btn-secondary" data-modal-action="profile-confirm-no">キャンセル</button>
        <button class="btn-primary" data-modal-action="profile-confirm-yes">変更する</button>
      </div>`);
  },

  // カードタイトル用のアイコン。sizeClassに"title-icon-lg"を渡すと主要状態表示サイズになる。
  // 正式アセット未配置時は絵文字にフォールバックする
  titleIcon(assetKey, fallbackEmoji, sizeClass) {
    const src = IMAGE_ASSETS[assetKey];
    const cls = sizeClass ? ` ${sizeClass}` : "";
    const fallback = fallbackEmoji ? `this.outerHTML='${fallbackEmoji}\\u00A0'` : "this.remove()";
    return `<img class="title-icon${cls}" src="${src}" alt="" onerror="${fallback}" />`;
  },

  brandIcon() {
    const src = IMAGE_ASSETS.brandSymbol;
    return `<img class="brand-icon" src="${src}" alt="" onerror="this.remove()" />`;
  },

  // src画像が読み込めない場合（placeholder未配置時）はCSSグラデーションのfallbackを表示する
  imageWithFallback(assetKey, altText, extraClass) {
    const src = IMAGE_ASSETS[assetKey];
    const cls = extraClass ? ` ${extraClass}` : "";
    return `
      <div class="bg-image-slot${cls}" data-asset="${assetKey}">
        <img src="${src}" alt="${altText}" loading="lazy"
             onerror="this.closest('.bg-image-slot').classList.add('is-fallback')" />
        <div class="bg-image-fallback" aria-hidden="true"></div>
      </div>`;
  },

  // Hero写真：モバイルは縦長(hero-morning.webp 4:5)、デスクトップは横長
  // (hero-morning-desktop.png 3:2)を<picture>で出し分ける。どちらも主被写体を
  // 切り落とさないよう、実画像の縦横比に合わせたaspect-ratioをCSS側で対応させる
  heroImageHtml() {
    const mobileSrc = IMAGE_ASSETS.heroMorning;
    const desktopSrc = IMAGE_ASSETS.heroMorningDesktop;
    return `
      <div class="bg-image-slot hero-slot" data-asset="heroMorning">
        <picture>
          <source media="(min-width: 700px)" srcset="${desktopSrc}" />
          <img src="${mobileSrc}" alt="" loading="lazy"
               onerror="this.closest('.bg-image-slot').classList.add('is-fallback')" />
        </picture>
        <div class="bg-image-fallback" aria-hidden="true"></div>
      </div>`;
  },

  // ============ HOME ============
  renderHome() {
    const el = document.querySelector('[data-screen="home"]');
    const { profile, goals, dailyRecords, injections } = this.state;

    const latest = Calc.latestWeightRecord(dailyRecords);
    const currentWeight = latest ? latest.weight : profile.startWeight;
    const currentBmi = Calc.bmi(currentWeight, profile.heightCm);
    const changeKg = Calc.changeKg(currentWeight, profile.startWeight);
    const changePct = Calc.changePct(currentWeight, profile.startWeight);
    const elapsedDays = Calc.elapsedDays(profile.startDate);

    const activeGoal = goals.activeGoal === 2 && goals.goal2 ? goals.goal2 : goals.goal1;
    const goalWeight = Calc.goalToWeightKg(activeGoal, profile.heightCm);
    const remaining = Calc.remainingToGoalKg(currentWeight, goalWeight);
    const isBelowLowerLine = currentBmi != null && currentBmi <= profile.bmiLowerLine;

    // 表示専用の進捗率（開始→目標の距離に対する現在地）。BMI/Goal判定ロジックには使わない
    let progressPct = 0;
    if (goalWeight != null && profile.startWeight !== goalWeight) {
      progressPct = ((profile.startWeight - currentWeight) / (profile.startWeight - goalWeight)) * 100;
      progressPct = Math.max(0, Math.min(100, progressPct));
    }

    const nextInjection = injections
      .filter((i) => i.status !== "administered")
      .sort((a, b) => (a.scheduledAt < b.scheduledAt ? -1 : 1))[0];

    // 375px比較試作用の切替（URLクエリ）。採用確定後に撤去する。
    //   ?lower=v1|v2 下部カード配置 / ?palette=a|b 配色 / ?bg=magic|magic2|page|fixed|top 背景方式
    //   bg=magic（既定・新背景v3の仮配置。正式採用前）／magic2=v2背景／page・fixed・top=旧背景
    const q = new URLSearchParams(location.search);
    const lowerLayout = q.get("lower") === "v2" ? "v2" : "v1";
    el.dataset.palette = q.get("palette") === "b" ? "b" : "a";
    el.dataset.bg = ["magic2", "page", "fixed", "top"].includes(q.get("bg")) ? q.get("bg") : "magic";
    const hasWeightRecords = dailyRecords.some((r) => r.weight != null);
    // 完成モック右上の日付表示（375px夜景のみ表示）。表示専用で保存データには関与しない
    const now = new Date();
    const todayLabel = `${now.getFullYear()}.${now.getMonth() + 1}.${now.getDate()} (${"日月火水木金土"[now.getDay()]})`;

    el.innerHTML = `
      <div class="home-bg" aria-hidden="true"></div>
      <div class="hero-section">
        <div class="hero-main">
          <div class="home-title-bar">${this.brandIcon()}<span class="home-title-text"><span class="ttl-up">BODY GARDEN</span><span class="ttl-mix">Body Garden</span></span></div>
          <p class="home-tagline">整える、続ける、好きになる</p>
          <section class="card hero-stat-card">
            <img class="hero-bouquet" src="${IMAGE_ASSETS.decoWeightBouquet}" alt="" onerror="this.remove()" />
            <p class="hero-day-line">開始から<strong>${elapsedDays ?? "—"}</strong>日目</p>
            <div class="hero-weight-row">
              <p class="current-weight">${fmt(currentWeight, 2)}<span class="unit">kg</span></p>
              <span class="hero-change-badge">${signedFmt(changeKg, 2)}kg<small>(${signedFmt(changePct, 1)}%)</small></span>
            </div>
            <div class="hero-progress-track">
              <div class="hero-progress-bar"><div class="hero-progress-fill" style="width:${progressPct}%"></div></div>
              <span class="hero-goal-bubble">目標 ${fmt(goalWeight, 2)}kg</span>
            </div>
            ${
              isBelowLowerLine
                ? `<p class="lower-line-badge">${this.titleIcon("iconLowerLine", "🪴", "title-icon-lg")}LOWER LINE 到達中 — 維持を意識するフェーズです</p>`
                : `<p class="remaining-line">目標まで ${remaining != null ? fmt(Math.abs(remaining), 1) + "kg" : "—"}</p>`
            }
            <div class="stat-row stat-row-mini">
              <div class="stat"><span class="stat-label">BMI</span><span class="stat-value">${fmt(currentBmi, 1)}</span></div>
              <div class="stat"><span class="stat-label">体重変化</span><span class="stat-value">${signedFmt(changeKg, 2)}kg</span></div>
              <div class="stat"><span class="stat-label">経過日数</span><span class="stat-value">${elapsedDays ?? "—"}日</span></div>
            </div>
          </section>
        </div>
        <img class="hero-person" src="${IMAGE_ASSETS.decoYurariFigure}" alt="" onerror="this.remove()" />
        <img class="hero-enisha" src="${IMAGE_ASSETS.decoEnisha}" alt="" onerror="this.remove()" />
        <div class="home-date"><span class="hd-date">${todayLabel}</span><span class="hd-sub">今日も、わたしのペースで</span></div>
      </div>

      ${this._goalAchievementBannerHtml()}

      <section class="card graph-card${hasWeightRecords ? "" : " graph-card--empty"}">
        <div class="graph-head">
          <p class="card-title">${this.lineIcon("trend")}体重グラフ</p>
          <div class="chart-range-tabs" role="group" aria-label="表示期間">
            ${[["7", "7日"], ["30", "30日"], ["all", "全期間"]]
              .map(([v, label]) => `<button type="button" data-graph-range="${v}" class="${this.graphRange === v ? "is-active" : ""}">${label}</button>`)
              .join("")}
          </div>
        </div>
        <div class="chart-wrap chart-wrap-lg">
          <canvas id="chart-weight-home" height="240"></canvas>
          <p class="chart-empty-msg" id="chart-weight-home-empty">体重を記録するとグラフが表示されます</p>
        </div>
        <div class="chart-legend" id="chart-weight-home-legend"></div>
      </section>

      <div class="home-lower" data-layout="${lowerLayout}">
      <div class="home-grid-2col">
        <section class="card injection-card">
          <img class="injection-vase" src="${IMAGE_ASSETS.decoInjectionVase}" alt="" onerror="this.remove()" />
          <p class="card-title">${this.lineIcon("injection")}<span class="t-en">NEXT INJECTION</span><span class="t-jp">次回の注射</span></p>
          ${
            nextInjection
              ? `<p class="injection-value">${nextInjection.scheduledAt}　${nextInjection.dose ?? "—"}mg</p>`
              : `<p class="injection-value muted">未設定</p>`
          }
          <div class="placeholder-box">Phase4で実装予定（投与記録・次回提案）</div>
        </section>

        <section class="card protein-card">
          ${ProteinHomeUI.cardInnerHtml(this.state)}
        </section>
      </div>

      <div class="home-grid-2col">
        <section class="card condition-card">
          <p class="card-title">${this.lineIcon("condition")}今日の体調</p>
          <div class="placeholder-box">Phase4で実装予定（なし／軽い／あり＋詳細）</div>
        </section>

        ${this._goalStatusCardHtml()}
      </div>
      </div>
    `;

    Charts.renderWeightChart("chart-weight-home", this.state, this.graphRange);
    this._bindGraphRange();
    this._bindAchievementBannerButtons();
    ProteinHomeUI.bindCard(this.state);
  },

  // 体重グラフの表示期間切替。状態はメモリ上のみ（保存データには書かない）
  _bindGraphRange() {
    const tabs = document.querySelectorAll("[data-graph-range]");
    tabs.forEach((btn) => {
      btn.addEventListener("click", () => {
        this.graphRange = btn.dataset.graphRange;
        tabs.forEach((b) => b.classList.toggle("is-active", b === btn));
        Charts.renderWeightChart("chart-weight-home", this.state, this.graphRange);
      });
    });
  },

  _goalStatusCardHtml() {
    const { profile, goals, dailyRecords } = this.state;
    const modeLabel = { reduction: "減量中", maintenancePrep: "維持準備中", maintenance: "維持モード" }[goals.mode] || "";
    const goalKey = goals.activeGoal === 2 && goals.goal2 ? "goal2" : "goal1";
    const activeGoal = goals[goalKey];
    const goalWeight = Calc.goalToWeightKg(activeGoal, profile.heightCm);
    const latest = Calc.latestWeightRecord(dailyRecords);
    const currentWeight = latest ? latest.weight : profile.startWeight;
    const remaining = Calc.remainingToGoalKg(currentWeight, goalWeight);
    return `
      <section class="card goal-status-card">
        <p class="card-title">${this.lineIcon("goal")}${goalKey === "goal2" ? "Goal 2" : "Goal 1"} / モード</p>
        <p class="goal-status-mode">${modeLabel}</p>
        <p class="goal-status-detail">目標 ${fmt(goalWeight, 2)}kg ／ 残り ${remaining != null ? fmt(Math.abs(remaining), 1) + "kg" : "—"}</p>
      </section>`;
  },

  _goalAchievementBannerHtml() {
    const { goals } = this.state;
    for (const goalKey of ["goal1", "goal2"]) {
      const goal = goals[goalKey];
      if (goal && goal.achievedAt && !goal.postAchievementChoice) {
        const hasNextGoal = goalKey === "goal1" && !!goals.goal2;
        const goalIconKey = goalKey === "goal1" ? "iconGoal1" : "iconGoal2";
        return `
          <section class="card achievement-banner" data-goal-key="${goalKey}">
            <p class="achievement-title">${this.titleIcon(goalIconKey, "🌸", "title-icon-lg")}${goalKey === "goal1" ? "Goal 1" : "Goal 2"} 達成</p>
            <p class="achievement-sub">${goal.achievedAt}に到達しました。次はどうしますか？</p>
            <div class="achievement-actions">
              ${hasNextGoal ? `<button class="btn-primary" data-achievement-action="nextGoal">次の目標へ進む</button>` : ""}
              <button class="btn-secondary" data-achievement-action="maintain">現在の体重を維持する</button>
            </div>
          </section>`;
      }
    }
    return "";
  },

  _bindAchievementBannerButtons() {
    const banner = document.querySelector(".achievement-banner");
    if (!banner) return;
    const goalKey = banner.dataset.goalKey;
    banner.querySelectorAll("[data-achievement-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const choice = btn.dataset.achievementAction === "nextGoal" ? "nextGoal" : "maintain";
        Logic.resolveGoalChoice(this.state, goalKey, choice);
        Storage.save(this.state);
        this.renderHome();
      });
    });
  },

  // ============ 維持準備画面 ============
  renderMaintenancePrep() {
    const el = document.getElementById("maintenance-prep-root");
    const reasonLabel = { bmi21: "BMI21到達", bmi20: "BMI20 LOWER LINE到達", goalChoice: "Goal達成" }[
      this.state.goals.maintenanceReason
    ] || "";
    const alreadyMaintaining = this.state.goals.mode === "maintenance";

    el.innerHTML = `
      <div class="card">
        <button class="btn-text" data-maintenance-action="back">← HOMEに戻る</button>
        <p class="card-title">${this.titleIcon("iconMaintenance", "🌿", "title-icon-lg")}維持準備</p>
        ${reasonLabel ? `<p class="maintenance-reason">きっかけ：${reasonLabel}</p>` : ""}
        <ul class="maintenance-list">
          <li>これ以上減らすことだけを目的にしません</li>
          <li>体重の維持を意識して記録を続けます</li>
          <li>タンパク質摂取は引き続き記録します</li>
          <li>体組成の変化も見ていきます</li>
          <li>体調の変化に注意します</li>
          <li>必要なら注射記録も継続します</li>
        </ul>
        ${
          alreadyMaintaining
            ? `<p class="maintenance-status">現在、維持モードです。</p>`
            : `<button class="btn-primary" data-maintenance-action="confirm">維持モードへ切り替える</button>`
        }
      </div>`;

    el.querySelectorAll("[data-maintenance-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.maintenanceAction === "confirm") {
          Logic.confirmMaintenanceMode(this.state);
          Storage.save(this.state);
          this.renderMaintenancePrep();
        } else {
          this.switchScreen("home");
        }
      });
    });
  },
};

function fmt(value, digits) {
  if (value == null || Number.isNaN(value)) return "—";
  return value.toFixed(digits);
}

function signedFmt(value, digits) {
  if (value == null || Number.isNaN(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}`;
}
