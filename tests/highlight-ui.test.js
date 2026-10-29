// 週刊ハイライト: 今週の変化（週内の最初→最後）の主役表示の条件（画面の文字列だけを確かめる。DOM・保存領域には触れない）

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
  assert.ok(m, "今週の変化のカードがある");
  return m[0];
}
const PREV = [["2026-10-19", 66.5], ["2026-10-20", 66.4], ["2026-10-21", 66.5]]; // 前の週：3日（平均 66.47）
const THIS = (n) => [["2026-10-26", 65.6], ["2026-10-27", 65.5], ["2026-10-28", 65.4]].slice(0, n); // 週内で減少
const NOTE = "記録が少ないため傾向判断は参考程度です";
const strong = (h) => h.includes('class="hl-hero"') && h.includes("hl-hero-value"); // 2.1rem＋紫の縦線
const soft = (h) => h.includes("hl-hero-soft");

test("週刊 主役: 今週0日 → 変化なし（データなし）。強調なし・注記なし", () => {
  const h = weekHero(PREV);
  assert.ok(!strong(h) && !soft(h) && !h.includes("hl-hero-value"));
  assert.ok(h.includes("データなし"));
  assert.ok(!h.includes(NOTE));
});

test("週刊 主役: 今週1日 → 変化量は出さず、その日の実測値だけ。強調なし。「参考程度」の注記あり", () => {
  const h = weekHero([...PREV, ...THIS(1)]);
  assert.ok(!strong(h) && !soft(h) && !h.includes("hl-hero-value"));
  assert.ok(/<p class="hl-big">65\.60 kg<\/p>/.test(h));
  assert.ok(h.includes("変化は出していません"));
  assert.ok(!/[+\-−]\d\.\d\d kg/.test(h), "変化量の数値は出さない");
  assert.ok(h.includes(NOTE));
});

test("週刊 主役: 今週2日 → 最初→最後の変化量は出すが、強調は一段弱める。「参考程度」の注記あり", () => {
  const h = weekHero([...PREV, ...THIS(2)]);
  assert.ok(soft(h) && h.includes("hl-hero-value") && !strong(h));
  assert.ok(h.includes("-0.10 kg"), h);
  assert.ok(h.includes("最初の実測") && h.includes("65.60 kg") && h.includes("最後の実測") && h.includes("65.50 kg"));
  assert.ok(h.includes(NOTE));
});

test("週刊 主役: 今週3日以上 → 最初→最後の変化量を主役で強調。注記なし。前の週の記録は主役に関係しない", () => {
  const h = weekHero([...PREV, ...THIS(3)]);
  assert.ok(strong(h) && !soft(h));
  assert.ok(h.includes("-0.20 kg"), h);
  assert.ok(!h.includes(NOTE));
  assert.ok(!h.includes("週平均") && !h.includes("前の週"));
  const noPrev = weekHero(THIS(3)); // 前の週の記録がなくても主役は同じ
  assert.ok(strong(noPrev) && noPrev.includes("-0.20 kg"));
});

test("週刊: 前の週の平均との差と、週内の変化の向きが逆でも、主役・発見・肯定文は週内の最初→最後。平均差は詳細カードの参考値", () => {
  // 前の週の平均 67.47（高い）→ 今週の平均 65.5 は大きく下がっているが、週の中では 65.4→65.6 と上がっている
  const rows = [["2026-10-19", 67.5], ["2026-10-20", 67.4], ["2026-10-21", 67.5], ["2026-10-26", 65.4], ["2026-10-27", 65.5], ["2026-10-28", 65.6]];
  UIH._period = H.periodContaining("week", TODAY);
  const st = state(rows);
  const html = UIH._viewHtml(st, TODAY);
  const hero = html.match(/<section class="card hl-hero-card">[\s\S]*?<\/section>/)[0];
  const disc = html.match(/<section class="card hl-discovery-card">[\s\S]*?<\/section>/)[0];
  assert.ok(hero.includes("+0.20 kg"), "主役は週内の最初→最後（+0.20）");
  assert.ok(!hero.includes("-1.9"), "週平均の差（約−1.97）は主役に出ない");
  assert.ok(disc.includes("65.40kgから65.60kgまで変化しました"), "発見文も週内の最初→最後");
  const s = H.summarize(st, UIH._period, TODAY);
  assert.ok(s.weight.diff < -1.9, "平均差の計算は残っている（削除していない）");
  assert.ok(!["少しずつ積み重ねた変化が、数字にも表れています。", "今週の記録には、ここまで続けてきた変化が見えています。"].includes(s.affirmation), "肯定文は週内の最初→最後（上がっている）を根拠にし、「減った」系を出さない");
  const det = html.slice(html.indexOf("体重の詳細"));
  assert.ok(det.includes("前の週の平均との差（参考）") && det.includes("-1.97 kg"), "平均差は詳細カードに（参考）として残る");
  assert.ok(!hero.includes("参考）"), "平均差を「今週の変化」と呼ばない");
});
