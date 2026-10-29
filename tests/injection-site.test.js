// 注射部位（任意項目 site）と次回候補。
// 部位は在庫・次回予定・72時間判定・打ち忘れ判定に一切影響しない。候補は毎回導出し、保存しない。
// すべてメモリ上のダミー（vm＋偽localStorage）。実データには触れない。

const test = require("node:test");
const assert = require("node:assert/strict");
const { D, setup, stateWith, admin, sched, rec, clone } = require("./injection-helpers");

const RLA = "rightLowerAbdomen";
const LLA = "leftLowerAbdomen";
const RT = "rightThigh";
const LT = "leftThigh";

test("INJECTION_SITES: 4つ・固定の並び・表示名（右腹部/左腹部とは書かない）", () => {
  const { env } = setup();
  const sites = clone(env.get("INJECTION_SITES"));
  assert.deepEqual(sites, [
    { id: RLA, label: "右下腹部" },
    { id: LLA, label: "左下腹部" },
    { id: RT, label: "右大腿" },
    { id: LT, label: "左大腿" },
  ]);
  assert.equal(env.get("createEmptyInjection()").site, null, "新しい記録は site:null");
  assert.equal(env.get("SCHEMA_VERSION"), 7, "schemaVersion は上げない");
});

// ============ ローテーション ============

test("ローテーション: 右下腹部→左下腹部→右大腿→左大腿→右下腹部", () => {
  const { L } = setup();
  assert.equal(L.nextSiteId(RLA), LLA);
  assert.equal(L.nextSiteId(LLA), RT);
  assert.equal(L.nextSiteId(RT), LT);
  assert.equal(L.nextSiteId(LT), RLA);
  assert.equal(L.nextSiteId("unknownSite"), null);
  assert.equal(L.nextSiteId(null), null);
  assert.equal(L.nextSiteId(undefined), null);
  assert.equal(L.siteLabel(LT), "左大腿");
  assert.equal(L.siteLabel("unknownSite"), null, "知らないIDは4つのどれにも置き換えない");
  assert.equal(L.siteLabel(undefined), null);
});

test("suggestSite: 直近の投与済みの部位の次を返す（4通り）", () => {
  const { env, L } = setup();
  const cases = [[RLA, LLA], [LLA, RT], [RT, LT], [LT, RLA]];
  for (const [from, to] of cases) {
    const s = stateWith(env);
    admin(env, s, "2026-10-07", "09:00", { site: from });
    const r = L.suggestSite(s);
    assert.equal(r.site, to, `${from} の次は ${to}`);
    assert.equal(r.basisSite, from);
    assert.equal(r.basisDate, "2026-10-07");
  }
});

test("suggestSite: 基準は直近の「実際に投与済み」だけ。新しい予定・見送りは無視する", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-07", "09:00", { site: RLA });
  admin(env, s, "2026-10-14", "09:00", { site: LLA });
  sched(env, s, "2026-10-21", "09:00", { site: RT }); // 予定に部位が入っていても数えない
  rec(env, s, { status: "skipped", kind: "regular", regularDate: "2026-10-28", scheduledAt: "2026-10-28", skipReason: "userChoice", site: LT });
  const r = L.suggestSite(s);
  assert.equal(r.site, RT, "最後の投与済み(左下腹部)の次");
  assert.equal(r.basisDate, "2026-10-14");
});

test("suggestSite: 基準の記録に部位が無ければ候補なし。部位のある古い記録へはさかのぼらない", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-07", "09:00", { site: RLA });
  admin(env, s, "2026-10-14", "09:00", { site: null }); // 最新に部位なし
  const r = L.suggestSite(s);
  assert.equal(r.site, null);
  assert.equal(r.reason, "basisSiteMissing");
  // 項目そのものが無い古い記録（site プロパティ無し）も同じ
  const s2 = stateWith(env);
  admin(env, s2, "2026-10-07", "09:00", { site: RLA });
  const old = admin(env, s2, "2026-10-14", "09:00");
  delete old.site;
  assert.equal(L.suggestSite(s2).site, null);
  assert.equal(L.suggestSite(s2).reason, "basisSiteMissing");
});

test("suggestSite: 知らないID（新しい版のバックアップ等）は候補なし。4つのどれにも置き換えない", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-07", "09:00", { site: "upperArm" });
  const r = L.suggestSite(s);
  assert.equal(r.site, null);
  assert.equal(r.reason, "basisSiteMissing");
  assert.equal(L.isSiteId("upperArm"), false);
  assert.equal(L.isSiteId(RT), true);
});

test("suggestSite: 投与済みが1件も無ければ候補なし。保存はしない（state は変わらない）", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  sched(env, s, "2026-10-07", "09:00", { site: RLA });
  const before = JSON.stringify(s);
  const r = L.suggestSite(s);
  assert.equal(r.site, null);
  assert.equal(r.reason, "noHistory");
  assert.equal(JSON.stringify(s), before);
  admin(env, s, "2026-10-14", "09:00", { site: LT });
  const before2 = JSON.stringify(s);
  L.suggestSite(s);
  assert.equal(JSON.stringify(s), before2, "候補を計算しても state は変わらない");
});

test("選んだ部位が次の基準になる（新規の投与を保存→候補が進む）", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-07", "09:00", { site: RLA });
  assert.equal(L.suggestSite(s).site, LLA);
  const r = L.applyAdministration(s, { date: "2026-10-14", time: "09:00", dose: 2.5, site: RT }, D(2026, 10, 14, 12, 0));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.record.site, RT, "候補(左下腹部)ではなく本人が選んだ部位が保存される");
  assert.equal(L.suggestSite(s).site, LT);
});

// ============ 候補を出してよい日付 ============

test("shouldShowSiteSuggestion: 最新の投与日以降だけ。さかのぼる日付・不正な日付・投与済み無しは出さない", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  assert.equal(L.shouldShowSiteSuggestion(s, "2026-10-14"), false, "投与済みが無い");
  admin(env, s, "2026-10-07", "09:00", { site: RLA });
  admin(env, s, "2026-10-14", "09:00", { site: LLA });
  assert.equal(L.shouldShowSiteSuggestion(s, "2026-10-21"), true);
  assert.equal(L.shouldShowSiteSuggestion(s, "2026-10-14"), true, "最新と同じ日付は出す");
  assert.equal(L.shouldShowSiteSuggestion(s, "2026-10-13"), false, "最新より前の日付");
  assert.equal(L.shouldShowSiteSuggestion(s, "2026-10-07"), false);
  assert.equal(L.shouldShowSiteSuggestion(s, ""), false);
  assert.equal(L.shouldShowSiteSuggestion(s, "bad"), false);
});

// ============ 入力の検証・保存 ============

test("INVALID_SITE: 空・null・undefined・既知のIDだけ通す。それ以外は拒否（state は変わらない）", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  const before = JSON.stringify(s);
  for (const bad of ["unknownSite", "右下腹部", 1, true, {}, "<b>x</b>"]) {
    const r = L.applyAdministration(s, { date: "2026-10-07", time: "09:00", dose: 2.5, confirmDose: true, site: bad }, D(2026, 10, 7, 12, 0));
    assert.equal(r.ok, false, String(bad));
    assert.equal(r.code, "INVALID_SITE", String(bad));
  }
  assert.equal(JSON.stringify(s), before);
  for (const good of [undefined, null, "", RLA, LLA, RT, LT]) {
    const s2 = stateWith(env);
    const r = L.applyAdministration(s2, { date: "2026-10-07", time: "09:00", dose: 2.5, confirmDose: true, site: good }, D(2026, 10, 7, 12, 0));
    assert.equal(r.ok, true, String(good) + JSON.stringify(r));
    assert.equal(r.record.site, good ? good : null);
  }
  const a = L.assessAdministration(s, { date: "2026-10-07", dose: 2.5, site: "zzz" }, D(2026, 10, 7, 12, 0));
  assert.equal(a.errors[0].code, "INVALID_SITE");
});

test("applyAdministration: 予定に結び付ける経路でも、新規作成の経路でも site を保存する。部位なしは従来どおり", () => {
  const { env, L } = setup();
  // 予定に結び付け
  const s = stateWith(env);
  const p = sched(env, s, "2026-10-07", "09:00");
  const r1 = L.applyAdministration(s, { recordId: p.id, date: "2026-10-07", time: "09:05", dose: 2.5, confirmDose: true, site: LLA }, D(2026, 10, 7, 12, 0));
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.equal(r1.record.id, p.id);
  assert.equal(r1.record.site, LLA);
  // 新規作成
  const s2 = stateWith(env);
  const r2 = L.applyAdministration(s2, { date: "2026-10-07", time: "09:05", dose: 2.5, confirmDose: true, site: RT, noLink: true }, D(2026, 10, 7, 12, 0));
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(r2.record.site, RT);
  // 部位なし（従来どおり）
  const s3 = stateWith(env);
  const r3 = L.applyAdministration(s3, { date: "2026-10-07", time: "09:05", dose: 2.5, confirmDose: true, noLink: true }, D(2026, 10, 7, 12, 0));
  assert.equal(r3.ok, true);
  assert.equal(r3.record.site, null);
  // 結び付けで site 未指定なら、既存の値を勝手に消さない
  const s4 = stateWith(env);
  const p4 = sched(env, s4, "2026-10-07", "09:00");
  const r4 = L.applyAdministration(s4, { recordId: p4.id, date: "2026-10-07", time: "09:05", dose: 2.5, confirmDose: true }, D(2026, 10, 7, 12, 0));
  assert.equal(r4.ok, true);
  assert.equal(r4.record.site, null);
});

test("部位の有無で、確認の要否（用量・間隔）は変わらない。部位を変えても新しい確認は求めない", () => {
  const { env, L } = setup();
  const mk = (site) => {
    const s = stateWith(env);
    admin(env, s, "2026-10-07", "09:00", { site: RLA });
    return L.assessAdministration(s, { date: "2026-10-08", time: "09:00", dose: 2.5, site }, D(2026, 10, 8, 12, 0));
  };
  const a0 = mk(undefined);
  const a1 = mk(LLA);
  assert.deepEqual(clone(a1.needs), clone(a0.needs), "間隔(72時間未満)の確認は部位があっても同じ");
  assert.ok(a0.needs.interval, "元から間隔の確認が必要なケース");
  // 確認不要なケースでは、部位を付けても確認が増えない
  const s = stateWith(env);
  admin(env, s, "2026-10-07", "09:00", { site: RLA });
  for (const site of [undefined, null, "", LLA, RT]) {
    const a = L.assessAdministration(s, { date: "2026-10-14", time: "09:00", dose: 2.5, site }, D(2026, 10, 14, 12, 0));
    assert.deepEqual(clone(a.errors), []);
    assert.equal(a.needs.dose, null);
    assert.equal(a.needs.interval, null);
  }
});

test("applyEditAdministration: site を保存する。未指定なら既存の部位を残す。部位だけの修正は新しい確認を求めない", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  const a = admin(env, s, "2026-10-07", "09:00", { site: RLA });
  const b = admin(env, s, "2026-10-14", "09:00");
  // 部位だけ付ける（日付・時刻・用量は同じ）→確認不要
  const r = L.applyEditAdministration(s, b.id, { date: "2026-10-14", time: "09:00", dose: 2.5, site: LLA }, D(2026, 10, 15, 9, 0));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(b.site, LLA);
  // site 未指定の修正では残る
  const r2 = L.applyEditAdministration(s, b.id, { date: "2026-10-14", time: "09:30", dose: 2.5, comment: "x" }, D(2026, 10, 15, 9, 0));
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(b.site, LLA);
  // null / "" で未記録に戻る
  assert.equal(L.applyEditAdministration(s, b.id, { date: "2026-10-14", time: "09:30", dose: 2.5, site: null }, D(2026, 10, 15, 9, 0)).ok, true);
  assert.equal(b.site, null);
  assert.equal(L.applyEditAdministration(s, a.id, { date: "2026-10-07", time: "09:00", dose: 2.5, site: "zzz" }, D(2026, 10, 15, 9, 0)).code, "INVALID_SITE");
  assert.equal(a.site, RLA, "拒否されたら変わらない");
  // 知らないIDが付いた記録を、site 未指定で修正しても消えない
  const c = admin(env, s, "2026-10-21", "09:00", { site: "upperArm" });
  assert.equal(L.applyEditAdministration(s, c.id, { date: "2026-10-21", time: "09:10", dose: 2.5 }, D(2026, 10, 22, 9, 0)).ok, true);
  assert.equal(c.site, "upperArm");
});

// ============ applySetSite ============

test("applySetSite: site と updatedAt 以外は一切変えない（記録をまるごと比較）", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  const p = sched(env, s, "2026-10-14", "09:00");
  admin(env, s, "2026-10-07", "09:00", { stockCount: "counts", doseConfirmedDifferent: true, createdAt: "2026-10-07T00:00:00.000Z", updatedAt: "2026-10-07T00:00:00.000Z", comment: "メモ", scheduleVersionId: 1 });
  const target = s.injections.find((r) => r.status === "administered");
  const beforeAll = clone(s);
  const beforeRec = clone(target);
  const now = D(2026, 10, 20, 8, 0);
  const r = L.applySetSite(s, target.id, LLA, now);
  assert.equal(r.ok, true, JSON.stringify(r));
  const afterRec = clone(target);
  assert.equal(afterRec.site, LLA);
  assert.equal(afterRec.updatedAt, now.toISOString(), "updatedAt は更新される");
  const { site: _s1, updatedAt: _u1, ...restBefore } = beforeRec;
  const { site: _s2, updatedAt: _u2, ...restAfter } = afterRec;
  assert.deepEqual(restAfter, restBefore, "site/updatedAt 以外は同一");
  // 他の記録・スケジュール・在庫・プロフィールも不変
  const afterAll = clone(s);
  afterAll.injections = afterAll.injections.filter((x) => x.id !== target.id);
  beforeAll.injections = beforeAll.injections.filter((x) => x.id !== target.id);
  assert.deepEqual(afterAll, beforeAll);
  assert.equal(p.status, "scheduled");
});

test("applySetSite: 投与済みだけが対象。予定・見送り・存在しないIDは拒否。INVALID_SITE。未記録に戻せる", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  const a = admin(env, s, "2026-10-07", "09:00");
  const p = sched(env, s, "2026-10-14", "09:00");
  const k = rec(env, s, { status: "skipped", kind: "regular", regularDate: "2026-10-21", scheduledAt: "2026-10-21", skipReason: "userChoice" });
  const now = D(2026, 10, 20, 8, 0);
  const before = JSON.stringify(s);
  assert.equal(L.applySetSite(s, p.id, RLA, now).code, "NOT_ADMINISTERED");
  assert.equal(L.applySetSite(s, k.id, RLA, now).code, "NOT_ADMINISTERED");
  assert.equal(L.applySetSite(s, 9999, RLA, now).code, "NOT_ADMINISTERED");
  assert.equal(L.applySetSite(s, a.id, "zzz", now).code, "INVALID_SITE");
  assert.equal(L.applySetSite(s, a.id, undefined, now).code, "INVALID_SITE");
  assert.equal(L.applySetSite(s, a.id, 3, now).code, "INVALID_SITE");
  assert.equal(JSON.stringify(s), before, "失敗したら何も変わらない");
  assert.equal(L.applySetSite(s, String(a.id), RT, now).ok, true, "id は文字列でも通る（画面の data 属性）");
  assert.equal(a.site, RT);
  assert.equal(L.applySetSite(s, a.id, null, now).ok, true);
  assert.equal(a.site, null, "未記録に戻せる");
  assert.equal(L.applySetSite(s, a.id, "", now).ok, true);
  assert.equal(a.site, null);
});

test("applySetSite: 用量が基準と違う記録・72時間未満の記録でも、確認を求めずに部位だけ付けられる", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-07", "09:00", { dose: 2.5 });
  const odd = admin(env, s, "2026-10-08", "09:00", { dose: 5 }); // 72時間未満・用量違い
  const r = L.applySetSite(s, odd.id, LLA, D(2026, 10, 20, 8, 0));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(odd.dose, 5);
  assert.equal(odd.administeredAt, "2026-10-08");
  assert.equal(odd.doseConfirmedDifferent, false, "確認フラグは触らない");
});

// ============ 在庫・次回予定・判定への非干渉 ============

// 実際の5件を、本物のロジックでメモリ上に再現する（本番データではない）
function reproduceFive(env, L, withSites) {
  const s = env.get("createDefaultState()");
  s.profile.startDate = "2026-10-01";
  const sites = withSites ? [RLA, LLA, RT, LT, RLA] : [undefined, undefined, undefined, undefined, undefined];
  const opt = (i) => (sites[i] ? { site: sites[i] } : {});
  // 10/2 14:45 手動の投与（定例スケジュール設定前）
  let r = L.applyAdministration(s, { date: "2026-10-02", time: "14:45", dose: 2.5, confirmDose: true, noLink: true, ...opt(0) }, D(2026, 10, 2, 15, 0));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.record.kind, "manual");
  // 定例: 木曜 08:00、10/8 から
  r = L.applyFirstSchedule(s, { date: "2026-10-08", time: "08:00" }, D(2026, 10, 3, 9, 0));
  assert.equal(r.ok, true, JSON.stringify(r));
  const rounds = [
    ["2026-10-08", "08:23", D(2026, 10, 8, 9, 0), 1],
    ["2026-10-15", "08:32", D(2026, 10, 15, 9, 0), 2],
    ["2026-10-22", "08:40", D(2026, 10, 22, 9, 0), 3],
    ["2026-10-29", "08:35", D(2026, 10, 29, 9, 0), 4],
  ];
  for (const [date, time, now, i] of rounds) {
    if (date !== "2026-10-08") {
      // 次回の予定を提案どおり確定してから、その予定に結び付けて投与する
      const prev = L.applyScheduleNext(s, { date, time: "08:00" }, D(2026, 10, Number(date.slice(8)) - 7, 12, 0));
      assert.equal(prev.ok, true, `${date} ${JSON.stringify(prev)}`);
    }
    const sc = s.injections.find((x) => x.status === "scheduled" && x.scheduledAt === date);
    assert.ok(sc, `${date} の予定がある`);
    const a = L.applyAdministration(s, { recordId: sc.id, date, time, dose: 2.5, confirmDose: true, ...opt(i) }, now);
    assert.equal(a.ok, true, `${date} ${JSON.stringify(a)}`);
    assert.equal(a.record.id, sc.id, "予定に結び付く");
  }
  return s;
}

test("実際の5件の再現（10/29 09:00）: 使用5本・残り19本・次回11/05・候補は左下腹部", () => {
  const { env, L } = setup();
  const now = D(2026, 10, 29, 9, 0);
  const s = reproduceFive(env, L, true);
  assert.equal(L.administered(s).length, 5);
  assert.deepEqual(clone(L.administered(s).map((r) => r.administeredAt)), ["2026-10-02", "2026-10-08", "2026-10-15", "2026-10-22", "2026-10-29"]);
  const k = L.stockSummary(s);
  assert.equal(k.used, 5);
  assert.equal(k.remaining, 19);
  assert.equal(k.needsReview, false);
  assert.equal(L.nextRegularFromState(s, now), "2026-11-05");
  const h = L.homeSummary(s, now);
  assert.equal(h.mode, "proposal");
  assert.equal(h.date, "2026-11-05");
  assert.equal(L.suggestNext(s, now).date, "2026-11-05");
  assert.equal(L.evaluateMissedDose(s, now).status, "nothingMissed");
  // 5件目(10/29)は右下腹部 → 次は左下腹部
  const sg = L.suggestSite(s);
  assert.equal(sg.site, LLA);
  assert.equal(L.siteLabel(sg.site), "左下腹部");
  // 並び: 右下腹部→左下腹部→右大腿→左大腿→右下腹部
  assert.deepEqual(clone(L.administered(s).map((r) => r.site)), [RLA, LLA, RT, LT, RLA]);
});

test("部位の有無で、在庫・HOME要約・次回提案・打ち忘れ・cursor・72時間判定は完全に同一", () => {
  const { env, L } = setup();
  const now = D(2026, 10, 29, 9, 0);
  const withS = reproduceFive(env, L, true);
  const noS = reproduceFive(env, L, false);
  assert.deepEqual(clone(L.stockSummary(withS)), clone(L.stockSummary(noS)));
  assert.deepEqual(clone(L.homeSummary(withS, now)), clone(L.homeSummary(noS, now)));
  assert.deepEqual(clone(L.suggestNext(withS, now)), clone(L.suggestNext(noS, now)));
  assert.deepEqual(clone(L.evaluateMissedDose(withS, now)), clone(L.evaluateMissedDose(noS, now)));
  assert.equal(L.cursor(withS), L.cursor(noS));
  assert.equal(L.nextRegularFromState(withS, now), L.nextRegularFromState(noS, now));
  assert.deepEqual(clone(L.uncoveredItems(withS, now)), clone(L.uncoveredItems(noS, now)));
  assert.equal(L.daysSinceLast(withS, "2026-10-29"), L.daysSinceLast(noS, "2026-10-29"));
  assert.equal(L.referenceDose(withS), L.referenceDose(noS));
  const probe = { date: "2026-10-30", time: "08:00", dose: 2.5 };
  assert.deepEqual(clone(L.assessAdministration(withS, probe, now)), clone(L.assessAdministration(noS, probe, now)));
  // 部位以外の項目は記録ごとに同一（id/日付/用量/stockCount/kind/regularDate）
  const strip = (st) => st.injections.map(({ site, ...rest }) => rest);
  assert.deepEqual(clone(strip(withS)), clone(strip(noS)));
});

test("後から applySetSite で5件に部位を付けても、在庫・次回・判定は変わらない（updatedAt 以外の記録も不変）", () => {
  const { env, L } = setup();
  const now = D(2026, 10, 29, 9, 0);
  const s = reproduceFive(env, L, false);
  const before = {
    stock: clone(L.stockSummary(s)),
    home: clone(L.homeSummary(s, now)),
    next: clone(L.suggestNext(s, now)),
    missed: clone(L.evaluateMissedDose(s, now)),
    cursor: L.cursor(s),
  };
  assert.equal(L.suggestSite(s).site, null, "全て未記録なら候補なし");
  const order = [RLA, LLA, RT, LT, RLA];
  L.administered(s).forEach((r, i) => assert.equal(L.applySetSite(s, r.id, order[i], D(2026, 10, 29, 10, i)).ok, true));
  assert.deepEqual(clone(L.stockSummary(s)), before.stock);
  assert.deepEqual(clone(L.homeSummary(s, now)), before.home);
  assert.deepEqual(clone(L.suggestNext(s, now)), before.next);
  assert.deepEqual(clone(L.evaluateMissedDose(s, now)), before.missed);
  assert.equal(L.cursor(s), before.cursor);
  assert.equal(L.suggestSite(s).site, LLA);
});

test("既存の記録に site を書き込まない: 古い記録（site 項目なし）は触れずに残り、未記録として扱う", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  const a = admin(env, s, "2026-10-07", "09:00");
  delete a.site;
  const snapshot = JSON.stringify(s);
  L.suggestSite(s);
  L.stockSummary(s);
  L.homeSummary(s, D(2026, 10, 8, 9, 0));
  assert.equal(JSON.stringify(s), snapshot, "読み取り系の関数は state を書き換えない");
  assert.equal("site" in a, false);
  assert.equal(L.siteLabel(a.site), null);
});
