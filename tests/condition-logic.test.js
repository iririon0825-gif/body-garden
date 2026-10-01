// 体調・副作用: ロジック（追加・編集・削除・並び・検証・既存データの保持・バックアップとの整合・他領域への非干渉）

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadEnv, sampleState, clone, exportText } = require("./helpers");

const NOW = new Date(2026, 9, 15, 12, 0, 0);
const at = (h, m = 0, day = 15) => new Date(2026, 9, day, h, m, 0);

function setup() {
  const env = loadEnv();
  const s = sampleState(env);
  s.conditionEntries = []; // 件数に依存しないよう空から始める
  return { env, L: env.get("ConditionLogic"), s };
}
const add = (L, s, over = {}, now = NOW) => L.applyAdd(s, { date: "2026-10-15", time: "12:00", level: "mild", symptoms: [], comment: "", ...over }, now);
const others = (s) => JSON.stringify({ ...clone(s), conditionEntries: null });

// ---------- 追加 ----------

test("追加: 連番idと createdAt が付き、他の領域（体重・体組成・注射・在庫・Protein・Goal）は1バイトも変わらない", () => {
  const { L, s } = setup();
  const before = others(s);
  const r = add(L, s, { level: "mild", symptoms: ["nausea"], comment: "朝だけ" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.entry.id, 1);
  assert.equal(r.entry.createdAt, NOW.toISOString());
  assert.equal(s.conditionEntries.length, 1);
  assert.equal(others(s), before);
  assert.equal(add(L, s, { level: "none" }).entry.id, 2);
});

test("追加: 未選択・未来日・年の範囲外・時刻の誤り・未知の症状・重複症状・「なし」＋症状・501字・制御文字は保存しない（state不変）", () => {
  const { L, s } = setup();
  const cases = [
    [{ level: null }, "LEVEL_REQUIRED"],
    [{ level: "severe" }, "LEVEL_REQUIRED"],
    [{ date: "2026-10-16" }, "FUTURE_DATE"],
    [{ date: "0202-10-01" }, "INVALID_DATE"],
    [{ date: "2026-02-30" }, "INVALID_DATE"],
    [{ time: "25:00" }, "INVALID_TIME"],
    [{ symptoms: ["headache"] }, "INVALID_SYMPTOMS"],
    [{ symptoms: ["nausea", "nausea"] }, "INVALID_SYMPTOMS"],
    [{ level: "none", symptoms: ["nausea"] }, "NONE_WITH_SYMPTOMS"],
    [{ comment: "あ".repeat(501) }, "INVALID_COMMENT"],
    [{ comment: "a\u0000b" }, "INVALID_COMMENT"],
  ];
  for (const [over, code] of cases) {
    const before = JSON.stringify(s);
    const r = add(L, s, over);
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.equal(r.code, code, JSON.stringify(over));
    assert.equal(JSON.stringify(s), before, "失敗したときは state を変えない");
  }
});

test("追加: メモのタブは空白に、改行は保持。500字ちょうどは通る", () => {
  const { L, s } = setup();
  const r = add(L, s, { comment: "a\tb\r\nc" });
  assert.equal(r.entry.comment, "a b\nc");
  assert.equal(add(L, s, { comment: "あ".repeat(500) }).ok, true);
});

test("追加: 受け入れた state は、必ず Backup.validateState を通る（書き出し・復元で壊れない）", () => {
  const { env, L, s } = setup();
  add(L, s, { level: "moderate", symptoms: ["nausea", "other"], comment: "メモ\n2行目" });
  add(L, s, { date: "2000-01-01", time: "", level: "none" });
  const v = env.Backup.validateState(clone(s));
  assert.deepEqual(clone(v.errors), []);
  const r = env.Backup.parse(exportText(env, s), null);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(clone(r.state.conditionEntries), clone(s.conditionEntries));
});

// ---------- 1日に複数件・最新・並び ----------

test("朝「軽い」と夜「なし」は、どちらも残る。最新は最後に入力した記録。履歴の並びも同じ基準（入力順）", () => {
  const { L, s } = setup();
  assert.equal(add(L, s, { time: "07:30", level: "mild" }, at(7, 30)).ok, true);
  assert.equal(add(L, s, { time: "21:10", level: "none" }, at(21, 10)).ok, true);
  const list = L.entriesForDate(s, "2026-10-15");
  assert.deepEqual(clone(list.map((e) => e.level)), ["mild", "none"]);
  assert.equal(L.latestForDate(s, "2026-10-15").level, "none");
  // 夜に入れたあと、朝の分（08:00）を後から足すと、最後に入力した朝の記録が「最新」になる。履歴も同じ並び
  assert.equal(add(L, s, { time: "08:00", level: "mild", comment: "あとから" }, at(22, 0)).ok, true);
  assert.equal(L.latestForDate(s, "2026-10-15").comment, "あとから");
  const g = L.historyGroups(s, 30).groups[0];
  assert.equal(g.entries[g.entries.length - 1].comment, "あとから");
});

test("並び: 入力順は id。createdAt が欠けている・別形式（+09:00）・同時刻でも落ちない。端末の時計を戻して入れた記録も、入力順どおり最後になる", () => {
  const { L, s } = setup();
  s.conditionEntries = [
    { id: 3, date: "2026-10-15", time: null, level: "mild", symptoms: [], comment: "c" },
    { id: 1, date: "2026-10-15", time: null, level: "none", symptoms: [], comment: "a", createdAt: "2026-10-15T09:00:00+09:00" },
    { id: 2, date: "2026-10-15", time: null, level: "mild", symptoms: [], comment: "b", createdAt: "2026-10-15T09:00:00+09:00" },
  ];
  assert.deepEqual(clone(L.entriesForDate(s, "2026-10-15").map((e) => e.comment)), ["a", "b", "c"]);
  assert.equal(L.latestForDate(s, "2026-10-15").id, 3);
  // 時計が2時間進んだ状態で朝の記録Aを入れ、時計を直してから記録Bを入れる → Bが最新（createdAt が古くても）
  const t = setup();
  assert.equal(t.L.applyAdd(t.s, { date: "2026-10-15", time: null, level: "mild", symptoms: [], comment: "A" }, new Date(2026, 9, 15, 14, 0)).ok, true);
  assert.equal(t.L.applyAdd(t.s, { date: "2026-10-15", time: null, level: "none", symptoms: [], comment: "B" }, new Date(2026, 9, 15, 12, 0)).ok, true);
  assert.equal(t.L.latestForDate(t.s, "2026-10-15").comment, "B");
  assert.deepEqual(clone(t.L.historyGroups(t.s, 30).groups[0].entries.map((e) => e.comment)), ["A", "B"]);
});

test("メモ: ZWJ を含む絵文字（🙇‍♀️ など）は保存できる。見えない制御文字（ZWSP・LRM・双方向制御・BOM）は拒否", () => {
  const { L, s } = setup();
  assert.equal(add(L, s, { comment: "🙇\u200d♀️ 🤷\u200d♀️ 👨\u200d👩\u200d👧" }).ok, true);
  for (const bad of ["a\u200bb", "a\u200eb", "a\u202eb", "a\u2066b", "\ufeffa"]) {
    assert.equal(add(L, s, { comment: bad }).code, "INVALID_COMMENT", JSON.stringify(bad));
  }
});

test("既存の未知の症状（headache など）は、残したまま別の症状を足せる・外せる。新しく未知のIDを足すことはできない", () => {
  const { L, s } = setup();
  s.conditionEntries = [{ id: 1, date: "2026-10-14", time: null, level: "mild", symptoms: ["headache"], comment: "", createdAt: "2026-10-14T00:00:00.000Z" }];
  const src = L.sourceOf(s.conditionEntries[0]);
  const r = L.applyEdit(s, 1, { symptoms: ["nausea", "headache"] }, src, NOW);
  assert.equal(r.ok, true, JSON.stringify(r));
  const r2 = L.applyEdit(s, 1, { symptoms: ["nausea"] }, L.sourceOf(r.entry), NOW);
  assert.equal(r2.ok, true);
  assert.equal(L.applyEdit(s, 1, { symptoms: ["nausea", "unknown2"] }, L.sourceOf(r2.entry), NOW).code, "INVALID_SYMPTOMS");
});

test("履歴: 日付の新しい順。dates日分で切り、続きがあるかと、ある日付の位置を返す", () => {
  const { L, s } = setup();
  for (let d = 1; d <= 5; d++) add(L, s, { date: `2026-10-0${d}` });
  const h = L.historyGroups(s, 3);
  assert.deepEqual(clone(h.groups.map((g) => g.date)), ["2026-10-05", "2026-10-04", "2026-10-03"]);
  assert.equal(h.hasMore, true);
  assert.equal(h.indexOfDate("2026-10-01"), 4);
  assert.equal(L.historyGroups(s, 30).hasMore, false);
});

// ---------- 編集 ----------

test("編集: 変えた項目だけ更新し、id・createdAt・触れていない項目は保つ。変更なしは保存しない", () => {
  const { L, s } = setup();
  const e = add(L, s, { level: "mild", symptoms: ["nausea"], comment: "x", time: "07:00" }).entry;
  const src = L.sourceOf(e);
  const r = L.applyEdit(s, e.id, { level: "none", comment: "y" }, src, NOW);
  // none + 症状は、症状を外さない限り不可
  assert.equal(r.ok, false);
  assert.equal(r.code, "NONE_WITH_SYMPTOMS");
  const r2 = L.applyEdit(s, e.id, { level: "moderate", comment: "y" }, src, NOW);
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(r2.entry.id, e.id);
  assert.equal(r2.entry.createdAt, e.createdAt);
  assert.deepEqual(clone(r2.entry.symptoms), ["nausea"]);
  assert.equal(r2.entry.time, "07:00");
  const none = L.applyEdit(s, e.id, { level: "moderate", comment: "y" }, L.sourceOf(r2.entry), NOW);
  assert.equal(none.code, "NO_CHANGE");
});

test("severe は削除せず、表示は「あり」。「あり」を押し直しても severe のまま。別の段階へ変えたときだけ変わる", () => {
  const { L, s } = setup();
  s.conditionEntries = [{ id: 1, date: "2026-10-14", time: "20:00", level: "severe", symptoms: ["nausea"], comment: "強め", createdAt: "2026-10-14T11:00:00.000Z" }];
  assert.equal(L.levelLabel("severe"), "あり");
  assert.equal(L.displayLevel("severe"), "moderate");
  const src = L.sourceOf(s.conditionEntries[0]);
  assert.equal(L.applyEdit(s, 1, { level: "moderate" }, src, NOW).code, "NO_CHANGE");
  const r = L.applyEdit(s, 1, { level: "moderate", comment: "強め→少し" }, src, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.entry.level, "severe", "メモだけ変えても、元の保存値は moderate に変わらない");
  const r2 = L.applyEdit(s, 1, { level: "mild" }, L.sourceOf(r.entry), NOW);
  assert.equal(r2.entry.level, "mild");
});

test("既存データの編集: 501字以上のメモ・未知の症状・未来日・level なし の記録も、触っていない項目のせいで編集できなくならない（切り捨てもしない）", () => {
  const { L, s } = setup();
  const long = "あ".repeat(800);
  s.conditionEntries = [
    { id: 1, date: "2026-12-01", time: null, level: null, symptoms: ["headache"], comment: long, createdAt: "2026-10-01T00:00:00.000Z" },
  ];
  const src = L.sourceOf(s.conditionEntries[0]);
  const r = L.applyEdit(s, 1, { level: "mild" }, src, NOW);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.entry.comment, long, "メモは切り捨てない");
  assert.deepEqual(clone(r.entry.symptoms), ["headache"]);
  assert.equal(r.entry.date, "2026-12-01");
  // 日付を変えるときは未来日を拒否
  assert.equal(L.applyEdit(s, 1, { date: "2026-12-02" }, L.sourceOf(r.entry), NOW).code, "FUTURE_DATE");
  // 触れたメモには上限を掛ける
  assert.equal(L.applyEdit(s, 1, { comment: "x".repeat(501) }, L.sourceOf(r.entry), NOW).code, "INVALID_COMMENT");
});

test("既存の「なし＋症状」の記録は、症状も段階も触らなければ、メモだけ直せる", () => {
  const { L, s } = setup();
  s.conditionEntries = [{ id: 1, date: "2026-10-14", time: null, level: "none", symptoms: ["nausea"], comment: "", createdAt: "2026-10-14T00:00:00.000Z" }];
  const r = L.applyEdit(s, 1, { comment: "メモ" }, L.sourceOf(s.conditionEntries[0]), NOW);
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("編集・削除は、下書きが指す記録の写しと照合する。idが再利用されても、別の記録を上書き・削除しない", () => {
  const { L, s } = setup();
  const a = add(L, s, { comment: "古い" }, at(8)).entry;
  const oldSource = L.sourceOf(a);
  // 古い記録を削除 → 最大idなので、次の追加で同じ id が再利用される
  assert.equal(L.applyDelete(s, a.id, oldSource).ok, true);
  const b = add(L, s, { comment: "新しい", level: "none" }, at(21)).entry;
  assert.equal(b.id, a.id, "id は再利用される");
  const before = JSON.stringify(s);
  assert.equal(L.applyEdit(s, a.id, { level: "moderate" }, oldSource, NOW).code, "STALE_SOURCE");
  assert.equal(L.applyDelete(s, a.id, oldSource).code, "STALE_SOURCE");
  assert.equal(JSON.stringify(s), before);
  assert.equal(L.applyEdit(s, 999, { level: "mild" }, oldSource, NOW).code, "NOT_FOUND");
});

// ---------- 削除・巻き戻し ----------

test("削除: その1件だけが消え、ほかの領域は変わらない。revert で元に戻る", () => {
  const { L, s } = setup();
  add(L, s, { comment: "1" }, at(8));
  const e2 = add(L, s, { comment: "2" }, at(9)).entry;
  const before = JSON.stringify(s);
  const r = L.applyDelete(s, e2.id, L.sourceOf(e2));
  assert.equal(r.ok, true);
  assert.deepEqual(clone(s.conditionEntries.map((e) => e.comment)), ["1"]);
  L.revert(s, r.snapshot);
  assert.equal(JSON.stringify(s), before);
});

test("追加・編集の revert でも、元の配列に戻る", () => {
  const { L, s } = setup();
  const e = add(L, s, { comment: "a" }, at(8)).entry;
  const before = JSON.stringify(s);
  const r = add(L, s, { comment: "b" }, at(9));
  L.revert(s, r.snapshot);
  assert.equal(JSON.stringify(s), before);
  const r2 = L.applyEdit(s, e.id, { comment: "c" }, L.sourceOf(e), NOW);
  L.revert(s, r2.snapshot);
  assert.equal(JSON.stringify(s), before);
});

test("HOMEで直してよいメモ: 改行なし・500字以内のものだけ", () => {
  const { L } = setup();
  assert.equal(L.memoEditableOnHome({ comment: "ふつう" }), true);
  assert.equal(L.memoEditableOnHome({ comment: "1行目\n2行目" }), false);
  assert.equal(L.memoEditableOnHome({ comment: "あ".repeat(501) }), false);
  assert.equal(L.memoEditableOnHome({}), true);
});

test("バックアップ往復: severe・複数件・症状・改行メモが、そのまま書き出し→読み込みできる", () => {
  const { env, L, s } = setup();
  s.conditionEntries = [{ id: 1, date: "2026-10-14", time: "20:00", level: "severe", symptoms: ["nausea"], comment: "a\nb", createdAt: "2026-10-14T11:00:00.000Z" }];
  add(L, s, { level: "none", comment: "夜" }, at(21));
  const r = env.Backup.parse(exportText(env, s), null);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(clone(r.state.conditionEntries), clone(s.conditionEntries));
});
