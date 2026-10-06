// 体組成トレンド: charts.js の描画（Charts.renderCompositionTrendChart）。
// DOM/Chart.js は最小のダミーで置き換える。体重グラフ（chart-weight-home）との非干渉も確認する

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
       constructor(ctx, config) { __calls.configs.push(config); FakeChart.last = this; }
       destroy() { __calls.destroyed = (__calls.destroyed||0) + 1; }
     }
     FakeChart.defaults = { color: "", borderColor: "" };
     const Chart = FakeChart;
     const __calls = { configs: [] };
     const __style = {
       "--chart-text": "rgba(255,255,255,0.9)", "--chart-grid": "rgba(255,255,255,0.2)",
       "--chart-line": "#d9c8ff", "--chart-line-fill": "rgba(217,200,255,0.18)",
       "--chart-goal1": "#f6a9d1", "--chart-goal2": "#9db4ff", "--chart-bmi21": "#f2dc9c", "--chart-bmi20": "#ffae9e",
     };
     const __trendStyle = {
       "--chart-text": "#7c756f", "--chart-grid": "rgba(77,66,112,0.1)",
       "--chart-line": "#4d4270", "--chart-line-fill": "rgba(77,66,112,0.12)",
     };
     function getComputedStyle(el){
       const style = el && el.__trend ? __trendStyle : __style;
       return { getPropertyValue(name){ return style[name] || ""; } };
     }
     const __weightEmpty = { hidden: true, textContent: "" };
     const __weightLegend = { innerHTML: "" };
     const __weightCanvas = { hidden: false, getContext(){ return {}; }, closest(){ return null; } };
     const __trendEmpty = { hidden: true, textContent: "" };
     const __trendCanvas = { hidden: false, __trend: true, getContext(){ return {}; }, closest(){ return null; } };
     const document = {
       getElementById(id){
         if (id === "chart-weight-home") return __weightCanvas;
         if (id === "chart-weight-home-empty") return __weightEmpty;
         if (id === "chart-weight-home-legend") return __weightLegend;
         if (id === "chart-composition-trend") return __trendCanvas;
         if (id === "chart-composition-trend-empty") return __trendEmpty;
         return null;
       },
     };`,
    env.ctx
  );
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", "charts.js"), "utf8"), env.ctx, { filename: "charts.js" });
  return {
    env,
    Charts: env.get("Charts"),
    calls: env.get("__calls"),
    trendCanvas: env.get("__trendCanvas"),
    trendEmpty: env.get("__trendEmpty"),
    weightCanvas: env.get("__weightCanvas"),
  };
}

test("renderCompositionTrendChart: 記録があれば、指標ラベルどおりのdatasetで描画する", () => {
  const { env, Charts, calls, trendCanvas } = setupCharts("2026-10-15");
  const s = sampleState(env);
  s.dailyRecords = [{ date: "2026-10-10", weight: null, comment: "", bodyComposition: { bodyFatMass: 20.5 }, compositionMeta: null }];
  Charts.renderCompositionTrendChart("chart-composition-trend", s, "bodyFatMass", "30");
  assert.equal(trendCanvas.hidden, false);
  const cfg = calls.configs[calls.configs.length - 1];
  assert.equal(cfg.data.datasets[0].label, "体脂肪量");
  assert.equal(cfg.data.datasets[0].borderColor, "#4d4270", "専用カードの紫（--chart-line）を使う");
});

test("renderCompositionTrendChart: その指標の記録が1件も無ければ、空メッセージを出してcanvasを隠す（例外にしない）", () => {
  const { env, Charts, trendCanvas, trendEmpty } = setupCharts("2026-10-15");
  const s = sampleState(env);
  s.dailyRecords = [];
  assert.doesNotThrow(() => Charts.renderCompositionTrendChart("chart-composition-trend", s, "bodyFatMass", "30"));
  assert.equal(trendCanvas.hidden, true);
  assert.equal(trendEmpty.hidden, false);
  assert.match(trendEmpty.textContent, /体脂肪量/);
});

test("renderCompositionTrendChart: 体重グラフ（chart-weight-home）と同時に存在しても、互いのinstanceを壊さない", () => {
  const { env, Charts, calls } = setupCharts("2026-10-15");
  const s = sampleState(env);
  s.dailyRecords = [
    { date: "2026-10-01", weight: 66.8, comment: "", bodyComposition: { skeletalMuscleMass: 25.4 }, compositionMeta: null },
    { date: "2026-10-05", weight: 66.5, comment: "", bodyComposition: {}, compositionMeta: null },
  ];
  Charts.renderWeightChart("chart-weight-home", s, "30");
  Charts.renderCompositionTrendChart("chart-composition-trend", s, "skeletalMuscleMass", "30");
  assert.ok(Charts._instances["chart-weight-home"], "体重グラフのinstanceが残っている");
  assert.ok(Charts._instances["chart-composition-trend"], "トレンドグラフのinstanceも別に存在する");
  assert.notEqual(Charts._instances["chart-weight-home"], Charts._instances["chart-composition-trend"]);
  // 体重グラフを再描画しても、トレンド側のinstanceは（destroyされた回数的に）巻き込まれない
  const before = calls.destroyed || 0;
  Charts.renderWeightChart("chart-weight-home", s, "7");
  assert.equal((calls.destroyed || 0) - before, 1, "destroyされるのは体重グラフのinstanceだけ");
});

test("renderCompositionTrendChart: 複数回呼んでも、同じcanvasIdのinstanceは毎回destroyしてから作り直す（重複しない）", () => {
  const { env, Charts, calls } = setupCharts("2026-10-15");
  const s = sampleState(env);
  s.dailyRecords = [{ date: "2026-10-12", weight: null, comment: "", bodyComposition: { bodyFatPct: 31.2 }, compositionMeta: null }];
  Charts.renderCompositionTrendChart("chart-composition-trend", s, "bodyFatPct", "30");
  Charts.renderCompositionTrendChart("chart-composition-trend", s, "bodyFatPct", "7");
  assert.equal(calls.destroyed, 1, "2回目の描画前に1回目のinstanceをdestroyする");
  assert.equal(calls.configs.length, 2);
});

test("renderCompositionTrendChart: BodyCompositionLogicが読み込まれていない環境でも例外にならない", () => {
  // body-composition-logic.js を読み込まない最小環境を自前で用意する（loadEnvは必ず読み込むため使わない）
  const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} }, Date, JSON, Math });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", "calc.js"), "utf8"), ctx, { filename: "calc.js" });
  vm.runInContext(
    `class FakeChart { constructor(){} destroy(){} }
     FakeChart.defaults = { color: "", borderColor: "" };
     const Chart = FakeChart;
     function getComputedStyle(){ return { getPropertyValue(){ return ""; } }; }
     const document = { getElementById(id){ return id === "c" ? { hidden: false, getContext(){return {};}, closest(){return null;} } : { hidden: true, textContent: "" }; } };`,
    ctx
  );
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", "charts.js"), "utf8"), ctx, { filename: "charts.js" });
  const Charts = vm.runInContext("Charts", ctx);
  const s = { dailyRecords: [{ date: "2026-10-01", bodyComposition: { bodyFatMass: 20.5 } }] };
  assert.equal(vm.runInContext("typeof BodyCompositionLogic", ctx), "undefined");
  assert.doesNotThrow(() => Charts.renderCompositionTrendChart("c", s, "bodyFatMass", "30"));
});
