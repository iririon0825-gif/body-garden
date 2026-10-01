// v5 → v6 移行（体組成の16項目化）。既存データを一切変えず、足りないキーを null で補うだけ。
// 移行前の退避・失敗時の安全な停止・旧バックアップとの互換・新しい版の拒否も確認する。

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadEnv, sampleState, clone, exportText } = require("./helpers");

const KEYS16 = ["measuredWeight", "bmi", "bodyFatPct", "heartRate", "muscleMass", "bmr", "waterPct", "bodyFatMass", "leanMass", "boneMass", "visceralFat", "proteinPct", "skeletalMuscleMass", "subcutaneousFat", "bodyAge", "bodyType"];
const OLD12 = ["bodyFatPct", "muscleMass", "waterPct", "bodyFatMass", "leanMass", "boneMass", "visceralFat", "proteinPct", "skeletalMuscleMass", "subcutaneousFat", "bodyAge", "bmr"];

function v5Raw(env, mutate) {
  const s = sampleState(env);
  s.schemaVersion = 5;
  // v5 の形: 体組成は12キーだけ、compositionMeta なし
  s.dailyRecords = [
    { date: "2026-09-29", weight: 67.3, bodyComposition: Object.fromEntries(OLD12.map((k) => [k, null])), comment: "" },
    { date: "2026-09-30", weight: 66.9, bodyComposition: { ...Object.fromEntries(OLD12.map((k) => [k, null])), bodyFatPct: 31.2, muscleMass: 43.7 }, comment: "メモ" },
    { date: "2026-10-01", weight: null, bodyComposition: { bodyFatPct: 30.1 }, comment: "" },
  ];
  if (mutate) mutate(s);
  return JSON.stringify(s);
}

test("体組成: 項目定義は16項目で、保存キーは重複せず、既存の12キーの名前は変わらない", () => {
  const env = loadEnv();
  const F = env.get("COMPOSITION_FIELDS");
  assert.deepEqual(clone(F.map((f) => f.key)), KEYS16);
  assert.equal(new Set(F.map((f) => f.csv)).size, 16, "CSV列名も重複しない");
  for (const k of OLD12) assert.ok(F.some((f) => f.key === k), `${k} が残っている`);
  assert.deepEqual(clone(Object.keys(env.get("EMPTY_BODY_COMPOSITION"))), KEYS16);
  assert.equal(F.find((f) => f.key === "bodyType").type, "string");
  assert.equal(F.filter((f) => f.type === "number").length, 15);
});

test("v5 → v6: 既存の値は1つも変わらず、足りないキーが null で補われる。体重・コメントは不変", () => {
  const env = loadEnv();
  const raw = v5Raw(env);
  env.ls.setItem(env.STORAGE_KEY, raw);
  const before = JSON.parse(raw);
  const s = env.Storage.load();
  assert.equal(s.schemaVersion, 6);
  s.dailyRecords.forEach((r, i) => {
    assert.equal(r.date, before.dailyRecords[i].date);
    assert.equal(r.weight, before.dailyRecords[i].weight);
    assert.equal(r.comment, before.dailyRecords[i].comment);
    assert.deepEqual(clone(Object.keys(r.bodyComposition)).sort(), [...KEYS16].sort(), "16キーがそろう");
    for (const [k, v] of Object.entries(before.dailyRecords[i].bodyComposition)) assert.equal(r.bodyComposition[k], v, `${k} は変わらない`);
    assert.equal(r.compositionMeta, null);
  });
  assert.equal(s.dailyRecords[1].bodyComposition.bodyFatPct, 31.2);
  assert.equal(s.dailyRecords[1].bodyComposition.heartRate, null);
  // 他の領域には触れない
  for (const k of ["profile", "goals", "proteinEntries", "conditionEntries", "injections", "injectionSchedule", "injectionStock", "proteinProducts", "registeredFoods"]) {
    assert.deepEqual(clone(s[k]), before[k], `${k} は変わらない`);
  }
});

test("v5 → v6: 移行前の生データを preMigration.v5 に退避してから保存する。既にあれば上書きしない", () => {
  const env = loadEnv();
  const raw = v5Raw(env);
  env.ls.setItem(env.STORAGE_KEY, raw);
  env.Storage.load();
  assert.equal(env.ls.getItem(`${env.STORAGE_KEY}.preMigration.v5`), raw);
  assert.equal(JSON.parse(env.ls.getItem(env.STORAGE_KEY)).schemaVersion, 6);
  const env2 = loadEnv();
  env2.ls.setItem(`${env2.STORAGE_KEY}.preMigration.v5`, "最初の退避");
  env2.ls.setItem(env2.STORAGE_KEY, raw);
  env2.Storage.load();
  assert.equal(env2.ls.getItem(`${env2.STORAGE_KEY}.preMigration.v5`), "最初の退避");
});

test("v5 → v6: 退避に失敗したら、移行結果を保存せず読み取り専用で止まる（自動で退避なしの移行をしない）", () => {
  const env = loadEnv();
  const raw = v5Raw(env);
  env.ls.setItem(env.STORAGE_KEY, raw);
  env.ls.failSetKeys.add(`${env.STORAGE_KEY}.preMigration.v5`);
  env.ls.setCalls.length = 0;
  const s = env.Storage.load();
  assert.equal(env.Storage.readOnly, true);
  assert.equal(env.Storage.readOnlyReason, "preMigrationBackupFailed");
  assert.equal(env.ls.getItem(env.STORAGE_KEY), raw, "保存データは v5 のまま");
  assert.equal(env.Storage.save(s), false);
  assert.ok(env.ls.setCalls.every((k) => k !== env.STORAGE_KEY), "本体への書き込みが0回");
});

test("v5 → v6: 移行は冪等で、壊れた bodyComposition（欠落・配列）も例外にしない", () => {
  const env = loadEnv();
  const s = JSON.parse(v5Raw(env, (st) => {
    st.dailyRecords.push({ date: "2026-10-02", weight: 66, comment: "" }); // 体組成の欄が無い
    st.dailyRecords.push({ date: "2026-10-03", weight: 66, bodyComposition: [], comment: "" }); // 配列（不正）
  }));
  const m = env.get("MIGRATIONS[5]");
  const once = m(clone(s));
  const twice = m(clone(once));
  assert.deepEqual(clone(twice), clone(once));
  assert.deepEqual(clone(Object.keys(once.dailyRecords[3].bodyComposition)), KEYS16);
  assert.deepEqual(clone(Object.keys(once.dailyRecords[4].bodyComposition)), KEYS16);
});

test("v4 → v6（連鎖）: 注射の移行と体組成の移行が順に行われ、既存データが保たれる", () => {
  const env = loadEnv();
  const v4 = {
    schemaVersion: 4,
    profile: { heightCm: 162, startDate: "2026-09-30", startWeight: 67.3, proteinTarget: 75, bmiMaintenanceAlert: 21, bmiLowerLine: 20 },
    goals: { goal1: { type: "weight", value: 60, achievedAt: null, postAchievementChoice: null }, goal2: null, activeGoal: 1, mode: "reduction", maintenanceReason: null, goalHistory: [] },
    dailyRecords: [{ date: "2026-09-30", weight: 67, bodyComposition: { bodyFatPct: 30 }, comment: "" }],
    proteinEntries: [], conditionEntries: [],
    guardrails: { bmi21: { acknowledgedForDate: null }, bmi20: { acknowledgedAt: null } },
    injections: [{ id: 1, scheduledAt: "2026-10-01", administeredAt: "2026-10-01", dose: 2.5, status: "administered", comment: "" }],
    proteinProducts: [{ id: "whey-default", name: "ホエイ", servingScoops: 3, proteinPerServing: 20.8, status: "active", isDefault: true }],
    registeredFoods: [], ui: { lastScreen: "home" },
  };
  env.ls.setItem(env.STORAGE_KEY, JSON.stringify(v4));
  const s = env.Storage.load();
  assert.equal(s.schemaVersion, 6);
  assert.equal(s.dailyRecords[0].bodyComposition.bodyFatPct, 30);
  assert.equal(s.dailyRecords[0].bodyComposition.bmi, null);
  assert.equal(s.injections[0].stockCount, "review", "注射・在庫の移行も行われる");
  assert.equal(env.ls.getItem(`${env.STORAGE_KEY}.preMigration.v4`), JSON.stringify(v4));
});

// ---------- バックアップ ----------

test("旧バックアップ（v5）は v6 へ変換して取り込める。値は変わらない", () => {
  const env = loadEnv();
  const v5 = JSON.parse(v5Raw(env));
  const e = { app: "body-garden", kind: "full-backup", formatVersion: 1, schemaVersion: 5, exportedAt: "2026-10-01T00:00:00Z", counts: env.Backup.counts(v5), state: v5 };
  const r = env.Backup.parse(JSON.stringify(e), null);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.state.schemaVersion, 6);
  assert.equal(r.summary.migrated, true);
  assert.equal(r.state.dailyRecords[1].bodyComposition.bodyFatPct, 31.2);
  assert.equal(r.state.dailyRecords[1].bodyComposition.bodyType, null);
  assert.equal(env.Backup.applyRestore(r.state).ok, true);
});

test("v6 のバックアップは書き出し→読み込みで完全に一致する（16項目・compositionMeta・ボディタイプ）", () => {
  const env = loadEnv();
  const s = sampleState(env);
  s.dailyRecords[1].bodyComposition = { ...env.get("EMPTY_BODY_COMPOSITION"), measuredWeight: 66.9, bmi: 25.5, bodyFatPct: 31.2, heartRate: 68, bmr: 1312, bodyType: "標準型" };
  s.dailyRecords[1].compositionMeta = { measuredTime: "07:12", source: "paste", formatVersion: 1, importedAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", mixed: false };
  const r = env.Backup.parse(exportText(env, s), null);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(clone(r.state), clone(s));
});

test("新しい版（v7）のバックアップは拒否される", () => {
  const env = loadEnv();
  const e = JSON.parse(exportText(env, sampleState(env)));
  e.schemaVersion = 7;
  e.state.schemaVersion = 7;
  assert.equal(env.Backup.parse(JSON.stringify(e), null).code, "NEWER_SCHEMA");
});
