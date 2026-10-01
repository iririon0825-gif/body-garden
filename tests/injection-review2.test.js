// Opus 再レビュー（2回目）の指摘に対応するテスト: 予定との結び付け範囲、用量確認の基準、在庫の切替、
// 開発中データの補完、HOME注射カードの表示（注意の優先・要確認・日付の表記）、Service Worker のキャッシュ

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { D, setup, stateWith, admin, sched, clone } = require("./injection-helpers");
const { loadEnv, sampleState, exportText } = require("./helpers");

// ---------- 高: 予定との結び付け範囲 ----------

test("高: 今後の予定（10/14）があるとき、先週分（10/7）の記録は、その予定に結び付けられない（予定が消えない）", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  const p = sched(env, s, "2026-10-14", "09:00");
  const now = D(2026, 10, 9, 12, 0);
  const explicit = L.applyAdministration(s, { recordId: p.id, date: "2026-10-07", time: "09:00", dose: 2.5, confirmDose: true }, now);
  assert.equal(explicit.ok, false);
  assert.equal(explicit.code, "LINK_OUT_OF_RANGE");
  assert.equal(p.status, "scheduled", "予定はそのまま残る");
  assert.deepEqual(clone(L.linkCandidates(s, "2026-10-07").map((r) => r.id)), [], "10/7 に結び付けてよい予定はない");
  const free = L.applyAdministration(s, { noLink: true, date: "2026-10-07", time: "09:00", dose: 2.5, confirmDose: true }, now);
  assert.equal(free.ok, true, JSON.stringify(free));
  assert.equal(p.status, "scheduled");
  assert.equal(p.scheduledAt, "2026-10-14");
  assert.equal(L.homeSummary(s, now).mode, "scheduled", "10/14 の予定は表示され続ける");
});

test("高: 結び付けの範囲は「予定日の6日前〜次の定例日の前日」。範囲内なら結び付く", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  sched(env, s, "2026-10-14", "09:00");
  assert.equal(L.linkCandidates(s, "2026-10-08").length, 1, "6日前（前倒し）は範囲内");
  assert.equal(L.linkCandidates(s, "2026-10-07").length, 0, "7日前は範囲外");
  assert.equal(L.linkCandidates(s, "2026-10-14").length, 1, "当日");
  assert.equal(L.linkCandidates(s, "2026-10-20").length, 1, "次の定例日(10/21)の前日まで");
  assert.equal(L.linkCandidates(s, "2026-10-21").length, 0, "次の定例日以降は範囲外");
});

test("高: recordId なしの自動結び付けも、範囲外なら結び付かない", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  const p = sched(env, s, "2026-10-14", "09:00", { kind: "regular", regularDate: "2026-10-07" }); // 定例日と予定日が違う
  const r = L.applyAdministration(s, { date: "2026-10-07", time: "09:00", dose: 2.5, confirmDose: true }, D(2026, 10, 9, 12, 0));
  assert.equal(r.ok, true);
  assert.equal(p.status, "scheduled", "定例日が一致しても、予定日(10/14)から離れていれば結び付けない");
  assert.equal(s.injections.length, 2);
});

test("中: 孤立した予定（すでに記録済みの回）には結び付けられない", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-14", "09:10");
  const orphan = sched(env, s, "2026-10-14", "09:00");
  const r = L.applyAdministration(s, { recordId: orphan.id, date: "2026-10-14", time: "09:30", dose: 2.5, confirmInterval: true }, D(2026, 10, 14, 12, 0));
  assert.equal(r.code, "ALREADY_RECORDED");
  assert.equal(L.linkCandidates(s, "2026-10-14").length, 0);
});

test("低: 同じ日付の予定が2件あるときは、自動では結び付けない（曖昧なまま結び付けない）", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  const a = sched(env, s, "2026-10-14", "09:00");
  const b = sched(env, s, "2026-10-14", "10:00");
  const r = L.applyAdministration(s, { date: "2026-10-14", time: "09:10", dose: 2.5, confirmDose: true }, D(2026, 10, 14, 12, 0));
  assert.equal(r.ok, true);
  assert.equal(a.status, "scheduled");
  assert.equal(b.status, "scheduled");
});

// ---------- 中: 用量確認の基準 ----------

test("中: 古い記録のメモだけを直しても、用量の確認は出ない（用量を変えていないとき）", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  const first = admin(env, s, "2026-09-30", "09:00", { dose: 2.5 });
  admin(env, s, "2026-10-07", "09:00", { dose: 5 });
  const r = L.applyEditAdministration(s, first.id, { date: "2026-09-30", time: "09:00", dose: 2.5, comment: "メモ" }, D(2026, 10, 8, 12, 0));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(first.comment, "メモ");
});

test("中: 用量の比較基準は「時系列で直前の投与」。過去分の新規入力でも、直前の投与と比べる", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-09-30", "09:00", { dose: 2.5 });
  admin(env, s, "2026-10-14", "09:00", { dose: 5 });
  const now = D(2026, 10, 20, 12, 0);
  assert.equal(L.assessAdministration(s, { date: "2026-10-07", time: "09:00", dose: 2.5 }, now).needs.dose, null);
  assert.equal(L.assessAdministration(s, { date: "2026-10-07", time: "09:00", dose: 5 }, now).needs.dose.from, 2.5);
});

test("低: 用量のない以前の記録が最新でも、数値の用量がある直近の記録と比べる。初回の確認は『用量を変えた』扱いにしない", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-09-30", "09:00", { dose: 5 });
  admin(env, s, "2026-10-07", "09:00", { dose: null, kind: "legacy", regularDate: null });
  const a = L.assessAdministration(s, { date: "2026-10-14", time: "09:00", dose: 5 }, D(2026, 10, 14, 12, 0));
  assert.equal(a.needs.dose, null, "5mg の記録までさかのぼって比べる");
  const empty = stateWith(env);
  const r = L.applyAdministration(empty, { date: "2026-10-08", time: "09:00", dose: 2.5, confirmDose: true }, D(2026, 10, 8, 12, 0));
  assert.equal(r.ok, true);
  assert.equal(r.record.doseConfirmedDifferent, false, "初回の確認は doseConfirmedDifferent にしない");
});

// ---------- 中: 在庫の確認の切替（取り消し手段） ----------

test("中: 在庫の数え方を、いつでも切り替えられる（確認の取り消し）。記録は消えない", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  const a = admin(env, s, "2026-10-07", "09:00", { stockCount: "review" });
  assert.equal(L.applyStockReview(s, a.id, "excluded").ok, true);
  assert.equal(L.stockSummary(s).remaining, 24);
  assert.equal(L.applyStockSet(s, a.id, "counts").ok, true, "数えない → 数える に戻せる");
  assert.equal(L.stockSummary(s).remaining, 23);
  assert.equal(L.applyStockSet(s, a.id, "excluded").ok, true);
  assert.equal(L.stockSummary(s).remaining, 24);
  assert.equal(L.applyStockSet(s, a.id, "どちらでも").code, "INVALID_DECISION");
  const p = sched(env, s, "2026-10-14", "09:00");
  assert.equal(L.applyStockSet(s, p.id, "counts").code, "NOT_ADMINISTERED", "予定は対象外");
  assert.equal(s.injections.length, 2);
});

test("低: 在庫の設定が無い状態で計算しても、全件を差し引かない（要確認として扱う）", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-07", "09:00");
  delete s.injectionStock;
  const k = L.stockSummary(s);
  assert.equal(k.needsReview, true);
  assert.equal(k.remaining, 24);
  assert.equal(k.used, 0);
});

// ---------- 取り込み・読み込みの補完 ----------

test("低: v4のバックアップに投与済みの記録があると、取り込み前に『要確認になる』と知らせる", () => {
  const env = loadEnv();
  const v4 = {
    schemaVersion: 4,
    profile: { heightCm: 162, startDate: "2026-09-30", startWeight: 67.3, proteinTarget: 75, bmiMaintenanceAlert: 21, bmiLowerLine: 20 },
    goals: { goal1: { type: "weight", value: 60, achievedAt: null, postAchievementChoice: null }, goal2: null, activeGoal: 1, mode: "reduction", maintenanceReason: null, goalHistory: [] },
    dailyRecords: [], proteinEntries: [], conditionEntries: [],
    guardrails: { bmi21: { acknowledgedForDate: null }, bmi20: { acknowledgedAt: null } },
    injections: [{ id: 1, scheduledAt: "2026-10-01", administeredAt: "2026-10-01", dose: 2.5, status: "administered", comment: "" }],
    proteinProducts: [{ id: "whey-default", name: "ホエイ", servingScoops: 3, proteinPerServing: 20.8, status: "active", isDefault: true }],
    registeredFoods: [], ui: { lastScreen: "home" },
  };
  const e = { app: "body-garden", kind: "full-backup", formatVersion: 1, schemaVersion: 4, exportedAt: "2026-10-01T00:00:00Z", counts: env.Backup.counts(v4), state: v4 };
  const r = env.Backup.parse(JSON.stringify(e), null);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.warnings.some((w) => w.includes("要確認")), JSON.stringify(r.warnings));
  assert.equal(r.state.injections[0].stockCount, "review");
});

test("低: 在庫も定例スケジュールも無い開発中のv5データを書き出しても、取り込める", () => {
  const env = loadEnv();
  const s = sampleState(env);
  delete s.injectionStock;
  delete s.injectionSchedule;
  s.injections = [];
  const e = JSON.parse(exportText(env, sampleState(env)));
  e.state = clone(s);
  e.counts = env.Backup.counts(e.state);
  const r = env.Backup.parse(JSON.stringify(e), null);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(clone(r.state.injectionSchedule), { regular: null, baseDoseMg: null, history: [] });
  assert.equal(r.state.injectionStock.initialPens, 24);
});

test("低: 在庫も定例スケジュールも無い同一版のデータを読み込むと、両方を補う", () => {
  const env = loadEnv();
  const s = env.get("createDefaultState()");
  s.profile.startDate = "2026-10-01";
  delete s.injectionStock;
  delete s.injectionSchedule;
  env.ls.setItem(env.STORAGE_KEY, JSON.stringify(s));
  const loaded = env.Storage.load();
  assert.equal(loaded.injectionStock.initialPens, 24);
  assert.deepEqual(clone(loaded.injectionSchedule), { regular: null, baseDoseMg: null, history: [] });
});

// ---------- HOME注射カードの表示 ----------

function loadUi(env) {
  // 同じ環境に2回読み込んでも宣言が重複しないようにする
  if (!env.__uiLoaded) {
    vm.runInContext(
      'function escapeHtml(s){return String(s).replace(/[&<>"\']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","\'":"&#39;"}[c]));} const UI={lineIcon(){return "";}};',
      env.ctx
    );
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", "ui-injection.js"), "utf8"), env.ctx, { filename: "ui-injection.js" });
    env.__uiLoaded = true;
  }
  const ui = env.get("InjectionUI");
  return (state, now) => {
    ui._now = () => new Date(now.getTime());
    return ui.homeCardInnerHtml(state).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  };
}

test("HOMEカード: 初回投与前は「前回：まだなし」「残り：24本」", () => {
  const env = loadEnv();
  const text = loadUi(env)(stateWith(env, { regular: false }), D(2026, 10, 8, 12, 0));
  assert.match(text, /前回：まだなし/);
  assert.match(text, /残り：24本/);
});

test("HOMEカード: 投与後は「前回：10/8（木）」「残り：23本」（全角かっこ）", () => {
  const env = loadEnv();
  const s = stateWith(env, { weekday: 4, effectiveFrom: "2026-10-01" });
  admin(env, s, "2026-10-08", "09:00");
  const text = loadUi(env)(s, D(2026, 10, 9, 12, 0));
  assert.match(text, /前回：10\/8（木）/);
  assert.match(text, /残り：23本/);
  assert.match(text, /10\/15（木）/, "次回予定（提案）も全角かっこ");
});

test("HOMEカード: 打ち忘れ・長期中断の注意があるときは、前回の行より注意を優先する（前回は出さない）", () => {
  const env = loadEnv();
  const s = stateWith(env);
  admin(env, s, "2026-09-30", "09:00");
  const text = loadUi(env)(s, D(2026, 10, 9, 12, 0));
  assert.match(text, /記録のない回あり/);
  assert.doesNotMatch(text, /前回：/);
  assert.match(text, /残り：23本/, "残本数は短く表示し続ける");
  const old = stateWith(env);
  admin(env, old, "2026-09-02", "09:00");
  const t2 = loadUi(env)(old, D(2026, 10, 9, 12, 0));
  assert.match(t2, /処方元に確認/);
  assert.doesNotMatch(t2, /前回：/);
});

test("HOMEカード: 在庫の確認待ちは「残り：要確認」。24本から自動で差し引かない", () => {
  const env = loadEnv();
  const s = stateWith(env);
  admin(env, s, "2026-10-07", "09:00", { stockCount: "review" });
  const text = loadUi(env)(s, D(2026, 10, 8, 12, 0));
  assert.match(text, /残り：要確認/);
  assert.doesNotMatch(text, /残り：23本/);
});

test("HOMEカード: 在庫を超える記録のときは、超過が分かる表示にする", () => {
  const env = loadEnv();
  const s = stateWith(env);
  s.injectionStock.initialPens = 1;
  admin(env, s, "2026-10-01", "09:00");
  admin(env, s, "2026-10-07", "09:00");
  assert.match(loadUi(env)(s, D(2026, 10, 8, 12, 0)), /残り：0本（超過）/);
});

test("HOMEカード: 注射のデータが壊れていても例外にせず、HOME全体の描画を止めない", () => {
  const env = loadEnv();
  const s = stateWith(env);
  s.injectionSchedule = { regular: { id: 1, weekday: "x", time: 5, effectiveFrom: null }, baseDoseMg: null, history: [] };
  s.injections = [{ id: 1, status: "scheduled", scheduledAt: null }];
  assert.doesNotThrow(() => loadUi(env)(s, D(2026, 10, 8, 12, 0)));
});

// ---------- Service Worker ----------

test("Service Worker: CDN は不透明な応答を cache.put で保存する（cache.add は不透明な応答を受け付けない）", () => {
  const sw = fs.readFileSync(path.join(__dirname, "..", "service-worker.js"), "utf8").replace(/\/\/.*$/gm, "");
  assert.match(sw, /mode:\s*"no-cors"/);
  assert.match(sw, /cache\.put\(/);
  assert.ok(!/cache\.add\(new Request\(u, \{ mode: "no-cors" \}\)\)/.test(sw), "cache.add(no-cors) は使わない");
});
