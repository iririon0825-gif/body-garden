// Body Garden — JSONバックアップ／ストレージ安全策のテスト（node --test tests/）
// ブラウザ用のグローバルスクリプトを vm コンテキストに読み込み、偽の localStorage で検証する。
// 実データには一切触れない（すべてメモリ上のダミー）。

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadEnv, sampleState, clone, exportText, envelopeOf } = require("./helpers");

// ============ 書き出し→読み込みの往復 ============

test("往復: 書き出したJSONを読み込むと元のデータと完全に一致する", () => {
  const env = loadEnv();
  const state = sampleState(env);
  const r = env.Backup.parse(exportText(env, state), null);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(clone(r.state), clone(state));
  assert.equal(r.summary.migrated, false);
  assert.deepEqual(clone(r.summary.range), { from: "2026-09-29", to: "2026-10-01" });
});

test("往復: 空に近い初期データでも読み込める", () => {
  const env = loadEnv();
  const state = env.get("createDefaultState()");
  state.profile.startDate = "2026-10-01";
  const r = env.Backup.parse(exportText(env, state), null);
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("ファイル名は日時入り、エンベロープに件数が入る", () => {
  const env = loadEnv();
  assert.match(env.Backup.fileName(new Date(2026, 9, 1, 8, 5)), /^body-garden-backup-20261001-0805\.json$/);
  const e = envelopeOf(env, sampleState(env));
  assert.equal(e.app, "body-garden");
  assert.equal(e.kind, "full-backup");
  assert.equal(e.schemaVersion, 5);
  assert.deepEqual(e.counts, { dailyRecords: 3, proteinEntries: 2, conditionEntries: 1, injections: 1, proteinProducts: 1, registeredFoods: 1 });
});

// ============ 不正ファイルの拒否 ============

function assertRejected(env, text, code) {
  const r = env.Backup.parse(text, null);
  assert.equal(r.ok, false, "拒否されるべき: " + code);
  assert.equal(r.code, code, `code=${r.code} message=${r.message} details=${JSON.stringify(r.details)}`);
  return r;
}

test("拒否: 空・空白", () => {
  const env = loadEnv();
  assertRejected(env, "", "EMPTY");
  assertRejected(env, "   \n", "EMPTY");
});

test("拒否: JSONでない／壊れたJSON", () => {
  const env = loadEnv();
  assertRejected(env, "これはJSONではありません", "NOT_JSON");
  const text = exportText(env, sampleState(env));
  assertRejected(env, text.slice(0, text.length - 40), "NOT_JSON");
});

test("拒否: 他のアプリのJSON／配列／nullなど", () => {
  const env = loadEnv();
  assertRejected(env, JSON.stringify({ app: "tonight-garden", kind: "full-backup", formatVersion: 1, state: {} }), "NOT_BODY_GARDEN");
  assertRejected(env, JSON.stringify([1, 2, 3]), "NOT_BODY_GARDEN");
  assertRejected(env, "null", "NOT_BODY_GARDEN");
  assertRejected(env, JSON.stringify(sampleState(env)), "NOT_BODY_GARDEN"); // 包みの無い生のstate
  const e = envelopeOf(env, sampleState(env));
  e.state = [];
  assertRejected(env, JSON.stringify(e), "NOT_BODY_GARDEN");
});

test("拒否: formatVersion が違う", () => {
  const env = loadEnv();
  const e = envelopeOf(env, sampleState(env));
  e.formatVersion = 2;
  assertRejected(env, JSON.stringify(e), "UNSUPPORTED_FORMAT");
});

test("拒否: schemaVersion が文字列／小数／0／食い違い", () => {
  const env = loadEnv();
  for (const bad of ["4", 4.5, 0, -1, null]) {
    const e = envelopeOf(env, sampleState(env));
    e.state.schemaVersion = bad;
    e.schemaVersion = bad;
    assertRejected(env, JSON.stringify(e), "INVALID_SCHEMA_VERSION");
  }
  const e = envelopeOf(env, sampleState(env));
  e.schemaVersion = 3; // 外側と内側で食い違い
  assertRejected(env, JSON.stringify(e), "INVALID_SCHEMA_VERSION");
});

test("拒否: 現在より新しい schemaVersion（v6）", () => {
  const env = loadEnv();
  const e = envelopeOf(env, sampleState(env));
  e.state.schemaVersion = 6;
  e.schemaVersion = 6;
  const r = assertRejected(env, JSON.stringify(e), "NEWER_SCHEMA");
  assert.match(r.message, /更新/);
});

test("拒否: 件数がファイル情報と一致しない（欠け・改ざん）", () => {
  const env = loadEnv();
  const e = envelopeOf(env, sampleState(env));
  e.state.dailyRecords.pop();
  assertRejected(env, JSON.stringify(e), "INTEGRITY");
  const e2 = envelopeOf(env, sampleState(env));
  delete e2.counts;
  assertRejected(env, JSON.stringify(e2), "INVALID_STRUCTURE");
});

test("拒否: サイズ上限（5MB超）", () => {
  const env = loadEnv();
  assertRejected(env, "x".repeat(env.Backup.MAX_BYTES + 1), "TOO_LARGE");
  // マルチバイトは文字数ではなくバイト数で数える（1.8M文字×3byte > 5MB）
  assertRejected(env, "あ".repeat(1_800_000), "TOO_LARGE");
});

// 構造・書式の不正は、1つ書き換えるごとに INVALID_STRUCTURE（件数は変えない）
function structureCases(env) {
  const xss = '<img src=x onerror=alert(1)>';
  return [
    ["日付にHTML", (s) => (s.dailyRecords[0].date = xss)],
    ["実在しない日付 2026-02-30", (s) => (s.dailyRecords[0].date = "2026-02-30")],
    ["日付が日時形式", (s) => (s.dailyRecords[0].date = "2026-09-29T00:00:00Z")],
    ["体重が文字列", (s) => (s.dailyRecords[1].weight = "66.9")],
    ["日付重複", (s) => (s.dailyRecords[1].date = s.dailyRecords[0].date)],
    ["profile欠落", (s) => delete s.profile],
    ["身長が文字列", (s) => (s.profile.heightCm = "162")],
    ["開始日にHTML", (s) => (s.profile.startDate = xss)],
    ["goal1欠落", (s) => delete s.goals.goal1],
    ["goal type 不正", (s) => (s.goals.goal1.type = "other")],
    ["achievedAtにHTML", (s) => (s.goals.goal1.achievedAt = xss)],
    ["activeGoal=2でgoal2なし", (s) => { s.goals.goal2 = null; s.goals.activeGoal = 2; }],
    ["mode 不正", (s) => (s.goals.mode = "x")],
    ["goalHistory が配列でない", (s) => (s.goals.goalHistory = {})],
    ["proteinEntries id にHTML", (s) => (s.proteinEntries[0].id = '"><script>')],
    ["proteinEntries id 重複", (s) => (s.proteinEntries[1].id = s.proteinEntries[0].id)],
    ["sourceType 不正", (s) => (s.proteinEntries[0].sourceType = "drink")],
    ["time 不正 25:00", (s) => (s.proteinEntries[0].time = "25:00")],
    ["proteinTotal がnull", (s) => (s.proteinEntries[0].proteinTotal = null)],
    ["conditionEntries level 不正", (s) => (s.conditionEntries[0].level = "extreme")],
    ["symptoms にHTML", (s) => (s.conditionEntries[0].symptoms = [xss])],
    ["injections status 不正", (s) => (s.injections[0].status = "done")],
    ["injections scheduledAt にHTML", (s) => (s.injections[0].scheduledAt = xss)],
    ["injections dose が文字列", (s) => (s.injections[0].dose = "2.5")],
    ["proteinProducts status 不正", (s) => (s.proteinProducts[0].status = "x")],
    ["proteinProducts isDefault が文字列", (s) => (s.proteinProducts[0].isDefault = "true")],
    ["registeredFoods name 空", (s) => (s.registeredFoods[0].name = "")],
    ["配列が配列でない", (s) => (s.registeredFoods = {})],
    ["guardrails 欠落", (s) => delete s.guardrails],
  ];
}

test("拒否: 構造・書式の不正（XSS文字列・型違い・重複など）", () => {
  const env = loadEnv();
  for (const [name, mutate] of structureCases(env)) {
    const state = sampleState(env);
    const before = JSON.stringify(Object.keys(env.Backup.counts(state)).map((k) => env.Backup.counts(state)[k]));
    mutate(state);
    // 件数が変わる変異は counts を合わせ直し、構造検証まで到達させる
    const e = envelopeOf(env, sampleState(env));
    e.state = clone(state);
    e.counts = env.Backup.counts(e.state);
    const r = env.Backup.parse(JSON.stringify(e), null);
    assert.equal(r.ok, false, `拒否されるべき: ${name}`);
    assert.ok(["INVALID_STRUCTURE", "MIGRATION_FAILED"].includes(r.code), `${name}: code=${r.code} ${r.message}`);
    void before;
  }
});

test("警告のみ: 未知の最上位キーは捨てる／uiの不正値は直す", () => {
  const env = loadEnv();
  const e = envelopeOf(env, sampleState(env));
  e.state.evil = { x: 1 };
  e.state.ui.lastScreen = "<script>";
  const r = env.Backup.parse(JSON.stringify(e), null);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.state.evil, undefined);
  assert.equal(r.state.ui.lastScreen, "home");
  assert.ok(r.warnings.some((w) => w.includes("evil")));
});

test("警告のみ: 範囲外の体重・未知の症状IDは取り込める", () => {
  const env = loadEnv();
  const e = envelopeOf(env, sampleState(env));
  e.state.dailyRecords[0].weight = 5;
  e.state.conditionEntries[0].symptoms = ["unknownSymptom"];
  const r = env.Backup.parse(JSON.stringify(e), null);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.warnings.length >= 2);
});

// ============ 古い版の取り込み（strict移行） ============

test("古い版(v3)のバックアップは変換して取り込める", () => {
  const env = loadEnv();
  const v3 = {
    schemaVersion: 3,
    profile: { heightCm: 162, startDate: "2026-09-01", startWeight: 67.3, proteinTarget: 75, bmiMaintenanceAlert: 21, bmiLowerLine: 20 },
    goals: { goal1: { type: "weight", value: 60, achievedAt: null, postAchievementChoice: null }, goal2: null, activeGoal: 1, mode: "reduction", maintenanceReason: null, goalHistory: [] },
    dailyRecords: [{ date: "2026-09-01", weight: 67.3, bodyComposition: {}, comment: "" }],
    proteinEntries: [{ id: 1, date: "2026-09-01", time: null, source: "whey", wheyProductId: "whey-default", scoops: 3 }],
    conditionEntries: [],
    guardrails: { bmi21: { acknowledgedForDate: null }, bmi20: { acknowledgedAt: null } },
    injections: [],
    proteinProducts: [{ id: "whey-default", name: "ホエイプロテイン", servingScoops: 3, proteinPerServing: 20.8 }],
    registeredFoods: [{ id: "food-oikos", name: "オイコス", unit: "個", proteinPerUnit: 10 }],
    ui: { lastScreen: "home" },
  };
  const e = { app: "body-garden", kind: "full-backup", formatVersion: 1, schemaVersion: 3, exportedAt: "2026-09-01T00:00:00Z", counts: env.Backup.counts(v3), state: v3 };
  const r = env.Backup.parse(JSON.stringify(e), null);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.state.schemaVersion, 5);
  assert.equal(r.summary.migrated, true);
  assert.equal(r.state.proteinEntries[0].sourceType, "whey");
  assert.equal(r.state.proteinProducts[0].status, "active");
  assert.equal(v3.schemaVersion, 3, "元の入力は変更されない");
});

test("strict移行: 移行関数が欠けていれば例外（通常起動は従来どおり止まるだけ）", () => {
  const env = loadEnv();
  env.get("delete MIGRATIONS[2]");
  assert.throws(() => env.Storage.migrate({ schemaVersion: 2 }, { strict: true }), /移行関数がありません/);
  const out = env.Storage.migrate({ schemaVersion: 2 });
  assert.equal(out.schemaVersion, 2);
});

// ============ 復元・ロールバック ============

test("復元: 成功すると新データが入り、直前のデータが preRestore に残る", () => {
  const env = loadEnv();
  const old = sampleState(env);
  old.dailyRecords = old.dailyRecords.slice(0, 1);
  env.ls.setItem(env.STORAGE_KEY, JSON.stringify(old));
  const incoming = sampleState(env);
  const res = env.Backup.applyRestore(incoming);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(JSON.parse(env.ls.getItem(env.STORAGE_KEY)), clone(incoming));
  assert.deepEqual(JSON.parse(env.ls.getItem(env.Backup.PRE_RESTORE_KEY)), clone(old), "退避は直前の生データそのもの");
  assert.ok(env.ls.getItem(env.Backup.PRE_RESTORE_AT_KEY), "退避した日時が別キーにある");
  assert.equal(env.Backup.hasPreRestore(), true);
});

test("復元: 保存データが空でも成功する（preRestoreは作らない）", () => {
  const env = loadEnv();
  const res = env.Backup.applyRestore(sampleState(env));
  assert.equal(res.ok, true);
  assert.equal(env.Backup.hasPreRestore(), false);
});

test("復元: 退避に失敗したら何も変更せず中止", () => {
  const env = loadEnv();
  const old = sampleState(env);
  const oldRaw = JSON.stringify(old);
  env.ls.setItem(env.STORAGE_KEY, oldRaw);
  env.ls.failSetKeys.add(env.Backup.PRE_RESTORE_KEY);
  const res = env.Backup.applyRestore(sampleState(env));
  assert.equal(res.ok, false);
  assert.equal(res.code, "PRE_RESTORE_FAILED");
  assert.equal(env.ls.getItem(env.STORAGE_KEY), oldRaw, "元のデータは不変");
});

test("復元: 書き込みに失敗したら元のデータに戻る（ロールバック）", () => {
  const env = loadEnv();
  const old = sampleState(env);
  const oldRaw = JSON.stringify(old);
  env.ls.setItem(env.STORAGE_KEY, oldRaw);
  // 本体キーへの書き込みだけを失敗させる（退避は成功する）
  env.ls.failSetKeys.add(env.STORAGE_KEY);
  const res = env.Backup.applyRestore(sampleState(env));
  assert.equal(res.ok, false);
  assert.equal(res.code, "WRITE_FAILED");
  assert.equal(env.ls.getItem(env.STORAGE_KEY), oldRaw, "元のデータが保たれる");
});

test("復元: 書き込み後の読み戻しが一致しなければ元に戻す", () => {
  const env = loadEnv();
  const oldRaw = JSON.stringify(sampleState(env));
  env.ls.setItem(env.STORAGE_KEY, oldRaw);
  const realSet = env.ls.setItem.bind(env.ls);
  let corruptNext = false;
  env.ls.setItem = (k, v) => {
    if (k === env.STORAGE_KEY && corruptNext === false && v !== oldRaw) {
      corruptNext = true;
      return realSet(k, v + " "); // 書き込み内容が変わってしまう障害を模擬
    }
    return realSet(k, v);
  };
  const incoming = sampleState(env);
  incoming.dailyRecords = incoming.dailyRecords.slice(0, 1); // 現在のデータと内容を変える
  const res = env.Backup.applyRestore(incoming);
  assert.equal(res.ok, false);
  assert.equal(res.code, "WRITE_FAILED");
  assert.equal(env.ls.getItem(env.STORAGE_KEY), oldRaw);
});

test("復元前に戻す: 入れ替わり、もう一度で元に戻る", () => {
  const env = loadEnv();
  const a = sampleState(env);
  const b = sampleState(env);
  b.dailyRecords = b.dailyRecords.slice(0, 1);
  env.ls.setItem(env.STORAGE_KEY, JSON.stringify(a));
  assert.equal(env.Backup.applyRestore(b).ok, true);
  assert.deepEqual(JSON.parse(env.ls.getItem(env.STORAGE_KEY)), clone(b));
  assert.equal(env.Backup.rollbackToPreRestore().ok, true);
  assert.deepEqual(JSON.parse(env.ls.getItem(env.STORAGE_KEY)), clone(a));
  assert.equal(env.Backup.rollbackToPreRestore().ok, true); // 逆向きにもう一度
  assert.deepEqual(JSON.parse(env.ls.getItem(env.STORAGE_KEY)), clone(b));
});

test("復元前に戻す: 退避が無い／壊れている／新しい版のときは何も変えない", () => {
  const env = loadEnv();
  const cur = JSON.stringify(sampleState(env));
  env.ls.setItem(env.STORAGE_KEY, cur);
  assert.equal(env.Backup.rollbackToPreRestore().code, "NO_PRE_RESTORE");
  env.ls.setItem(env.Backup.PRE_RESTORE_KEY, "壊れた");
  assert.equal(env.Backup.rollbackToPreRestore().code, "PRE_RESTORE_INVALID");
  env.ls.setItem(env.Backup.PRE_RESTORE_KEY, "{not json");
  assert.equal(env.Backup.rollbackToPreRestore().code, "PRE_RESTORE_INVALID");
  env.ls.setItem(env.Backup.PRE_RESTORE_KEY, JSON.stringify({ schemaVersion: 99 }));
  assert.equal(env.Backup.rollbackToPreRestore().code, "PRE_RESTORE_INVALID");
  assert.equal(env.ls.getItem(env.STORAGE_KEY), cur);
});

test("parse() は localStorage に一切書き込まない（検証だけ）", () => {
  const env = loadEnv();
  const text = exportText(env, sampleState(env));
  env.Backup.parse(text, null);
  const bad = JSON.parse(text);
  bad.state.dailyRecords[0].date = "bad";
  env.Backup.parse(JSON.stringify(bad), null);
  assert.equal(env.ls.setCalls.length, 0);
});

// ============ ストレージの安全策（旧版アプリによる上書き防止・移行前退避） ============

test("読み込み: 新しい版(v99)のデータは読み取り専用で起動し、保存しない", () => {
  const env = loadEnv();
  const raw = JSON.stringify({ schemaVersion: 99, profile: {}, future: true });
  env.ls.setItem(env.STORAGE_KEY, raw);
  env.ls.setCalls.length = 0;
  const s = env.Storage.load();
  assert.equal(env.Storage.readOnly, true);
  assert.equal(env.Storage.readOnlyReason, "newerSchema");
  assert.equal(s.future, true);
  assert.equal(env.Storage.save(s), false);
  assert.equal(env.ls.getItem(env.STORAGE_KEY), raw, "新しいデータは1バイトも変わらない");
  assert.equal(env.ls.setCalls.length, 0, "書き込み呼び出し自体が0回");
});

test("保存: 保存済みが新しい版なら（別タブ等が書いた場合）上書きしない", () => {
  const env = loadEnv();
  const state = sampleState(env);
  const newer = JSON.stringify({ schemaVersion: 6, data: "新" });
  env.ls.setItem(env.STORAGE_KEY, newer);
  assert.equal(env.Storage.save(state), false);
  assert.equal(env.ls.getItem(env.STORAGE_KEY), newer);
  assert.equal(env.Storage.readOnly, true);
});

test("保存: メモ欄に schemaVersion という文字列があっても誤判定しない", () => {
  const env = loadEnv();
  const state = sampleState(env);
  state.dailyRecords[0].comment = '"schemaVersion": 99';
  env.ls.setItem(env.STORAGE_KEY, JSON.stringify(state));
  assert.equal(env.Storage.save(state), true);
  assert.equal(env.Storage.readOnly, false);
});

test("読み込み: 同じ版(v5)は読み込むだけで書き込まない", () => {
  const env = loadEnv();
  env.ls.setItem(env.STORAGE_KEY, JSON.stringify(sampleState(env)));
  env.ls.setCalls.length = 0;
  env.Storage.load();
  assert.equal(env.Storage.readOnly, false);
  assert.equal(env.ls.setCalls.length, 0);
});

function v3Raw() {
  return JSON.stringify({
    schemaVersion: 3,
    profile: { heightCm: 162, startDate: "2026-09-01", startWeight: 67.3, proteinTarget: 75, bmiMaintenanceAlert: 21, bmiLowerLine: 20 },
    goals: { goal1: { type: "weight", value: 60, achievedAt: null, postAchievementChoice: null }, goal2: null, activeGoal: 1, mode: "reduction", maintenanceReason: null, goalHistory: [] },
    dailyRecords: [], proteinEntries: [], conditionEntries: [],
    guardrails: { bmi21: { acknowledgedForDate: null }, bmi20: { acknowledgedAt: null } },
    injections: [], proteinProducts: [], registeredFoods: [], ui: { lastScreen: "home" },
  });
}

test("読み込み: 古い版(v3)は移行前に退避してから移行・保存する", () => {
  const env = loadEnv();
  const raw = v3Raw();
  env.ls.setItem(env.STORAGE_KEY, raw);
  const s = env.Storage.load();
  assert.equal(s.schemaVersion, 5);
  assert.equal(env.ls.getItem(`${env.STORAGE_KEY}.preMigration.v3`), raw, "元のv3を退避");
  assert.equal(JSON.parse(env.ls.getItem(env.STORAGE_KEY)).schemaVersion, 5);
  assert.equal(env.Storage.readOnly, false);
});

test("読み込み: 既にある移行前の退避は上書きしない", () => {
  const env = loadEnv();
  env.ls.setItem(`${env.STORAGE_KEY}.preMigration.v3`, "最初の退避");
  env.ls.setItem(env.STORAGE_KEY, v3Raw());
  env.Storage.load();
  assert.equal(env.ls.getItem(`${env.STORAGE_KEY}.preMigration.v3`), "最初の退避");
});

test("読み込み: 移行前の退避に失敗したら、移行結果を保存せず読み取り専用", () => {
  const env = loadEnv();
  const raw = v3Raw();
  env.ls.setItem(env.STORAGE_KEY, raw);
  env.ls.failSetKeys.add(`${env.STORAGE_KEY}.preMigration.v3`);
  const s = env.Storage.load();
  assert.equal(s.schemaVersion, 5, "メモリ上では使える");
  assert.equal(env.Storage.readOnly, true);
  assert.equal(env.Storage.readOnlyReason, "preMigrationBackupFailed");
  assert.equal(env.ls.getItem(env.STORAGE_KEY), raw, "保存データは変わらない");
});

test("読み込み: 壊れたJSON／null は退避して初期状態へ", () => {
  for (const bad of ["{壊れている", "null", "[1,2]"]) {
    const env = loadEnv();
    env.ls.setItem(env.STORAGE_KEY, bad);
    const s = env.Storage.load();
    assert.equal(s.schemaVersion, 5);
    const corrupted = [...env.ls.map.keys()].filter((k) => k.startsWith(`${env.STORAGE_KEY}.corrupted.`));
    assert.equal(corrupted.length, 1, `退避が作られる: ${bad}`);
    assert.equal(env.ls.getItem(corrupted[0]), bad);
  }
});

test("読み込み: 保存データが無い初回起動は初期状態を作る", () => {
  const env = loadEnv();
  const s = env.Storage.load();
  assert.equal(s.schemaVersion, 5);
  assert.ok(s.profile.startDate);
});
