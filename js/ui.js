// Body Garden — 画面レンダリング・画面遷移・モーダル基盤
// Tonight Garden の data-screen 属性パターンを踏襲（ハッシュルーティングなし）。

const SCREENS = ["home", "records", "injection", "composition", "settings"];
// ナビゲーションには出さないが switchScreen で遷移しうる内部画面
const INTERNAL_SCREENS = ["maintenance-prep"];

const UI = {
  state: null,
  _modalQueue: [],

  init(state) {
    this.state = state;
    this.bindNav();
    this.bindModalRoot();
    this.switchScreen(state.ui.lastScreen || "home");
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

  // カードタイトル用の小さいアイコン。正式アセット未配置時は絵文字にフォールバックする
  titleIcon(assetKey, fallbackEmoji) {
    const src = IMAGE_ASSETS[assetKey];
    const fallback = fallbackEmoji ? `this.outerHTML='${fallbackEmoji}\\u00A0'` : "this.remove()";
    return `<img class="title-icon" src="${src}" alt="" onerror="${fallback}" />`;
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

    const nextInjection = injections
      .filter((i) => i.status !== "administered")
      .sort((a, b) => (a.scheduledAt < b.scheduledAt ? -1 : 1))[0];

    el.innerHTML = `
      ${this.imageWithFallback("heroMorning", "", "hero-slot")}
      ${this._goalAchievementBannerHtml()}
      <section class="card hero-card">
        <p class="eyebrow">${this.brandIcon()}BODY GARDEN</p>
        <p class="current-weight">${fmt(currentWeight, 2)}<span class="unit">kg</span></p>
        <p class="range-line">START ${fmt(profile.startWeight, 2)} → GOAL ${fmt(goalWeight, 2)}</p>
        <div class="stat-row">
          <div class="stat"><span class="stat-label">DAY</span><span class="stat-value">${elapsedDays ?? "—"}</span></div>
          <div class="stat"><span class="stat-label">BMI</span><span class="stat-value">${fmt(currentBmi, 1)}</span></div>
          <div class="stat"><span class="stat-label">変化</span><span class="stat-value">${signedFmt(changeKg, 2)}kg</span></div>
          <div class="stat"><span class="stat-label">変化率</span><span class="stat-value">${signedFmt(changePct, 1)}%</span></div>
        </div>
        ${
          isBelowLowerLine
            ? `<p class="lower-line-badge">${this.titleIcon("iconLowerLine", "🪴")}LOWER LINE 到達中 — 維持を意識するフェーズです</p>`
            : `<p class="remaining-line">目標まで ${remaining != null ? fmt(Math.abs(remaining), 1) + "kg" : "—"}</p>`
        }
      </section>

      <section class="card graph-card">
        <p class="card-title">${this.titleIcon("iconWeight", "🌱")}体重グラフ</p>
        <div class="chart-wrap">
          <canvas id="chart-weight-home" height="180"></canvas>
          <p class="chart-empty-msg" id="chart-weight-home-empty">体重を記録するとグラフが表示されます</p>
        </div>
      </section>

      <section class="card protein-card">
        ${ProteinHomeUI.cardInnerHtml(this.state)}
      </section>

      <section class="card injection-card">
        <p class="card-title">${this.titleIcon("iconInjection", "💉")}NEXT INJECTION</p>
        ${
          nextInjection
            ? `<p class="injection-value">${nextInjection.scheduledAt}　${nextInjection.dose ?? "—"}mg</p>`
            : `<p class="injection-value muted">未設定</p>`
        }
        <div class="placeholder-box">Phase4で実装予定（投与記録・次回提案）</div>
      </section>

      <section class="card condition-card">
        <p class="card-title">${this.titleIcon("iconCondition", "")}今日の体調</p>
        <div class="placeholder-box">Phase4で実装予定（なし／軽い／あり＋詳細）</div>
      </section>
    `;

    Charts.renderWeightChart("chart-weight-home", this.state);
    this._bindAchievementBannerButtons();
    ProteinHomeUI.bindCard(this.state);
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
            <p class="achievement-title">${this.titleIcon(goalIconKey, "🌸")}${goalKey === "goal1" ? "Goal 1" : "Goal 2"} 達成</p>
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
        <p class="card-title">${this.titleIcon("iconMaintenance", "🌿")}維持準備</p>
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
