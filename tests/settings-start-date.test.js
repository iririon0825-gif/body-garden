// 設定: 利用開始日（profile.startDate）の編集。新規fieldなし・schema変更なし。
// HOMEの「利用開始○日目」の基準であり、注射の初回投与日（注射履歴から導出）とは別

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { loadEnv, sampleState, clone, exportText } = require("./helpers");

function setup({ today = "2026-10-08" } = {}) {
  const env = loadEnv();
  vm.runInContext(`todayISODate = () => ${JSON.stringify(today)};`, env.ctx);
  // 画面層（SettingsUI）を、DOMに触れない部分だけ使えるよう読み込む
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", "ui-settings.js"), "utf8"), env.ctx, { filename: "ui-settings.js" });
  const S = env.get("SettingsUI");
  const log = { saves: 0, confirms: 0 };
  vm.runInContext(
    `var UI = { confirmProfileChange(fn){ __log.confirms++; fn(); } };
     var ProteinSettingsUI = { render(){} }; var BackupUI = { render(){} };`,
    Object.assign(env.ctx, { __log: log })
  );
  env.Storage.save = () => {
    log.saves++;
    return true;
  };
  S._renderForm = () => {}; // 描画はしない（検証・保存の流れだけ見る）
  const state = sampleState(env);
  S._draft = S._buildDraft(state);
  return { env, S, state, log };
}

function trySave(S, state, startDate) {
  S._draft.profile.startDate = startDate;
  S._error = null;
  S._handleSave(state);
  return S._error;
}

// ---------- 検証（空欄・不正日付・未来日） ----------

test("利用開始日: 有効な日付だけ受け付ける（今日以前・実在する日・2000〜2100年）", () => {
  const { S } = setup();
  for (const ok of ["2026-09-28", "2026-10-08", "2000-01-01", "2024-02-29"]) assert.equal(S._startDateError(ok), null, ok);
});

test("利用開始日: 空欄は拒否する", () => {
  const { S } = setup();
  assert.match(S._startDateError(""), /入力してください/);
  assert.match(S._startDateError(null), /入力してください/);
  assert.match(S._startDateError(undefined), /入力してください/);
});

test("利用開始日: 不正な日付（存在しない日・形式違い・範囲外の年）は拒否する", () => {
  const { S } = setup();
  for (const bad of ["2026-02-30", "2026-13-01", "abc", "2026/10/01", "1999-12-31", "2101-01-01", "0001-01-01"]) {
    assert.match(S._startDateError(bad), /実在する日付/, bad);
  }
});

test("利用開始日: 未来日は拒否する（今日はOK）", () => {
  const { S } = setup({ today: "2026-10-08" });
  assert.match(S._startDateError("2026-10-09"), /今日以前/);
  assert.equal(S._startDateError("2026-10-08"), null);
});

test("画面で保存できる日付は、JSONバックアップの復元でも必ず受け付けられる（Backup._isRealISODateと一致）", () => {
  const { env, S } = setup();
  const isReal = env.get("Backup")._isRealISODate.bind(env.get("Backup"));
  for (const v of ["2026-09-28", "2000-01-01", "2024-02-29", "1999-12-31", "2026-02-30", "2101-01-01", "x"]) {
    if (S._startDateError(v) === null) assert.equal(isReal(v), true, `${v} は保存できるなら復元もできる`);
  }
});

// ---------- 保存 ----------

test("既存のstartDateが初期表示（下書き）に入る", () => {
  const { S, state } = setup();
  assert.equal(S._draft.profile.startDate, state.profile.startDate);
  assert.equal(state.profile.startDate, "2026-09-29");
});

test("日付を変更して保存すると state.profile.startDate が更新される（確認ダイアログを経る）", () => {
  const { S, state, log } = setup();
  const err = trySave(S, state, "2026-09-28");
  assert.equal(err, null);
  assert.equal(state.profile.startDate, "2026-09-28");
  assert.equal(log.confirms, 1, "開始条件の変更は確認を挟む");
  assert.equal(log.saves, 1);
});

test("空欄・不正日付・未来日で保存しようとすると、stateを変えず保存もしない", () => {
  const { S, state, log } = setup();
  const before = JSON.stringify(state);
  for (const bad of ["", "2026-02-30", "1999-01-01", "2026-10-09"]) {
    const err = trySave(S, state, bad);
    assert.ok(err, `${bad} はエラーになる`);
  }
  assert.equal(JSON.stringify(state), before);
  assert.equal(log.saves, 0);
});

test("利用開始日を保存しても、他の記録・schemaVersion・注射履歴は変わらない", () => {
  const { env, S, state } = setup();
  const before = clone(state);
  assert.equal(trySave(S, state, "2026-09-28"), null);
  const after = clone(state);
  const strip = (s) => ({ ...s, profile: { ...s.profile, startDate: null } });
  assert.deepEqual(strip(after), strip(before), "startDate以外はすべて同じ");
  assert.equal(after.schemaVersion, 7);
  assert.equal(Object.keys(after.profile).sort().join(), Object.keys(before.profile).sort().join(), "profileに新規fieldを増やさない");
});

// ---------- HOMEの「利用開始○日目」・注射の初回投与日・バックアップ ----------

test("HOMEの利用開始○日目: 新しいstartDate基準で再計算される（9/28 → 10/8 は11日目）", () => {
  const { env, S, state } = setup({ today: "2026-10-08" });
  const Calc = env.get("Calc");
  assert.equal(Calc.elapsedDays(state.profile.startDate, "2026-10-08"), 10, "変更前（9/29始まり）");
  trySave(S, state, "2026-09-28");
  assert.equal(Calc.elapsedDays(state.profile.startDate, "2026-10-08"), 11, "変更後（9/28始まり）");
});

test("注射の初回投与日は、利用開始日を変えても変わらない（別概念）", () => {
  const { env, S, state } = setup();
  const L = env.get("InjectionLogic");
  state.injections = [Object.assign(env.get("createEmptyInjection()"), { id: 1, status: "administered", kind: "regular", administeredAt: "2026-10-02", administeredTime: "09:30", dose: 2.5 })];
  assert.equal(L.firstAdministeredDate(state), "2026-10-02");
  trySave(S, state, "2026-09-28");
  assert.equal(L.firstAdministeredDate(state), "2026-10-02");
  trySave(S, state, "2026-10-05");
  assert.equal(L.firstAdministeredDate(state), "2026-10-02");
});

test("JSONバックアップ: 変更した利用開始日が書き出し→読み込みで維持される", () => {
  const { env, S, state } = setup();
  trySave(S, state, "2026-09-28");
  const r = env.Backup.parse(exportText(env, state), null);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.state.profile.startDate, "2026-09-28");
});
