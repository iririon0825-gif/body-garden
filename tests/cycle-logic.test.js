// 月経周期: ロジック（開始・終了・編集・削除・重複防止・検証・v6→v7移行・バックアップ・CSV・帯の計算）

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadEnv, sampleState, clone, exportText } = require("./helpers");

const NOW = new Date(2026, 9, 15, 12, 0, 0);
const D = (y, m, d, h = 12) => new Date(y, m - 1, d, h, 0, 0);

function setup() {
  const env = loadEnv();
  const L = env.get("CycleLogic");
  const s = sampleState(env);
  s.cycleEntries = [];
  return { env, L, s };
}

// ---------- 開始 ----------

test("開始: 今日の日付で記録でき、連番idが付く。他の領域（体重・体組成・注射・在庫・Protein・体調・Goal）は変わらない", () => {
  const { L, s } = setup();
  const before = JSON.stringify({ ...clone(s), cycleEntries: null });
  const r = L.applyStart(s, { date: "2026-10-15" }, NOW);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.entry.id, 1);
  assert.equal(r.entry.startDate, "2026-10-15");
  assert.equal(r.entry.endDate, null);
  assert.equal(r.entry.createdAt, NOW.toISOString());
  assert.equal(r.entry.updatedAt, NOW.toISOString());
  assert.equal(JSON.stringify({ ...clone(s), cycleEntries: null }), before);
});

test("開始: 同時に複数の「月経中」を作れない。未来日・不正日付も拒否。失敗時はstateを変えない", () => {
  const { L, s } = setup();
  assert.equal(L.applyStart(s, { date: "2026-10-15" }, NOW).ok, true);
  const before = JSON.stringify(s);
  const again = L.applyStart(s, { date: "2026-10-20" }, NOW);
  assert.equal(again.ok, false);
  assert.equal(again.code, "ALREADY_OPEN");
  assert.equal(JSON.stringify(s), before);

  const { L: L2, s: s2 } = setup();
  assert.equal(L2.applyStart(s2, { date: "2026-10-16" }, NOW).code, "FUTURE_DATE");
  assert.equal(L2.applyStart(s2, { date: "2026-02-30" }, NOW).code, "INVALID_DATE");
  assert.equal(L2.applyStart(s2, { date: "0202-10-01" }, NOW).code, "INVALID_DATE");
  assert.equal(s2.cycleEntries.length, 0);
});

test("開始: 既存の完了済み期間と重なる日付は拒否する（不自然な期間重複の防止）", () => {
  const { L, s } = setup();
  L.applyStart(s, { date: "2026-09-01" }, D(2026, 9, 1));
  L.applyEnd(s, s.cycleEntries[0].id, { date: "2026-09-05" }, D(2026, 9, 5));
  const r = L.applyStart(s, { date: "2026-09-03" }, NOW); // 既存期間(9/1〜9/5)の内側
  assert.equal(r.ok, false);
  assert.equal(r.code, "OVERLAP");
});

// ---------- 終了 ----------

test("終了: 開始日以降の日付で記録でき、月経期間（日数）が決まる", () => {
  const { L, s } = setup();
  const started = L.applyStart(s, { date: "2026-10-01" }, D(2026, 10, 1)).entry;
  const r = L.applyEnd(s, started.id, { date: "2026-10-05" }, D(2026, 10, 5, 9));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.entry.endDate, "2026-10-05");
  assert.equal(L._diffDays(r.entry.startDate, r.entry.endDate) + 1, 5);
});

test("終了: 進行中の記録が無い・既に終了済み・開始日より前・未来日・重複はすべて拒否", () => {
  const { L, s } = setup();
  assert.equal(L.applyEnd(s, 999, { date: "2026-10-05" }, NOW).code, "NOT_FOUND");
  const e = L.applyStart(s, { date: "2026-10-01" }, D(2026, 10, 1)).entry;
  assert.equal(L.applyEnd(s, e.id, { date: "2026-09-30" }, D(2026, 10, 1)).code, "END_BEFORE_START");
  assert.equal(L.applyEnd(s, e.id, { date: "2026-10-20" }, D(2026, 10, 1)).code, "FUTURE_DATE");
  const ok = L.applyEnd(s, e.id, { date: "2026-10-05" }, D(2026, 10, 5));
  assert.equal(ok.ok, true);
  assert.equal(L.applyEnd(s, e.id, { date: "2026-10-06" }, D(2026, 10, 6)).code, "ALREADY_CLOSED");
});

// ---------- 編集 ----------

test("編集: 変えた項目だけ更新し、id・createdAtは保つ。endDateをnullには戻せない", () => {
  const { L, s } = setup();
  const e = L.applyStart(s, { date: "2026-10-01", comment: "a" }, D(2026, 10, 1)).entry;
  L.applyEnd(s, e.id, { date: "2026-10-05" }, D(2026, 10, 5));
  const cur = L.findById(s, e.id);
  const src = L.sourceOf(cur);
  const r = L.applyEdit(s, e.id, { startDate: "2026-09-29", comment: "b" }, src, D(2026, 10, 6));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.entry.id, e.id);
  assert.equal(r.entry.createdAt, e.createdAt);
  assert.equal(r.entry.startDate, "2026-09-29");
  assert.equal(r.entry.endDate, "2026-10-05");
  assert.equal(r.entry.comment, "b");
  assert.equal(L.applyEdit(s, e.id, { endDate: null }, L.sourceOf(r.entry), NOW).code, "INVALID_DECISION");
  assert.equal(L.applyEdit(s, e.id, { comment: "b" }, L.sourceOf(r.entry), NOW).code, "NO_CHANGE");
});

test("編集: 終了日を開始日より前にはできない。編集後の期間が他の記録と重なるのも拒否", () => {
  const { L, s } = setup();
  const a = L.applyStart(s, { date: "2026-09-01" }, D(2026, 9, 1)).entry;
  L.applyEnd(s, a.id, { date: "2026-09-05" }, D(2026, 9, 5));
  const b = L.applyStart(s, { date: "2026-09-20" }, D(2026, 9, 20)).entry;
  L.applyEnd(s, b.id, { date: "2026-09-24" }, D(2026, 9, 24));
  const curA = L.findById(s, a.id);
  assert.equal(L.applyEdit(s, a.id, { endDate: "2026-08-31" }, L.sourceOf(curA), NOW).code, "END_BEFORE_START");
  assert.equal(L.applyEdit(s, a.id, { endDate: "2026-09-22" }, L.sourceOf(curA), NOW).code, "OVERLAP");
});

test("編集: 下書きが指す記録の写しと照合する（STALE_SOURCE）。idが再利用されても別の記録を上書きしない", () => {
  const { L, s } = setup();
  const a = L.applyStart(s, { date: "2026-09-01" }, D(2026, 9, 1)).entry;
  const oldSource = L.sourceOf(a);
  L.applyEnd(s, a.id, { date: "2026-09-05" }, D(2026, 9, 5));
  L.applyDelete(s, a.id, L.sourceOf(L.findById(s, a.id)));
  const b = L.applyStart(s, { date: "2026-10-01" }, D(2026, 10, 1)).entry;
  assert.equal(b.id, a.id, "idが再利用される");
  assert.equal(L.applyEdit(s, a.id, { comment: "x" }, oldSource, NOW).code, "STALE_SOURCE");
  assert.equal(s.cycleEntries[0].comment, "");
});

// ---------- 削除・巻き戻し ----------

test("削除: その1件だけ消え、他の領域は変わらない。revertで元に戻る", () => {
  const { L, s } = setup();
  const a = L.applyStart(s, { date: "2026-09-01" }, D(2026, 9, 1)).entry;
  L.applyEnd(s, a.id, { date: "2026-09-05" }, D(2026, 9, 5));
  const b = L.applyStart(s, { date: "2026-10-01" }, D(2026, 10, 1)).entry;
  const before = JSON.stringify(s);
  const r = L.applyDelete(s, b.id, L.sourceOf(L.findById(s, b.id)));
  assert.equal(r.ok, true);
  assert.equal(s.cycleEntries.length, 1);
  L.revert(s, r.snapshot);
  assert.equal(JSON.stringify(s), before);
});

// ---------- 検証：コメント文字数 ----------

test("コメントは500字まで。制御文字は拒否", () => {
  const { L, s } = setup();
  assert.equal(L.applyStart(s, { date: "2026-10-01", comment: "あ".repeat(500) }, D(2026, 10, 1)).ok, true);
  const { L: L2, s: s2 } = setup();
  assert.equal(L2.applyStart(s2, { date: "2026-10-01", comment: "あ".repeat(501) }, D(2026, 10, 1)).code, "INVALID_COMMENT");
  const { L: L3, s: s3 } = setup();
  assert.equal(L3.applyStart(s3, { date: "2026-10-01", comment: "a\u0000b" }, D(2026, 10, 1)).code, "INVALID_COMMENT");
});

// ---------- v6→v7 migration ----------

test("v6→v7: cycleEntriesが無ければ[]を足すだけ。既存データは一切変わらない。冪等", () => {
  const env = loadEnv();
  const before = env.get("createDefaultState()");
  before.schemaVersion = 6;
  delete before.cycleEntries;
  before.dailyRecords = [{ date: "2026-10-01", weight: 66.2, bodyComposition: {}, compositionMeta: null, comment: "" }];
  const snapshot = JSON.stringify(before);
  const migrated = env.Storage.migrate(clone(JSON.parse(snapshot)));
  assert.equal(migrated.schemaVersion, 7);
  assert.deepEqual(clone(migrated.cycleEntries), []);
  assert.equal(JSON.stringify({ ...clone(migrated), cycleEntries: null, schemaVersion: null }), JSON.stringify({ ...JSON.parse(snapshot), cycleEntries: null, schemaVersion: null }));
  // 冪等：既にcycleEntriesがある状態にもう一度かけても壊れない（直接MIGRATIONS[6]を単体で確認）
  const withData = { schemaVersion: 6, cycleEntries: [{ id: 1, startDate: "2026-09-01", endDate: "2026-09-05", comment: "", createdAt: "x", updatedAt: "x" }] };
  const once = env.Storage.migrate(clone(withData));
  assert.deepEqual(clone(once.cycleEntries), withData.cycleEntries);
});

test("v4→v7（連鎖）: 途中の移行（注射・体組成）を経て、最終的にcycleEntriesが付く", () => {
  const env = loadEnv();
  const v4 = env.get("createDefaultState()");
  v4.schemaVersion = 4;
  delete v4.injectionSchedule;
  delete v4.injectionStock;
  const migrated = env.Storage.migrate(v4);
  assert.equal(migrated.schemaVersion, 7);
  assert.deepEqual(clone(migrated.cycleEntries), []);
  assert.ok(migrated.injectionStock);
});

// ---------- JSON backup / restore ----------

test("バックアップ往復: cycleEntries（severe級の境界値含む）がそのまま書き出し→読み込みできる", () => {
  const { env, L, s } = setup();
  L.applyStart(s, { date: "2026-09-01", comment: "軽め" }, D(2026, 9, 1));
  L.applyEnd(s, s.cycleEntries[0].id, { date: "2026-09-05" }, D(2026, 9, 5));
  L.applyStart(s, { date: "2026-10-01", comment: "" }, D(2026, 10, 1)); // 進行中
  const r = env.Backup.parse(exportText(env, s), null);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(clone(r.state.cycleEntries), clone(s.cycleEntries));
});

test("バックアップ検証: id重複・日付不正・endDate<startDate・複数の月経中・文字数超過を拒否", () => {
  const { env, s } = setup();
  const base = () => clone(s);

  const dup = base();
  dup.cycleEntries = [
    { id: 1, startDate: "2026-09-01", endDate: "2026-09-05", comment: "", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" },
    { id: 1, startDate: "2026-10-01", endDate: null, comment: "", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" },
  ];
  assert.ok(env.Backup.validateState(dup).errors.length > 0, "id重複");

  const badDate = base();
  badDate.cycleEntries = [{ id: 1, startDate: "2026-13-01", endDate: null, comment: "", createdAt: null, updatedAt: null }];
  assert.ok(env.Backup.validateState(badDate).errors.length > 0, "不正日付");

  const endBeforeStart = base();
  endBeforeStart.cycleEntries = [{ id: 1, startDate: "2026-09-05", endDate: "2026-09-01", comment: "", createdAt: null, updatedAt: null }];
  assert.ok(env.Backup.validateState(endBeforeStart).errors.length > 0, "endDate<startDate");

  const twoOpen = base();
  twoOpen.cycleEntries = [
    { id: 1, startDate: "2026-09-01", endDate: null, comment: "", createdAt: null, updatedAt: null },
    { id: 2, startDate: "2026-10-01", endDate: null, comment: "", createdAt: null, updatedAt: null },
  ];
  assert.ok(env.Backup.validateState(twoOpen).errors.length > 0, "月経中が複数");

  const tooLong = base();
  tooLong.cycleEntries = [{ id: 1, startDate: "2026-09-01", endDate: null, comment: "a".repeat(5001), createdAt: null, updatedAt: null }];
  assert.ok(env.Backup.validateState(tooLong).errors.length > 0, "コメント文字数超過");

  const ok = base();
  ok.cycleEntries = [{ id: 1, startDate: "2026-09-01", endDate: "2026-09-05", comment: "ok", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-05T00:00:00.000Z" }];
  assert.deepEqual(clone(env.Backup.validateState(ok).errors), []);
});

test("旧バックアップ（v6、cycleEntriesなし）はv7へ変換して取り込める", () => {
  const env = loadEnv();
  const v6 = env.get("createDefaultState()");
  v6.schemaVersion = 6;
  delete v6.cycleEntries;
  const e = { app: "body-garden", kind: "full-backup", formatVersion: 1, schemaVersion: 6, exportedAt: "2026-10-01T00:00:00Z", counts: env.Backup.counts(v6), state: v6 };
  const r = env.Backup.parse(JSON.stringify(e), null);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.state.schemaVersion, 7);
  assert.deepEqual(clone(r.state.cycleEntries), []);
});

// ---------- CSV ----------

test("cycles.csv: ID・開始日・終了日・日数・メモ・記録日時・更新日時。終了日未入力は空欄（0にしない）", () => {
  const { env, L, s } = setup();
  const C = env.get("CsvLogic");
  L.applyStart(s, { date: "2026-09-01", comment: "a" }, D(2026, 9, 1, 8));
  L.applyEnd(s, s.cycleEntries[0].id, { date: "2026-09-05" }, D(2026, 9, 5, 9));
  L.applyStart(s, { date: "2026-10-01" }, D(2026, 10, 1, 7));
  const { headers, rows } = C.buildCycles(s);
  assert.deepEqual(clone(headers), ["ID", "開始日", "終了日", "日数", "メモ", "記録日時", "更新日時"]);
  assert.equal(rows.length, 2, "複数回の記録が欠落しない");
  const closed = rows.find((r) => r[1] === "2026-09-01");
  assert.equal(closed[2], "2026-09-05");
  assert.equal(closed[3], 5);
  assert.equal(closed[4], "a");
  const open = rows.find((r) => r[1] === "2026-10-01");
  assert.equal(open[2], null, "終了日未入力は空欄（0にしない）");
  assert.equal(open[3], null, "日数も計算できないので空欄");
});

test("buildAll: cyclesシートが追加され、既存7ファイルの並び・内容は壊れない", () => {
  const { env, s } = setup();
  const C = env.get("CsvLogic");
  const defs = C.buildAll(s, new Date(2026, 9, 10, 9, 0));
  assert.deepEqual(clone(defs.map((d) => d.sheet)), ["weight", "body_composition", "protein", "injections", "injection_schedule", "conditions", "cycles", "export_info"]);
  const info = defs.find((d) => d.sheet === "export_info");
  assert.ok(info.rows.some((r) => r[0] === "cycles 件数"));
});

// ---------- 月経期band（記録済み＝実績） ----------

test("月経期band: 記録した開始〜終了がそのまま帯になる。終了未記録は今日までの帯になる", () => {
  const { L, s } = setup();
  L.applyStart(s, { date: "2026-10-01" }, D(2026, 10, 1));
  L.applyEnd(s, s.cycleEntries[0].id, { date: "2026-10-05" }, D(2026, 10, 5));
  const b1 = L.bands(s, D(2026, 10, 10));
  const period = b1.filter((b) => b.phase === "period");
  assert.deepEqual(clone(period), [{ from: "2026-10-01", to: "2026-10-05", phase: "period", source: "recorded" }]);

  const { L: L2, s: s2 } = setup();
  L2.applyStart(s2, { date: "2026-10-08" }, D(2026, 10, 8));
  const b2 = L2.bands(s2, D(2026, 10, 10));
  const open = b2.find((b) => b.phase === "period");
  assert.deepEqual(clone(open), { from: "2026-10-08", to: "2026-10-10", phase: "period", source: "recorded" });
});

// ---------- 完了済み周期の卵胞期・黄体期（実績ベース） ----------

test("完了済み周期: 次回開始日の実績から、黄体期＝次回開始日の14日前〜前日、卵胞期＝前回終了日の翌日〜黄体期開始の前日", () => {
  const { L, s } = setup();
  L.applyStart(s, { date: "2026-09-01" }, D(2026, 9, 1));
  L.applyEnd(s, s.cycleEntries[0].id, { date: "2026-09-05" }, D(2026, 9, 5));
  L.applyStart(s, { date: "2026-09-29" }, D(2026, 9, 29)); // 次の月経開始＝周期28日
  const b = L.bands(s, D(2026, 10, 1));
  const luteal = b.find((x) => x.phase === "luteal");
  const follicular = b.find((x) => x.phase === "follicular");
  assert.deepEqual(clone(luteal), { from: "2026-09-15", to: "2026-09-28", phase: "luteal", source: "derived" });
  assert.deepEqual(clone(follicular), { from: "2026-09-06", to: "2026-09-14", phase: "follicular", source: "derived" });
});

test("排卵日そのものを『確定日』として返さない（luteal/follicularの期間だけを返し、単一のovulationDateは持たない）", () => {
  const { L, s } = setup();
  L.applyStart(s, { date: "2026-09-01" }, D(2026, 9, 1));
  L.applyEnd(s, s.cycleEntries[0].id, { date: "2026-09-05" }, D(2026, 9, 5));
  L.applyStart(s, { date: "2026-09-29" }, D(2026, 9, 29));
  const b = L.bands(s, D(2026, 10, 1));
  for (const band of b) assert.ok(!("ovulationDate" in band) && !("ovulation" in band));
});

// ---------- 現在周期の推定（3周期未満では出さない／3周期以上で中央値） ----------

function completedCycle(L, s, start, end, nextStart) {
  L.applyStart(s, { date: start }, new Date(...start.split("-").map((n, i) => (i === 1 ? Number(n) - 1 : Number(n)))));
  const id = s.cycleEntries[s.cycleEntries.length - 1].id;
  L.applyEnd(s, id, { date: end }, new Date(...end.split("-").map((n, i) => (i === 1 ? Number(n) - 1 : Number(n)))));
  if (nextStart) {
    const d = new Date(...nextStart.split("-").map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))));
    L.applyStart(s, { date: nextStart }, d);
  }
}

test("3周期未満では、現在の周期の卵胞期・黄体期を推定しない（記録済みの月経期だけ表示）", () => {
  const { L, s } = setup();
  // 完了済み周期を2つだけ作る（3つ目は無し＝現在進行中のまま）
  L.applyStart(s, { date: "2026-07-01" }, D(2026, 7, 1));
  L.applyEnd(s, s.cycleEntries[0].id, { date: "2026-07-05" }, D(2026, 7, 5));
  L.applyStart(s, { date: "2026-07-29" }, D(2026, 7, 29));
  L.applyEnd(s, s.cycleEntries[1].id, { date: "2026-08-02" }, D(2026, 8, 2));
  L.applyStart(s, { date: "2026-08-26" }, D(2026, 8, 26)); // 現在の周期（まだ次回が無い）
  assert.equal(L.estimateCycleLength(s), null);
  const bands = L.bands(s, D(2026, 9, 10));
  // 現在周期(8/26始まり)に対応する推定luteal/follicularは出ない。完了済み2件分のderivedは出る
  const estimated = bands.filter((b) => b.source === "estimated");
  assert.deepEqual(clone(estimated), []);
});

test("3周期以上で中央値を使って推定する。外れ値（単発の長い/短い周期）に引きずられない", () => {
  const { L, s } = setup();
  // 周期日数: 28, 28, 90（外れ値） → 中央値は28（平均なら大きくぶれる）
  L.applyStart(s, { date: "2026-06-01" }, D(2026, 6, 1));
  L.applyEnd(s, s.cycleEntries[0].id, { date: "2026-06-05" }, D(2026, 6, 5));
  L.applyStart(s, { date: "2026-06-29" }, D(2026, 6, 29)); // 28日後
  L.applyEnd(s, s.cycleEntries[1].id, { date: "2026-07-03" }, D(2026, 7, 3));
  L.applyStart(s, { date: "2026-07-27" }, D(2026, 7, 27)); // 28日後
  L.applyEnd(s, s.cycleEntries[2].id, { date: "2026-07-31" }, D(2026, 7, 31));
  L.applyStart(s, { date: "2026-10-25" }, D(2026, 10, 25)); // 90日後（外れ値）→現在の周期の開始
  assert.equal(L.estimateCycleLength(s), 28, "中央値=28（平均なら(28+28+90)/3=48.67）");
});

test("現在周期の推定: 次回開始日の実績がないため、直近3周期中央値を使って推定次回開始日→黄体期開始(14日前)を計算する。未来部分は描かない", () => {
  const { L, s } = setup();
  L.applyStart(s, { date: "2026-06-01" }, D(2026, 6, 1));
  L.applyEnd(s, s.cycleEntries[0].id, { date: "2026-06-05" }, D(2026, 6, 5));
  L.applyStart(s, { date: "2026-06-29" }, D(2026, 6, 29));
  L.applyEnd(s, s.cycleEntries[1].id, { date: "2026-07-03" }, D(2026, 7, 3));
  L.applyStart(s, { date: "2026-07-27" }, D(2026, 7, 27));
  L.applyEnd(s, s.cycleEntries[2].id, { date: "2026-07-31" }, D(2026, 7, 31));
  L.applyStart(s, { date: "2026-08-24" }, D(2026, 8, 24)); // 現在の周期。28日後＝9/21が推定次回開始
  L.applyEnd(s, s.cycleEntries[3].id, { date: "2026-08-28" }, D(2026, 8, 28));
  // 「今日」を推定黄体期の途中にする：推定luteal = 9/7〜9/20
  const bands = L.bands(s, D(2026, 9, 12));
  const estLuteal = bands.find((b) => b.source === "estimated" && b.phase === "luteal");
  const estFollicular = bands.find((b) => b.source === "estimated" && b.phase === "follicular");
  assert.ok(estLuteal, "推定黄体期が出る");
  assert.equal(estLuteal.from, "2026-09-07");
  assert.equal(estLuteal.to, "2026-09-12", "今日(9/12)より未来は描かれない（本来は9/20まで）");
  assert.ok(estFollicular, "期間が終わっている現在の周期は推定卵胞期も出る");
  assert.equal(estFollicular.from, "2026-08-29");
  assert.equal(estFollicular.to, "2026-09-06");

  // 今日が推定次回開始日(9/21)より後でも、推定帯そのものはすでに過去の期間なのでそのまま出る
  // （次の月経がまだ記録されていないため、依然として「現在の周期」の推定として扱われる）
  const bandsLater = L.bands(s, D(2026, 10, 1));
  const estLater = bandsLater.filter((b) => b.source === "estimated");
  assert.deepEqual(clone(estLater), [
    { from: "2026-09-07", to: "2026-09-20", phase: "luteal", source: "estimated" },
    { from: "2026-08-29", to: "2026-09-06", phase: "follicular", source: "estimated" },
  ]);
  // ただし「未来方向には絶対に伸ばさない」という制約そのものは別のテストで確認済み
  // （次回開始予測日より先の日付は、このbands()のどの呼び出しでも登場しない）
  for (const b of bandsLater) assert.ok(b.to <= "2026-10-01");
});

test("今日より未来のbandは一切描かない（境界: fromが未来なら除外、toだけ未来なら今日で切る）", () => {
  const { L, s } = setup();
  L.applyStart(s, { date: "2026-10-10" }, D(2026, 10, 10));
  const bands = L.bands(s, D(2026, 10, 12));
  for (const b of bands) assert.ok(b.to <= "2026-10-12");
  const bands2 = L.bands(s, D(2026, 10, 9)); // 開始日(10/10)より前が「今日」
  assert.deepEqual(clone(bands2), [], "開始日がまだ来ていなければ帯は出ない");
});

// ---------- 既存体重グラフの非破壊 ----------
// Charts.bandsへの実際の変換（CSS変数の色解決を含む）はDOM統合なので tests/cycle-ui.test.js で確認する

test("CycleLogicが無い/cycleEntriesが空でも、bands()は空配列を返すだけで例外にならない", () => {
  const { L, s } = setup();
  assert.deepEqual(clone(L.bands(s, NOW)), []);
});
