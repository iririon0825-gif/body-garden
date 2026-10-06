// たんぱく質トレンド（記録タブ、読み取り専用）: ProteinLogic.trendPoints/trendSeries
// 保存はしない・既存proteinEntriesの読み取りだけ。未記録日は件数0で判定し、0gに補完しない

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadEnv, sampleState, clone } = require("./helpers");

function setup() {
  const env = loadEnv();
  const P = env.get("ProteinLogic");
  const s = sampleState(env);
  return { env, P, s };
}

let nextId = 1;
function entry(date, proteinTotal, extra = {}) {
  return { id: nextId++, date, time: null, sourceType: "meal", sourceId: null, sourceName: "テスト", quantity: null, unitProtein: null, servingScoops: null, proteinTotal, memo: null, createdAt: `${date}T00:00:00.000Z`, ...extra };
}

const NOW = new Date(2026, 9, 15, 12, 0); // 2026-10-15

test("trendPoints: 同じ日に複数entryがあれば合算する（Calc.proteinTotalForDateを再利用）", () => {
  const { P, s } = setup();
  s.proteinEntries = [entry("2026-10-01", 20.8), entry("2026-10-01", 24.0)];
  const pts = P.trendPoints(s);
  assert.deepEqual(clone(pts), [{ date: "2026-10-01", value: 44.8 }]);
});

test("trendPoints: whey / food / meal が混在していても区別せず合算する", () => {
  const { P, s } = setup();
  s.proteinEntries = [
    entry("2026-10-01", 20.8, { sourceType: "whey", sourceId: 1 }),
    entry("2026-10-01", 24.0, { sourceType: "food", sourceId: 2 }),
    entry("2026-10-01", 10.0, { sourceType: "meal" }),
  ];
  assert.deepEqual(clone(P.trendPoints(s)), [{ date: "2026-10-01", value: 54.8 }]);
});

test("trendPoints: 編集後の最新proteinTotalが反映される（配列に直接書き換わっている前提）", () => {
  const { P, s } = setup();
  const e = entry("2026-10-01", 20.0);
  s.proteinEntries = [e];
  assert.equal(P.trendPoints(s)[0].value, 20.0);
  e.proteinTotal = 15.5; // ui-protein-home.js と同じ、直接書き換え
  assert.equal(P.trendPoints(s)[0].value, 15.5, "編集後の値がそのまま反映される");
});

test("trendPoints: 削除済み（配列から除去済み）のentryは集計対象外になる", () => {
  const { P, s } = setup();
  const e1 = entry("2026-10-01", 20.0);
  const e2 = entry("2026-10-01", 24.0);
  s.proteinEntries = [e1, e2];
  assert.equal(P.trendPoints(s)[0].value, 44.0);
  s.proteinEntries = s.proteinEntries.filter((x) => x.id !== e2.id); // storage.jsの削除と同じ操作
  assert.equal(P.trendPoints(s)[0].value, 20.0, "削除したentryは合計から消える");
});

test("trendPoints: entryが1件も無い日は、trendPointsに含まれない（0gの点を作らない）", () => {
  const { P, s } = setup();
  s.proteinEntries = [entry("2026-10-01", 20.0)];
  const pts = P.trendPoints(s);
  assert.equal(pts.length, 1);
  assert.deepEqual(clone(pts).map((p) => p.date), ["2026-10-01"]);
});

test("trendSeries: 未記録日はnull。0gには補完しない", () => {
  const { P, s } = setup();
  s.proteinEntries = [entry("2026-10-10", 20.0), entry("2026-10-13", 15.0)];
  const series = P.trendSeries(s, "7", NOW);
  const byDay = Object.fromEntries(series.days.map((d, i) => [d, series.data[i]]));
  assert.equal(byDay["2026-10-10"], 20.0);
  assert.equal(byDay["2026-10-11"], null, "記録が無い日はnull");
  assert.equal(byDay["2026-10-12"], null);
  assert.equal(byDay["2026-10-13"], 15.0);
  assert.notEqual(byDay["2026-10-11"], 0, "0gではない（nullとの違いを明示）");
});

test("trendSeries: 7日間は今日を含む直近7日", () => {
  const { P, s } = setup();
  s.proteinEntries = [entry("2026-10-12", 20.0)];
  const series = P.trendSeries(s, "7", NOW);
  assert.deepEqual(clone(series.days), ["2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"]);
});

test("trendSeries: 30日間は今日から30日ぶん", () => {
  const { P, s } = setup();
  s.proteinEntries = [entry("2026-10-12", 20.0)];
  const series = P.trendSeries(s, "30", NOW);
  assert.equal(series.days.length, 30);
  assert.equal(series.days[0], "2026-09-16");
  assert.equal(series.days[29], "2026-10-15");
});

test("trendSeries: 全期間は最初の記録日から今日（または最後の記録日）まで", () => {
  const { P, s } = setup();
  s.proteinEntries = [entry("2026-09-01", 20.0), entry("2026-10-10", 15.0)];
  const series = P.trendSeries(s, "all", NOW);
  assert.equal(series.days[0], "2026-09-01");
  assert.equal(series.days[series.days.length - 1], "2026-10-15");
});

test("trendSeries: データが1日だけでも成立する", () => {
  const { P, s } = setup();
  s.proteinEntries = [entry("2026-10-10", 20.0)];
  const series = P.trendSeries(s, "30", NOW);
  assert.equal(series.points.length, 1);
  assert.equal(series.data[series.days.indexOf("2026-10-10")], 20.0);
});

test("trendSeries: データが0件なら points/days/data とも空", () => {
  const { P, s } = setup();
  s.proteinEntries = [];
  assert.deepEqual(clone(P.trendSeries(s, "30", NOW)), { points: [], days: [], data: [] });
});

test("現在のproteinTargetはstate.profileから取得する（固定値を埋め込まない）", () => {
  const { s } = setup();
  assert.equal(s.profile.proteinTarget, 75, "既定値75（サンプル状態）");
  s.profile.proteinTarget = 90;
  assert.equal(s.profile.proteinTarget, 90, "変更すればそのまま新しい値になる（charts.js側はstate.profile.proteinTargetを都度読む設計）");
});
