// Body Garden — 画面レンダリング・画面遷移
// Tonight Garden の data-screen 属性パターンを踏襲（ハッシュルーティングなし）。

const SCREENS = ["home", "records", "injection", "composition", "settings"];

const UI = {
  state: null,

  init(state) {
    this.state = state;
    this.bindNav();
    this.switchScreen(state.ui.lastScreen || "home");
  },

  bindNav() {
    document.querySelectorAll("[data-nav-target]").forEach((btn) => {
      btn.addEventListener("click", () => this.switchScreen(btn.dataset.navTarget));
    });
  },

  switchScreen(screenName) {
    if (!SCREENS.includes(screenName)) screenName = "home";
    document.querySelectorAll("[data-screen]").forEach((el) => {
      el.hidden = el.dataset.screen !== screenName;
    });
    document.querySelectorAll("[data-nav-target]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.navTarget === screenName);
    });
    this.state.ui.lastScreen = screenName;
    Storage.save(this.state);
    this.renderScreen(screenName);
  },

  renderScreen(screenName) {
    if (screenName === "home") this.renderHome();
    // records / injection / composition / settings は Phase2以降で実装
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

  renderHome() {
    const el = document.querySelector('[data-screen="home"]');
    const { profile, goals, dailyRecords, proteinEntries, proteinProducts, registeredFoods, injections } = this.state;

    const latest = Calc.latestWeightRecord(dailyRecords);
    const currentWeight = latest ? latest.weight : profile.startWeight;
    const currentBmi = Calc.bmi(currentWeight, profile.heightCm);
    const changeKg = Calc.changeKg(currentWeight, profile.startWeight);
    const changePct = Calc.changePct(currentWeight, profile.startWeight);
    const elapsedDays = Calc.elapsedDays(profile.startDate);

    const activeGoal = goals.activeGoal === 2 && goals.goal2 ? goals.goal2 : goals.goal1;
    const goalWeight = Calc.goalToWeightKg(activeGoal, profile.heightCm);
    const remaining = Calc.remainingToGoalKg(currentWeight, goalWeight);

    const proteinTotal = Calc.proteinTotalForDate(todayISODate(), proteinEntries, proteinProducts, registeredFoods);

    const nextInjection = injections
      .filter((i) => i.status !== "administered")
      .sort((a, b) => (a.scheduledAt < b.scheduledAt ? -1 : 1))[0];

    el.innerHTML = `
      ${this.imageWithFallback("heroMorning", "", "hero-slot")}
      <section class="card hero-card">
        <p class="eyebrow">BODY GARDEN</p>
        <p class="current-weight">${fmt(currentWeight, 2)}<span class="unit">kg</span></p>
        <p class="range-line">START ${fmt(profile.startWeight, 2)} → GOAL ${fmt(goalWeight, 2)}</p>
        <div class="stat-row">
          <div class="stat"><span class="stat-label">DAY</span><span class="stat-value">${elapsedDays ?? "—"}</span></div>
          <div class="stat"><span class="stat-label">BMI</span><span class="stat-value">${fmt(currentBmi, 1)}</span></div>
          <div class="stat"><span class="stat-label">変化</span><span class="stat-value">${signedFmt(changeKg, 2)}kg</span></div>
          <div class="stat"><span class="stat-label">変化率</span><span class="stat-value">${signedFmt(changePct, 1)}%</span></div>
        </div>
        <p class="remaining-line">目標まで ${remaining != null ? fmt(Math.abs(remaining), 1) + "kg" : "—"}</p>
      </section>

      <section class="card graph-card">
        <p class="card-title">体重グラフ</p>
        <div class="placeholder-box">Phase2で実装予定（Goal1/Goal2/BMI21・BMI20ラインを重ねて表示）</div>
      </section>

      <section class="card protein-card">
        <p class="card-title">TODAY'S PROTEIN</p>
        <p class="protein-value">${fmt(proteinTotal, 1)} / ${profile.proteinTarget} g</p>
        <div class="progress-bar"><div class="progress-fill" style="width:${Math.min(100, (proteinTotal / profile.proteinTarget) * 100)}%"></div></div>
        <div class="placeholder-box">Phase3で実装予定（ホエイ／登録食品／食事の追加操作）</div>
      </section>

      <section class="card injection-card">
        <p class="card-title">💉 NEXT INJECTION</p>
        ${
          nextInjection
            ? `<p class="injection-value">${nextInjection.scheduledAt}　${nextInjection.dose ?? "—"}mg</p>`
            : `<p class="injection-value muted">未設定</p>`
        }
        <div class="placeholder-box">Phase4で実装予定（投与記録・次回提案）</div>
      </section>

      <section class="card condition-card">
        <p class="card-title">今日の体調</p>
        <div class="placeholder-box">Phase4で実装予定（なし／軽い／あり＋詳細）</div>
      </section>
    `;
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
