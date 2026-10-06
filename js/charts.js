// Body Garden — 体重グラフ（Chart.js）
// 実測体重・Goal1/Goal2ライン・BMI21/BMI20相当体重ラインを重ねて描画する。
// HOMEのグラフは表示期間（直近7日／直近30日／全期間）ごとに縦軸の範囲と目盛り間隔を切り替える。
// 期間の切替状態はメモリ上のみで、保存データ(localStorage)には書き込まない。

const Charts = {
  _instances: {},

  // 将来、月経期／卵胞期／黄体期などの周期帯を背景に重ねるための入力口。
  // [{ from: "YYYY-MM-DD", to: "YYYY-MM-DD", color: "rgba(...)" }] を入れると、
  // 横軸（日単位）の位置に合わせて背景帯が描かれる。未使用時は何も描かない
  bands: [],

  // range: "7" | "30" | "all"
  renderWeightChart(canvasId, state, range) {
    const canvas = document.getElementById(canvasId);
    const emptyMsg = document.getElementById(`${canvasId}-empty`);
    const legendEl = document.getElementById(`${canvasId}-legend`);
    if (!canvas) return;
    const card = canvas.closest(".graph-card");

    if (this._instances[canvasId]) {
      this._instances[canvasId].destroy();
      delete this._instances[canvasId];
    }

    const { profile, goals, dailyRecords } = state;
    const points = (dailyRecords || [])
      .filter((r) => r.weight != null)
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    const showMessage = (text, noRange) => {
      canvas.hidden = true;
      if (emptyMsg) {
        emptyMsg.textContent = text;
        emptyMsg.hidden = false;
      }
      if (legendEl) legendEl.innerHTML = "";
      if (card) card.classList.toggle("graph-card--norange", !!noRange);
    };

    if (points.length === 0) {
      showMessage("体重を記録するとグラフが表示されます", false);
      return;
    }
    // 外部ライブラリ（Chart.js）を取得できない状態（オフライン等）でも、HOME全体の描画を止めない
    if (typeof Chart === "undefined") {
      showMessage("グラフを表示できません（通信できる状態で、もう一度開いてください）", false);
      return;
    }

    // --- 表示期間の日付列（日単位の連続した横軸。記録のない日は線を補間するだけで空ける） ---
    const today = todayISODate();
    const lastDate = points[points.length - 1].date;
    const endDate = lastDate > today ? lastDate : today;
    const period = range === "7" || range === "30" ? Number(range) : null;
    const startDate = period ? addDays(today, -(period - 1)) : points[0].date;
    const days = enumerateDays(startDate, period ? today : endDate);
    const inWindow = points.filter((p) => p.date >= days[0] && p.date <= days[days.length - 1]);
    if (inWindow.length === 0) {
      showMessage("この期間の記録はありません", true);
      return;
    }
    if (card) card.classList.remove("graph-card--norange");
    canvas.hidden = false;
    if (emptyMsg) emptyMsg.hidden = true;

    const byDay = {};
    inWindow.forEach((p) => (byDay[p.date] = p.weight));
    const weightData = days.map((d) => (d in byDay ? byDay[d] : null));

    // --- 目標・ガードレールの体重値 ---
    const cardStyle = getComputedStyle(canvas);
    const cv = (name, fallback) => cardStyle.getPropertyValue(name).trim() || fallback;
    const goal1Weight = Calc.goalToWeightKg(goals.goal1, profile.heightCm);
    const goal2Weight = goals.goal2 ? Calc.goalToWeightKg(goals.goal2, profile.heightCm) : null;
    const bmi21Weight = Calc.weightForBmi(profile.bmiMaintenanceAlert, profile.heightCm);
    const bmi20Weight = Calc.weightForBmi(profile.bmiLowerLine, profile.heightCm);
    const guides = [
      { label: "Goal1", short: "Goal1", value: goal1Weight, color: cv("--chart-goal1", "#d9a9ac"), dashed: false },
      { label: "Goal2", short: "Goal2", value: goal2Weight, color: cv("--chart-goal2", "#b7a9d6"), dashed: false },
      { label: `BMI${profile.bmiMaintenanceAlert}`, short: `BMI${profile.bmiMaintenanceAlert}`, value: bmi21Weight, color: cv("--chart-bmi21", "#e0c68a"), dashed: true },
      { label: `BMI${profile.bmiLowerLine} LOWER LINE`, short: "LOWER LINE", badge: "LOWER", value: bmi20Weight, color: cv("--chart-bmi20", "#c08a8a"), dashed: true },
    ].filter((g) => g.value != null);

    // --- 縦軸の範囲と刻み ---
    const weights = inWindow.map((p) => p.weight);
    const axis = computeAxis(period, weights, [profile.startWeight, goal1Weight, goal2Weight]);

    const inRange = (v) => v >= axis.min && v <= axis.max;
    const datasets = [
      {
        label: "体重",
        data: weightData,
        borderColor: cv("--chart-line", "#6fa89c"),
        backgroundColor: cv("--chart-line-fill", "rgba(111,168,156,0.15)"),
        pointRadius: period === null && days.length > 45 ? 2 : 3,
        tension: 0.25,
        spanGaps: true,
        fill: true,
      },
    ];
    guides.filter((g) => inRange(g.value)).forEach((g) => {
      datasets.push(flatLine(g.label, g.value, days.length, g.color, g.dashed));
    });

    // --- 凡例（1行）と、縦軸範囲外の目標バッジ ---
    if (legendEl) {
      const swatch = (color, dashed) =>
        `<i class="cl-sw${dashed ? " is-dashed" : ""}" style="--c:${color}"></i>`;
      const items = [`<span class="cl-item">${swatch(datasets[0].borderColor, false)}体重</span>`];
      guides.forEach((g) => {
        if (inRange(g.value)) {
          items.push(`<span class="cl-item">${swatch(g.color, g.dashed)}${g.short}</span>`);
        } else {
          const arrow = g.value < axis.min ? "↓" : "↑";
          items.push(
            `<span class="cl-badge" style="--c:${g.color}" title="${g.short}（表示範囲外）">${g.badge || g.short} ${g.value.toFixed(1)}${arrow}</span>`
          );
        }
      });
      legendEl.innerHTML = items.join("");
    }

    // 文字色・目盛線色もカード側のCSS変数から読む（未定義のカードはChart.jsの既定色）
    Chart.defaults.color = cv("--chart-text", "#666");
    Chart.defaults.borderColor = cv("--chart-grid", "rgba(0, 0, 0, 0.1)");

    // 月経周期の背景帯。CycleLogicは色を知らない（from/to/phaseだけを返す純粋関数）ので、
    // 描画の直前にここで色（CSS変数）へ変換する。cycle-logic.jsが無い/未読込でも描画は止めない
    const PHASE_FALLBACK = { period: "rgba(199,125,150,0.22)", follicular: "rgba(150,150,220,0.14)", luteal: "rgba(214,160,200,0.14)" };
    // 「今日」はこの関数の横軸と同じ基準（today, 上で計算済み）を使う。CycleLogic側の既定(new Date())とは
    // 別の時計にならないようにする
    this.bands =
      typeof CycleLogic !== "undefined"
        ? CycleLogic.bands(state, parseISO(today)).map((b) => ({ from: b.from, to: b.to, color: cv(`--chart-cycle-${b.phase}`, PHASE_FALLBACK[b.phase]) }))
        : [];

    const spanDays = days.length;
    this._instances[canvasId] = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: { labels: days, datasets },
      plugins: [cycleBandsPlugin],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        layout: { padding: { top: 4, right: 6 } },
        plugins: {
          legend: { display: false },
          cycleBands: { bands: this.bands },
          tooltip: {
            callbacks: {
              title: (items) => (items.length ? shortDate(items[0].label, spanDays) : ""),
              label: (item) => `${item.dataset.label}: ${Number(item.raw).toFixed(1)}kg`,
            },
          },
        },
        scales: {
          y: {
            min: axis.min,
            max: axis.max,
            ticks: {
              stepSize: axis.step,
              callback: (v) => `${Number(v).toFixed(axis.step < 1 ? 1 : 0)}kg`,
            },
          },
          x: {
            ticks: {
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: period === 7 ? 7 : 6,
              callback(value) {
                return shortDate(this.getLabelForValue(value), spanDays);
              },
            },
          },
        },
      },
    });
  },

  // 体組成タブ：1指標だけの時系列（読み取り専用）。日付・期間ロジックはBodyCompositionLogic.trendSeriesに
  // 任せ、ここは見た目（Chart.js設定）だけを組み立てる。体重グラフ（chart-weight-home）とは別instanceで、
  // 互いに干渉しない
  renderCompositionTrendChart(canvasId, state, fieldKey, range) {
    const canvas = document.getElementById(canvasId);
    const emptyMsg = document.getElementById(`${canvasId}-empty`);
    if (!canvas) return;

    if (this._instances[canvasId]) {
      this._instances[canvasId].destroy();
      delete this._instances[canvasId];
    }

    const field = (typeof COMPOSITION_FIELDS !== "undefined" ? COMPOSITION_FIELDS : []).find((f) => f.key === fieldKey);
    if (!field) return;

    const showMessage = (text) => {
      canvas.hidden = true;
      if (emptyMsg) {
        emptyMsg.textContent = text;
        emptyMsg.hidden = false;
      }
    };

    if (typeof BodyCompositionLogic === "undefined") {
      showMessage("グラフを表示できません");
      return;
    }
    // 体重グラフ・月経帯と同じ「今日」を使う（別の時計にならないように todayISODate() 基準で揃える）
    const { days, data } = BodyCompositionLogic.trendSeries(state, fieldKey, range, parseISO(todayISODate()));
    if (days.length === 0) {
      showMessage(`${field.label}を記録するとグラフが表示されます`);
      return;
    }
    if (typeof Chart === "undefined") {
      showMessage("グラフを表示できません（通信できる状態で、もう一度開いてください）");
      return;
    }
    const values = data.filter((v) => v != null);
    if (values.length === 0) {
      showMessage("この期間の記録はありません");
      return;
    }
    canvas.hidden = false;
    if (emptyMsg) emptyMsg.hidden = true;

    const cardStyle = getComputedStyle(canvas);
    const cv = (name, fallback) => cardStyle.getPropertyValue(name).trim() || fallback;
    Chart.defaults.color = cv("--chart-text", "#7c756f");
    Chart.defaults.borderColor = cv("--chart-grid", "rgba(0, 0, 0, 0.08)");

    const period = range === "7" || range === "30" ? Number(range) : null;
    const axis = computeMetricAxis(values);
    const spanDays = days.length;
    const decimals = field.decimals || 0;
    const unit = field.unit || "";

    this._instances[canvasId] = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: {
        labels: days,
        datasets: [
          {
            label: field.label,
            data,
            borderColor: cv("--chart-line", "#4d4270"),
            backgroundColor: cv("--chart-line-fill", "rgba(77, 66, 112, 0.12)"),
            pointRadius: period === null && days.length > 45 ? 2 : 3,
            tension: 0.25,
            spanGaps: true,
            fill: true,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        layout: { padding: { top: 4, right: 6 } },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => (items.length ? shortDate(items[0].label, spanDays) : ""),
              label: (item) => `${field.label}: ${Number(item.raw).toFixed(decimals)}${unit}`,
            },
          },
        },
        scales: {
          y: {
            min: axis.min,
            max: axis.max,
            ticks: {
              stepSize: axis.step,
              callback: (v) => `${Number(v).toFixed(decimals ? 1 : 0)}${unit}`,
            },
          },
          x: {
            ticks: {
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: period === 7 ? 7 : 6,
              callback(value) {
                return shortDate(this.getLabelForValue(value), spanDays);
              },
            },
          },
        },
      },
    });
  },
};

// 体組成指標の縦軸：目標値などの考慮は不要なぶん、体重グラフよりシンプル。データの最小〜最大に
// 余白を付け、きりのよい刻み幅を選ぶ（kg・%のどちらでも使える単位非依存のロジック）
function computeMetricAxis(values) {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const rawStep = Math.max(hi - lo, 0.5) / 4;
  const candidates = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50];
  const step = candidates.find((s) => s >= rawStep) || 50;
  const min = Math.floor((lo - step * 0.3) / step) * step;
  const max = Math.ceil((hi + step * 0.3) / step) * step;
  return { min: round2(min), max: round2(max), step };
}

// 縦軸：7日=0.5kg刻み、30日=1kg刻み、全期間=開始体重・記録値・目標値を含めて自動調整。
// 小さな変化を誇張しすぎないよう、期間ごとに最小の表示幅を確保する
function computeAxis(period, weights, extraTargets) {
  const lo = Math.min(...weights);
  const hi = Math.max(...weights);
  if (period === 7 || period === 30) {
    const step = period === 7 ? 0.5 : 1;
    const minSpan = period === 7 ? 2 : 4;
    const pad = period === 7 ? 0.2 : 0.4;
    let min = Math.floor((lo - pad) / step) * step;
    let max = Math.ceil((hi + pad) / step) * step;
    let flip = false;
    while (max - min < minSpan - 1e-9) {
      if (flip) min -= step;
      else max += step;
      flip = !flip;
    }
    return { min: round2(min), max: round2(max), step };
  }
  const all = weights.concat(extraTargets.filter((v) => v != null));
  const aLo = Math.min(...all);
  const aHi = Math.max(...all);
  const rawStep = Math.max(aHi - aLo, 4) / 5;
  const step = [0.5, 1, 2, 2.5, 5, 10].find((s) => s >= rawStep) || 10;
  const min = Math.floor((aLo - step * 0.3) / step) * step;
  const max = Math.ceil((aHi + step * 0.3) / step) * step;
  return { min: round2(min), max: round2(max), step };
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

function parseISO(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function fmtISO(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function addDays(iso, n) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return fmtISO(d);
}
function enumerateDays(startIso, endIso) {
  const out = [];
  for (let d = parseISO(startIso), end = parseISO(endIso); d <= end; d.setDate(d.getDate() + 1)) {
    out.push(fmtISO(d));
  }
  return out;
}

// 年を省略した短い日付（9/26）。約1年を超える期間だけ「26/9」形式の年月表示にする
function shortDate(iso, spanDays) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  if (spanDays > 400) return `${String(y).slice(2)}/${m}`;
  return `${m}/${d}`;
}

function flatLine(label, value, length, color, dashed) {
  return {
    label,
    data: new Array(length).fill(value),
    borderColor: color,
    borderWidth: 1.5,
    borderDash: dashed ? [4, 4] : undefined,
    pointRadius: 0,
    fill: false,
  };
}

// 周期帯（月経期・卵胞期・黄体期など）の背景描画。Charts.bandsが空なら何もしない
const cycleBandsPlugin = {
  id: "cycleBands",
  beforeDatasetsDraw(chart, _args, opts) {
    const bands = (opts && opts.bands) || [];
    const labels = chart.data.labels || [];
    if (!bands.length || !labels.length) return;
    const { ctx, chartArea, scales } = chart;
    const x = scales.x;
    const half = labels.length > 1 ? (x.getPixelForValue(1) - x.getPixelForValue(0)) / 2 : 0;
    bands.forEach((b) => {
      const first = labels.findIndex((d) => d >= b.from && d <= b.to);
      if (first < 0) return;
      let last = first;
      labels.forEach((d, i) => {
        if (d >= b.from && d <= b.to) last = i;
      });
      const left = Math.max(chartArea.left, x.getPixelForValue(first) - half);
      const right = Math.min(chartArea.right, x.getPixelForValue(last) + half);
      ctx.save();
      ctx.fillStyle = b.color;
      ctx.fillRect(left, chartArea.top, right - left, chartArea.bottom - chartArea.top);
      ctx.restore();
    });
  },
};
