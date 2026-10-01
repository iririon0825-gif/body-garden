// Opus レビュー（注射管理）の指摘に対応するテスト
// 前提: 定例は水曜 09:00（2026-10-07・10-14・10-21 は水曜）。

const test = require("node:test");
const assert = require("node:assert/strict");
const { D, setup, stateWith, admin, sched, clone } = require("./injection-helpers");

test("A-1: 予定がある日に recordId なしで記録しても、その予定の投与として結び付く（予定が未投与のまま残らない）", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-07", "09:00");
  const p = sched(env, s, "2026-10-14", "09:00");
  const now = D(2026, 10, 14, 12, 0);
  const r = L.applyAdministration(s, { date: "2026-10-14", time: "09:10", dose: 2.5, confirmDose: false }, now);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(s.injections.length, 2, "新しい記録を作らず、予定を投与済みにする");
  assert.equal(p.status, "administered");
  assert.equal(p.administeredAt, "2026-10-14");
  // 翌日: 存在しない打ち忘れが出ない
  const next = D(2026, 10, 15, 12, 0);
  assert.equal(L.evaluateMissedDose(s, next).status, "nothingMissed");
  assert.notEqual(L.homeSummary(s, next).mode, "missed");
  assert.equal(L.homeSummary(s, D(2026, 10, 14, 15, 0)).administeredToday, true);
});

test("A-1: recordId が空文字のときは「結び付けない指定なし」と同じ扱い（日付が一致する予定に結び付く）", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-07", "09:00");
  const p = sched(env, s, "2026-10-14", "09:00");
  const r = L.applyAdministration(s, { recordId: "", date: "2026-10-14", time: "09:10", dose: 2.5 }, D(2026, 10, 14, 12, 0));
  assert.equal(r.ok, true);
  assert.equal(p.status, "administered");
});

test("A-1: 結び付けない指定(noLink)なら、予定はそのまま残る", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-07", "09:00");
  const p = sched(env, s, "2026-10-14", "09:00");
  const r = L.applyAdministration(s, { noLink: true, date: "2026-10-14", time: "09:10", dose: 2.5 }, D(2026, 10, 14, 12, 0));
  assert.equal(r.ok, true);
  assert.equal(p.status, "scheduled");
  assert.equal(s.injections.length, 3);
});

test("A-1: 投与済みと同じ定例日の期限切れの予定（孤立した予定）は、記録のない回として扱わない", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-07", "09:00");
  admin(env, s, "2026-10-14", "09:10"); // 記録済みの回
  const orphan = sched(env, s, "2026-10-14", "09:00"); // 同じ回の予定が未投与のまま残っている
  const now = D(2026, 10, 15, 12, 0);
  assert.equal(L.uncoveredItems(s, now).length, 0);
  assert.equal(L.evaluateMissedDose(s, now).status, "nothingMissed");
  assert.equal(L.applyCancelScheduled(s, orphan.id).ok, true, "孤立した予定は取消できる");
});

test("A-2: 前倒しした単発変更の予定を打ち忘れたとき、対象の日付は変更後の予定日（今日以降にならない）", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-07", "09:00");
  const p = sched(env, s, "2026-10-12", "09:00", { kind: "oneOffChange", regularDate: "2026-10-14" }); // 10/14 の回を月曜に前倒し
  const now = D(2026, 10, 13, 12, 0);
  const ev = L.evaluateMissedDose(s, now);
  assert.equal(ev.status, "judged");
  assert.equal(ev.target.date, "2026-10-12", "予定していた日（変更後）");
  assert.equal(ev.target.regularDate, "2026-10-14", "属する定例日は別に持つ");
  const sk = L.applySkip(s, { recordId: p.id, regularDate: ev.target.regularDate, reason: "userChoice" }, now);
  assert.equal(sk.ok, true, JSON.stringify(sk));
  assert.equal(p.status, "skipped");
});

test("A-2: 予定日が今日以降の予定は、見送りにできない", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  const p = sched(env, s, "2026-10-14", "09:00");
  assert.equal(L.applySkip(s, { recordId: p.id, regularDate: "2026-10-14", reason: "userChoice" }, D(2026, 10, 14, 8, 0)).code, "NOT_PAST");
});

test("A-3: 予定時刻の設定だけを行える（未記録の回があっても）。時刻が入ると判定不能が解消する", () => {
  const { env, L } = setup();
  const s = stateWith(env, { time: null });
  admin(env, s, "2026-09-30", "09:00");
  const now = D(2026, 10, 11, 12, 0); // 10/7 が記録なし。予定時刻が不明なので判定不能
  assert.equal(L.evaluateMissedDose(s, now).judgment.result, "unknown");
  assert.equal(L.canChangeSchedule(s, now).code, "UNCOVERED_PAST", "曜日変更は先に打ち忘れの処理が必要");
  const r = L.applyRegularTime(s, "09:00", now);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(L.schedule(s).regular.time, "09:00");
  assert.equal(L.schedule(s).regular.weekday, 3, "曜日・開始日は変わらない");
  assert.equal(L.schedule(s).regular.effectiveFrom, "2026-09-30");
  assert.equal(L.schedule(s).history.at(-1).type, "timeChange");
  const after = L.evaluateMissedDose(s, now).judgment;
  assert.equal(after.result, "lt72", "時刻が入ったので判定できる（10/11 12:00 → 10/14 09:00 は69時間）");
  assert.equal(L.formatDuration(after.minMs), "69時間0分0秒");
});

test("A-3: 予定時刻の設定: 書式不正・変更なし・未設定・前回から72時間未満になる予定は拒否", () => {
  const { env, L } = setup();
  const s = stateWith(env, { time: "09:00" });
  admin(env, s, "2026-10-12", "20:00", { kind: "manual", regularDate: null });
  sched(env, s, "2026-10-14", "09:00");
  const now = D(2026, 10, 13, 9, 0);
  assert.equal(L.applyRegularTime(s, "9:00", now).code, "INVALID_TIME");
  assert.equal(L.applyRegularTime(s, "09:00", now).code, "NO_CHANGE");
  assert.equal(L.applyRegularTime(s, "10:00", now).code, "INTERVAL_UNDER_72H", "10/12 20:00 から 10/14 10:00 は 38時間");
  const none = stateWith(env, { regular: false });
  assert.equal(L.applyRegularTime(none, "09:00", now).code, "NO_SCHEDULE");
});

test("A-4: 前回の実投与から72時間以上あかない提案は出さない（確定できない提案を表示しない）", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-12", "09:00", { kind: "manual", regularDate: null }); // 月曜に手動で投与
  assert.equal(L.suggestNext(s, D(2026, 10, 12, 15, 0)), null, "10/14 09:00 は48時間後");
  const ok = stateWith(env);
  admin(env, ok, "2026-10-07", "09:00");
  assert.equal(L.suggestNext(ok, D(2026, 10, 8, 12, 0)).date, "2026-10-14");
});

test("A-5: 初回の記録は、用量の確認が必須（初期選択のまま、別の用量で保存してしまわない）。修正では不要", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  const now = D(2026, 10, 8, 12, 0);
  const input = { date: "2026-10-08", time: "09:00", dose: 2.5 };
  const a = L.assessAdministration(s, input, now);
  assert.equal(a.needs.dose.first, true);
  assert.equal(L.applyAdministration(s, input, now).code, "CONFIRM_REQUIRED");
  const ok = L.applyAdministration(s, { ...input, confirmDose: true }, now);
  assert.equal(ok.ok, true);
  const edit = L.applyEditAdministration(s, ok.record.id, { date: "2026-10-08", time: "09:30", dose: 2.5 }, now);
  assert.equal(edit.ok, true, "既存の記録の修正に、初回の確認は出ない");
});

test("A-6: 種別は「予定日より後に投与したときだけ」臨時投与(makeup)", () => {
  const { env, L } = setup();
  const mk = () => {
    const s = stateWith(env);
    admin(env, s, "2026-10-07", "09:00");
    const p = sched(env, s, "2026-10-16", "09:00", { kind: "oneOffChange", regularDate: "2026-10-14" }); // 金曜に変更
    return { s, p };
  };
  const a = mk();
  assert.equal(L.applyAdministration(a.s, { recordId: a.p.id, date: "2026-10-15", time: "09:00", dose: 2.5, confirmDose: true }, D(2026, 10, 15, 12, 0)).ok, true);
  assert.equal(a.p.kind, "oneOffChange", "予定日より前（木曜）は makeup にしない");
  const b = mk();
  assert.equal(L.applyAdministration(b.s, { recordId: b.p.id, date: "2026-10-17", time: "09:00", dose: 2.5, confirmDose: true }, D(2026, 10, 17, 12, 0)).ok, true);
  assert.equal(b.p.kind, "makeup", "予定日より後（土曜）は臨時投与");
});

test("A-7: 前後の両方の投与と72時間未満のときは、両方を知らせる", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-07", "09:00");
  admin(env, s, "2026-10-09", "09:00");
  const a = L.assessAdministration(s, { date: "2026-10-08", time: "09:00", dose: 2.5 }, D(2026, 10, 10, 12, 0));
  assert.deepEqual(clone(a.needs.intervals.map((x) => x.with)), ["prev", "next"]);
});

test("A-8: 曜日変更の候補に、今日のすでに過ぎた時刻は含めない。1週間より先の候補は日数を持つ", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-09-30", "09:00");
  const now = D(2026, 10, 8, 10, 0); // 木曜 10:00
  const c = L.weekdayChangeCandidates(s, { weekday: 4, time: "09:00" }, now);
  assert.equal(c[0].date, "2026-10-15", "今日(木) 09:00 はすでに過ぎている");
  assert.equal(c[0].daysFromToday, 7);
  const later = L.weekdayChangeCandidates(s, { weekday: 4, time: "11:00" }, now);
  assert.equal(later[0].date, "2026-10-08", "今日の11:00はまだ先");
  const fri = L.weekdayChangeCandidates(s, { weekday: 3, time: "09:00" }, now);
  assert.equal(fri[0].daysFromToday, 6);
});

test("B-7: 未来の予定が2件以上あるときは、曜日変更を拒否する（旧曜日の予定を残さない）", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-07", "09:00");
  sched(env, s, "2026-10-14", "09:00");
  sched(env, s, "2026-10-21", "09:00");
  const r = L.applyWeekdayChange(s, { weekday: 4, time: "09:00", firstDate: "2026-10-15" }, D(2026, 10, 8, 10, 0));
  assert.equal(r.code, "MULTIPLE_PENDING");
});

test("C-5: 定例が未設定なら提案は出ない（HOMEとタブで食い違わない）", () => {
  const { env, L } = setup();
  const s = stateWith(env, { regular: false });
  admin(env, s, "2026-10-07", "09:00", { kind: "legacy", regularDate: null });
  assert.equal(L.homeSummary(s, D(2026, 10, 8, 12, 0)).mode, "unset");
});

test("B-4: 実施日のない投与済みの記録（以前のデータ）は、計算から除外され、バックアップでは警告にとどまる", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  s.injections.push(Object.assign(env.get("createEmptyInjection()"), { id: 1, status: "administered", kind: "legacy", administeredAt: null, dose: 2.5 }));
  assert.equal(L.lastAdministered(s), null);
  assert.doesNotThrow(() => L.homeSummary(s, D(2026, 10, 8, 12, 0)));
  const text = env.Backup.serialize(s);
  const r = env.Backup.parse(text, null);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.warnings.some((w) => w.includes("実施日")));
});
