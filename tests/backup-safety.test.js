// Body Garden — JSONバックアップ: 失敗経路・退避の保全・実アプリ関数で作ったデータの往復
// （Opusレビューの指摘を再現するテスト。node --test）

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadEnv, sampleState, clone, exportText, envelopeOf } = require("./helpers");

// ============ 退避（preRestore）の保全 ============

test("復元前に戻す: 本体の書き込みに失敗しても、退避を失わない（本体も退避も操作前のまま）", () => {
  const env = loadEnv();
  const a = sampleState(env);
  const b = sampleState(env);
  b.dailyRecords = b.dailyRecords.slice(0, 1);
  env.ls.setItem(env.STORAGE_KEY, JSON.stringify(a));
  assert.equal(env.Backup.applyRestore(b).ok, true); // 本体=b、退避=a
  const mainBefore = env.ls.getItem(env.STORAGE_KEY);
  const preBefore = env.ls.getItem(env.Backup.PRE_RESTORE_KEY);
  env.ls.failSetKeys.add(env.STORAGE_KEY); // 本体への書き込みだけ失敗させる
  const r = env.Backup.rollbackToPreRestore();
  assert.equal(r.ok, false);
  assert.equal(r.code, "WRITE_FAILED");
  assert.equal(env.ls.getItem(env.STORAGE_KEY), mainBefore, "本体は操作前のまま");
  assert.equal(env.ls.getItem(env.Backup.PRE_RESTORE_KEY), preBefore, "退避(a)は失われない");
});

test("復元に失敗しても、以前の退避の世代は変わらない", () => {
  const env = loadEnv();
  const gen1 = JSON.stringify({ ...sampleState(env), note: "最初の退避" });
  env.ls.setItem(env.Backup.PRE_RESTORE_KEY, gen1);
  env.ls.setItem(env.Backup.PRE_RESTORE_AT_KEY, "2026-10-01T00:00:00.000Z");
  const cur = JSON.stringify(sampleState(env));
  env.ls.setItem(env.STORAGE_KEY, cur);
  env.ls.failSetKeys.add(env.STORAGE_KEY);
  const incoming = sampleState(env);
  incoming.dailyRecords = incoming.dailyRecords.slice(0, 1);
  const r = env.Backup.applyRestore(incoming);
  assert.equal(r.ok, false);
  assert.equal(env.ls.getItem(env.STORAGE_KEY), cur);
  assert.equal(env.ls.getItem(env.Backup.PRE_RESTORE_KEY), gen1, "以前の退避が残る");
  assert.equal(env.ls.getItem(env.Backup.PRE_RESTORE_AT_KEY), "2026-10-01T00:00:00.000Z");
});

test("復元・戻す: 保存済みのデータが新しい版なら上書きしない", () => {
  const env = loadEnv();
  const newer = JSON.stringify({ schemaVersion: 8, future: true });
  env.ls.setItem(env.STORAGE_KEY, newer);
  env.ls.setCalls.length = 0;
  assert.equal(env.Backup.applyRestore(sampleState(env)).code, "NEWER_STORED");
  env.ls.setItem(env.Backup.PRE_RESTORE_KEY, JSON.stringify(sampleState(env)));
  env.ls.setCalls.length = 0;
  assert.equal(env.Backup.rollbackToPreRestore().code, "NEWER_STORED");
  assert.equal(env.ls.getItem(env.STORAGE_KEY), newer);
  assert.equal(env.ls.setCalls.length, 0);
});

test("復元後の保存データは schemaVersion が先頭の項目になる", () => {
  const env = loadEnv();
  const s = sampleState(env);
  const reordered = { profile: s.profile, ...s }; // 先頭が schemaVersion でない形
  assert.equal(env.Backup.applyRestore(reordered).ok, true);
  assert.match(env.ls.getItem(env.STORAGE_KEY), /^\{"schemaVersion":6,/);
});

// ============ ストレージの安全策 ============

test("読み込み: 壊れたデータの退避に失敗したら、初期状態で上書きしない", () => {
  const env = loadEnv();
  env.ls.setItem(env.STORAGE_KEY, "{壊れている");
  env.ls.failAllSet = true; // 退避も初期状態の保存も失敗する状況
  const s = env.Storage.load();
  assert.equal(env.Storage.readOnly, true);
  assert.equal(env.Storage.readOnlyReason, "corruptBackupFailed");
  assert.equal(s.schemaVersion, 6, "メモリ上の初期状態で起動できる");
  assert.equal(env.ls.getItem(env.STORAGE_KEY), "{壊れている", "元のデータは消されない");
});

test("保存の失敗・新しい版の検出は、画面側へ通知される", () => {
  const env = loadEnv();
  const seen = [];
  env.Storage.onProblem = (k) => seen.push(k);
  env.ls.failSetKeys.add(env.STORAGE_KEY);
  assert.equal(env.Storage.save(sampleState(env)), false);
  env.ls.failSetKeys.clear();
  env.ls.setItem(env.STORAGE_KEY, JSON.stringify({ schemaVersion: 9 }));
  assert.equal(env.Storage.save(sampleState(env)), false);
  assert.deepEqual(clone(seen), ["saveFailed", "newerSchema"]);
});

// ============ 実際のアプリ関数で作ったデータの往復（書き出せたのに復元できない、を防ぐ） ============

test("アプリの関数で作ったProtein記録・長い名前も、書き出し→読み込みで通る", () => {
  const env = loadEnv();
  const state = env.get("createDefaultState()");
  state.profile.startDate = "2026-10-01";
  const longName = "あ".repeat(300); // 入力欄にmaxlengthは無いので、長い名前は普通に作れる
  state.proteinProducts.push({ id: 2, name: longName, servingScoops: 2, proteinPerServing: 15, status: "active", isDefault: false });
  state.registeredFoods.push({ id: 2, name: longName, unit: "個", proteinPerUnit: 8, status: "active" });
  const PL = env.get("ProteinLogic");
  const entries = [
    PL.createWheyEntry(state, "2026-10-01", "whey-default", 3),
    PL.createWheyEntry(state, "2026-10-01", 2, 1),
    PL.createFoodEntry(state, "2026-10-01", "food-oikos", 2),
    PL.createFoodEntry(state, "2026-10-01", 2, 1),
    PL.createMealEntry("2026-10-01", longName, 25.5, "メモ"),
  ];
  entries.forEach((e, i) => (e.id = i + 1));
  state.proteinEntries = entries;
  const text = env.Backup.serialize(state);
  assert.equal(env.Backup.selfCheck(text).ok, true, JSON.stringify(env.Backup.selfCheck(text)));
  const r = env.Backup.parse(text, null);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(clone(r.state), clone(state));
});

test("selfCheck: 復元の検証を通らないデータは、書き出し時点で分かる", () => {
  const env = loadEnv();
  const state = sampleState(env);
  state.proteinEntries[0].id = -5;
  assert.equal(env.Backup.selfCheck(env.Backup.serialize(state)).ok, false);
});

test("拒否: 記録idが負数・小数・巨大値／身長0／範囲外の年／goalKey不正", () => {
  const env = loadEnv();
  const cases = [
    ["負数id", (s) => (s.proteinEntries[0].id = -1)],
    ["小数id", (s) => (s.conditionEntries[0].id = 1.5)],
    ["巨大id", (s) => (s.injections[0].id = 1e300)],
    ["文字列id(記録)", (s) => (s.proteinEntries[0].id = "abc")],
    ["身長0", (s) => (s.profile.heightCm = 0)],
    ["開始体重が負", (s) => (s.profile.startWeight = -1)],
    ["1回分のスプーン数0", (s) => (s.proteinProducts[0].servingScoops = 0)],
    ["年が2200", (s) => (s.dailyRecords[0].date = "2200-01-01")],
    ["年が1900", (s) => (s.dailyRecords[0].date = "1900-01-01")],
    ["goalKey不正", (s) => (s.goals.goalHistory[0].goalKey = "goal9")],
  ];
  for (const [name, mutate] of cases) {
    const state = sampleState(env);
    mutate(state);
    const e = envelopeOf(env, sampleState(env));
    e.state = clone(state);
    e.counts = env.Backup.counts(e.state);
    const r = env.Backup.parse(JSON.stringify(e), null);
    assert.equal(r.ok, false, `拒否されるべき: ${name}`);
  }
});

test("警告のみ: 未来の日付の体重記録は取り込める", () => {
  const env = loadEnv();
  const e = envelopeOf(env, sampleState(env));
  e.state.dailyRecords[2].date = "2099-12-31";
  const r = env.Backup.parse(JSON.stringify(e), null);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.warnings.some((w) => w.includes("未来")));
});

test("__proto__ を含むファイルでも、プロトタイプは汚染されない", () => {
  const env = loadEnv();
  const text = exportText(env, sampleState(env)).replace('"ui": {', '"__proto__": {"polluted": true}, "ui": {');
  const r = env.Backup.parse(text, null);
  assert.equal({}.polluted, undefined);
  if (r.ok) assert.equal(r.state.polluted, undefined);
});

test("wrapRaw: 生データを、将来のアプリが読める包みに入れる／壊れた生データはそのまま", () => {
  const env = loadEnv();
  const wrapped = JSON.parse(env.Backup.wrapRaw(JSON.stringify({ schemaVersion: 9, injections: [{ id: 1 }] }), new Date("2026-10-01T00:00:00Z")));
  assert.equal(wrapped.app, "body-garden");
  assert.equal(wrapped.schemaVersion, 9);
  assert.equal(wrapped.counts.injections, 1);
  assert.equal(env.Backup.wrapRaw("{壊れている"), "{壊れている");
});

test("サイズ上限: 文字数だけで超える入力は、バイト数を数える前に弾く", () => {
  const env = loadEnv();
  assert.equal(env.Backup.parse("x".repeat(env.Backup.MAX_BYTES + 1), null).code, "TOO_LARGE");
});
