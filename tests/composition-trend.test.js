// 体組成トレンド（記録タブ…ではなく体組成タブ内、読み取り専用）: BodyCompositionLogic.trendPoints/trendSeries
// 保存はしない・既存データの読み取りだけ。体重グラフ・既存テストへの非干渉は charts.js 側の統合テストで確認する

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadEnv, sampleState, clone } = require("./helpers");

function setup() {
  const env = loadEnv();
  const B = env.get("BodyCompositionLogic");
  const s = sampleState(env);
  return { env, B, s };
}

function rec(date, bc, extra = {}) {
  return { date, weight: null, comment: "", bodyComposition: bc, compositionMeta: null, ...extra };
}

const NOW = new Date(2026, 9, 15, 12, 0); // 2026-10-15

// ---------- trendPoints: 対象3指標・null除外・日付昇順 ----------

test("TREND_FIELDS は bodyFatMass / skeletalMuscleMass / bodyFatPct の3つ", () => {
  const { B } = setup();
  assert.deepEqual(clone(B.TREND_FIELDS), ["bodyFatMass", "skeletalMuscleMass", "bodyFatPct"]);
});

test("trendPoints: 指定した1指標だけを、記録のある日だけ・日付昇順で返す", () => {
  const { B, s } = setup();
  s.dailyRecords = [
    rec("2026-10-03", { bodyFatMass: 20.1 }),
    rec("2026-10-01", { bodyFatMass: 20.5 }),
    rec("2026-10-02", { bodyFatMass: null }), // この指標は未記録
  ];
  const pts = B.trendPoints(s, "bodyFatMass");
  assert.deepEqual(clone(pts), [
    { date: "2026-10-01", value: 20.5 },
    { date: "2026-10-03", value: 20.1 },
  ]);
});

test("trendPoints: 3指標それぞれ独立に取り出せる（体脂肪量・骨格筋量・体脂肪率）", () => {
  const { B, s } = setup();
  s.dailyRecords = [rec("2026-10-01", { bodyFatMass: 20.5, skeletalMuscleMass: 25.4, bodyFatPct: 31.2 })];
  assert.equal(B.trendPoints(s, "bodyFatMass")[0].value, 20.5);
  assert.equal(B.trendPoints(s, "skeletalMuscleMass")[0].value, 25.4);
  assert.equal(B.trendPoints(s, "bodyFatPct")[0].value, 31.2);
});

test("trendPoints: bodyCompositionが無い日・空オブジェクトの日は含まれない", () => {
  const { B, s } = setup();
  s.dailyRecords = [
    { date: "2026-10-01", weight: 66.8, comment: "" }, // bodyComposition プロパティ自体が無い
    rec("2026-10-02", {}),
    rec("2026-10-03", { bodyFatMass: 20.0 }),
  ];
  assert.deepEqual(clone(B.trendPoints(s, "bodyFatMass")), [{ date: "2026-10-03", value: 20.0 }]);
});

test("trendPoints: 体組成を削除した日（全項目null）は自動的に除外される", () => {
  const { B, s } = setup();
  s.dailyRecords = [rec("2026-10-01", { bodyFatMass: 20.5 })];
  // applyDeleteComposition相当：全項目nullに戻る
  const del = B.applyDeleteComposition(s, "2026-10-01");
  assert.equal(del.ok, true);
  assert.deepEqual(clone(B.trendPoints(s, "bodyFatMass")), []);
});

test("trendPoints: mixed:true の記録でも、その日の最終保存値（既存を残した値／新規に書いた値）をそのまま1点として使う", () => {
  const { B, s } = setup();
  const text1 = "【Body Garden 体組成 v1】\n測定日: 2026-10-01\n体脂肪量: 19.00 kg\n【ここまで】";
  const p1 = B.parse(text1, NOW);
  const a1 = B.assess(s, p1, "2026-10-01", NOW);
  B.applyImport(s, p1, { date: "2026-10-01", time: null, overwrite: {}, weight: "keep", acknowledged: true, basis: a1.basis }, NOW);

  // 2回目: 体脂肪量は別の値（conflict、上書きしない＝既存19.00を残す）。骨格筋量は新規追加 → mixedになる
  const text2 = "【Body Garden 体組成 v1】\n測定日: 2026-10-01\n体脂肪量: 20.50 kg\n骨格筋量: 25.40 kg\n【ここまで】";
  const p2 = B.parse(text2, NOW);
  const a2 = B.assess(s, p2, "2026-10-01", NOW);
  B.applyImport(s, p2, { date: "2026-10-01", time: null, overwrite: {}, weight: "keep", acknowledged: true, basis: a2.basis }, NOW);

  const rec1 = s.dailyRecords.find((r) => r.date === "2026-10-01");
  assert.equal(rec1.compositionMeta.mixed, true);
  assert.equal(rec1.bodyComposition.bodyFatMass, 19.0, "既存を残す（上書きしない）");
  assert.equal(rec1.bodyComposition.skeletalMuscleMass, 25.4);
  assert.deepEqual(clone(B.trendPoints(s, "bodyFatMass")), [{ date: "2026-10-01", value: 19.0 }]);
  assert.deepEqual(clone(B.trendPoints(s, "skeletalMuscleMass")), [{ date: "2026-10-01", value: 25.4 }]);
});

// ---------- trendSeries: 期間（7日/30日/全期間）・補間しない・0件/1件 ----------

test("trendSeries: データが0件なら points/days/data とも空", () => {
  const { B, s } = setup();
  s.dailyRecords = [];
  const series = B.trendSeries(s, "bodyFatMass", "30", NOW);
  assert.deepEqual(clone(series), { points: [], days: [], data: [] });
});

test("trendSeries: 記録が1件だけでも days/data が1件として成立する（今日までの日付列になる）", () => {
  const { B, s } = setup();
  s.dailyRecords = [rec("2026-10-10", { bodyFatMass: 20.0 })];
  const series = B.trendSeries(s, "bodyFatMass", "30", NOW);
  assert.equal(series.points.length, 1);
  assert.equal(series.days[series.days.length - 1], "2026-10-15", "今日（NOW）まで日付列が伸びる");
  assert.equal(series.data[series.days.indexOf("2026-10-10")], 20.0);
});

test("trendSeries: 7日間は今日を含む直近7日ぶんの日付列になる", () => {
  const { B, s } = setup();
  s.dailyRecords = [rec("2026-10-12", { bodyFatMass: 20.0 }), rec("2026-09-01", { bodyFatMass: 25.0 })];
  const series = B.trendSeries(s, "bodyFatMass", "7", NOW);
  assert.equal(series.days.length, 7);
  assert.deepEqual(clone(series.days), ["2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"]);
  assert.equal(series.points.length, 1, "範囲外（9/1）は points に含まれない");
});

test("trendSeries: 30日間は今日から30日ぶん", () => {
  const { B, s } = setup();
  s.dailyRecords = [rec("2026-10-12", { bodyFatMass: 20.0 })];
  const series = B.trendSeries(s, "bodyFatMass", "30", NOW);
  assert.equal(series.days.length, 30);
  assert.equal(series.days[0], "2026-09-16");
  assert.equal(series.days[29], "2026-10-15");
});

test("trendSeries: 全期間は最初の記録日から（今日または最後の記録日の遅い方）まで", () => {
  const { B, s } = setup();
  s.dailyRecords = [rec("2026-09-01", { bodyFatMass: 25.0 }), rec("2026-10-10", { bodyFatMass: 20.0 })];
  const series = B.trendSeries(s, "bodyFatMass", "all", NOW);
  assert.equal(series.days[0], "2026-09-01");
  assert.equal(series.days[series.days.length - 1], "2026-10-15");
  assert.equal(series.points.length, 2);
});

test("trendSeries: 記録のない日はnull（補間しない）。存在する点だけ日付昇順で並ぶ", () => {
  const { B, s } = setup();
  s.dailyRecords = [rec("2026-10-13", { bodyFatMass: 20.0 }), rec("2026-10-10", { bodyFatMass: 21.0 })];
  const series = B.trendSeries(s, "bodyFatMass", "7", NOW);
  const byDay = Object.fromEntries(series.days.map((d, i) => [d, series.data[i]]));
  assert.equal(byDay["2026-10-10"], 21.0);
  assert.equal(byDay["2026-10-11"], null);
  assert.equal(byDay["2026-10-12"], null);
  assert.equal(byDay["2026-10-13"], 20.0);
  assert.deepEqual(clone(series.points).map((p) => p.date), ["2026-10-10", "2026-10-13"], "日付昇順");
});

test("trendSeries: 指標ごとに独立（体脂肪量の記録しかない日は、骨格筋量のtrendには出てこない）", () => {
  const { B, s } = setup();
  s.dailyRecords = [rec("2026-10-10", { bodyFatMass: 20.0 }), rec("2026-10-11", { skeletalMuscleMass: 25.0 })];
  const fatSeries = B.trendSeries(s, "bodyFatMass", "7", NOW);
  const muscleSeries = B.trendSeries(s, "skeletalMuscleMass", "7", NOW);
  assert.deepEqual(clone(fatSeries.points).map((p) => p.date), ["2026-10-10"]);
  assert.deepEqual(clone(muscleSeries.points).map((p) => p.date), ["2026-10-11"]);
});
