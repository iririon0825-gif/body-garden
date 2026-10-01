// 体組成: 保存前の確認（同じ日の差分）・保存・体重との整合・ロールバック・削除・既存データへの非干渉

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadEnv, sampleState, clone, exportText } = require("./helpers");

const NOW = new Date(2026, 9, 15, 12, 0);
const KEYS = ["measuredWeight", "bmi", "bodyFatPct", "heartRate", "muscleMass", "bmr", "waterPct", "bodyFatMass", "leanMass", "boneMass", "visceralFat", "proteinPct", "skeletalMuscleMass", "subcutaneousFat", "bodyAge", "bodyType"];

function setup(mutate) {
  const env = loadEnv();
  const B = env.get("BodyCompositionLogic");
  const s = sampleState(env);
  if (mutate) mutate(s, env);
  return { env, B, s };
}
// 解析 → 確認 → 保存に必要な decisions を作る
function plan(B, s, text, over = {}) {
  const parsed = B.parse(text || B.sampleText(), NOW);
  const date = over.date !== undefined ? over.date : parsed.date;
  const a = B.assess(s, parsed, date, NOW);
  const decisions = { date, time: parsed.time, overwrite: {}, weight: "keep", acknowledged: true, basis: a.basis, ...over.decisions };
  return { parsed, a, decisions, date };
}
const snapshot = (s) => JSON.stringify(s);

test("新しい日: 16項目がすべて add。体重は「登録」を選べる。BMI差の警告・確認の要否", () => {
  const { B, s } = setup();
  const p = plan(B, s, null, { date: "2026-10-02" });
  assert.equal(p.a.existing, null);
  assert.equal(p.a.rows.length, 16);
  assert.ok(p.a.rows.every((r) => r.kind === "add"));
  assert.equal(p.a.weight.kind, "add");
  assert.equal(p.a.weight.measured, 66.8);
  assert.deepEqual(clone(p.a.blocking), []);
  assert.equal(p.a.needsAck, false, "16項目すべて読み取れていて警告もなければ、確認チェックは不要");
  assert.equal(p.a.bmiCheck, null, "BMI 25.5 と 66.8/1.62² は 0.2 以内");
});

test("保存（新しい日）: 16キーがそろった記録が作られ、日付順に入る。compositionMeta が付く。体重は既定で触らない", () => {
  const { B, s } = setup();
  const before = s.dailyRecords.length;
  const p = plan(B, s, null, { date: "2026-10-02" });
  const r = B.applyImport(s, p.parsed, p.decisions, NOW);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(s.dailyRecords.length, before + 1);
  const rec = s.dailyRecords.find((x) => x.date === "2026-10-02");
  assert.deepEqual(clone(Object.keys(rec.bodyComposition)), KEYS);
  assert.equal(rec.bodyComposition.measuredWeight, 66.8);
  assert.equal(rec.bodyComposition.bmi, 25.5);
  assert.equal(rec.bodyComposition.bodyType, "標準型");
  assert.equal(rec.weight, null, "weight: keep を選んだので、その日の体重は登録しない");
  assert.equal(r.weightChanged, false);
  assert.deepEqual(clone(rec.compositionMeta), { measuredTime: "07:12", source: "paste", formatVersion: 1, importedAt: NOW.toISOString(), updatedAt: NOW.toISOString(), mixed: false });
  const dates = s.dailyRecords.map((x) => x.date);
  assert.deepEqual(dates, [...dates].sort(), "日付順");
  assert.equal(r.written.length, 16);
});

test("体重: 既存がなければ登録を選べる（weightChanged=true）。選ばなければ体重は null のまま", () => {
  const { B, s } = setup();
  const p = plan(B, s, null, { date: "2026-10-02", decisions: { weight: "set" } });
  const r = B.applyImport(s, p.parsed, p.decisions, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.weightChanged, true);
  assert.equal(s.dailyRecords.find((x) => x.date === "2026-10-02").weight, 66.8);
});

test("同じ日に既存の体重・体組成がある: 既存を残す（既定）。違う値は conflict として並べ、無断で上書きしない", () => {
  const { B, s } = setup((st) => {
    const rec = st.dailyRecords.find((r) => r.date === "2026-09-30");
    rec.bodyComposition = { ...clone(st.dailyRecords[0].bodyComposition), bodyFatPct: 30.0, muscleMass: 43.7, heartRate: 70 };
  });
  const p = plan(B, s, null, { date: "2026-09-30" });
  const row = (k) => p.a.rows.find((r) => r.key === k);
  assert.equal(row("bodyFatPct").kind, "conflict", "既存30.0 と 今回31.2");
  assert.equal(row("muscleMass").kind, "same");
  assert.equal(row("heartRate").kind, "conflict");
  assert.equal(row("bmi").kind, "add");
  assert.equal(p.a.weight.kind, "conflict", "既存の体重 66.9 と 今回の 66.8");
  assert.equal(p.a.weight.diff, -0.1);
  const before = snapshot(s.dailyRecords.find((r) => r.date === "2026-09-30"));
  const r = B.applyImport(s, p.parsed, p.decisions, NOW);
  assert.equal(r.ok, true, JSON.stringify(r));
  const rec = s.dailyRecords.find((x) => x.date === "2026-09-30");
  assert.equal(rec.bodyComposition.bodyFatPct, 30.0, "既存の値は上書きされない");
  assert.equal(rec.bodyComposition.heartRate, 70);
  assert.equal(rec.bodyComposition.bmi, 25.5, "空欄だった項目は追加される");
  assert.equal(rec.weight, 66.9, "既存の体重は変わらない");
  assert.equal(rec.comment, JSON.parse(before).comment, "メモも変わらない");
  assert.deepEqual(clone(r.kept).sort(), ["bodyFatPct", "heartRate"]);
  assert.equal(rec.compositionMeta.mixed, true, "既存を残した項目と新しく書いた項目が両方ある＝2回分の測定が混ざる");
});

test("上書きは本人が項目ごとに明示的に選んだときだけ。体重も同様", () => {
  const { B, s } = setup((st) => {
    st.dailyRecords.find((r) => r.date === "2026-09-30").bodyComposition = { ...clone(st.dailyRecords[0].bodyComposition), bodyFatPct: 30.0, heartRate: 70 };
  });
  const p = plan(B, s, null, { date: "2026-09-30", decisions: { overwrite: { bodyFatPct: true }, weight: "set" } });
  const r = B.applyImport(s, p.parsed, p.decisions, NOW);
  assert.equal(r.ok, true, JSON.stringify(r));
  const rec = s.dailyRecords.find((x) => x.date === "2026-09-30");
  assert.equal(rec.bodyComposition.bodyFatPct, 31.2, "選んだ項目だけ上書き");
  assert.equal(rec.bodyComposition.heartRate, 70, "選ばなかった項目は既存のまま");
  assert.deepEqual(clone(r.overwritten), ["bodyFatPct"]);
  assert.equal(rec.weight, 66.8, "体重を「体組成計の値にする」と選んだ");
  assert.equal(r.weightChanged, true);
});

test("同じ値の項目・今回が未読取の項目は、既存を変えない（取り込みで値を消さない）", () => {
  const { B, s } = setup((st) => {
    st.dailyRecords.find((r) => r.date === "2026-09-30").bodyComposition = { ...clone(st.dailyRecords[0].bodyComposition), bodyFatPct: 31.2, muscleMass: 40.0 };
  });
  const text = B.sampleText().replace("筋肉量: 43.70 kg", "筋肉量: 未読取");
  const p = plan(B, s, text, { date: "2026-09-30" });
  const row = (k) => p.a.rows.find((r) => r.key === k);
  assert.equal(row("bodyFatPct").kind, "same");
  assert.equal(row("muscleMass").kind, "keep");
  assert.equal(B.applyImport(s, p.parsed, p.decisions, NOW).ok, true);
  assert.equal(s.dailyRecords.find((x) => x.date === "2026-09-30").bodyComposition.muscleMass, 40.0, "未読取で既存の値を消さない");
});

test("保存できない・保存しない条件: 日付なし・未来日・未読取だけ・確認チェックなし・変更なし", () => {
  const { B, s } = setup();
  const before = snapshot(s);
  const noDate = plan(B, s, B.sampleText().replace("測定日: 2026-10-01", "測定日: 未読取"));
  assert.equal(noDate.parsed.date, null);
  assert.equal(B.applyImport(s, noDate.parsed, noDate.decisions, NOW).code, "DATE_REQUIRED");
  const future = plan(B, s, null, { date: "2026-10-16" });
  assert.equal(B.applyImport(s, future.parsed, future.decisions, NOW).code, "FUTURE_DATE");
  const empty = B.parse("【Body Garden 体組成 v1】\n測定日: 2026-10-02\n体重: 未読取\n【ここまで】", NOW);
  const e = B.assess(s, empty, "2026-10-02", NOW);
  assert.equal(e.blocking[0].code, "NOTHING_TO_SAVE");
  const missing = plan(B, s, B.sampleText().replace("骨量: 2.30 kg", "骨量: 未読取"), { date: "2026-10-02" });
  assert.equal(missing.a.needsAck, true, "保存されない項目があるので確認が必要");
  assert.equal(B.applyImport(s, missing.parsed, { ...missing.decisions, acknowledged: false }, NOW).code, "ACK_REQUIRED");
  assert.equal(B.applyImport(s, missing.parsed, { ...missing.decisions, acknowledged: true }, NOW).ok, true);
  assert.equal(snapshot(s) === before, false);
  // 変更が無い（既存と同じ・既存を残す）
  const again = plan(B, s, B.sampleText().replace("骨量: 2.30 kg", "骨量: 未読取"), { date: "2026-10-02" });
  assert.equal(B.applyImport(s, again.parsed, again.decisions, NOW).code, "NOTHING_TO_SAVE", "同じ内容を、もう一度保存しようとしても変更なし");
});

test("保存に失敗する場合は、state を一切変えない（ACK・未来日・不正な上書き・古いプレビュー）", () => {
  const { B, s } = setup((st) => {
    st.dailyRecords.find((r) => r.date === "2026-09-30").bodyComposition = { ...clone(st.dailyRecords[0].bodyComposition), bodyFatPct: 30.0 };
  });
  const before = snapshot(s);
  const p = plan(B, s, B.sampleText().replace("骨量: 2.30 kg", "骨量: 未読取"), { date: "2026-09-30" });
  assert.equal(B.applyImport(s, p.parsed, { ...p.decisions, acknowledged: false }, NOW).code, "ACK_REQUIRED");
  assert.equal(B.applyImport(s, p.parsed, { ...p.decisions, overwrite: { heartRate: true } }, NOW).code, "INVALID_DECISION", "conflict でない項目は上書きできない");
  assert.equal(B.applyImport(s, p.parsed, { ...p.decisions, overwrite: { nothing: true } }, NOW).code, "INVALID_DECISION");
  assert.equal(B.applyImport(s, p.parsed, { ...p.decisions, weight: "set", date: "2026-10-16" }, NOW).code, "FUTURE_DATE");
  assert.equal(B.applyImport(s, p.parsed, { ...p.decisions, time: "25:00" }, NOW).code, "INVALID_TIME");
  assert.equal(B.applyImport(s, { ok: false }, p.decisions, NOW).code, "INVALID_PARSE");
  assert.equal(snapshot(s), before, "失敗した操作は state を変えない");
  // プレビュー後に、その日の記録が変わった（別の操作）ときは保存しない
  s.dailyRecords.find((r) => r.date === "2026-09-30").bodyComposition.bodyFatPct = 29.0;
  const changed = snapshot(s);
  assert.equal(B.applyImport(s, p.parsed, p.decisions, NOW).code, "STALE_PREVIEW");
  assert.equal(snapshot(s), changed);
});

test("確認の注意: 範囲外(soft)・桁数・項目どうしの食い違いは、警告つきで保存できる（確認が必須）", () => {
  const { B, s } = setup();
  const text = B.sampleText().replace("内臓脂肪: 9", "内臓脂肪: 45");
  const p = plan(B, s, text, { date: "2026-10-02" });
  assert.equal(p.parsed.counts.suspect, 1);
  assert.equal(p.a.needsAck, true);
  assert.equal(B.applyImport(s, p.parsed, { ...p.decisions, acknowledged: false }, NOW).code, "ACK_REQUIRED");
  assert.equal(B.applyImport(s, p.parsed, p.decisions, NOW).ok, true);
  assert.equal(s.dailyRecords.find((r) => r.date === "2026-10-02").bodyComposition.visceralFat, 45);
});

test("体組成計のBMIとアプリ計算のBMIが違うときは警告のみ。保存されるのは体組成計の値、判定にはアプリ計算を使う", () => {
  const { B, s, env } = setup();
  const text = B.sampleText().replace("BMI: 25.5", "BMI: 24.0");
  const p = plan(B, s, text, { date: "2026-10-02", decisions: { weight: "set" } });
  assert.ok(p.a.bmiCheck && p.a.bmiCheck.measured === 24.0);
  assert.ok(p.a.warnings.some((w) => w.code === "BMI_DIFF"));
  assert.equal(B.applyImport(s, p.parsed, p.decisions, NOW).ok, true);
  const rec = s.dailyRecords.find((r) => r.date === "2026-10-02");
  assert.equal(rec.bodyComposition.bmi, 24.0, "BMIは体組成計の測定表示値として保存");
  const Calc = env.get("Calc");
  assert.equal(Math.round(Calc.bmi(rec.weight, s.profile.heightCm) * 10) / 10, 25.5, "判定用のBMIはアプリ計算（体重と身長から）");
});

test("測定日の警告: 30日より前・開始日より前は警告（確認が必要）", () => {
  const { B, s } = setup();
  const old = B.assess(s, B.parse(B.sampleText(), NOW), "2026-08-01", NOW);
  assert.ok(old.warnings.some((w) => w.code === "OLD_DATE"));
  assert.ok(old.warnings.some((w) => w.code === "BEFORE_START"));
  assert.equal(old.needsAck, true);
});

// ---------- 体重の保存との連携（afterWeightSave）とロールバック ----------

test("体重が実際に変わったときだけ Logic.afterWeightSave を呼ぶ（Goal達成）。失敗時は記録と goals を元に戻す", () => {
  const { B, s, env } = setup();
  const Logic = env.get("Logic");
  const text = B.sampleText().replace("体重: 66.80 kg", "体重: 59.90 kg").replace("BMI: 25.5", "BMI: 22.8");
  // 体重を登録しない選択: 変更なし → afterWeightSave は不要（goals は変わらない）
  const keep = plan(B, s, text, { date: "2026-10-02" });
  const goalsBefore0 = snapshot(s.goals);
  const r0 = B.applyImport(s, keep.parsed, keep.decisions, NOW);
  assert.equal(r0.ok, true);
  assert.equal(r0.weightChanged, false);
  assert.equal(snapshot(s.goals), goalsBefore0);
  B.applyDeleteComposition(s, "2026-10-02");

  // 体重を登録する選択: weightChanged → afterWeightSave（Goal1=60kg 達成）
  const p = plan(B, s, text, { date: "2026-10-02", decisions: { weight: "set" } });
  const histBefore = s.goals.goalHistory.length;
  const snap = { date: "2026-10-02", prevRecord: null, goals: clone(s.goals) };
  const r = B.applyImport(s, p.parsed, p.decisions, NOW);
  assert.equal(r.weightChanged, true);
  const modals = Logic.afterWeightSave(s, r.record);
  assert.ok(s.goals.goal1.achievedAt, "Goal1 達成が記録された");
  assert.equal(s.goals.goalHistory.length, histBefore + 1, "達成の履歴が1件追加された");
  assert.ok(Array.isArray(modals));
  // 保存に失敗した想定: 元に戻す
  B.revertImport(s, snap);
  assert.equal(s.dailyRecords.find((x) => x.date === "2026-10-02"), undefined, "新しい日の記録は消える");
  assert.equal(s.goals.goal1.achievedAt, null, "goals も元に戻る");
  assert.equal(s.goals.goalHistory.length, histBefore, "履歴も元に戻る");
});

test("ロールバック: 既存の日を更新したあと revert すると、元の記録に戻る（体重・体組成・メモ）", () => {
  const { B, s } = setup();
  const original = clone(s.dailyRecords.find((r) => r.date === "2026-09-30"));
  const p = plan(B, s, null, { date: "2026-09-30", decisions: { weight: "set", overwrite: {} } });
  const prevRecord = clone(s.dailyRecords.find((r) => r.date === "2026-09-30"));
  const r = B.applyImport(s, p.parsed, p.decisions, NOW);
  assert.equal(r.ok, true);
  assert.notDeepEqual(clone(s.dailyRecords.find((x) => x.date === "2026-09-30")), original);
  B.revertImport(s, { date: "2026-09-30", prevRecord, goals: clone(s.goals) });
  assert.deepEqual(clone(s.dailyRecords.find((x) => x.date === "2026-09-30")), original);
});

// ---------- 削除・履歴 ----------

test("削除: 体組成だけが消え、体重・メモは残る。体組成だけの日は記録ごと取り除く", () => {
  const { B, s } = setup();
  const withWeight = plan(B, s, null, { date: "2026-09-30" });
  B.applyImport(s, withWeight.parsed, withWeight.decisions, NOW);
  const only = plan(B, s, null, { date: "2026-10-02" });
  B.applyImport(s, only.parsed, only.decisions, NOW);
  const d1 = B.applyDeleteComposition(s, "2026-09-30");
  assert.deepEqual(clone(d1), { ok: true, removedRecord: false });
  const rec = s.dailyRecords.find((r) => r.date === "2026-09-30");
  assert.equal(rec.weight, 66.9, "体重は残る");
  assert.equal(rec.comment, "メモ <b>強調</b>");
  assert.ok(Object.values(rec.bodyComposition).every((v) => v === null));
  assert.equal(rec.compositionMeta, null);
  const d2 = B.applyDeleteComposition(s, "2026-10-02");
  assert.deepEqual(clone(d2), { ok: true, removedRecord: true });
  assert.equal(s.dailyRecords.find((r) => r.date === "2026-10-02"), undefined);
  assert.equal(B.applyDeleteComposition(s, "2026-10-02").code, "NOT_FOUND");
  assert.equal(B.applyDeleteComposition(s, "2026-09-30").code, "NO_COMPOSITION");
});

test("履歴: 体組成のある日だけを新しい順に（20件まで）", () => {
  const { B, s } = setup();
  for (const d of ["2026-10-02", "2026-10-03", "2026-10-04"]) {
    const p = plan(B, s, B.sampleText().replace("2026-10-01", d), { date: d });
    assert.equal(B.applyImport(s, p.parsed, p.decisions, NOW).ok, true);
  }
  const rows = B.historyRows(s, 20);
  assert.deepEqual(rows.map((r) => r.date), ["2026-10-04", "2026-10-03", "2026-10-02", "2026-09-29"].filter((d) => rows.some((r) => r.date === d)));
  assert.ok(rows.every((r) => r.compositionMeta || Object.values(r.bodyComposition).some((v) => v !== null)));
  assert.equal(B.historyRows(s, 2).length, 2);
});

// ---------- 既存データへの非干渉 ----------

test("体組成の保存・上書き・削除は、注射履歴・在庫・定例スケジュール・Protein・体調・Goal に影響しない", () => {
  const { B, s, env } = setup((st, e) => {
    st.injections = [Object.assign(e.get("createEmptyInjection()"), { id: 1, status: "administered", kind: "regular", administeredAt: "2026-10-01", administeredTime: "09:00", dose: 2.5 })];
  });
  const untouched = () => snapshot({ injections: s.injections, injectionSchedule: s.injectionSchedule, injectionStock: s.injectionStock, proteinEntries: s.proteinEntries, conditionEntries: s.conditionEntries, goals: s.goals, guardrails: s.guardrails, proteinProducts: s.proteinProducts, registeredFoods: s.registeredFoods, profile: s.profile });
  const before = untouched();
  const stockBefore = env.get("InjectionLogic").stockSummary(s).remaining;
  const p = plan(B, s, null, { date: "2026-10-02" });
  assert.equal(B.applyImport(s, p.parsed, p.decisions, NOW).ok, true);
  assert.equal(untouched(), before, "保存");
  const p2 = plan(B, s, B.sampleText().replace("体脂肪率: 31.2 %", "体脂肪率: 30.0 %"), { date: "2026-10-02", decisions: { overwrite: { bodyFatPct: true } } });
  assert.equal(B.applyImport(s, p2.parsed, p2.decisions, NOW).ok, true);
  assert.equal(untouched(), before, "上書き");
  assert.equal(B.applyDeleteComposition(s, "2026-10-02").ok, true);
  assert.equal(untouched(), before, "削除");
  assert.equal(env.get("InjectionLogic").stockSummary(s).remaining, stockBefore, "在庫の残りも変わらない");
});

test("体組成だけの日（体重 null）は、HOME・グラフ・最新体重に出ない。既存の体重の記録も変わらない", () => {
  const { B, s, env } = setup();
  const Calc = env.get("Calc");
  const latestBefore = Calc.latestWeightRecord(s.dailyRecords).date;
  const p = plan(B, s, null, { date: "2026-10-02" });
  B.applyImport(s, p.parsed, p.decisions, NOW);
  assert.equal(Calc.latestWeightRecord(s.dailyRecords).date, latestBefore, "体重のない日は最新体重にならない");
  const withWeight = s.dailyRecords.filter((r) => r.weight != null).length;
  assert.equal(withWeight, 3, "体重のある記録の数は変わらない");
});

// ---------- バックアップとの往復 ----------

test("取り込んだ体組成は、書き出し→読み込みで完全に一致する（16項目・compositionMeta）。selfCheck も通る", () => {
  const { B, s, env } = setup();
  const p = plan(B, s, null, { date: "2026-10-02", decisions: { weight: "set" } });
  B.applyImport(s, p.parsed, p.decisions, NOW);
  const text = exportText(env, s);
  assert.equal(env.Backup.selfCheck(text).ok, true, JSON.stringify(env.Backup.selfCheck(text)));
  const r = env.Backup.parse(text, null);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(clone(r.state), clone(s));
  assert.equal(env.Backup.applyRestore(r.state).ok, true);
});

test("バックアップ検証: ボディタイプの不正・compositionMeta の不正は拒否し、範囲外の数値は警告のみ", () => {
  const { env } = setup();
  const mk = (mutate) => {
    const s = sampleState(env);
    s.dailyRecords[1].bodyComposition = { ...env.get("EMPTY_BODY_COMPOSITION"), bodyType: "標準型", bodyFatPct: 31.2 };
    s.dailyRecords[1].compositionMeta = { measuredTime: "07:12", source: "paste", formatVersion: 1, importedAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", mixed: false };
    mutate(s.dailyRecords[1]);
    const e = JSON.parse(exportText(env, sampleState(env)));
    e.state = clone(s);
    e.counts = env.Backup.counts(e.state);
    return env.Backup.parse(JSON.stringify(e), null);
  };
  assert.equal(mk(() => {}).ok, true);
  assert.equal(mk((r) => (r.bodyComposition.bodyType = "<img onerror=1>")).ok, false);
  assert.equal(mk((r) => (r.bodyComposition.bodyType = "あ".repeat(21))).ok, false);
  assert.equal(mk((r) => (r.bodyComposition.bodyType = "=1+1")).ok, false);
  assert.equal(mk((r) => (r.bodyComposition.bodyType = 5)).ok, false, "文字列でない");
  assert.equal(mk((r) => (r.bodyComposition.bodyFatPct = "31.2")).ok, false, "数値の項目に文字列");
  assert.equal(mk((r) => (r.bodyComposition.heartRate = 9999)).ok, true, "範囲外の数値は取り込める");
  assert.ok(mk((r) => (r.bodyComposition.heartRate = 9999)).warnings.some((w) => w.includes("範囲外")));
  assert.equal(mk((r) => (r.compositionMeta.source = "ocr")).ok, false);
  assert.equal(mk((r) => (r.compositionMeta.extra = 1)).ok, false, "知らない項目");
  assert.equal(mk((r) => (r.compositionMeta.measuredTime = "25:00")).ok, false);
  assert.equal(mk((r) => (r.compositionMeta.mixed = "no")).ok, false);
  assert.equal(mk((r) => (r.compositionMeta = null)).ok, true, "compositionMeta なし（null）は可");
  assert.equal(mk((r) => delete r.compositionMeta).ok, true, "古い形式（項目なし）も可");
});

test("体重タブの保存（getRecordForDate → weight だけ上書き → upsertRecord）は、体組成と compositionMeta を消さない", () => {
  const { B, s, env } = setup();
  const p = plan(B, s, null, { date: "2026-10-02" });
  assert.equal(B.applyImport(s, p.parsed, p.decisions, NOW).ok, true);
  const bcBefore = clone(s.dailyRecords.find((r) => r.date === "2026-10-02").bodyComposition);
  const metaBefore = clone(s.dailyRecords.find((r) => r.date === "2026-10-02").compositionMeta);
  // ui-records.js と同じ書き方
  const rec = env.Storage.getRecordForDate(s, "2026-10-02");
  rec.weight = 66.5;
  env.Storage.upsertRecord(s, rec);
  const after = s.dailyRecords.find((r) => r.date === "2026-10-02");
  assert.equal(after.weight, 66.5);
  assert.deepEqual(clone(after.bodyComposition), bcBefore);
  assert.deepEqual(clone(after.compositionMeta), metaBefore);
});
