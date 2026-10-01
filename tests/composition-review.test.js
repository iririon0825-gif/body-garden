// 体組成: レビュー指摘の再現テスト（解析の取りこぼし・mixed/時刻・画面層の保存手順）

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { loadEnv, sampleState, clone } = require("./helpers");

const NOW = new Date(2026, 9, 15, 12, 0);

function setup() {
  const env = loadEnv();
  return { env, B: env.get("BodyCompositionLogic"), s: sampleState(env) };
}
const sampleWith = (B, edits) => {
  let t = B.sampleText();
  for (const [a, b] of edits) t = t.replace(a, b);
  return t;
};
function save(B, s, text, over = {}) {
  const parsed = B.parse(text, NOW);
  const date = over.date || parsed.date;
  const a = B.assess(s, parsed, date, NOW);
  const r = B.applyImport(s, parsed, { date, time: parsed.time, overwrite: {}, weight: "keep", acknowledged: true, basis: a.basis, ...over.decisions }, NOW);
  return { r, parsed, a };
}

// ---------- M4: mixed と測定時刻 ----------

test("M4: 07:12 の16項目に、21:00 の別の測定を全項目「上書き」で重ねても、読めなかった項目が残るなら mixed になり、時刻は 21:00 にならない", () => {
  const { B, s } = setup();
  assert.equal(save(B, s, B.sampleText(), { date: "2026-10-02" }).r.ok, true);
  const later = "【Body Garden 体組成 v1】\n測定日: 2026-10-02\n測定時刻: 21:00\n体重: 66.20 kg\n体脂肪率: 30.5 %\n【ここまで】";
  const { r } = save(B, s, later, { date: "2026-10-02", decisions: { overwrite: { measuredWeight: true, bodyFatPct: true } } });
  assert.equal(r.ok, true, JSON.stringify(r));
  const rec = s.dailyRecords.find((x) => x.date === "2026-10-02");
  assert.equal(rec.compositionMeta.mixed, true);
  assert.equal(rec.compositionMeta.measuredTime, "07:12", "残った14項目は 07:12 の値。21:00 の測定として表示しない");
});

test("M4: 同じ測定の値を2回に分けて足すだけ（時刻が同じ・違う値なし）なら mixed にしない", () => {
  const { B, s } = setup();
  const part1 = "【Body Garden 体組成 v1】\n測定日: 2026-10-02\n測定時刻: 07:12\n体重: 66.80 kg\n体脂肪率: 31.2 %\n【ここまで】";
  const part2 = "【Body Garden 体組成 v1】\n測定日: 2026-10-02\n測定時刻: 07:12\n筋肉量: 43.70 kg\n【ここまで】";
  assert.equal(save(B, s, part1, { date: "2026-10-02" }).r.ok, true);
  assert.equal(save(B, s, part2, { date: "2026-10-02" }).r.ok, true);
  const rec = s.dailyRecords.find((x) => x.date === "2026-10-02");
  assert.equal(rec.compositionMeta.mixed, false);
  assert.equal(rec.compositionMeta.measuredTime, "07:12");
});

test("M4: 時刻なしの項目を足しても、以前の測定時刻を消さない", () => {
  const { B, s } = setup();
  const part1 = "【Body Garden 体組成 v1】\n測定日: 2026-10-02\n測定時刻: 07:12\n体重: 66.80 kg\n【ここまで】";
  const part2 = "【Body Garden 体組成 v1】\n測定日: 2026-10-02\n心拍数: 68 bpm\n【ここまで】";
  save(B, s, part1, { date: "2026-10-02" });
  save(B, s, part2, { date: "2026-10-02" });
  assert.equal(s.dailyRecords.find((x) => x.date === "2026-10-02").compositionMeta.measuredTime, "07:12");
});

test("M4: 今回と違う値を既存のまま残したときは、従来どおり mixed", () => {
  const { B, s } = setup();
  save(B, s, B.sampleText(), { date: "2026-10-02" });
  const { r } = save(B, s, sampleWith(B, [["筋肉量: 43.70 kg", "筋肉量: 44.50 kg"], ["体脂肪率: 31.2 %", "体脂肪率: 30.0 %"]]), { date: "2026-10-02", decisions: { overwrite: { bodyFatPct: true } } });
  assert.equal(r.ok, true);
  assert.equal(s.dailyRecords.find((x) => x.date === "2026-10-02").compositionMeta.mixed, true);
});

// ---------- L2〜L5 解析 ----------

test("L2: 測定日の2行目が読めない形なら警告を出す。測定時刻が2回違う値で出たら、最初を採用して警告を出す", () => {
  const { B } = setup();
  const p = B.parse(sampleWith(B, [["測定日: 2026-10-01", "測定日: 2026-10-01\n測定日: 昨日"]]), NOW);
  assert.equal(p.ok, true);
  assert.equal(p.date, "2026-10-01");
  assert.ok(p.warnings.some((w) => w.code === "DATE_LINE_IGNORED"));
  const q = B.parse(sampleWith(B, [["測定時刻: 07:12", "測定時刻: 07:12\n測定時刻: 21:00"]]), NOW);
  assert.equal(q.time, "07:12");
  assert.ok(q.warnings.some((w) => w.code === "TIME_LINE_IGNORED"));
  const same = B.parse(sampleWith(B, [["測定時刻: 07:12", "測定時刻: 07:12\n測定時刻: 07:12"]]), NOW);
  assert.ok(!same.warnings.some((w) => w.code === "TIME_LINE_IGNORED"), "同じ値なら警告しない");
});

test("L3: 測定時刻が読めない形（7時12分）なら警告が出て、確認チェックが必要になる", () => {
  const { B, s } = setup();
  const p = B.parse(sampleWith(B, [["測定時刻: 07:12", "測定時刻: 7時12分"]]), NOW);
  assert.equal(p.timeStatus, "invalid");
  assert.ok(p.warnings.some((w) => w.code === "TIME_INVALID"));
  assert.equal(B.assess(s, p, "2026-10-02", NOW).needsAck, true);
});

test("L4: 項目名の末尾の（%）（kg）は無視して照合する。案内どおり「体脂肪率（%）」と書いても読める", () => {
  const { B } = setup();
  const p = B.parse(sampleWith(B, [["体脂肪率: 31.2 %", "体脂肪率（%）: 31.2 %"], ["筋肉量: 43.70 kg", "筋肉量(kg): 43.70 kg"]]), NOW);
  const get = (k) => p.items.find((i) => i.key === k);
  assert.equal(get("bodyFatPct").value, 31.2);
  assert.equal(get("muscleMass").value, 43.7);
  assert.equal(p.unrecognizedLines.length, 0);
});

test("L5: 長い備考が1行あっても、テキスト全体は拒否されない（備考は200字で切る）。ほかの行が長いときは従来どおり拒否", () => {
  const { B } = setup();
  const p = B.parse(sampleWith(B, [["【ここまで】", `備考: ${"あ".repeat(300)}\n【ここまで】`]]), NOW);
  assert.equal(p.ok, true);
  assert.equal(p.notes[0].length, 200);
  const q = B.parse(sampleWith(B, [["【ここまで】", `メモ: ${"あ".repeat(300)}\n【ここまで】`]]), NOW);
  assert.equal(q.ok, false);
  assert.equal(q.errors[0].code, "LINE_TOO_LONG");
});

// ---------- L6 bodyComposition が無い記録 ----------

test("L6: bodyComposition の無い記録があっても、履歴は16キーにそろえて返す（画面が落ちない）", () => {
  const { B, s } = setup();
  s.dailyRecords.push({ date: "2026-10-03", weight: 66, comment: "", compositionMeta: { measuredTime: null, source: "paste", formatVersion: 1, importedAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z", mixed: false } });
  const rows = B.historyRows(s, 20);
  const row = rows.find((r) => r.date === "2026-10-03");
  assert.ok(row);
  assert.equal(Object.keys(row.bodyComposition).length, 16);
});

// ---------- 画面層（CompositionUI）。DOM は最小のダミーで置き換える ----------

function loadUi(env) {
  const calls = { modals: [], hidden: 0, enqueued: [], afterWeightSave: 0 };
  vm.runInContext(
    `function escapeHtml(s){return String(s).replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c]));}
     const __calls = { modals: [], hidden: 0, enqueued: [] };
     const UI = { lineIcon(){return "";}, showModal(h){__calls.modals.push(h);}, hideModal(){__calls.hidden++;}, enqueueGuardrailModals(m,r){__calls.enqueued.push(m);} };
     const __el = () => ({ addEventListener(){}, remove(){}, insertAdjacentHTML(){}, set innerHTML(v){ this._h = v; }, get innerHTML(){ return this._h; }, value: "", checked: false });
     const document = { getElementById(){ return __el(); }, querySelector(){ return null; }, querySelectorAll(){ return []; } };`,
    env.ctx
  );
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", "ui-composition.js"), "utf8"), env.ctx, { filename: "ui-composition.js" });
  const ui = env.get("CompositionUI");
  ui._now = () => new Date(NOW.getTime());
  const logic = env.get("Logic");
  const orig = logic.afterWeightSave.bind(logic);
  logic.afterWeightSave = (...a) => {
    calls.afterWeightSave++;
    return orig(...a);
  };
  return { ui, calls, modals: () => env.get("__calls") };
}

function stage(ui, B, s, text, edit) {
  ui._draft = ui._fresh();
  const d = ui._d();
  d.text = text;
  d.parsed = B.parse(text, NOW);
  d.date = d.parsed.date || "";
  d.time = d.parsed.time || "";
  ui._resetChoices(s);
  d.ack = true;
  if (edit) edit(d);
  return d;
}

test("画面: プレビューのHTMLは、貼り付けの文字列（未認識の行・備考・ボディタイプ・単位）をエスケープする", () => {
  const { env, B, s } = setup();
  const { ui } = loadUi(env);
  const evil = '<img src=x onerror=alert(1)>';
  const text = `【Body Garden 体組成 v1】\n測定日: 2026-10-02\n体重: 66.8 ${evil}\n${evil}: 5\n備考: ${evil}\nボディタイプ: ${evil}\n【ここまで】`;
  const d = stage(ui, B, s, text);
  const html = ui._pageHtml(s);
  assert.ok(d.parsed.ok);
  assert.doesNotMatch(html, /<img/, "タグとして出力されない");
  assert.match(html, /&lt;img/);
});

test("画面: 保存は、プレビューを出した時点の状態（basis）で照合する。確認のあとに別の操作で体重が入ったら、保存せず並べ直す（M2/M3）", () => {
  const { env, B, s } = setup();
  const { ui, calls } = loadUi(env);
  const d = stage(ui, B, s, B.sampleText(), (x) => {
    x.date = "2026-10-02";
    ui._resetChoices(s);
    x.ack = true;
  });
  assert.equal(d.weight, "set", "体重の無い日は、体重を登録する選択が既定");
  // プレビューのあとに、記録タブ相当の操作で同じ日の体重が入る
  env.Storage.upsertRecord(s, { ...env.Storage.getRecordForDate(s, "2026-10-02"), weight: 66.5 });
  const before = JSON.stringify(s.dailyRecords);
  ui._save(s);
  assert.equal(JSON.stringify(s.dailyRecords), before, "何も変更されない");
  assert.equal(calls.afterWeightSave, 0, "afterWeightSave も呼ばれない");
  assert.equal(ui._draft.weight, "keep", "並べ直しで、体重の選択は既存あり用の既定（残す）に戻る");
  const rec = s.dailyRecords.find((r) => r.date === "2026-10-02");
  assert.equal(rec.weight, 66.5);
  assert.equal(rec.bodyComposition.bmi, null);
});

test("画面: 体重が変わるときだけ afterWeightSave を呼ぶ。保存に失敗したら、記録も goals も元に戻る", () => {
  const { env, B, s } = setup();
  const { ui, calls } = loadUi(env);
  // 体重を「残す」→ afterWeightSave なし
  s.dailyRecords.push({ date: "2026-10-02", weight: 66.5, bodyComposition: undefined, compositionMeta: null, comment: "" });
  stage(ui, B, s, B.sampleText(), (x) => {
    x.date = "2026-10-02";
    ui._resetChoices(s);
    x.ack = true;
  });
  env.Storage.save = () => true;
  ui._save(s);
  assert.equal(calls.afterWeightSave, 0);
  assert.equal(s.dailyRecords.find((r) => r.date === "2026-10-02").weight, 66.5);
  assert.equal(s.dailyRecords.find((r) => r.date === "2026-10-02").bodyComposition.bmi, 25.5);

  // 体重を「更新する」→ afterWeightSave あり。保存失敗で全部戻る
  const s2 = sampleState(env);
  s2.dailyRecords.push({ date: "2026-10-03", weight: 66.5, bodyComposition: undefined, compositionMeta: null, comment: "" });
  stage(ui, B, s2, B.sampleText(), (x) => {
    x.date = "2026-10-03";
    ui._resetChoices(s2);
    x.weight = "set";
    x.ack = true;
  });
  const snap = JSON.stringify({ r: s2.dailyRecords, g: s2.goals });
  env.Storage.save = () => false;
  ui._save(s2);
  assert.equal(calls.afterWeightSave, 1);
  assert.equal(JSON.stringify({ r: s2.dailyRecords, g: s2.goals }), snap, "保存失敗: 記録も goals も元どおり");
});

test("画面: 上書きにチェックしたまま、その日の体組成を削除しても、保存できなくならない（L1）", () => {
  const { env, B, s } = setup();
  const { ui } = loadUi(env);
  assert.equal(save(B, s, B.sampleText(), { date: "2026-10-02" }).r.ok, true);
  const text = sampleWith(B, [["体脂肪率: 31.2 %", "体脂肪率: 30.0 %"]]);
  const d = stage(ui, B, s, text, (x) => {
    x.date = "2026-10-02";
    ui._resetChoices(s);
    x.overwrite = { bodyFatPct: true };
    x.ack = true;
  });
  assert.equal(B.applyDeleteComposition(s, "2026-10-02").ok, true);
  ui._pageHtml(s); // 描画のたびに、いま上書きできない項目の選択は外れる
  assert.deepEqual(clone(d.overwrite), {});
});
