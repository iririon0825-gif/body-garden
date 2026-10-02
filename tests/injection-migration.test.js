// v4 → v5 移行（既存データを維持）、v5 データのバックアップ検証、v4 バックアップの復元

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadEnv, sampleState, clone, exportText } = require("./helpers");

function v4Raw(overrides = {}) {
  return JSON.stringify({
    schemaVersion: 4,
    profile: { heightCm: 162, startDate: "2026-09-30", startWeight: 67.3, proteinTarget: 75, bmiMaintenanceAlert: 21, bmiLowerLine: 20 },
    goals: { goal1: { type: "weight", value: 60, achievedAt: null, postAchievementChoice: null }, goal2: { type: "weight", value: 57, achievedAt: null, postAchievementChoice: null }, activeGoal: 1, mode: "reduction", maintenanceReason: null, goalHistory: [] },
    dailyRecords: [{ date: "2026-09-30", weight: 67, bodyComposition: {}, comment: "" }],
    proteinEntries: [],
    conditionEntries: [],
    guardrails: { bmi21: { acknowledgedForDate: null }, bmi20: { acknowledgedAt: null } },
    injections: [],
    proteinProducts: [{ id: "whey-default", name: "ホエイプロテイン", servingScoops: 3, proteinPerServing: 20.8, status: "active", isDefault: true }],
    registeredFoods: [{ id: "food-oikos", name: "オイコス", unit: "個", proteinPerUnit: 10, status: "active" }],
    ui: { lastScreen: "home" },
    ...overrides,
  });
}

test("v4（注射データなし）→ v6: 定例スケジュールが追加され、他のデータは変わらない。移行前のデータが退避される", () => {
  const env = loadEnv();
  const raw = v4Raw();
  env.ls.setItem(env.STORAGE_KEY, raw);
  const s = env.Storage.load();
  assert.equal(s.schemaVersion, 7);
  assert.deepEqual(clone(s.injectionSchedule), { regular: null, baseDoseMg: null, history: [] });
  assert.deepEqual(clone(s.injections), []);
  const before = JSON.parse(raw);
  for (const k of ["profile", "goals", "proteinProducts", "registeredFoods", "guardrails", "ui"]) {
    assert.deepEqual(clone(s[k]), before[k], `${k} は変わらない`);
  }
  // 体重の記録は変わらない（体組成の欄が16キーに広がり、compositionMeta が追加されるだけ）
  assert.equal(s.dailyRecords.length, 1);
  assert.equal(s.dailyRecords[0].weight, before.dailyRecords[0].weight);
  assert.equal(s.dailyRecords[0].date, before.dailyRecords[0].date);
  assert.equal(env.ls.getItem(`${env.STORAGE_KEY}.preMigration.v4`), raw, "移行前の生データを退避");
  assert.equal(JSON.parse(env.ls.getItem(env.STORAGE_KEY)).schemaVersion, 7);
});

test("v4（既存の注射データあり）→ v5: 値を変えずに引き継ぎ、kind は legacy になる", () => {
  const env = loadEnv();
  const legacy = [
    { id: 1, scheduledAt: "2026-10-01", administeredAt: "2026-10-01", dose: 2.5, status: "administered", comment: "初回" },
    { id: 2, scheduledAt: "2026-10-08", administeredAt: null, dose: 2.5, status: "scheduled", comment: "" },
    { id: 3, scheduledAt: "2026-10-15", administeredAt: null, dose: null, status: "skipped", comment: "休み" },
  ];
  env.ls.setItem(env.STORAGE_KEY, v4Raw({ injections: legacy }));
  const s = env.Storage.load();
  assert.equal(s.injections.length, 3);
  s.injections.forEach((r, i) => {
    for (const k of ["id", "scheduledAt", "administeredAt", "dose", "status", "comment"]) assert.equal(r[k], legacy[i][k], `injections[${i}].${k} は変わらない`);
    assert.equal(r.kind, "legacy");
    assert.equal(r.administeredTime, null);
    assert.equal(r.skipReason, null);
  });
  assert.equal(s.injectionSchedule.regular, null, "定例曜日は既存データから推測しない");
});

test("v4 の注射データの欠損（status/idなし）も壊さずに補完する／移行は冪等", () => {
  const env = loadEnv();
  const legacy = [{ scheduledAt: "2026-10-01", administeredAt: "2026-10-01", dose: 2.5 }, { id: 5, scheduledAt: "2026-10-08" }];
  env.ls.setItem(env.STORAGE_KEY, v4Raw({ injections: legacy }));
  const s = env.Storage.load();
  assert.equal(s.injections[0].status, "administered");
  assert.equal(s.injections[1].status, "scheduled");
  assert.ok(s.injections.every((r) => Number.isInteger(r.id) && r.id > 0));
  assert.equal(new Set(s.injections.map((r) => r.id)).size, 2, "idが重複しない");
  // 移行済みのデータをもう一度移行しても変わらない
  const again = env.Storage.migrate(clone(s));
  assert.deepEqual(clone(again), clone(s));
  const m = env.get("MIGRATIONS[4]")(clone(s));
  assert.deepEqual(clone(m.injections), clone(s.injections));
});

test("移行前の退避に失敗したら、通常の起動で退避なしの移行を保存しない（読み取り専用のまま）", () => {
  const env = loadEnv();
  const raw = v4Raw({ injections: [{ id: 1, scheduledAt: "2026-10-08", administeredAt: null, dose: 2.5, status: "scheduled", comment: "" }] });
  env.ls.setItem(env.STORAGE_KEY, raw);
  env.ls.failSetKeys.add(`${env.STORAGE_KEY}.preMigration.v4`);
  env.ls.setCalls.length = 0;
  const s = env.Storage.load();
  assert.equal(env.Storage.readOnly, true);
  assert.equal(env.Storage.readOnlyReason, "preMigrationBackupFailed");
  assert.equal(env.ls.getItem(env.STORAGE_KEY), raw, "保存データは v4 のまま");
  assert.equal(env.Storage.save(s), false, "その後の保存も行われない");
  assert.equal(env.ls.getItem(env.STORAGE_KEY), raw);
  assert.ok(env.ls.setCalls.every((k) => k !== env.STORAGE_KEY), "本体キーへの書き込み呼び出しが0回");
});

test("新しい版(v8)のデータは、v7のアプリで読み取り専用になり書き換えられない", () => {
  const env = loadEnv();
  const raw = JSON.stringify({ schemaVersion: 8, injections: [], future: true });
  env.ls.setItem(env.STORAGE_KEY, raw);
  env.Storage.load();
  assert.equal(env.Storage.readOnly, true);
  assert.equal(env.Storage.readOnlyReason, "newerSchema");
  assert.equal(env.Storage.save({ schemaVersion: 7 }), false);
  assert.equal(env.ls.getItem(env.STORAGE_KEY), raw);
});

// ---------- バックアップ: v5 の検証・往復・v4 ファイルの復元 ----------

function v5State(env) {
  const s = sampleState(env);
  s.injections = [
    Object.assign(env.get("createEmptyInjection()"), { id: 1, status: "administered", kind: "regular", regularDate: "2026-10-07", scheduledAt: "2026-10-07", scheduledTime: "09:00", administeredAt: "2026-10-07", administeredTime: "09:10", dose: 2.5 }),
    Object.assign(env.get("createEmptyInjection()"), { id: 2, status: "skipped", kind: "regular", regularDate: "2026-10-14", scheduledAt: "2026-10-14", skipReason: "missedUnder72h", missedCheck: { judgedAt: "2026-10-12T00:00:00.000Z", target: "2026-10-14", next: { date: "2026-10-21", time: "09:00" }, result: "lt72", minMs: 1000, maxMs: 1000 } }),
    Object.assign(env.get("createEmptyInjection()"), { id: 3, status: "scheduled", kind: "oneOffChange", regularDate: "2026-10-21", scheduledAt: "2026-10-22", scheduledTime: null }),
  ];
  s.injectionSchedule = { regular: { id: 2, weekday: 3, time: "09:00", effectiveFrom: "2026-09-30" }, baseDoseMg: 5, history: [{ id: 1, changedAt: "2026-09-30T00:00:00.000Z", type: "set", from: null, to: { weekday: 3, time: "09:00", effectiveFrom: "2026-09-30" }, check: { lastAdministered: null, firstDate: "2026-09-30", result: "noHistory", minMs: null, maxMs: null }, replacedScheduledId: null }, { id: 2, changedAt: "2026-10-01T00:00:00.000Z", type: "timeChange", from: { weekday: 3, time: null }, to: { weekday: 3, time: "09:00", effectiveFrom: "2026-10-07" }, check: null, replacedScheduledId: null }] };
  return s;
}

test("バックアップ: v5の注射データ・定例スケジュールが、書き出し→読み込みで完全に一致する", () => {
  const env = loadEnv();
  const s = v5State(env);
  const r = env.Backup.parse(exportText(env, s), null);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(clone(r.state), clone(s));
});

test("バックアップ: v4 のファイルは v5 へ変換して取り込める（注射データも維持）", () => {
  const env = loadEnv();
  const v4 = JSON.parse(v4Raw({ injections: [{ id: 1, scheduledAt: "2026-10-08", administeredAt: null, dose: 2.5, status: "scheduled", comment: "" }] }));
  const e = { app: "body-garden", kind: "full-backup", formatVersion: 1, schemaVersion: 4, exportedAt: "2026-10-01T00:00:00Z", counts: env.Backup.counts(v4), state: v4 };
  const r = env.Backup.parse(JSON.stringify(e), null);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.state.schemaVersion, 7);
  assert.equal(r.state.injections[0].kind, "legacy");
  assert.equal(r.summary.migrated, true);
  assert.equal(env.Backup.applyRestore(r.state).ok, true);
  assert.equal(JSON.parse(env.ls.getItem(env.STORAGE_KEY)).schemaVersion, 7);
});

test("バックアップ: 注射データの不正（状態・種別・日付・時刻・曜日・履歴）は拒否する", () => {
  const env = loadEnv();
  const xss = "<img src=x onerror=alert(1)>";
  const cases = [
    ["status不正", (s) => (s.injections[0].status = "done")],
    ["kind不正", (s) => (s.injections[0].kind = "x")],
    ["administeredAtにHTML", (s) => (s.injections[0].administeredAt = xss)],
    ["administeredTime不正", (s) => (s.injections[0].administeredTime = "25:61")],
    ["scheduledTimeに秒", (s) => (s.injections[2].scheduledTime = "09:00:00")],
    ["skipReason不正", (s) => (s.injections[1].skipReason = "勝手に見送り")],
    ["missedCheck.result不正", (s) => (s.injections[1].missedCheck.result = "maybe")],
    ["定例 weekday 範囲外", (s) => (s.injectionSchedule.regular.weekday = 7)],
    ["定例 effectiveFrom と曜日が不一致", (s) => (s.injectionSchedule.regular.effectiveFrom = "2026-10-01")],
    ["定例 time 不正", (s) => (s.injectionSchedule.regular.time = "9:00")],
    ["history が配列でない", (s) => (s.injectionSchedule.history = {})],
    ["history type 不正", (s) => (s.injectionSchedule.history[0].type = "reset")],
    ["history id 重複", (s) => (s.injectionSchedule.history[1].id = 1)],
    ["baseDoseMg が文字列", (s) => (s.injectionSchedule.baseDoseMg = "5")],
  ];
  for (const [name, mutate] of cases) {
    const s = v5State(env);
    mutate(s);
    const e = JSON.parse(exportText(env, v5State(env)));
    e.state = clone(s);
    e.counts = env.Backup.counts(e.state);
    const r = env.Backup.parse(JSON.stringify(e), null);
    assert.equal(r.ok, false, `拒否されるべき: ${name}`);
  }
});

test("バックアップ: 規格外の用量・予定の複数件は警告にとどめる（取り込める）", () => {
  const env = loadEnv();
  const s = v5State(env);
  s.injections[0].dose = 3;
  s.injections.push(Object.assign(env.get("createEmptyInjection()"), { id: 4, status: "scheduled", scheduledAt: "2026-10-29", regularDate: "2026-10-28" }));
  const r = env.Backup.parse(exportText(env, s), null);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.warnings.some((w) => w.includes("規格")));
  assert.ok(r.warnings.some((w) => w.includes("複数")));
});
