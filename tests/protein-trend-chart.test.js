// たんぱく質トレンド: charts.js の描画（Charts.renderProteinTrendChart）。
// DOM/Chart.js は最小のダミーで置き換える。体重グラフ・体組成トレンドとの非干渉も確認する

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
     const __style = { "--chart-line": "#d9c8ff" };
     const __trendStyle = { "--chart-text": "#7c756f", "--chart-grid": "rgba(77,66,112,0.1)", "--chart-line": "#4d4270", "--chart-line-fill": "rgba(77,66,112,0.12)" };
     const __proteinStyle = { "--chart-text": "#7c756f", "--chart-grid": "rgba(77,66,112,0.1)", "--chart-line": "#4d4270", "--chart-target": "#b7a9d6" };
     function getComputedStyle(el){
       const style = el && el.__kind === "trend" ? __trendStyle : el && el.__kind === "protein" ? __proteinStyle : __style;
       return { getPropertyValue(name){ return style[name] || ""; } };
     }
     const __weightCanvas = { hidden: false, getContext(){ return {}; }, closest(){ return null; } };
     const __weightEmpty = { hidden: true, textContent: "" };
     const __weightLegend = { innerHTML: "" };
     const __trendCanvas = { hidden: false, __kind: "trend", getContext(){ return {}; }, closest(){ return null; } };
     const __trendEmpty = { hidden: true, textContent: "" };
     const __proteinCanvas = { hidden: false, __kind: "protein", getContext(){ return {}; }, closest(){ return null; } };
     const __proteinEmpty = { hidden: true, textContent: "" };
     const document = {
       getElementById(id){
         if (id === "chart-weight-home") return __weightCanvas;
         if (id === "chart-weight-home-empty") return __weightEmpty;
         if (id === "chart-weight-home-legend") return __weightLegend;
         if (id === "chart-composition-trend") return __trendCanvas;
         if (id === "chart-composition-trend-empty") return __trendEmpty;
         if (id === "chart-protein-trend") return __proteinCanvas;
         if (id === "chart-protein-trend-empty") return __proteinEmpty;
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
    proteinCanvas: env.get("__proteinCanvas"),
    proteinEmpty: env.get("__proteinEmpty"),
  };
}

let nextId = 1;
function entry(date, proteinTotal) {
  return { id: nextId++, date, time: null, sourceType: "meal", sourceId: null, sourceName: "テスト", quantity: null, unitProtein: null, servingScoops: null, proteinTotal, memo: null, createdAt: `${date}T00:00:00.000Z` };
}

test("renderProteinTrendChart: 棒グラフデータセット＋現在の目標の破線を重ねて描画する", () => {
  const { env, Charts, calls, proteinCanvas } = setupCharts("2026-10-15");
  const s = sampleState(env);
  s.proteinEntries = [entry("2026-10-12", 60)];
  s.profile.proteinTarget = 75;
  Charts.renderProteinTrendChart("chart-protein-trend", s, "30");
  assert.equal(proteinCanvas.hidden, false);
  const cfg = calls.configs[calls.configs.length - 1];
  assert.equal(cfg.type, "bar");
  const bar = cfg.data.datasets.find((d) => d.type === "bar");
  const line = cfg.data.datasets.find((d) => d.type === "line");
  assert.ok(bar, "棒グラフのdatasetがある");
  assert.ok(line, "目標の破線datasetがある");
  assert.equal(line.label, "現在の目標 75g", "ラベルに現在の目標値が入っている");
  assert.ok(line.borderDash, "破線である");
});

test("renderProteinTrendChart: proteinTargetを変更すると、目標ラインのラベル・値が更新される", () => {
  const { env, Charts, calls } = setupCharts("2026-10-15");
  const s = sampleState(env);
  s.proteinEntries = [entry("2026-10-12", 60)];
  s.profile.proteinTarget = 90;
  Charts.renderProteinTrendChart("chart-protein-trend", s, "30");
  const cfg = calls.configs[calls.configs.length - 1];
  const line = cfg.data.datasets.find((d) => d.type === "line");
  assert.equal(line.label, "現在の目標 90g");
  assert.ok(line.data.every((v) => v === 90));
});

test("renderProteinTrendChart: 未記録日はnullのまま棒グラフに渡す（0に補完しない）", () => {
  const { env, Charts, calls } = setupCharts("2026-10-15");
  const s = sampleState(env);
  s.proteinEntries = [entry("2026-10-10", 20), entry("2026-10-13", 15)];
  Charts.renderProteinTrendChart("chart-protein-trend", s, "7");
  const cfg = calls.configs[calls.configs.length - 1];
  const bar = cfg.data.datasets.find((d) => d.type === "bar");
  const byDay = Object.fromEntries(cfg.data.labels.map((d, i) => [d, bar.data[i]]));
  assert.equal(byDay["2026-10-11"], null);
  assert.equal(byDay["2026-10-10"], 20);
});

test("renderProteinTrendChart: 記録が1件も無ければ空メッセージを出す（例外にしない）", () => {
  const { env, Charts, proteinCanvas, proteinEmpty } = setupCharts("2026-10-15");
  const s = sampleState(env);
  s.proteinEntries = [];
  assert.doesNotThrow(() => Charts.renderProteinTrendChart("chart-protein-trend", s, "30"));
  assert.equal(proteinCanvas.hidden, true);
  assert.equal(proteinEmpty.hidden, false);
});

test("renderProteinTrendChart: 体重グラフ・体組成トレンドと同時に存在しても、互いのinstanceを壊さない", () => {
  const { env, Charts, calls } = setupCharts("2026-10-15");
  const s = sampleState(env);
  s.dailyRecords = [{ date: "2026-10-01", weight: 66.8, comment: "", bodyComposition: { bodyFatMass: 20.5 }, compositionMeta: null }];
  s.proteinEntries = [entry("2026-10-01", 60)];
  Charts.renderWeightChart("chart-weight-home", s, "30");
  Charts.renderCompositionTrendChart("chart-composition-trend", s, "bodyFatMass", "30");
  Charts.renderProteinTrendChart("chart-protein-trend", s, "30");
  assert.ok(Charts._instances["chart-weight-home"]);
  assert.ok(Charts._instances["chart-composition-trend"]);
  assert.ok(Charts._instances["chart-protein-trend"]);
  const ids = new Set([Charts._instances["chart-weight-home"], Charts._instances["chart-composition-trend"], Charts._instances["chart-protein-trend"]]);
  assert.equal(ids.size, 3, "3つとも別instance");
  const before = calls.destroyed || 0;
  Charts.renderProteinTrendChart("chart-protein-trend", s, "7");
  assert.equal((calls.destroyed || 0) - before, 1, "destroyされるのはたんぱく質グラフのinstanceだけ");
});

test("renderProteinTrendChart: ProteinLogicが読み込まれていない環境でも例外にならない", () => {
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
  const s = { proteinEntries: [entry("2026-10-01", 60)], profile: { proteinTarget: 75 } };
  assert.equal(vm.runInContext("typeof ProteinLogic", ctx), "undefined");
  assert.doesNotThrow(() => Charts.renderProteinTrendChart("c", s, "30"));
});
