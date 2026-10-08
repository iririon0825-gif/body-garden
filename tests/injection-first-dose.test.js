// 初回投与日: 既存の注射履歴から導出する（保存しない・schema変更なし）。
// Body Garden開始日（profile.startDate）とは別の概念。予定・見送りは初回投与日として扱わない

const test = require("node:test");
const assert = require("node:assert/strict");
const { setup, stateWith, admin, sched, rec, clone } = require("./injection-helpers");

test("初回投与日: 実際に「投与済み」の記録のうち最も古い日（予定・見送りは対象外）", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  sched(env, s, "2026-09-25", "09:00"); // 予定（未投与）は初回にならない
  rec(env, s, { status: "skipped", kind: "regular", regularDate: "2026-09-26", scheduledAt: "2026-09-26", skipReason: "userChoice" }); // 見送りも対象外
  admin(env, s, "2026-10-09", "09:00");
  admin(env, s, "2026-10-02", "09:30"); // 最古の投与済み
  admin(env, s, "2026-10-16", "09:00");
  assert.equal(L.firstAdministeredDate(s), "2026-10-02");
  assert.equal(L.firstAdministered(s).administeredAt, "2026-10-02");
});

test("初回投与日: 投与済みの記録が1件もなければ null（予定だけ・見送りだけでも null）", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  assert.equal(L.firstAdministeredDate(s), null);
  sched(env, s, "2026-10-02", "09:00");
  rec(env, s, { status: "skipped", kind: "regular", regularDate: "2026-09-26", scheduledAt: "2026-09-26", skipReason: "userChoice" });
  assert.equal(L.firstAdministeredDate(s), null);
  assert.equal(L.daysSinceFirst(s, "2026-10-08"), null);
});

test("初回投与日は、profile.startDate（Body Garden開始日）と無関係に決まる", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  s.profile.startDate = "2026-09-01"; // アプリを使い始めた日
  admin(env, s, "2026-10-02", "09:00"); // 実際の初回投与日はそれより後
  assert.equal(L.firstAdministeredDate(s), "2026-10-02");
  s.profile.startDate = "2026-10-05"; // 開始日を変えても、初回投与日は変わらない
  assert.equal(L.firstAdministeredDate(s), "2026-10-02");
});

test("daysSinceFirst: 初回投与日を0日として数える。今日より後の初回は null", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-02", "09:00");
  assert.equal(L.daysSinceFirst(s, "2026-10-02"), 0);
  assert.equal(L.daysSinceFirst(s, "2026-10-08"), 6);
  assert.equal(L.daysSinceFirst(s, "2026-10-01"), null, "初回投与日より前の日付では日数を出さない");
});

test("初回投与日の導出は state を一切変えない（保存項目を増やさない）", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-02", "09:00");
  const before = JSON.stringify(s);
  L.firstAdministered(s);
  L.firstAdministeredDate(s);
  L.daysSinceFirst(s, "2026-10-08");
  assert.equal(JSON.stringify(s), before);
  assert.equal(clone(s).schemaVersion, 7, "schemaVersionは7のまま");
});

test("formatFullDate: 年を必ず含み、曜日つきで返す", () => {
  const { L } = setup();
  assert.equal(L.formatFullDate("2026-10-02"), "2026/10/2（金）");
});

test("同じ日に複数の投与済みがあれば、時刻の早い方が先頭（_cmpDt の並びに従う）", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-02", "21:00", { id: 10 });
  admin(env, s, "2026-10-02", "08:00", { id: 11 });
  assert.equal(L.firstAdministered(s).administeredTime, "08:00");
  assert.equal(L.firstAdministeredDate(s), "2026-10-02");
});
