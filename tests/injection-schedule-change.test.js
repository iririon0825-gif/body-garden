// 曜日変更の判定（電子添付文書 7.2）: 前回の実投与日時 → 変更後の最初の予定日時 の間隔が72時間以上か
// 打ち忘れ判定とは別のロジック・別のテスト。72時間未満・判定不能は確定できない（確定を保留し、時刻の確認を求める）。
// 前提: 定例は水曜 09:00（2026-10-07・10-14 は水曜）。直前の投与は 10/7(水) 09:00。

const test = require("node:test");
const assert = require("node:assert/strict");
const { D, setup, stateWith, admin, sched, clone } = require("./injection-helpers");

const last = (time) => ({ date: "2026-10-07", time });

test("前回の実投与から 71:59 / 72:00 / 72:01 の予定（時刻あり）", () => {
  const { L } = setup();
  const j = (t) => L.judgeWeekdayChange(last("09:00"), { date: "2026-10-10", time: t });
  assert.equal(j("08:59").result, "lt72");
  assert.equal(j("08:59").canConfirm, false, "72時間未満は確定できない");
  assert.equal(j("09:00").result, "ge72", "72時間ちょうどは含む");
  assert.equal(j("09:00").canConfirm, true);
  assert.equal(j("09:01").result, "ge72");
});

test("時刻不明の組み合わせ: 幅で確実に言えるときだけ判定し、それ以外は判定不能（確定不可）", () => {
  const { L } = setup();
  // 新しい予定の時刻だけ不明
  assert.equal(L.judgeWeekdayChange(last("09:00"), { date: "2026-10-10", time: null }).result, "unknown");
  assert.equal(L.judgeWeekdayChange(last("09:00"), { date: "2026-10-09", time: null }).result, "lt72", "最長でも62:59:59.999");
  assert.equal(L.judgeWeekdayChange(last("09:00"), { date: "2026-10-11", time: null }).result, "ge72", "最短でも72時間超");
  // 前回の時刻だけ不明
  assert.equal(L.judgeWeekdayChange(last(null), { date: "2026-10-10", time: "09:00" }).result, "unknown");
  assert.equal(L.judgeWeekdayChange(last(null), { date: "2026-10-11", time: "00:00" }).result, "ge72");
  // 両方不明
  const both = (d) => L.judgeWeekdayChange(last(null), { date: d, time: null });
  assert.equal(both("2026-10-09").result, "lt72", "最長でも71:59:59.999");
  assert.equal(both("2026-10-10").result, "unknown");
  assert.equal(both("2026-10-11").result, "ge72");
  assert.equal(both("2026-10-10").canConfirm, false);
});

test("投与履歴が無いときは判定対象が無い（noHistory。確定できる）", () => {
  const { L } = setup();
  const j = L.judgeWeekdayChange(null, { date: "2026-10-10", time: null });
  assert.equal(j.result, "noHistory");
  assert.equal(j.canConfirm, true);
});

test("候補日: 木曜へ変更 → 10/8 は選べず、10/15 は選べる", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-07", "09:00");
  const c = L.weekdayChangeCandidates(s, { weekday: 4, time: "09:00" }, D(2026, 10, 7, 10, 0));
  assert.deepEqual(clone(c.map((x) => x.date)), ["2026-10-08", "2026-10-15", "2026-10-22"]);
  assert.equal(c[0].judgment.canConfirm, false);
  assert.equal(c[1].judgment.canConfirm, true);
});

test("曜日変更の確定: 72時間以上なら通り、未来の予定は置き換わる。過去の記録は一切変わらない", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-07", "09:00");
  const pending = sched(env, s, "2026-10-14", "09:00");
  const pastBefore = clone(s.injections[0]);
  const r = L.applyWeekdayChange(s, { weekday: 4, time: "10:30", firstDate: "2026-10-15" }, D(2026, 10, 8, 10, 0));
  assert.equal(r.ok, true, JSON.stringify(r));
  const reg = L.schedule(s).regular;
  assert.equal(reg.weekday, 4);
  assert.equal(reg.time, "10:30");
  assert.equal(reg.effectiveFrom, "2026-10-15");
  assert.equal(L.schedule(s).history.length, 2);
  assert.equal(L.schedule(s).history[1].type, "weekdayChange");
  assert.equal(L.schedule(s).history[1].check.result, "ge72");
  assert.equal(pending.scheduledAt, "2026-10-15", "未来の予定は新しい最初の予定日へ（idは維持）");
  assert.equal(pending.regularDate, "2026-10-15");
  assert.equal(pending.id, 2);
  assert.deepEqual(clone(s.injections[0]), pastBefore, "過去の投与記録は変わらない");
});

test("曜日変更の確定: 72時間未満・判定不能は拒否し、state は変わらない", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-07", "09:00");
  const snapshot = JSON.stringify(s);
  const under = L.applyWeekdayChange(s, { weekday: 4, time: "09:00", firstDate: "2026-10-08" }, D(2026, 10, 7, 10, 0));
  assert.equal(under.ok, false);
  assert.equal(under.code, "INTERVAL_UNDER_72H");
  const unknown = L.applyWeekdayChange(s, { weekday: 6, time: null, firstDate: "2026-10-10" }, D(2026, 10, 7, 10, 0)); // 10/10 は土曜
  assert.equal(unknown.code, "INTERVAL_UNKNOWN");
  assert.equal(JSON.stringify(s), snapshot);
});

test("時刻の入力で判定不能が解消する（前回時刻が分かれば確定できる）", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-07", null); // 前回の時刻が不明
  const now = D(2026, 10, 8, 10, 0);
  assert.equal(L.applyWeekdayChange(s, { weekday: 6, time: "09:00", firstDate: "2026-10-10" }, now).code, "INTERVAL_UNKNOWN");
  // 前回の時刻を履歴の修正で入力した場合
  const ed = L.applyEditAdministration(s, 1, { date: "2026-10-07", time: "09:00", dose: 2.5 }, now);
  assert.equal(ed.ok, true, JSON.stringify(ed));
  assert.equal(L.applyWeekdayChange(s, { weekday: 6, time: "09:30", firstDate: "2026-10-10" }, now).ok, true);
});

test("過去に記録のない回があるときは、曜日変更を先に処理させない（打ち忘れの確認が先）", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-09-30", "09:00"); // 10/7 が記録なし
  const now = D(2026, 10, 16, 10, 0);
  assert.equal(L.canChangeSchedule(s, now).code, "UNCOVERED_PAST");
  const r = L.applyWeekdayChange(s, { weekday: 4, time: "09:00", firstDate: "2026-10-22" }, now);
  assert.equal(r.ok, false);
  assert.equal(r.code, "UNCOVERED_PAST");
});

test("曜日変更の入力検証: 曜日と日付の不一致・過去日・91日先・時刻の書式", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-07", "09:00");
  const now = D(2026, 10, 8, 10, 0);
  assert.equal(L.applyWeekdayChange(s, { weekday: 5, time: "09:00", firstDate: "2026-10-15" }, now).code, "WEEKDAY_MISMATCH");
  assert.equal(L.applyWeekdayChange(s, { weekday: 3, time: "09:00", firstDate: "2026-10-07" }, now).code, "PAST_DATE");
  assert.equal(L.applyWeekdayChange(s, { weekday: 4, time: "09:00", firstDate: "2027-01-14" }, now).code, "TOO_FAR");
  assert.equal(L.applyWeekdayChange(s, { weekday: 4, time: "9:00", firstDate: "2026-10-15" }, now).code, "INVALID_TIME");
});

test("定例曜日の変更と、一時的な日程変更は別の操作: 単発変更では定例曜日が変わらない", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-07", "09:00");
  const pending = sched(env, s, "2026-10-14", "09:00");
  const r = L.applyOneOffChange(s, pending.id, { date: "2026-10-15", time: "09:00" }, D(2026, 10, 8, 10, 0));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(pending.kind, "oneOffChange");
  assert.equal(pending.regularDate, "2026-10-14", "定例日は元のまま");
  assert.equal(pending.scheduledAt, "2026-10-15");
  assert.equal(L.schedule(s).regular.weekday, 3, "定例曜日は変わらない");
  assert.equal(L.schedule(s).history.length, 1, "曜日変更の履歴は増えない");
  // その1回だけの変更を、定例日へ戻す
  assert.equal(L.applyOneOffChange(s, pending.id, { date: "2026-10-14", time: "09:00" }, D(2026, 10, 8, 10, 0)).ok, true);
  assert.equal(pending.kind, "regular");
});

test("単発変更: 前回の実投与から72時間未満は確定不可（アプリ独自）、次の定例日以降へは動かせない", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-07", "09:00");
  const pending = sched(env, s, "2026-10-14", "09:00");
  const now = D(2026, 10, 8, 10, 0);
  assert.equal(L.applyOneOffChange(s, pending.id, { date: "2026-10-09", time: "09:00" }, now).code, "INTERVAL_UNDER_72H");
  assert.equal(L.applyOneOffChange(s, pending.id, { date: "2026-10-21", time: "09:00" }, now).code, "BEYOND_NEXT_REGULAR");
  assert.equal(pending.scheduledAt, "2026-10-14", "失敗したら変更されない");
});

test("単発変更: 次の定例投与まで72時間未満になる日程は、警告として確認を求める（確定は止めない）", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-07", "09:00");
  const pending = sched(env, s, "2026-10-14", "09:00");
  const now = D(2026, 10, 8, 10, 0);
  const first = L.applyOneOffChange(s, pending.id, { date: "2026-10-19", time: "09:00" }, now); // 次の定例 10/21 09:00 まで48時間
  assert.equal(first.code, "CONFIRM_REQUIRED");
  assert.deepEqual(clone(first.needs), ["nextGap"]);
  assert.equal(L.applyOneOffChange(s, pending.id, { date: "2026-10-19", time: "09:00", confirmNextGap: true }, now).ok, true);
});
