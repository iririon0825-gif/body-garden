// 週刊ハイライト: 前週比の主役表示の条件（画面の文字列だけを確かめる。DOM・保存領域には触れない）

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { loadEnv } = require("./helpers");

const env = loadEnv();
vm.runInContext(`const UI = { lineIcon() { return ""; } };`, env.ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", "ui-highlight.js"), "utf8"), env.ctx, { filename: "ui-highlight.js" });
const UIH = env.get("HighlightUI");
const H = env.get("HighlightLogic");

const TODAY = "2026-10-29"; // 木曜。今週は 10/26〜11/1、前の週は 10/19〜10/25
function state(rows) {
  const s = env.get("createDefaultState()");
  s.profile.startDate = "2026-09-01";
  s.dailyRecords = rows.map(([d, w]) => {
    const r = env.get("createEmptyDailyRecord")(d);
    r.weight = w;
    return r;
  });
  return s;
}
function weekHero(rows) {
  UIH._period = H.periodContaining("week", TODAY);
  const html = UIH._viewHtml(state(rows), TODAY);
  const m = html.match(/<section class="card hl-hero-card">[\s\S]*?<\/section>/);
  assert.ok(m, "前週比のカードがある");
  return m[0];
}
const PREV = [["2026-10-19", 66.5], ["2026-10-20", 66.4], ["2026-10-21", 66.5]]; // 前の週：3日
const THIS = (n) => [["2026-10-26", 65.6], ["2026-10-27", 65.5], ["2026-10-28", 65.4]].slice(0, n);
const NOTE = "記録が少ないため傾向判断は参考程度です";

test("週刊 前週比: 今週0日 → 前週比なし（データなし）。強調なし・注記なし", () => {
  const h = weekHero(PREV);
  assert.ok(!h.includes("hl-hero\""), "主役の強調なし");
  assert.ok(!h.includes(" kg</p>"), "前週比の数値なし");
  assert.ok(h.includes("データなし"));
  assert.ok(!h.includes(NOTE));
});

test("週刊 前週比: 今週1日・2日 → 数値は出すが主役の強調はしない。「参考程度」の注記あり", () => {
  for (const n of [1, 2]) {
    const h = weekHero([...PREV, ...THIS(n)]);
    assert.ok(!h.includes("hl-hero\""), `${n}日: 主役の強調なし`);
    assert.ok(!h.includes("hl-hero-value"), `${n}日: 2.1rem の表示なし`);
    assert.ok(/<p class="hl-big">-\d\.\d\d kg<\/p>/.test(h), `${n}日: 数値は通常表示で出る`);
    assert.ok(h.includes(NOTE), `${n}日: 参考程度の注記`);
  }
});

test("週刊 前週比: 今週3日以上 → 主役の強調。前の週が少ないときは注記を残す", () => {
  const h = weekHero([...PREV, ...THIS(3)]);
  assert.ok(h.includes("hl-hero\"") && h.includes("hl-hero-value"));
  assert.ok(!h.includes(NOTE));
  const prevLow = weekHero([["2026-10-20", 66.4], ...THIS(3)]); // 前の週は1日だけ
  assert.ok(prevLow.includes("hl-hero-value"), "今週が3日以上なら主役");
  assert.ok(prevLow.includes(NOTE), "前の週が少ないので参考程度の注記");
});

test("週刊 前週比: 前の週の記録がないとき → 「前の週の記録なし」。強調なし", () => {
  const h = weekHero(THIS(3));
  assert.ok(h.includes("前の週の記録なし"));
  assert.ok(!h.includes("hl-hero\""));
});
