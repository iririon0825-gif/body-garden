// Body Garden — 週刊・月刊ハイライト（記録タブ：読み取り専用）
// 記録タブの上部の切替「毎日の記録／週刊／月刊」。最初は「毎日の記録」＝これまでの記録タブそのまま。
// 週刊・月刊では、毎日の記録の4つのカードを隠し、ここで集計を表示する。
// 保存はしない（state を書き換えない）。切替・見ている期間はメモリ上だけ。表示のたびに state から計算し直す
// （過去の記録を直せば、次の表示に反映される）。集計は HighlightLogic、グラフは Charts.renderPeriod* が担当する。

const HighlightUI = {
  _mode: "daily", // "daily" | "week" | "month"
  _period: null, // 見ている期間 { kind, from, to }（week / month のときだけ使う）

  DAILY_ROOT_IDS: ["records-root", "protein-trend-root", "cycle-root", "condition-root"],
  MODES: [
    ["daily", "毎日の記録"],
    ["week", "週刊"],
    ["month", "月刊"],
  ],

  isDaily() {
    return this._mode === "daily";
  },

  _esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  },
  _f(v, d) {
    return v == null || !Number.isFinite(v) ? "—" : Number(v).toFixed(d);
  },
  _signed(v, d) {
    if (v == null || !Number.isFinite(v)) return "—";
    const s = Number(v).toFixed(d);
    return v > 0 && Number(s) !== 0 ? `+${s}` : s;
  },

  // 記録タブの描画（UI.renderScreen("records") から呼ぶ）。毎日の記録のときは何も差し替えず、
  // 4つのカードの表示を戻して切替だけを描く
  render(state) {
    const el = document.getElementById("highlight-root");
    if (!el) return;
    const daily = this.isDaily();
    this.DAILY_ROOT_IDS.forEach((id) => {
      const root = document.getElementById(id);
      if (root) root.hidden = !daily;
    });
    const today = todayISODate();
    if (!daily) this._period = HighlightLogic.normalizePeriod(this._period, this._mode, today);

    el.innerHTML = this._switchHtml() + (daily ? "" : this._viewHtml(state, today));
    this._bind(state);
    if (!daily) this._drawCharts(state);
  },

  _switchHtml() {
    const tabs = this.MODES.map(
      ([v, label]) => `<button type="button" class="cond-tab${this._mode === v ? " is-active" : ""}" data-hl-mode="${v}" aria-pressed="${this._mode === v}">${label}</button>`
    ).join("");
    return `<div class="cond-tabs hl-switch" role="group" aria-label="記録の表示">${tabs}</div>`;
  },

  _bind(state) {
    document.querySelectorAll("[data-hl-mode]").forEach((b) =>
      b.addEventListener("click", () => this._setMode(state, b.dataset.hlMode))
    );
    document.querySelectorAll("[data-hl-nav]").forEach((b) =>
      b.addEventListener("click", () => {
        if (b.disabled || !this._period) return;
        this._period = b.dataset.hlNav === "prev" ? HighlightLogic.prevPeriod(this._period) : HighlightLogic.nextPeriod(this._period);
        this.render(state);
      })
    );
  },

  _setMode(state, mode) {
    if (mode === this._mode) return;
    this._mode = mode === "week" || mode === "month" ? mode : "daily";
    this._period = this._mode === "daily" ? null : HighlightLogic.periodContaining(this._mode, todayISODate());
    // 毎日の記録に戻るときは、4つのカードを最新の state で描き直してから見せる
    if (this._mode === "daily" && typeof UI !== "undefined" && UI.renderRecordsDaily) UI.renderRecordsDaily();
    this.render(state);
  },

  // ============ 画面 ============

  _viewHtml(state, today) {
    const L = HighlightLogic;
    const s = L.summarize(state, this._period, today);
    const isMonth = s.kind === "month";
    const prevOk = L.canGoPrev(state, this._period, today);
    const nextOk = L.canGoNext(this._period, today);
    const ids = this._chartIds();

    const parts = [];
    // 期間の見出しと前後ボタン
    parts.push(`
      <section class="card hl-period-card">
        <div class="hl-nav">
          <button type="button" class="btn-secondary hl-nav-btn" data-hl-nav="prev" ${prevOk ? "" : "disabled"} aria-label="${isMonth ? "前の月" : "前の週"}">‹ ${isMonth ? "前の月" : "前の週"}</button>
          <p class="hl-nav-label">${this._esc(s.label)}</p>
          <button type="button" class="btn-secondary hl-nav-btn" data-hl-nav="next" ${nextOk ? "" : "disabled"} aria-label="${isMonth ? "次の月" : "次の週"}">${isMonth ? "次の月" : "次の週"} ›</button>
        </div>
        <p class="hl-sub">体重を記録した日：${s.weight.n}日${s.inProgress ? "（この期間はまだ途中です）" : ""}</p>
      </section>`);

    parts.push(this._weightCardHtml(s, isMonth));
    if (isMonth) parts.push(this._monthCardHtml(s));

    parts.push(`
      <section class="card comp-trend-card">
        <p class="card-title">${UI.lineIcon("trend")}${isMonth ? "月" : "週"}の体重グラフ</p>
        <div class="chart-wrap comp-trend-wrap">
          <canvas id="${ids.weight}"></canvas>
          <p class="chart-empty-msg" id="${ids.weight}-empty">${L.NO_DATA}</p>
        </div>
        <div class="chart-legend" id="${ids.weight}-legend"></div>
        <p class="comp-trend-note">記録のない日は空けて表示しています（0kgとして扱いません）。</p>
      </section>`);

    parts.push(this._compositionCardHtml(s, ids));
    parts.push(this._proteinCardHtml(s));
    parts.push(this._recordsCardHtml(s));
    parts.push(this._discoveryCardHtml(s, isMonth));
    return parts.join("");
  },

  _chartIds() {
    return {
      weight: "chart-hl-weight",
      bodyFatMass: "chart-hl-bodyFatMass",
      skeletalMuscleMass: "chart-hl-skeletalMuscleMass",
      bodyFatPct: "chart-hl-bodyFatPct",
    };
  },

  // key=true は、そのカードで視線を集める主要値（1カード1〜2個）。増減の方向で色は変えない
  _stat(label, value, sub, key) {
    const emphasize = key && value !== HighlightLogic.NO_DATA; // 値がないときは強調しない
    return `<div class="hl-stat${emphasize ? " hl-stat-key" : ""}"><span class="hl-stat-label">${label}</span><span class="hl-stat-value">${value}</span>${sub ? `<span class="hl-stat-sub">${sub}</span>` : ""}</div>`;
  },

  _dated(p, digits, unit) {
    return p ? `${this._f(p.value, digits)}${unit}<br />${HighlightLogic.mdw(p.date)}` : HighlightLogic.NO_DATA;
  },

  _weightCardHtml(s, isMonth) {
    const L = HighlightLogic;
    const w = s.weight;
    const prevLabel = isMonth ? "前の月" : "前の週";
    const avgText = w.avg == null ? L.NO_DATA : `${this._f(w.avg, 2)} kg`;
    let diffText;
    let diffSub = "";
    if (w.diff == null) {
      diffText = w.n === 0 ? L.NO_DATA : `${prevLabel}の記録なし`;
    } else {
      diffText = `${this._signed(w.diff, 2)} kg`;
      diffSub = `${prevLabel}の平均 ${this._f(w.prev.avg, 2)} kg（${w.prev.n}日）`;
      if (w.diffReferenceOnly) diffSub += `<br />${L.LOW_COUNT_NOTE}`;
    }
    const stats = [
      this._stat(`${isMonth ? "月" : "週"}の平均`, avgText, w.n ? `${w.n}日の平均` : "", true),
      this._stat(`${prevLabel}との差`, diffText, diffSub, !isMonth && w.diff != null), // 前の週の記録がないとき（文言だけ）は強調しない
      this._stat("最小", this._dated(w.min, 2, " kg")),
      this._stat("最大", this._dated(w.max, 2, " kg")),
    ];
    if (isMonth) {
      const fl = s.firstLast;
      // ％は、月内で最初に測った体重を基準にした変化率（HOMEの「kg変化＋％」と同じ Calc.changePct）。
      // 最初と最後の実測が両方あるとき（fl.available）だけ出し、推定はしない
      const flPct = fl.available ? Calc.changePct(fl.to.value, fl.from.value) : null;
      const flValue = fl.available
        ? `${this._signed(fl.diff, 2)} kg${flPct == null ? "" : `<small class="hl-pct">（${this._signed(flPct, 1).replace(/^-(0\.0+)$/, "$1")}%）</small>`}`
        : L.NO_DATA;
      stats.push(
        this._stat(
          "最初と最後の差",
          flValue,
          fl.available ? `${L.mdw(fl.from.date)} ${this._f(fl.from.value, 2)} → ${L.mdw(fl.to.date)} ${this._f(fl.to.value, 2)}` : w.n === 1 ? "測定が1日だけのため、差は出していません" : "",
          true
        )
      );
    }
    return `
      <section class="card">
        <p class="card-title">${UI.lineIcon("weight")}体重</p>
        <div class="hl-stats">${stats.join("")}</div>
        ${w.lowCountNote && w.n > 0 && !w.diffReferenceOnly ? `<p class="hl-note">${w.lowCountNote}</p>` : ""}
        ${s.softNote ? `<p class="hl-note">${s.softNote}</p>` : ""}
      </section>`;
  },

  _monthCardHtml(s) {
    const L = HighlightLogic;
    const ss = s.sinceStart;
    let since;
    if (!ss.available && ss.reason === "startWeightUnset") {
      since = `<p class="hl-line">${L.START_WEIGHT_UNSET}</p>`;
    } else if (!ss.available) {
      since = `<p class="hl-line">${L.NO_DATA}</p>`;
    } else {
      since = `<p class="hl-big hl-key">${this._signed(ss.changeKg, 2)} kg<small>（${this._signed(ss.changePct, 1)}%）</small></p>
        <p class="hl-sub">開始体重（設定値）${this._f(ss.startWeight, 2)} kg から／この月で最後に測った ${L.mdw(ss.lastDate)} の ${this._f(ss.lastWeight, 2)} kg</p>`;
    }
    const g = s.goals;
    const rows = g.rows
      .map((r) => {
        if (r.status === "noData") return `<li class="hl-goal-row"><span class="hl-goal-name">${r.label}</span><span class="hl-goal-main">${L.NO_DATA}</span></li>`;
        if (r.status === "noTarget") return `<li class="hl-goal-row"><span class="hl-goal-name">${r.label}</span><span class="hl-goal-main">目標体重を計算できません</span></li>`;
        const main = r.reached ? `目標体重（${this._f(r.targetKg, 2)} kg）以下で記録されました` : `まであと <span class="hl-key">${this._f(r.remainingKg, 1)} kg</span>`;
        const pct = r.progressPct == null ? "" : `<span class="hl-goal-pct">進み ${this._f(r.progressPct, 0)}%</span>`;
        return `<li class="hl-goal-row"><span class="hl-goal-name">${r.label}</span><span class="hl-goal-main">${main}</span>${pct}</li>`;
      })
      .join("");
    return `
      <section class="card">
        <p class="card-title">${UI.lineIcon("goal")}開始からの変化とGoal</p>
        ${since}
        <p class="hl-sub">Goalへの進み：${g.lastWeight ? `この月で最後に測った ${L.mdw(g.lastWeight.date)} の ${this._f(g.lastWeight.value, 2)} kg で計算` : L.NO_DATA}</p>
        <ul class="hl-goal-list">${rows}</ul>
        <p class="comp-trend-note">${g.note}</p>
      </section>`;
  },

  _compositionCardHtml(s, ids) {
    const L = HighlightLogic;
    const blocks = s.composition.fields
      .map((f) => {
        const info =
          f.count === 0
            ? ""
            : `記録 ${f.count}回／最初 ${L.md(f.first.date)} ${this._f(f.first.value, f.decimals)}${f.unit}${f.count >= 2 ? `／最後 ${L.md(f.last.date)} ${this._f(f.last.value, f.decimals)}${f.unit}` : ""}`;
        return `
        <div class="hl-comp-block">
          <p class="hl-comp-title">${this._esc(f.label)}${info ? `<span class="hl-comp-info">${info}</span>` : ""}</p>
          <div class="chart-wrap comp-trend-wrap hl-comp-wrap">
            <canvas id="${ids[f.key]}"></canvas>
            <p class="chart-empty-msg" id="${ids[f.key]}-empty">${L.NO_DATA}</p>
          </div>
        </div>`;
      })
      .join("");
    return `
      <section class="card comp-trend-card">
        <p class="card-title">${UI.lineIcon("composition")}体組成</p>
        <p class="hl-sub">体組成を記録した日：${s.composition.recordedDays}日</p>
        ${blocks}
        <p class="comp-trend-note">${L.COMPOSITION_NOTE}。記録のない日・項目は「${L.NO_DATA}」で、推定や計算で補っていません。</p>
      </section>`;
  },

  _proteinCardHtml(s) {
    const p = s.protein;
    let body;
    if (p.recordedDays === 0) {
      body = `<p class="hl-line">${HighlightLogic.NO_DATA}</p>`;
    } else if (p.target == null) {
      body = `<p class="hl-big">記録日 ${p.recordedDays}日</p><p class="hl-sub">目標量が未設定のため、到達日数は出していません</p>`;
    } else {
      body = `<p class="hl-big">記録日 ${p.recordedDays}日中、現在の目標${this._esc(p.target)}g<span class="hl-key">到達 ${p.achievedDays}日</span></p>`;
    }
    return `
      <section class="card">
        <p class="card-title">${UI.lineIcon("protein")}たんぱく質</p>
        ${body}
        <p class="comp-trend-note">${s.proteinNote}。記録のない日は、届かなかった日として数えていません。</p>
      </section>`;
  },

  _recordsCardHtml(s) {
    const L = HighlightLogic;
    const inj = s.injections;
    const injRows = [
      ...inj.administered.map((r) => ({ date: r.date, time: r.time || "", html: `<span class="cond-chip">投与</span> ${L.mdw(r.date)} ${r.time ? this._esc(r.time) : "時刻不明"}　${r.dose != null ? this._esc(r.dose) + "mg" : "用量不明"}` })),
      ...inj.skipped.map((r) => ({ date: r.date, time: "", html: `<span class="cond-chip">見送り</span> ${L.mdw(r.date)}　${this._esc(r.reason)}` })),
    ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
    const injHtml = injRows.length ? `<ul class="hl-list">${injRows.map((r) => `<li>${r.html}</li>`).join("")}</ul>` : `<p class="hl-line">${L.NO_DATA}</p>`;

    const c = s.condition;
    const condHtml =
      c.entries === 0
        ? `<p class="hl-line">${L.NO_DATA}</p>`
        : `<p class="hl-line">体調の記録がある日：${c.days}日（${c.entries}件）</p>
           <p class="hl-sub">なし ${c.levels.none}件／軽い ${c.levels.mild}件／あり ${c.levels.moderate}件</p>
           ${c.symptoms.length ? `<p class="hl-sub">${c.symptoms.map((x) => `${this._esc(x.label)} ${x.count}件`).join("／")}</p>` : ""}`;

    const cy = s.cycle;
    const cycleHtml = cy.length
      ? `<ul class="hl-list">${cy.map((e) => `<li>${L.mdw(e.startDate)} 〜 ${e.isOpen ? "月経中" : L.mdw(e.endDate)}</li>`).join("")}</ul>`
      : `<p class="hl-line">${L.NO_DATA}</p>`;

    return `
      <section class="card">
        <p class="card-title">${UI.lineIcon("injection")}注射</p>
        ${injHtml}
        <p class="card-title hl-subtitle">${UI.lineIcon("condition")}体調</p>
        ${condHtml}
        <p class="card-title hl-subtitle">${UI.lineIcon("records")}月経</p>
        ${cycleHtml}
        <p class="comp-trend-note">この期間にある記録を並べて表示しています。</p>
      </section>`;
  },

  _discoveryCardHtml(s, isMonth) {
    const w = s.inProgress ? (isMonth ? "今月" : "今週") : isMonth ? "この月" : "この週";
    const sentences = s.discoveries;
    return `
      <section class="card">
        <p class="card-title">${UI.lineIcon("trend")}${w}のからだの発見</p>
        <ul class="hl-list hl-discoveries">${sentences.map((t) => `<li>${this._esc(t)}</li>`).join("")}</ul>
        <p class="hl-sub">${this._esc(s.closing)}</p>
      </section>`;
  },

  _drawCharts(state) {
    if (typeof Charts === "undefined" || !this._period) return;
    const ids = this._chartIds();
    const { from, to } = this._period;
    Charts.renderPeriodWeightChart(ids.weight, state, from, to);
    HighlightLogic.COMPOSITION_KEYS.forEach((key) => Charts.renderPeriodMetricChart(ids[key], state, key, from, to));
  },
};
