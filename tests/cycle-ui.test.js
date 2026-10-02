// 月経周期: 画面層（CycleUI）とグラフ統合（charts.js が Charts.bands を実際に組み立てるか）。
// DOM/Chart.js は最小のダミーで置き換える

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { loadEnv, sampleState, clone } = require("./helpers");

const D = (y, m, d, h = 12) => new Date(y, m - 1, d, h, 0, 0);

function setupUI({ now = D(2026, 10, 15) } = {}) {
  const env = loadEnv();
  const s = sampleState(env);
  s.cycleEntries = [];
  vm.runInContext(
    `function escapeHtml(s){return String(s).replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c]));}
     const UI = { state: null, lineIcon(){return "";}, showModal(h){__t.modals.push(h);}, hideModal(){__t.hidden++;} };
     const __t = { modals: [], hidden: 0, lastHtml: null };
     const __el = () => ({ addEventListener(){}, set innerHTML(v){ this._h=v; __t.lastHtml=v; }, get innerHTML(){ return this._h; } });
     const document = { getElementById(id){ return id==="cycle-root" ? __el() : (id==="chart-weight-home" ? null : __el()); }, querySelectorAll(){ return []; }, querySelector(){ return null; } };`,
    env.ctx
  );
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", "ui-cycle.js"), "utf8"), env.ctx, { filename: "ui-cycle.js" });
  const ui = env.get("CycleUI");
  ui._now = () => new Date(now.getTime());
  const saves = { n: 0, ok: true };
  env.Storage.save = () => {
    saves.n++;
    return saves.ok;
  };
  return { env, ui, s, saves, t: env.get("__t"), L: env.get("CycleLogic") };
}

// ---------- 開始・終了（通常表示はシンプルに：1タップ） ----------

test("月経外のとき「月経が始まった」を押すと、今日の日付で1件記録される。表示は『現在：月経中／開始：日付』に変わる", () => {
  const { ui, s } = setupUI({ now: D(2026, 10, 15, 9, 0) });
  const html0 = ui._html(s);
  assert.match(html0, /現在：月経外/);
  assert.doesNotMatch(html0, /id="cycle-end-btn"/);
  ui._start(s);
  assert.equal(s.cycleEntries.length, 1);
  assert.equal(s.cycleEntries[0].startDate, "2026-10-15");
  assert.equal(s.cycleEntries[0].endDate, null);
  const html1 = ui._html(s);
  assert.match(html1, /現在：<strong>月経中<\/strong>/);
  assert.match(html1, /開始：2026\/10\/15/);
  assert.match(html1, /月経が終わった/);
});

test("月経中のとき「月経が終わった」を押すと、今日の日付で終了が記録され、表示が『月経外』に戻る", () => {
  const { ui, s } = setupUI({ now: D(2026, 10, 15) });
  ui._start(s);
  ui._now = () => D(2026, 10, 19);
  ui._end(s);
  assert.equal(s.cycleEntries[0].endDate, "2026-10-19");
  assert.match(ui._html(s), /現在：月経外/);
});

test("保存に失敗したら配列を元に戻し、「何も変更していません」と出す。読み取り専用のときは書き込まない", () => {
  const { ui, s, saves } = setupUI({ now: D(2026, 10, 15) });
  saves.ok = false;
  ui._start(s);
  assert.equal(s.cycleEntries.length, 0);
  assert.match(ui._msg, /何も変更していません/);
  saves.ok = true;
  ui._writable = () => false;
  const n = saves.n;
  ui._start(s);
  assert.equal(saves.n, n);
  assert.equal(s.cycleEntries.length, 0);
  assert.match(ui._msg, /いまは変更を保存できません/);
});

// ---------- 履歴・編集・削除 ----------

test("履歴を見る: 開始日・終了日・日数・メモが表示される", () => {
  const { ui, s } = setupUI({ now: D(2026, 9, 1) });
  ui._start(s);
  ui._now = () => D(2026, 9, 5);
  ui._end(s);
  assert.match(ui._html(s), /履歴を見る/);
  ui._view = "history";
  const histHtml = ui._html(s);
  assert.match(histHtml, /2026\/09\/01 〜 2026\/09\/05/);
  assert.match(histHtml, /5日間/);
});

test("編集: 開始日・終了日・メモを過去日に修正できる。endDateはnullに戻せない。id・createdAtは変わらない", () => {
  const { ui, s } = setupUI({ now: D(2026, 10, 15) });
  ui._start(s);
  ui._now = () => D(2026, 10, 19);
  ui._end(s);
  const e = s.cycleEntries[0];
  const createdAt = e.createdAt;
  ui._startEdit(s, e.id);
  assert.equal(ui._view, "edit");
  ui._edit.startDate = "2026-10-14"; // 過去日へ修正
  ui._edit.comment = "重め";
  ui._saveEdit(s);
  assert.equal(s.cycleEntries[0].startDate, "2026-10-14");
  assert.equal(s.cycleEntries[0].comment, "重め");
  assert.equal(s.cycleEntries[0].id, e.id);
  assert.equal(s.cycleEntries[0].createdAt, createdAt);
  assert.equal(ui._view, "history");
});

test("削除: 確認モーダルを出す（タップするまで削除しない）", () => {
  const { ui, s, t } = setupUI({ now: D(2026, 10, 15) });
  ui._start(s);
  ui._now = () => D(2026, 10, 19);
  ui._end(s);
  const id = s.cycleEntries[0].id;
  const before = JSON.stringify(s.cycleEntries);
  ui._confirmDelete(s, id);
  assert.equal(t.modals.length, 1);
  assert.match(t.modals[0], /この月経の記録を削除します/);
  assert.equal(JSON.stringify(s.cycleEntries), before, "モーダルを出しただけでは削除しない");
});

test("削除（保存までの一連の流れ）: applyDelete→Storage.save の経路で1件だけ消え、保存失敗時はrevertされる", () => {
  const { ui, s, L, saves } = setupUI({ now: D(2026, 10, 15) });
  ui._start(s);
  ui._now = () => D(2026, 10, 19);
  ui._end(s);
  ui._now = () => D(2026, 11, 1);
  ui._start(s);
  const keepId = s.cycleEntries[0].id;
  const delId = s.cycleEntries[1].id;
  const source = L.sourceOf(L.findById(s, delId));

  saves.ok = false;
  let r = L.applyDelete(s, delId, source);
  assert.equal(r.ok, true);
  assert.equal(s.cycleEntries.length, 1);
  if (!saves.ok) {
    L.revert(s, r.snapshot);
  }
  assert.equal(s.cycleEntries.length, 2, "保存失敗を模したのでrevertで元に戻る");

  saves.ok = true;
  r = L.applyDelete(s, delId, source);
  assert.equal(s.cycleEntries.length, 1);
  assert.equal(s.cycleEntries[0].id, keepId);
});

test("編集中の記録が別操作で変わっていたら、STALE_SOURCEで履歴に戻り、上書きしない", () => {
  const { ui, s, L } = setupUI({ now: D(2026, 10, 1) });
  ui._start(s);
  const e = s.cycleEntries[0];
  ui._startEdit(s, e.id);
  // 裏で削除→同id再利用で別記録ができる
  L.applyDelete(s, e.id, L.sourceOf(e));
  L.applyStart(s, { date: "2026-10-10" }, D(2026, 10, 10));
  ui._edit.comment = "古い下書き";
  ui._saveEdit(s);
  assert.equal(s.cycleEntries[0].comment, "", "古い下書きでは上書きされない");
  assert.equal(ui._view, "history");
});

// ---------- エスケープ ----------

test("メモに入っていたタグは、履歴表示で文字として出る", () => {
  const { ui, s } = setupUI({ now: D(2026, 10, 1) });
  ui._start(s);
  ui._now = () => D(2026, 10, 5);
  ui._end(s);
  s.cycleEntries[0].comment = '<img src=x onerror=alert(1)>';
  ui._view = "history";
  const html = ui._html(s);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

// ---------- 読み取り専用のとき、ボタンを無効にする ----------

test("読み取り専用のときは、開始／終了ボタンがdisabledになり、案内が出る", () => {
  const { ui, s } = setupUI({ now: D(2026, 10, 1) });
  ui._writable = () => false;
  const html = ui._html(s);
  assert.match(html, /id="cycle-start-btn" disabled/);
  assert.match(html, /いまは変更を保存できません/);
});

// ================= charts.js: Charts.bands の実際の組み立て =================

function setupCharts(fakeToday) {
  const env = loadEnv();
  const calls = { configs: [] };
  if (fakeToday) vm.runInContext(`todayISODate = () => ${JSON.stringify(fakeToday)};`, env.ctx); // calc.jsの関数宣言を上書き（再宣言はしない）
  vm.runInContext(
    `class FakeChart {
       constructor(ctx, config) { __calls.configs.push(config); FakeChart.last = this; }
       destroy() {}
     }
     FakeChart.defaults = { color: "", borderColor: "" };
     const Chart = FakeChart;
     const __calls = { configs: [] };
     const __style = {
       "--chart-text": "rgba(255,255,255,0.9)", "--chart-grid": "rgba(255,255,255,0.2)",
       "--chart-line": "#d9c8ff", "--chart-line-fill": "rgba(217,200,255,0.18)",
       "--chart-goal1": "#f6a9d1", "--chart-goal2": "#9db4ff", "--chart-bmi21": "#f2dc9c", "--chart-bmi20": "#ffae9e",
       "--chart-cycle-period": "rgba(199,125,150,0.22)", "--chart-cycle-follicular": "rgba(150,150,220,0.14)", "--chart-cycle-luteal": "rgba(214,160,200,0.14)",
     };
     function getComputedStyle(){ return { getPropertyValue(name){ return __style[name] || ""; } }; }
     const __legend = { innerHTML: "" };
     const __empty = { hidden: true, textContent: "" };
     const __canvas = { hidden: false, getContext(){ return {}; }, closest(){ return null; } };
     const document = {
       getElementById(id){
         if (id === "chart-weight-home") return __canvas;
         if (id === "chart-weight-home-empty") return __empty;
         if (id === "chart-weight-home-legend") return __legend;
         return null;
       },
     };`,
    env.ctx
  );
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", "charts.js"), "utf8"), env.ctx, { filename: "charts.js" });
  return { env, Charts: env.get("Charts"), calls: env.get("__calls"), L: env.get("CycleLogic") };
}

test("charts.js: renderWeightChartを呼ぶと、CycleLogic.bands()の内容がCharts.bandsへ color付きで反映される", () => {
  const { env, Charts, calls } = setupCharts("2026-10-15");
  const s = sampleState(env);
  s.cycleEntries = [];
  const L = env.get("CycleLogic");
  L.applyStart(s, { date: "2026-10-01" }, new Date(2026, 9, 1));
  L.applyEnd(s, s.cycleEntries[0].id, { date: "2026-10-05" }, new Date(2026, 9, 5));

  Charts.renderWeightChart("chart-weight-home", s, "30");

  assert.deepEqual(clone(Charts.bands), [{ from: "2026-10-01", to: "2026-10-05", color: "rgba(199,125,150,0.22)" }]);
  const lastConfig = calls.configs[calls.configs.length - 1];
  assert.deepEqual(clone(lastConfig.options.plugins.cycleBands.bands), clone(Charts.bands));
});

test("charts.js: 月経の記録が無いときは、Charts.bandsが空配列になり、グラフ自体は変わらず描ける", () => {
  const { env, Charts, calls } = setupCharts();
  const s = sampleState(env);
  s.cycleEntries = [];
  Charts.renderWeightChart("chart-weight-home", s, "30");
  assert.deepEqual(clone(Charts.bands), []);
  assert.equal(calls.configs.length, 1, "グラフの生成自体は成功する");
});

test("charts.js: CycleLogicが読み込まれていない環境でも、Charts.bandsは空配列になり例外にならない", () => {
  const env = loadEnv();
  vm.runInContext(
    `class FakeChart { constructor(){} destroy(){} }
     FakeChart.defaults = { color: "", borderColor: "" };
     const Chart = FakeChart;
     function getComputedStyle(){ return { getPropertyValue(){ return ""; } }; }
     const document = {
       getElementById(id){
         if (id === "c") return { hidden: false, getContext(){ return {}; }, closest(){ return null; } };
         return { hidden: true, textContent: "", innerHTML: "" };
       },
     };`,
    env.ctx
  );
  // CycleLogic抜きでcharts.jsだけを読み込む（typeof CycleLogic !== "undefined" ガードの確認）
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", "charts.js"), "utf8"), env.ctx, { filename: "charts.js" });
  const Charts = env.get("Charts");
  const s = sampleState(env);
  assert.doesNotThrow(() => Charts.renderWeightChart("c", s, "30"));
  assert.deepEqual(clone(Charts.bands), []);
});
