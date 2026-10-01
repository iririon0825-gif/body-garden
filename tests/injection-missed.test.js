// 打ち忘れ判定（電子添付文書 7.2）: 現在時刻 → 次の定例投与日時 の残り時間が72時間以上か
// 曜日変更の判定とは別のロジック・別のテスト。現在時刻は秒・ミリ秒まで計算する（切り捨てない）。
// 前提: 定例は水曜 09:00。2026-10-07・10-14・10-21 は水曜。直前の投与は 9/30(水) 09:00。

const test = require("node:test");
const assert = require("node:assert/strict");
const { D, setup, stateWith, admin, sched, clone } = require("./injection-helpers");

function missedState(env, opts) {
  const s = stateWith(env, opts);
  admin(env, s, "2026-09-30", "09:00"); // 10/7 の回が記録なしになる
  return s;
}

test("72時間ちょうどは「72時間以上」に含む／71:59:59.999 は未満（時刻あり）", () => {
  const { env, L, T } = setup();
  const s = missedState(env);
  const at = (...a) => L.evaluateMissedDose(s, D(...a));
  const exact = at(2026, 10, 11, 9, 0, 0, 0); // 次の定例 10/14 09:00 まで ちょうど72:00:00
  assert.equal(exact.status, "judged");
  assert.equal(exact.target.date, "2026-10-07");
  assert.deepEqual(clone(exact.next), { date: "2026-10-14", time: "09:00", source: "regular" });
  assert.equal(exact.judgment.minMs, T);
  assert.equal(exact.judgment.result, "ge72");
  assert.equal(at(2026, 10, 11, 9, 0, 0, 1).judgment.result, "lt72", "1ミリ秒でも72時間未満");
  assert.equal(at(2026, 10, 11, 9, 0, 0, 500).judgment.result, "lt72");
  assert.equal(at(2026, 10, 11, 9, 0, 1).judgment.result, "lt72", "71時間59分59秒");
  assert.equal(at(2026, 10, 11, 8, 59, 59).judgment.result, "ge72", "72時間0分1秒");
  assert.equal(at(2026, 10, 11, 8, 59, 59, 999).judgment.result, "ge72");
});

test("秒を切り捨てない: 09:00:45 は残り71:59:15 で72時間未満", () => {
  const { env, L } = setup();
  const s = missedState(env);
  const r = L.evaluateMissedDose(s, D(2026, 10, 11, 9, 0, 45));
  assert.equal(r.judgment.result, "lt72");
  assert.equal(L.formatDuration(r.judgment.minMs), "71時間59分15秒");
});

test("予定時刻が不明（時刻なし）: 日の幅で判定し、72時間をまたぐときだけ判定不能", () => {
  const { env, L } = setup();
  const s = missedState(env, { time: null });
  const j = (...a) => L.evaluateMissedDose(s, D(...a)).judgment.result;
  assert.equal(j(2026, 10, 10, 23, 59, 59, 999), "ge72", "最短でも72:00:00.001");
  assert.equal(j(2026, 10, 11, 0, 0, 0, 0), "ge72", "最短がちょうど72:00:00");
  assert.equal(j(2026, 10, 11, 0, 0, 0, 1), "unknown");
  assert.equal(j(2026, 10, 11, 12, 0, 0, 0), "unknown");
  assert.equal(j(2026, 10, 11, 23, 59, 59, 999), "unknown", "最長がちょうど72:00:00.000で、未満とは言えない");
  assert.equal(j(2026, 10, 12, 0, 0, 0, 0), "lt72", "最長でも71:59:59.999");
});

test("判定不能のときは、残り時間を幅で示す", () => {
  const { env, L } = setup();
  const s = missedState(env, { time: null });
  const r = L.evaluateMissedDose(s, D(2026, 10, 11, 12, 0, 0, 0));
  assert.equal(r.judgment.result, "unknown");
  assert.match(L.formatGap(r.judgment), /〜/);
});

test("対象の回と、その次の定例投与日時を明示する／評価は記録を一切作らない", () => {
  const { env, L } = setup();
  const s = missedState(env);
  const before = JSON.stringify(s);
  const r = L.evaluateMissedDose(s, D(2026, 10, 9, 12, 0));
  assert.equal(r.target.date, "2026-10-07");
  assert.equal(r.next.date, "2026-10-14");
  assert.equal(r.next.time, "09:00");
  L.homeSummary(s, D(2026, 10, 9, 12, 0));
  assert.equal(JSON.stringify(s), before, "評価・表示で state は変わらない（自動で見送りにしない）");
});

test("連続打ち忘れ: 対象は最新の1回、古い回は older に並べるだけ（自動保存しない）", () => {
  const { env, L } = setup();
  const s = missedState(env);
  const before = JSON.stringify(s);
  const r = L.evaluateMissedDose(s, D(2026, 10, 16, 12, 0)); // 10/7 と 10/14 を忘れた
  assert.equal(r.target.date, "2026-10-14");
  assert.deepEqual(clone(r.older.map((o) => o.date)), ["2026-10-07"]);
  assert.equal(r.next.date, "2026-10-21");
  assert.equal(r.judgment.result, "ge72");
  assert.equal(JSON.stringify(s), before);
  assert.equal(s.injections.filter((i) => i.status === "skipped").length, 0);
});

test("今日が定例日の回は、打ち忘れの対象にしない（今日の予定として扱う）", () => {
  const { env, L } = setup();
  const s = missedState(env);
  const r = L.evaluateMissedDose(s, D(2026, 10, 14, 8, 0)); // 10/14 は今日
  assert.deepEqual(clone(r.items.map((o) => o.date)), ["2026-10-07"]);
  assert.equal(r.next.date, "2026-10-14");
  assert.equal(r.judgment.result, "lt72");
});

test("記録のない回が無ければ nothingMissed／定例が無ければ noSchedule", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-07", "09:00");
  assert.equal(L.evaluateMissedDose(s, D(2026, 10, 9, 12, 0)).status, "nothingMissed");
  const none = stateWith(env, { regular: false });
  sched(env, none, "2026-10-07", null, { kind: "manual", regularDate: null });
  assert.equal(L.evaluateMissedDose(none, D(2026, 10, 9, 12, 0)).status, "noSchedule");
});

test("見送り・臨時投与の後も、定例スケジュールは変わらず次の定例が基準になる", () => {
  const { env, L } = setup();
  const s = missedState(env);
  const sk = L.applySkip(s, { regularDate: "2026-10-07", reason: "userChoice" }, D(2026, 10, 9, 12, 0));
  assert.equal(sk.ok, true);
  assert.equal(L.schedule(s).regular.weekday, 3);
  assert.equal(L.schedule(s).regular.time, "09:00");
  const s2 = missedState(env);
  const ad = L.applyAdministration(s2, { date: "2026-10-08", time: "10:00", dose: 2.5, regularDate: "2026-10-07", confirmInterval: true }, D(2026, 10, 8, 12, 0));
  assert.equal(ad.ok, true);
  assert.equal(ad.record.kind, "makeup");
  assert.equal(L.schedule(s2).regular.weekday, 3, "臨時投与の後も定例曜日は自動で変わらない");
});

test("暦の境界: 年またぎ（12/30 → 1/6）の72時間", () => {
  const { env, L } = setup();
  const s = stateWith(env, { effectiveFrom: "2026-12-23" });
  admin(env, s, "2026-12-23", "09:00");
  const r = L.evaluateMissedDose(s, D(2026, 12, 31, 12, 0));
  assert.equal(r.target.date, "2026-12-30");
  assert.equal(r.next.date, "2027-01-06");
  assert.equal(L.evaluateMissedDose(s, D(2027, 1, 3, 9, 0, 0, 0)).judgment.result, "ge72", "ちょうど72:00:00");
  assert.equal(L.evaluateMissedDose(s, D(2027, 1, 3, 9, 0, 1, 0)).judgment.result, "lt72");
});

test("暦の境界: うるう日（2028-02-29 火曜 → 3/7）の72時間", () => {
  const { env, L } = setup();
  const s = stateWith(env, { weekday: 2, effectiveFrom: "2028-02-22" });
  admin(env, s, "2028-02-22", "09:00");
  const r = L.evaluateMissedDose(s, D(2028, 3, 3, 9, 0));
  assert.equal(r.target.date, "2028-02-29");
  assert.equal(r.next.date, "2028-03-07");
  assert.equal(L.evaluateMissedDose(s, D(2028, 3, 4, 9, 0, 0, 0)).judgment.result, "ge72");
  assert.equal(L.evaluateMissedDose(s, D(2028, 3, 4, 9, 0, 1, 0)).judgment.result, "lt72");
});

test("月末: 9/30 の回を忘れ、次は 10/7", () => {
  const { env, L } = setup();
  const s = stateWith(env, { effectiveFrom: "2026-09-23" });
  admin(env, s, "2026-09-23", "09:00");
  const r = L.evaluateMissedDose(s, D(2026, 10, 2, 9, 0));
  assert.equal(r.target.date, "2026-09-30");
  assert.equal(r.next.date, "2026-10-07");
});

test("深夜の境界: 定例時刻 00:00 で 72時間ちょうど／1秒未満", () => {
  const { env, L } = setup();
  const s = missedState(env, { time: "00:00" });
  assert.equal(L.evaluateMissedDose(s, D(2026, 10, 11, 0, 0, 0)).judgment.result, "ge72");
  assert.equal(L.evaluateMissedDose(s, D(2026, 10, 11, 0, 0, 1)).judgment.result, "lt72");
});

test("長期中断(28日)の境界: 27日=判定、28日以上=長期中断（72時間の判定は残る）", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-07", "09:00");
  assert.equal(L.isLongGap(s, "2026-11-03"), false, "27日");
  assert.equal(L.isLongGap(s, "2026-11-04"), true, "28日");
  assert.equal(L.isLongGap(s, "2026-11-05"), true, "29日");
  const r = L.evaluateMissedDose(s, D(2026, 11, 5, 12, 0));
  assert.equal(r.longGap, true);
  assert.equal(r.status, "judged", "28日を理由に72時間ルールを別のルールへ置き換えない");
  assert.ok(["ge72", "lt72", "unknown"].includes(r.judgment.result));
  const home = L.homeSummary(s, D(2026, 11, 5, 12, 0));
  assert.ok(home.notices.includes("longGap"));
});

test("打ち忘れた回を、本人の操作で見送りとして記録する（理由・判定のスナップショット付き）", () => {
  const { env, L } = setup();
  const s = missedState(env);
  const now = D(2026, 10, 11, 9, 0, 1);
  const ev = L.evaluateMissedDose(s, now);
  const check = { judgedAt: now.toISOString(), target: ev.target.date, next: { date: ev.next.date, time: ev.next.time }, result: ev.judgment.result, minMs: ev.judgment.minMs, maxMs: ev.judgment.maxMs };
  const r = L.applySkip(s, { regularDate: ev.target.date, reason: "missedUnder72h", missedCheck: check }, now);
  assert.equal(r.ok, true);
  assert.equal(r.record.status, "skipped");
  assert.equal(r.record.kind, "regular");
  assert.equal(r.record.skipReason, "missedUnder72h");
  assert.deepEqual(clone(r.record.missedCheck), clone(check));
  assert.equal(L.schedule(s).regular.weekday, 3, "見送りを記録しても定例スケジュールは消えない");
  assert.equal(L.suggestNext(s, now), null, "見送り後に、次回の提案を再表示しない");
});
