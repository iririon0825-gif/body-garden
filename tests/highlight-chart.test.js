// 週刊・月刊ハイライトの期間グラフ: charts.js の Charts.renderPeriodWeightChart / renderPeriodMetricChart。
// DOM/Chart.js は最小のダミーで置き換える（protein-trend-chart.test.js と同じ方式）。HOMEの体重グラフ・体組成トレンドとの非干渉も確認する

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { loadEnv, sampleState, clone } = require("./helpers");

function setupCharts(fakeToday) {
  const env = loadEnv();
  if (fakeToday) vm.runInContext(`todayISODate = () => ${JSON.stringify(fakeToday)};`, env.ctx);
  vm.runInContext(
    `class FakeChart {
       constructor(ctx, config) { config.__canvas = ctx.__id; __calls.configs.push(config); FakeChart.last = this; }
       destroy() { __calls.destroyed = (__calls.destroyed||0) + 1; }
     }
     FakeChart.defaults = { color: "", borderColor: "" };
     const Chart = FakeChart;
     const __calls = { configs: [] };
     function getComputedStyle(){ return { getPropertyValue(){ return ""; } }; }
     const __els = {};
     function __mk(id){
       __els[id] = { hidden: false, getContext(){ return { __id: id }; }, closest(){ return null; } };
       __els[id + "-empty"] = { hidden: true, textContent: "" };
       __els[id + "-legend"] = { innerHTML: "" };
     }
     ["chart-weight-home", "chart-composition-trend", "chart-protein-trend", "chart-hl-weight", "chart-hl-bodyFatMass", "chart-hl-skeletalMuscleMass", "chart-hl-bodyFatPct"].forEach(__mk);
     const document = { getElementById(id){ return __els[id] || null; } };`,
    env.ctx
  );
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", "charts.js"), "utf8"), env.ctx, { filename: "charts.js" });
  return {
    env,
    Charts: env.get("Charts"),
    calls: env.get("__calls"),
    el: (id) => env.get(`__els[${JSON.stringify(id)}]`),
    configFor: (id) => [...env.get("__calls").configs].reverse().find((c) => c.__canvas === id),
  };
}

function rec(env, date, weight, bc) {
  const r = env.get("createEmptyDailyRecord")(date);
  r.weight = weight;
  if (bc) Object.assign(r.bodyComposition, bc);
  return r;
}

test("renderPeriodWeightChart: 週の全7日を横軸にし、記録の無い日はnull（0にしない・線をつなげない）", () => {
  const { env, Charts, configFor, el } = setupCharts("2026-10-29");
  const s = sampleState(env);
  s.dailyRecords = [rec(env, "2026-10-26", 66.1), rec(env, "2026-10-28", 65.9), rec(env, "2026-11-01", 65.5), rec(env, "2026-10-20", 70)];
  Charts.renderPeriodWeightChart("chart-hl-weight", s, "2026-10-26", "2026-11-01");
  const cfg = configFor("chart-hl-weight");
  assert.equal(cfg.type, "line");
  assert.deepEqual(clone(cfg.data.labels), ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]);
  const w = cfg.data.datasets[0];
  assert.deepEqual(clone(w.data), [66.1, null, 65.9, null, null, null, 65.5]);
  assert.equal(w.spanGaps, false);
  assert.ok(!w.data.includes(0));
  assert.equal(el("chart-hl-weight").hidden, false);
  assert.equal(el("chart-hl-weight-empty").hidden, true);
  // 期間外(10/20)の70kgで縦軸が広がらない
  assert.ok(cfg.options.scales.y.max < 70);
  // 月経の背景帯用プラグインが付く
  assert.equal(cfg.plugins.length, 1);
  assert.ok(Array.isArray(cfg.options.plugins.cycleBands.bands));
});

test("renderPeriodWeightChart: 月の全日（うるう日を含む）が横軸", () => {
  const { env, Charts, configFor } = setupCharts("2028-03-10");
  const s = sampleState(env);
  s.dailyRecords = [rec(env, "2028-02-29", 60.5), rec(env, "2028-02-01", 61)];
  Charts.renderPeriodWeightChart("chart-hl-weight", s, "2028-02-01", "2028-02-29");
  const cfg = configFor("chart-hl-weight");
  assert.equal(cfg.data.labels.length, 29);
  assert.equal(cfg.data.labels[28], "2028-02-29");
  assert.equal(cfg.data.datasets[0].data[28], 60.5);
  assert.equal(cfg.data.datasets[0].data[0], 61);
  assert.equal(cfg.data.datasets[0].data.filter((v) => v != null).length, 2);
});

test("renderPeriodWeightChart: Goal・ガードレールの線を、縦軸に収まるものだけ重ねる。月経の帯は共有のCharts.bandsを書き換えない", () => {
  const { env, Charts, configFor } = setupCharts("2026-10-29");
  const s = sampleState(env);
  s.dailyRecords = [rec(env, "2026-10-27", 60.2), rec(env, "2026-10-28", 60.4)];
  s.goals.goal1 = { type: "weight", value: 60 };
  s.goals.goal2 = { type: "weight", value: 50 }; // 縦軸の範囲外
  s.cycleEntries = [{ id: 1, startDate: "2026-10-27", endDate: "2026-10-30", comment: "", createdAt: null, updatedAt: null }];
  Charts.bands = [{ from: "x", to: "y", color: "z" }];
  Charts.renderPeriodWeightChart("chart-hl-weight", s, "2026-10-26", "2026-11-01");
  const cfg = configFor("chart-hl-weight");
  const labels = cfg.data.datasets.map((d) => d.label);
  assert.ok(labels.includes("Goal1"));
  assert.ok(!labels.includes("Goal2"));
  assert.ok(cfg.options.plugins.cycleBands.bands.length >= 1);
  assert.equal(Charts.bands.length, 1);
  assert.equal(Charts.bands[0].from, "x");
});

test("renderPeriodWeightChart: 期間に体重が1件も無ければ「データなし」（canvasを隠し、Chartを作らない）", () => {
  const { env, Charts, calls, el } = setupCharts("2026-10-29");
  const s = sampleState(env);
  s.dailyRecords = [rec(env, "2026-10-01", 66), rec(env, "2026-10-27", null)];
  Charts.renderPeriodWeightChart("chart-hl-weight", s, "2026-10-26", "2026-11-01");
  assert.equal(calls.configs.length, 0);
  assert.equal(el("chart-hl-weight").hidden, true);
  assert.equal(el("chart-hl-weight-empty").hidden, false);
  assert.equal(el("chart-hl-weight-empty").textContent, "データなし");
  assert.equal(Charts._instances["chart-hl-weight"], undefined);
  // 存在しないcanvasは何もしない
  assert.doesNotThrow(() => Charts.renderPeriodWeightChart("no-such-canvas", s, "2026-10-26", "2026-11-01"));
});

test("renderPeriodMetricChart: 記録された値だけを描く。体脂肪量が無い日を 体重×体脂肪率 で補わない", () => {
  const { env, Charts, configFor } = setupCharts("2026-10-29");
  const s = sampleState(env);
  s.dailyRecords = [
    rec(env, "2026-10-26", 66, { bodyFatPct: 30 }), // 体脂肪量は未記録
    rec(env, "2026-10-28", 65, { bodyFatMass: 19.5, bodyFatPct: 30 }),
  ];
  Charts.renderPeriodMetricChart("chart-hl-bodyFatMass", s, "bodyFatMass", "2026-10-26", "2026-11-01");
  const cfg = configFor("chart-hl-bodyFatMass");
  const d = cfg.data.datasets[0];
  assert.equal(d.label, "体脂肪量");
  assert.deepEqual(clone(d.data), [null, null, 19.5, null, null, null, null]);
  assert.equal(d.spanGaps, false);
  assert.equal(cfg.options.plugins.tooltip.callbacks.label({ raw: 19.5 }), "体脂肪量: 19.50kg");
  // 体脂肪率は記録された2日
  Charts.renderPeriodMetricChart("chart-hl-bodyFatPct", s, "bodyFatPct", "2026-10-26", "2026-11-01");
  assert.deepEqual(clone(configFor("chart-hl-bodyFatPct").data.datasets[0].data), [30, null, 30, null, null, null, null]);
});

test("renderPeriodMetricChart: 値が1件も無い・不明な項目は、データなし／何もしない", () => {
  const { env, Charts, calls, el } = setupCharts("2026-10-29");
  const s = sampleState(env);
  s.dailyRecords = [rec(env, "2026-10-26", 66, { bodyFatPct: 30 })];
  Charts.renderPeriodMetricChart("chart-hl-skeletalMuscleMass", s, "skeletalMuscleMass", "2026-10-26", "2026-11-01");
  assert.equal(calls.configs.length, 0);
  assert.equal(el("chart-hl-skeletalMuscleMass").hidden, true);
  assert.equal(el("chart-hl-skeletalMuscleMass-empty").textContent, "データなし");
  assert.doesNotThrow(() => Charts.renderPeriodMetricChart("chart-hl-skeletalMuscleMass", s, "noSuchField", "2026-10-26", "2026-11-01"));
  assert.equal(calls.configs.length, 0);
});

test("期間グラフはHOMEの体重グラフ・体組成トレンド・たんぱく質トレンドと別instanceで、互いを壊さない", () => {
  const { env, Charts, calls } = setupCharts("2026-10-29");
  const s = sampleState(env);
  s.dailyRecords = [rec(env, "2026-10-27", 66.8, { bodyFatMass: 20.5 }), rec(env, "2026-10-28", 66.6, { bodyFatMass: 20.4 })];
  s.proteinEntries = [{ id: 9, date: "2026-10-27", proteinTotal: 60, createdAt: "2026-10-27T00:00:00.000Z" }];
  Charts.renderWeightChart("chart-weight-home", s, "30");
  Charts.renderCompositionTrendChart("chart-composition-trend", s, "bodyFatMass", "30");
  Charts.renderProteinTrendChart("chart-protein-trend", s, "30");
  const homeBands = Charts.bands;
  Charts.renderPeriodWeightChart("chart-hl-weight", s, "2026-10-26", "2026-11-01");
  Charts.renderPeriodMetricChart("chart-hl-bodyFatMass", s, "bodyFatMass", "2026-10-26", "2026-11-01");
  const ids = ["chart-weight-home", "chart-composition-trend", "chart-protein-trend", "chart-hl-weight", "chart-hl-bodyFatMass"];
  for (const id of ids) assert.ok(Charts._instances[id], id);
  assert.equal(new Set(ids.map((id) => Charts._instances[id])).size, 5, "すべて別instance");
  assert.equal(Charts.bands, homeBands, "HOMEの月経帯の共有値は期間グラフで変わらない");
  // 期間グラフの再描画で壊れるのは、自分のinstanceだけ
  const before = calls.destroyed || 0;
  const home = Charts._instances["chart-weight-home"];
  Charts.renderPeriodWeightChart("chart-hl-weight", s, "2026-10-19", "2026-10-25");
  assert.equal((calls.destroyed || 0) - before, 1);
  assert.equal(Charts._instances["chart-weight-home"], home);
  // 逆に、HOMEの再描画で期間グラフは壊れない
  const hl = Charts._instances["chart-hl-weight"];
  Charts.renderWeightChart("chart-weight-home", s, "7");
  assert.equal(Charts._instances["chart-hl-weight"], hl);
});

test("Chart.js を読み込めない状態でも例外にしない（メッセージを出す）", () => {
  // Chart を未定義にした別コンテキストを作る
  const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} }, Date, JSON, Math });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", "calc.js"), "utf8"), ctx, { filename: "calc.js" });
  const empty = { hidden: false, textContent: "" };
  vm.runInContext(`const document = { getElementById(id){ return id === "c" ? { hidden: false, getContext(){return {};} } : id === "c-empty" ? __empty : null; } };`, Object.assign(ctx, { __empty: empty }));
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", "charts.js"), "utf8"), ctx, { filename: "charts.js" });
  const C = vm.runInContext("Charts", ctx);
  const s = { profile: {}, goals: {}, dailyRecords: [{ date: "2026-10-27", weight: 66, bodyComposition: {} }] };
  assert.doesNotThrow(() => C.renderPeriodWeightChart("c", s, "2026-10-26", "2026-11-01"));
  assert.match(empty.textContent, /グラフを表示できません/);
});
