// Body Garden — たんぱく質トレンド（記録タブ：読み取り専用）
// 既存のproteinEntriesを棒グラフで日別表示する。保存はしない・HOMEには追加しない。
// 配色・カード構造は体組成トレンド（ui-composition.js の _trendCard）と統一する

const ProteinTrendUI = {
  _range: "30",

  render(state) {
    const el = document.getElementById("protein-trend-root");
    if (!el) return;
    el.innerHTML = this._cardHtml();
    this._bind(state);
    if (typeof Charts !== "undefined") Charts.renderProteinTrendChart("chart-protein-trend", state, this._range);
  },

  _cardHtml() {
    const t = this._range;
    const rangeTabs = [["7", "7日"], ["30", "30日"], ["all", "全期間"]]
      .map(([v, label]) => `<button type="button" data-protein-trend-range="${v}" class="${t === v ? "is-active" : ""}">${label}</button>`)
      .join("");
    return `
      <section class="card comp-trend-card">
        <p class="card-title">${UI.lineIcon("records")}たんぱく質トレンド</p>
        <div class="graph-head comp-trend-head">
          <span class="comp-trend-period-label">表示期間</span>
          <div class="chart-range-tabs" role="group" aria-label="表示期間">${rangeTabs}</div>
        </div>
        <div class="chart-wrap comp-trend-wrap">
          <canvas id="chart-protein-trend"></canvas>
          <p class="chart-empty-msg" id="chart-protein-trend-empty">たんぱく質を記録するとグラフが表示されます</p>
        </div>
        <p class="comp-trend-note">目標線は現在設定している目標量です。</p>
      </section>`;
  },

  _bind(state) {
    document.querySelectorAll("[data-protein-trend-range]").forEach((b) =>
      b.addEventListener("click", () => {
        this._range = b.dataset.proteinTrendRange;
        this.render(state);
      })
    );
  },
};
