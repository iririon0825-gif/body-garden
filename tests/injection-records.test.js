// 実投与の記録・次回提案・見送り・予定の取消と履歴の削除・初回登録・用量
// 前提: 定例は水曜 09:00（2026-10-07・10-14 は水曜）。

const test = require("node:test");
const assert = require("node:assert/strict");
const { D, setup, stateWith, admin, sched, rec, clone } = require("./injection-helpers");

// ---------- 実投与は事実の記録: 72時間未満でも拒否しない（確認を挟んで記録できる） ----------

test("実投与: 前回から72時間未満でも拒否せず、確認を挟めば記録できる", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-07", "09:00");
  const now = D(2026, 10, 8, 12, 0);
  const input = { date: "2026-10-08", time: "09:30", dose: 2.5 }; // 24.5時間後
  const first = L.applyAdministration(s, input, now);
  assert.equal(first.ok, false);
  assert.equal(first.code, "CONFIRM_REQUIRED");
  assert.deepEqual(clone(first.needs), ["interval"]);
  assert.equal(s.injections.length, 1, "確認前は何も保存しない");
  const second = L.applyAdministration(s, { ...input, confirmInterval: true }, now);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.record.status, "administered");
  assert.equal(s.injections.length, 2);
});

test("実投与: 同じ日の2回目も事実として記録できる（確認が必要）", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-07", "09:00");
  const now = D(2026, 10, 7, 20, 0);
  const input = { date: "2026-10-07", time: "18:00", dose: 2.5 };
  assert.equal(L.applyAdministration(s, input, now).code, "CONFIRM_REQUIRED");
  assert.equal(L.applyAdministration(s, { ...input, confirmInterval: true }, now).ok, true);
});

test("実投与: 時刻不明で72時間かどうか判定できないときも、確認を挟んで記録できる", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-07", null);
  const now = D(2026, 10, 10, 12, 0);
  const input = { date: "2026-10-10", time: null, dose: 2.5 };
  const a = L.assessAdministration(s, input, now);
  assert.equal(a.needs.interval.result, "unknown");
  assert.equal(L.applyAdministration(s, { ...input, confirmInterval: true }, now).ok, true);
});

test("実投与: 72時間以上空いていれば確認は要らない", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-07", "09:00");
  const r = L.applyAdministration(s, { date: "2026-10-14", time: "09:00", dose: 2.5 }, D(2026, 10, 14, 12, 0));
  assert.equal(r.ok, true);
  assert.equal(r.record.kind, "regular", "定例の曜日・日付の投与は regular");
});

test("実投与の入力検証: 未来日・今日の未来時刻・用量・日付・時刻・メモ", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  const now = D(2026, 10, 8, 10, 0);
  const t = (input) => L.applyAdministration(s, { date: "2026-10-08", time: "09:00", dose: 2.5, confirmDose: true, ...input }, now).code;
  assert.equal(t({ date: "2026-10-09" }), "FUTURE_DATE");
  assert.equal(t({ time: "10:01" }), "FUTURE_TIME");
  assert.equal(t({ time: "10:00" }), undefined, "ちょうど今の時刻は可");
  assert.equal(t({ dose: 3 }), "INVALID_DOSE");
  assert.equal(t({ dose: 20 }), "INVALID_DOSE", "選択肢にない用量（自由入力は不可）");
  assert.equal(t({ dose: null }), "INVALID_DOSE", "用量は自動で選ばない");
  assert.equal(t({ date: "2026-02-30" }), "INVALID_DATE");
  assert.equal(t({ time: "9:00" }), "INVALID_TIME");
  assert.equal(t({ comment: "あ".repeat(501) }), "INVALID_COMMENT");
  assert.equal(s.injections.length, 1, "拒否された入力は保存されず、成功した1件（ちょうど今の時刻）だけが残る");
});

test("用量の変更: 基準と違う用量は保存前の確認が必要（増減の推奨はしない）", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-07", "09:00"); // 2.5mg
  const now = D(2026, 10, 14, 12, 0);
  const input = { date: "2026-10-14", time: "09:00", dose: 5 };
  const first = L.applyAdministration(s, input, now);
  assert.equal(first.code, "CONFIRM_REQUIRED");
  assert.deepEqual(clone(first.needs), ["dose"]);
  assert.deepEqual(clone(first.assessment.needs.dose), { from: 2.5, to: 5 });
  const ok = L.applyAdministration(s, { ...input, confirmDose: true }, now);
  assert.equal(ok.ok, true);
  assert.equal(ok.record.doseConfirmedDifferent, true);
  // 同じ用量なら確認は要らない
  const same = L.applyAdministration(s, { date: "2026-10-21", time: "09:00", dose: 5 }, D(2026, 10, 21, 12, 0));
  assert.equal(same.ok, true);
  assert.equal(same.record.doseConfirmedDifferent, false);
});

test("用量の初期選択: 基準用量 > 直近の投与 > 2.5mg。28日以上の中断後は自動で選ばない", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  const now = D(2026, 10, 8, 12, 0);
  assert.equal(L.defaultDose(s, now), 2.5);
  admin(env, s, "2026-10-07", "09:00", { dose: 7.5 });
  assert.equal(L.defaultDose(s, now), 7.5);
  L.applyBaseDose(s, 5);
  assert.equal(L.defaultDose(s, now), 5);
  assert.equal(L.defaultDose(s, D(2026, 11, 5, 12, 0)), null, "28日以上空いたら null（自動選択しない）");
  assert.equal(L.applyBaseDose(s, 6).code, "INVALID_DOSE");
});

test("予定の投与: 予定(scheduled)を投与済みにする。定例日より後なら臨時投与(makeup)、同日なら定例のまま", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-09-30", "09:00");
  const p = sched(env, s, "2026-10-07", "09:00");
  const late = L.applyAdministration(s, { recordId: p.id, date: "2026-10-08", time: "10:00", dose: 2.5, confirmInterval: true }, D(2026, 10, 8, 12, 0));
  assert.equal(late.ok, true, JSON.stringify(late));
  assert.equal(p.status, "administered");
  assert.equal(p.kind, "makeup");
  assert.equal(p.regularDate, "2026-10-07", "元の定例日は残る");
  assert.equal(p.scheduledAt, "2026-10-07", "予定日と実施日は別フィールド");
  assert.equal(p.administeredAt, "2026-10-08");
  const s2 = stateWith(env);
  admin(env, s2, "2026-09-30", "09:00");
  const q = sched(env, s2, "2026-10-07", "09:00");
  assert.equal(L.applyAdministration(s2, { recordId: q.id, date: "2026-10-07", time: "09:05", dose: 2.5 }, D(2026, 10, 7, 12, 0)).record.kind, "regular");
});

test("投与記録の修正: 実施日・時刻・用量・メモを直せる。定例日と種別は変わらない", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  const a = admin(env, s, "2026-10-07", "09:00");
  const r = L.applyEditAdministration(s, a.id, { date: "2026-10-07", time: "09:45", dose: 2.5, comment: "遅れた" }, D(2026, 10, 8, 12, 0));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(a.administeredTime, "09:45");
  assert.equal(a.comment, "遅れた");
  assert.equal(a.kind, "regular");
  assert.equal(a.regularDate, "2026-10-07");
  assert.equal(L.applyEditAdministration(s, 999, { date: "2026-10-07", time: null, dose: 2.5 }, D(2026, 10, 8, 12, 0)).code, "NOT_ADMINISTERED");
});

// ---------- 次回提案（保存しない。確定は本人の操作） ----------

test("提案: 通常の投与の後は定例の次回（実施日+7日と同じ）。提案を見ただけでは何も保存されない", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-07", "09:00");
  const before = JSON.stringify(s);
  const p = L.suggestNext(s, D(2026, 10, 8, 12, 0));
  assert.deepEqual(clone(p), { date: "2026-10-14", time: "09:00", basis: "regular", regularDate: "2026-10-14" });
  assert.equal(JSON.stringify(s), before);
});

test("提案: 臨時投与（木曜に遅れて投与）の後も定例の系列（翌水曜）に戻る。実施日+7日にはしない", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-09-30", "09:00");
  admin(env, s, "2026-10-08", "10:00", { kind: "makeup", regularDate: "2026-10-07" });
  assert.equal(L.suggestNext(s, D(2026, 10, 8, 15, 0)).date, "2026-10-14", "10/15(木)ではなく10/14(水)");
  assert.equal(L.schedule(s).regular.weekday, 3, "定例曜日は自動変更しない");
});

test("提案: 定例日より前倒しで投与した後は、その回の定例日を再提案しない", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-12", "09:00", { kind: "oneOffChange", regularDate: "2026-10-14" });
  assert.equal(L.suggestNext(s, D(2026, 10, 12, 15, 0)).date, "2026-10-21");
});

test("提案: 見送りが最新のとき／予定があるとき／28日以上の中断後は出さない", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-09-30", "09:00");
  L.applySkip(s, { regularDate: "2026-10-07", reason: "userChoice" }, D(2026, 10, 8, 12, 0));
  assert.equal(L.suggestNext(s, D(2026, 10, 8, 12, 0)), null, "見送り後は「直前の投与日+7日」を再表示しない");
  const home = L.homeSummary(s, D(2026, 10, 8, 12, 0));
  assert.equal(home.mode, "unset", "次回予定は未設定。新しい予定は手動で登録する");

  const s2 = stateWith(env);
  admin(env, s2, "2026-10-07", "09:00");
  sched(env, s2, "2026-10-14", "09:00");
  assert.equal(L.suggestNext(s2, D(2026, 10, 8, 12, 0)), null, "予定があるときは出さない");

  const s3 = stateWith(env);
  admin(env, s3, "2026-10-07", "09:00");
  assert.equal(L.suggestNext(s3, D(2026, 11, 5, 12, 0)), null, "長期中断後は再開日を決めない");
});

test("提案: 過去の日付になる提案は出さない（打ち忘れの確認へ）／定例が未設定なら提案しない", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-07", "09:00");
  assert.equal(L.suggestNext(s, D(2026, 10, 16, 12, 0)), null);
  // 定例スケジュールが未設定のときは提案しない（確定できない提案を出さない。初回の予定を登録してもらう）
  const none = stateWith(env, { regular: false });
  admin(env, none, "2026-10-07", "09:00", { kind: "manual", regularDate: null });
  assert.equal(L.suggestNext(none, D(2026, 10, 8, 12, 0)), null);
});

test("提案の確定は本人の操作: 確定すると予定(scheduled, regular)が作られ、同時に2件にはならない", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-07", "09:00");
  const now = D(2026, 10, 8, 12, 0);
  const p = L.suggestNext(s, now);
  const r = L.applyScheduleNext(s, { date: p.date, time: p.time, regularDate: p.regularDate }, now);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.record.kind, "regular");
  assert.equal(r.record.status, "scheduled");
  assert.equal(r.record.scheduledAt, "2026-10-14");
  assert.equal(L.applyScheduleNext(s, { date: "2026-10-14", time: "09:00" }, now).code, "PENDING_EXISTS");
  assert.equal(L.suggestNext(s, now), null, "確定後は提案が消える");
});

test("見送り後の手動登録: 前回から72時間未満は確定不可（アプリ独自）／日付の範囲", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-07", "09:00");
  const now = D(2026, 10, 8, 12, 0);
  assert.equal(L.applyScheduleNext(s, { date: "2026-10-09", time: "09:00" }, now).code, "INTERVAL_UNDER_72H");
  assert.equal(L.applyScheduleNext(s, { date: "2026-10-07", time: "09:00" }, now).code, "PAST_DATE");
  assert.equal(L.applyScheduleNext(s, { date: "2027-02-01", time: "09:00" }, now).code, "TOO_FAR");
  assert.equal(s.injections.length, 1);
});

test("単発の日程変更を含めた登録: 定例日と違う日で確定すると oneOffChange（regularDate は元のまま）", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-07", "09:00");
  const r = L.applyScheduleNext(s, { date: "2026-10-15", time: "09:00", regularDate: "2026-10-14" }, D(2026, 10, 8, 12, 0));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.record.kind, "oneOffChange");
  assert.equal(r.record.regularDate, "2026-10-14");
});

// ---------- 初回の予定（定例スケジュールの設定） ----------

test("初回予定: 手動登録で定例曜日・予定時刻が決まる。二重の設定はできない", () => {
  const { env, L } = setup();
  const s = stateWith(env, { regular: false });
  const now = D(2026, 10, 8, 12, 0);
  const r = L.applyFirstSchedule(s, { date: "2026-10-14", time: "09:00" }, now);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(clone(L.schedule(s).regular), { id: 1, weekday: 3, time: "09:00", effectiveFrom: "2026-10-14" });
  assert.equal(L.schedule(s).history[0].type, "set");
  assert.equal(r.record.kind, "regular");
  assert.equal(L.applyFirstSchedule(s, { date: "2026-10-21", time: "09:00" }, now).code, "ALREADY_SET");
});

test("初回予定: 過去日・91日先・時刻の書式・規格外の基準用量は拒否し、何も保存しない", () => {
  const { env, L } = setup();
  const s = stateWith(env, { regular: false });
  const now = D(2026, 10, 8, 12, 0);
  const before = JSON.stringify(s);
  assert.equal(L.applyFirstSchedule(s, { date: "2026-10-07", time: "09:00" }, now).code, "PAST_DATE");
  assert.equal(L.applyFirstSchedule(s, { date: "2027-02-01", time: "09:00" }, now).code, "TOO_FAR");
  assert.equal(L.applyFirstSchedule(s, { date: "2026-10-14", time: "25:00" }, now).code, "INVALID_TIME");
  assert.equal(L.applyFirstSchedule(s, { date: "2026-10-14", time: "09:00", baseDoseMg: 4 }, now).code, "INVALID_DOSE");
  assert.equal(JSON.stringify(s), before);
});

// ---------- 見送り ----------

test("見送り: 今日以降の回・記録済みの回・不正な理由は拒否", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-09-30", "09:00");
  const now = D(2026, 10, 9, 12, 0);
  assert.equal(L.applySkip(s, { regularDate: "2026-10-09", reason: "userChoice" }, now).code, "NOT_PAST");
  assert.equal(L.applySkip(s, { regularDate: "2026-10-07", reason: "勝手に" }, now).code, "INVALID_REASON");
  assert.equal(L.applySkip(s, { regularDate: "2026-09-30", reason: "userChoice" }, now).code, "ALREADY_RECORDED");
  assert.equal(L.applySkip(s, { regularDate: "2026-10-07", reason: "userChoice" }, now).ok, true);
  assert.equal(L.applySkip(s, { regularDate: "2026-10-07", reason: "userChoice" }, now).code, "ALREADY_RECORDED");
});

test("見送り: 予定(scheduled)の見送りは、その記録を skipped にする（定例スケジュールは残る）", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-09-30", "09:00");
  const p = sched(env, s, "2026-10-07", "09:00");
  const r = L.applySkip(s, { recordId: p.id, regularDate: "2026-10-07", reason: "missedUnknown" }, D(2026, 10, 9, 12, 0));
  assert.equal(r.ok, true);
  assert.equal(p.status, "skipped");
  assert.equal(s.injections.length, 2);
  assert.ok(L.schedule(s).regular);
});

// ---------- 予定の取消と、投与済み・見送り履歴の削除は別の操作 ----------

test("予定の取消は scheduled だけ。定例スケジュール・履歴には触れない", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  const a = admin(env, s, "2026-10-07", "09:00");
  const p = sched(env, s, "2026-10-14", "09:00");
  const histBefore = JSON.stringify(L.schedule(s));
  assert.equal(L.applyCancelScheduled(s, a.id).code, "NOT_SCHEDULED", "投与済みは取消の対象ではない");
  assert.equal(L.applyCancelScheduled(s, p.id).ok, true);
  assert.equal(s.injections.length, 1);
  assert.equal(JSON.stringify(L.schedule(s)), histBefore, "定例スケジュールは残る");
  assert.equal(s.injections[0].status, "administered");
});

test("履歴の削除は administered / skipped だけ。予定は削除対象ではない", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  const a = admin(env, s, "2026-10-07", "09:00");
  const p = sched(env, s, "2026-10-14", "09:00");
  assert.equal(L.applyDeleteHistory(s, p.id).code, "NOT_HISTORY");
  assert.equal(L.applyDeleteHistory(s, a.id).ok, true);
  assert.equal(s.injections.length, 1);
  assert.equal(s.injections[0].status, "scheduled");
});

// ---------- 状態（status）と種別（kind）、HOME の表示 ----------

test("HOME要約: 次回予定日・予定時刻・未投与・時刻未設定の注意・今日投与済み", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-07", "09:00");
  const p = sched(env, s, "2026-10-14", null);
  const h = L.homeSummary(s, D(2026, 10, 7, 20, 0));
  assert.equal(h.mode, "scheduled");
  assert.equal(h.date, "2026-10-14");
  assert.equal(h.chip, "未投与");
  assert.equal(h.timeUnknown, true);
  assert.ok(h.notices.includes("timeUnset"));
  assert.equal(h.administeredToday, true);
  p.scheduledTime = "09:00";
  assert.equal(L.homeSummary(s, D(2026, 10, 14, 8, 0)).mode, "today");
  assert.equal(L.homeSummary(s, D(2026, 10, 14, 8, 0)).time, "09:00");
});

test("HOME要約: 記録のない回があれば missed（打ち忘れの注意）。見送りは次回として表示しない", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-09-30", "09:00");
  const m = L.homeSummary(s, D(2026, 10, 9, 12, 0));
  assert.equal(m.mode, "missed");
  assert.equal(m.date, "2026-10-07");
  assert.ok(m.notices.includes("missed"));
  const s2 = stateWith(env);
  rec(env, s2, { status: "skipped", kind: "regular", regularDate: "2026-10-07", scheduledAt: "2026-10-07", skipReason: "userChoice" });
  const h = L.homeSummary(s2, D(2026, 10, 8, 12, 0));
  assert.notEqual(h.mode, "scheduled", "見送りは「次回」として拾わない（v4で見送りを次回扱いした不具合の回帰）");
});

test("日付ヘルパー: 年が違うときだけ年を出す／72時間表記", () => {
  const { L } = setup();
  assert.equal(L.formatShortDate("2026-10-14", "2026-10-01"), "10/14（水）", "かっこは全角（HOMEの表記例に合わせる）");
  assert.equal(L.formatShortDate("2027-01-05", "2026-12-30"), "2027/1/5（火）");
  assert.equal(L.formatDuration(72 * 3600 * 1000), "72時間0分0秒");
  assert.equal(L.addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(L.addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(L.diffDays("2026-10-07", "2026-10-14"), 7);
});
