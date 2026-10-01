// 注射の在庫（残本数）: 初期在庫24本。残りは保存せず、投与記録（1回につき1本）から毎回計算する。
// 在庫の設定時点ですでにある投与記録は、実記録かテスト用か判別できないので、本人が確認するまで数えない（要確認）。

const test = require("node:test");
const assert = require("node:assert/strict");
const { D, setup, stateWith, admin, sched, rec, clone } = require("./injection-helpers");
const { loadEnv, sampleState, exportText } = require("./helpers");

test("初期状態: 24本・使用済み0本・残り24本（要確認なし）。追加購入・入庫の概念はない", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  const k = L.stockSummary(s);
  assert.deepEqual({ initial: k.initial, used: k.used, remaining: k.remaining, needsReview: k.needsReview, over: k.over }, { initial: 24, used: 0, remaining: 24, needsReview: false, over: false });
  assert.deepEqual(clone(s.injectionStock), { initialPens: 24, setupAt: null });
  assert.equal(L.stockSummary(s).remaining, 24, "何度計算しても変わらない（保存された数値を減らす方式ではない）");
});

test("投与済み1回につき1本。予定・見送り・打ち忘れの確認・曜日変更では減らない", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-07", "09:00");
  assert.equal(L.stockSummary(s).remaining, 23);
  sched(env, s, "2026-10-14", "09:00"); // 予定の登録
  assert.equal(L.stockSummary(s).remaining, 23, "予定は数えない");
  rec(env, s, { status: "skipped", kind: "regular", regularDate: "2026-10-21", scheduledAt: "2026-10-21", skipReason: "userChoice" });
  assert.equal(L.stockSummary(s).remaining, 23, "見送りは数えない");
  L.evaluateMissedDose(s, D(2026, 10, 25, 12, 0)); // 打ち忘れの判定・案内
  L.homeSummary(s, D(2026, 10, 25, 12, 0));
  assert.equal(L.stockSummary(s).remaining, 23, "打ち忘れの判定は数えない");
  const r = L.applyWeekdayChange(s, { weekday: 4, time: "09:00", firstDate: "2026-10-29" }, D(2026, 10, 25, 12, 0));
  assert.equal(L.stockSummary(s).remaining, 23, `曜日変更は数えない ${JSON.stringify(r.code || "")}`);
});

test("二重減算が起きない: 予定を投与済みにしても1本。何度画面を開いても同じ", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  admin(env, s, "2026-10-07", "09:00");
  const p = sched(env, s, "2026-10-14", "09:00");
  assert.equal(L.stockSummary(s).used, 1);
  const r = L.applyAdministration(s, { recordId: p.id, date: "2026-10-14", time: "09:10", dose: 2.5 }, D(2026, 10, 14, 12, 0));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(L.stockSummary(s).used, 2, "予定が投与済みになった分だけ1本");
  for (let i = 0; i < 5; i++) L.homeSummary(s, D(2026, 10, 14, 13, 0));
  assert.equal(L.stockSummary(s).used, 2);
});

test("投与履歴の修正では変わらず、削除では計算し直される。予定の取消は数に影響しない", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  const a = admin(env, s, "2026-10-07", "09:00");
  const p = sched(env, s, "2026-10-14", "09:00");
  assert.equal(L.stockSummary(s).remaining, 23);
  assert.equal(L.applyEditAdministration(s, a.id, { date: "2026-10-07", time: "09:30", dose: 2.5, comment: "修正" }, D(2026, 10, 8, 12, 0)).ok, true);
  assert.equal(L.stockSummary(s).remaining, 23, "修正しても1本のまま（二重に減らない）");
  assert.equal(L.applyCancelScheduled(s, p.id).ok, true);
  assert.equal(L.stockSummary(s).remaining, 23, "予定の取消は数に影響しない");
  assert.equal(L.applyDeleteHistory(s, a.id).ok, true);
  assert.equal(L.stockSummary(s).remaining, 24, "投与記録を削除すると、残りは計算し直されて戻る");
});

test("在庫を超える記録は、残りを0本と表示できるよう over で知らせる", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  for (let i = 0; i < 25; i++) admin(env, s, `2026-${String(i < 9 ? 1 : 2).padStart(2, "0")}-${String((i % 9) + 1).padStart(2, "0")}`, "09:00");
  const k = L.stockSummary(s);
  assert.equal(k.used, 25);
  assert.equal(k.remaining, -1);
  assert.equal(k.over, true);
});

// ---------- 実データとテストデータの区別 ----------

function v4Raw(injections) {
  return JSON.stringify({
    schemaVersion: 4,
    profile: { heightCm: 162, startDate: "2026-09-30", startWeight: 67.3, proteinTarget: 75, bmiMaintenanceAlert: 21, bmiLowerLine: 20 },
    goals: { goal1: { type: "weight", value: 60, achievedAt: null, postAchievementChoice: null }, goal2: null, activeGoal: 1, mode: "reduction", maintenanceReason: null, goalHistory: [] },
    dailyRecords: [], proteinEntries: [], conditionEntries: [],
    guardrails: { bmi21: { acknowledgedForDate: null }, bmi20: { acknowledgedAt: null } },
    injections,
    proteinProducts: [{ id: "whey-default", name: "ホエイプロテイン", servingScoops: 3, proteinPerServing: 20.8, status: "active", isDefault: true }],
    registeredFoods: [{ id: "food-oikos", name: "オイコス", unit: "個", proteinPerUnit: 10, status: "active" }],
    ui: { lastScreen: "home" },
  });
}

test("v4（注射データなし）→ v5: 在庫は24本・使用済み0本。要確認なし", () => {
  const env = loadEnv();
  env.ls.setItem(env.STORAGE_KEY, v4Raw([]));
  const s = env.Storage.load();
  const L = env.get("InjectionLogic");
  const k = L.stockSummary(s);
  assert.deepEqual({ initial: k.initial, used: k.used, remaining: k.remaining, needsReview: k.needsReview }, { initial: 24, used: 0, remaining: 24, needsReview: false });
  assert.ok(s.injectionStock.setupAt, "設定した日時が残る");
});

test("v4に既存の投与済みの記録がある: 24本から自動で差し引かず「要確認」にする。記録は削除・上書きしない", () => {
  const env = loadEnv();
  const legacy = [
    { id: 1, scheduledAt: "2026-10-01", administeredAt: "2026-10-01", dose: 2.5, status: "administered", comment: "テスト" },
    { id: 2, scheduledAt: "2026-10-08", administeredAt: "2026-10-08", dose: 2.5, status: "administered", comment: "" },
    { id: 3, scheduledAt: "2026-10-15", administeredAt: null, dose: 2.5, status: "scheduled", comment: "" },
    { id: 4, scheduledAt: "2026-10-22", administeredAt: null, dose: null, status: "skipped", comment: "" },
  ];
  env.ls.setItem(env.STORAGE_KEY, v4Raw(legacy));
  const s = env.Storage.load();
  const L = env.get("InjectionLogic");
  const k = L.stockSummary(s);
  assert.equal(k.needsReview, true);
  assert.equal(k.used, 0, "確認が済むまで使用本数に数えない");
  assert.equal(k.remaining, 24, "24本から自動で差し引かない");
  assert.equal(k.reviewRecords.length, 2, "確認待ちは投与済みの2件だけ");
  assert.equal(s.injections.length, 4, "既存の記録は1件も削除しない");
  s.injections.forEach((r, i) => {
    for (const key of ["id", "scheduledAt", "administeredAt", "dose", "status", "comment"]) assert.equal(r[key], legacy[i][key], `injections[${i}].${key} は変わらない`);
  });
  assert.equal(s.injections[2].stockCount, null, "予定は数え方の対象外");
  // 確認が済むまでは、新しく記録した分は通常どおり数える
  const now = D(2026, 10, 30, 12, 0);
  const added = L.applyAdministration(s, { date: "2026-10-30", time: "09:00", dose: 2.5, confirmDose: true, confirmInterval: true }, now);
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.equal(L.stockSummary(s).used, 1);
  assert.equal(L.stockSummary(s).needsReview, true);
});

test("在庫の確認: 本人が選ぶと数え方が決まる（含める／含めない）。確認待ちでない記録は対象外", () => {
  const env = loadEnv();
  env.ls.setItem(env.STORAGE_KEY, v4Raw([
    { id: 1, scheduledAt: "2026-10-01", administeredAt: "2026-10-01", dose: 2.5, status: "administered", comment: "" },
    { id: 2, scheduledAt: "2026-10-08", administeredAt: "2026-10-08", dose: 2.5, status: "administered", comment: "" },
    { id: 3, scheduledAt: "2026-10-15", administeredAt: "2026-10-15", dose: 2.5, status: "administered", comment: "" },
  ]));
  const s = env.Storage.load();
  const L = env.get("InjectionLogic");
  assert.equal(L.applyStockReview(s, 1, "counts").ok, true);
  assert.equal(L.applyStockReview(s, 2, "excluded").ok, true);
  let k = L.stockSummary(s);
  assert.deepEqual({ used: k.used, remaining: k.remaining, needsReview: k.needsReview }, { used: 1, remaining: 23, needsReview: true }, "1件が未確認のうちは要確認のまま");
  assert.equal(L.applyStockReview(s, 1, "counts").code, "NOT_REVIEW", "確認済みの記録は対象外");
  assert.equal(L.applyStockReview(s, 3, "どちらでも").code, "INVALID_DECISION");
  assert.equal(L.applyStockReviewAll(s, "excluded").count, 1);
  k = L.stockSummary(s);
  assert.deepEqual({ used: k.used, remaining: k.remaining, needsReview: k.needsReview }, { used: 1, remaining: 23, needsReview: false });
  assert.equal(s.injections.length, 3, "確認しても記録は消えない");
});

test("v5で在庫の設定が無いデータ（開発中の形式）を読み込むと、初期値を入れて既存の記録は『要確認』にする（削除しない）", () => {
  const env = loadEnv();
  const base = env.get("createDefaultState()");
  delete base.injectionStock;
  base.profile.startDate = "2026-10-01";
  base.injections = [Object.assign(env.get("createEmptyInjection()"), { id: 1, status: "administered", administeredAt: "2026-10-08", administeredTime: "09:00", dose: 2.5 })];
  delete base.injections[0].stockCount;
  env.ls.setItem(env.STORAGE_KEY, JSON.stringify(base));
  const s = env.Storage.load();
  assert.equal(s.injectionStock.initialPens, 24);
  assert.equal(s.injections[0].stockCount, "review");
  assert.equal(s.injections.length, 1);
  assert.equal(JSON.parse(env.ls.getItem(env.STORAGE_KEY)).injectionStock.initialPens, 24, "保存される");
  // 2回目の起動では、すでに設定があるので何も変えない
  env.ls.setCalls.length = 0;
  env.Storage.load();
  assert.equal(env.ls.setCalls.length, 0);
});

test("applyStockBaseline: すでに在庫の設定があるデータは変更しない（冪等）", () => {
  const env = loadEnv();
  const s = sampleState(env);
  s.injections = [Object.assign(env.get("createEmptyInjection()"), { id: 1, status: "administered", administeredAt: "2026-10-08", dose: 2.5 })];
  const before = JSON.stringify(s);
  env.get("applyStockBaseline")(s);
  assert.equal(JSON.stringify(s), before);
});

// ---------- バックアップ: 在庫の初期値と投与履歴の整合 ----------

test("バックアップ: 在庫の設定と各記録の数え方が、書き出し→復元で変わらず、残本数も一致する", () => {
  const env = loadEnv();
  const L = env.get("InjectionLogic");
  const s = sampleState(env);
  s.injections = [
    Object.assign(env.get("createEmptyInjection()"), { id: 1, status: "administered", kind: "legacy", administeredAt: "2026-10-01", dose: 2.5, stockCount: "excluded" }),
    Object.assign(env.get("createEmptyInjection()"), { id: 2, status: "administered", kind: "legacy", administeredAt: "2026-10-08", dose: 2.5, stockCount: "counts" }),
    Object.assign(env.get("createEmptyInjection()"), { id: 3, status: "administered", kind: "regular", administeredAt: "2026-10-15", administeredTime: "09:00", dose: 2.5 }),
  ];
  const before = L.stockSummary(s);
  const r = env.Backup.parse(exportText(env, s), null);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(clone(r.state.injectionStock), clone(s.injectionStock));
  assert.deepEqual(clone(r.state.injections.map((i) => i.stockCount)), ["excluded", "counts", null]);
  const after = L.stockSummary(r.state);
  assert.deepEqual({ used: after.used, remaining: after.remaining, needsReview: after.needsReview }, { used: before.used, remaining: before.remaining, needsReview: before.needsReview });
  assert.equal(after.remaining, 22);
  assert.equal(env.Backup.applyRestore(r.state).ok, true);
  const restored = JSON.parse(env.ls.getItem(env.STORAGE_KEY));
  assert.equal(L.stockSummary(restored).remaining, 22);
});

test("バックアップ: 確認待ち(review)のまま書き出して復元しても、要確認のまま（勝手に差し引かない）", () => {
  const env = loadEnv();
  const L = env.get("InjectionLogic");
  const s = sampleState(env);
  s.injections = [Object.assign(env.get("createEmptyInjection()"), { id: 1, status: "administered", kind: "legacy", administeredAt: "2026-10-01", dose: 2.5, stockCount: "review" })];
  const r = env.Backup.parse(exportText(env, s), null);
  assert.equal(r.ok, true);
  const k = L.stockSummary(r.state);
  assert.deepEqual({ needsReview: k.needsReview, remaining: k.remaining }, { needsReview: true, remaining: 24 });
});

test("バックアップ: 在庫の設定が無いファイルは、初期値を入れ、既存の投与記録を『要確認』にして取り込む（警告つき）", () => {
  const env = loadEnv();
  const s = sampleState(env);
  s.injections = [Object.assign(env.get("createEmptyInjection()"), { id: 1, status: "administered", kind: "legacy", administeredAt: "2026-10-01", dose: 2.5 })];
  delete s.injectionStock;
  delete s.injections[0].stockCount;
  const e = JSON.parse(exportText(env, sampleState(env)));
  e.state = clone(s);
  e.counts = env.Backup.counts(e.state);
  const r = env.Backup.parse(JSON.stringify(e), null);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.state.injectionStock.initialPens, 24);
  assert.equal(r.state.injections[0].stockCount, "review");
  assert.ok(r.warnings.some((w) => w.includes("在庫")));
});

test("バックアップ: 在庫の設定・数え方の不正は拒否する", () => {
  const env = loadEnv();
  const cases = [
    ["initialPens が文字列", (s) => (s.injectionStock.initialPens = "24")],
    ["initialPens が負", (s) => (s.injectionStock.initialPens = -1)],
    ["initialPens が小数", (s) => (s.injectionStock.initialPens = 24.5)],
    ["setupAt が不正", (s) => (s.injectionStock.setupAt = "<script>")],
    ["stockCount が不正", (s) => (s.injections[0].stockCount = "maybe")],
  ];
  for (const [name, mutate] of cases) {
    const s = sampleState(env);
    s.injections = [Object.assign(env.get("createEmptyInjection()"), { id: 1, status: "administered", kind: "regular", administeredAt: "2026-10-01", dose: 2.5 })];
    mutate(s);
    const e = JSON.parse(exportText(env, sampleState(env)));
    e.state = clone(s);
    e.counts = env.Backup.counts(e.state);
    assert.equal(env.Backup.parse(JSON.stringify(e), null).ok, false, `拒否されるべき: ${name}`);
  }
});

test("「数えない」は残り本数への算入だけを変える: 前回の投与日・72時間の判定・次回提案は変わらない", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  const a = admin(env, s, "2026-10-07", "09:00");
  const now = D(2026, 10, 8, 12, 0);
  const snapshot = () => ({
    last: L.lastAdministered(s).administeredAt,
    proposal: clone(L.suggestNext(s, now)),
    gap: clone(L.judgeScheduleInterval({ date: "2026-10-07", time: "09:00" }, { date: "2026-10-09", time: "09:00" })),
    missed: L.evaluateMissedDose(s, D(2026, 10, 18, 12, 0)).status,
    records: s.injections.length,
    home: L.homeSummary(s, now).lastAdministeredAt,
  });
  const before = snapshot();
  assert.equal(L.applyStockSet(s, a.id, "excluded").ok, true);
  assert.equal(L.stockSummary(s).remaining, 24, "残り本数への算入だけが変わる");
  assert.deepEqual(snapshot(), before, "履歴・前回の投与日・72時間の判定・次回提案は変わらない");
});

test("HOME要約: 在庫（残本数・要確認）と前回の投与日を持つ", () => {
  const { env, L } = setup();
  const s = stateWith(env);
  let h = L.homeSummary(s, D(2026, 10, 8, 12, 0));
  assert.equal(h.lastAdministeredAt, null, "初回の投与前は「前回：まだなし」");
  assert.equal(h.stock.remaining, 24);
  admin(env, s, "2026-10-08", "09:00");
  h = L.homeSummary(s, D(2026, 10, 8, 12, 0));
  assert.equal(h.lastAdministeredAt, "2026-10-08");
  assert.equal(h.stock.remaining, 23);
});
