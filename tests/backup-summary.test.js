// バックアップ確認画面の「体重の記録」は、体重が入っている日の数（体組成・メモだけの日を含めない）

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadEnv, sampleState, clone, exportText } = require("./helpers");

test("体組成だけの日・メモだけの日は、体重の記録の件数と期間に入らない。counts（書き出しの整合確認）は従来どおり", () => {
  const env = loadEnv();
  const s = sampleState(env);
  const weighted = s.dailyRecords.filter((r) => typeof r.weight === "number").length;
  const total = s.dailyRecords.length;
  s.dailyRecords.push(env.get("createEmptyDailyRecord")("2026-10-05")); // 体重なし（体組成を足す）
  s.dailyRecords[s.dailyRecords.length - 1].bodyComposition.bodyFatPct = 30;
  const memoOnly = env.get("createEmptyDailyRecord")("2026-10-06");
  memoOnly.comment = "メモだけ";
  s.dailyRecords.push(memoOnly);

  const r = env.Backup.parse(exportText(env, s), s);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.summary.weightDays.incoming, weighted);
  assert.equal(r.summary.weightDays.current, weighted + 0, "現在側も同じ数え方");
  assert.equal(r.summary.incoming.dailyRecords, total + 2, "counts は dailyRecords の全件（既存のバックアップとの整合確認）");
  assert.deepEqual(clone(r.summary.range), { from: "2026-09-29", to: "2026-10-01" }, "期間は体重のある日だけ");
  assert.equal(r.summary.compositionDays.incoming, s.dailyRecords.filter((x) => Object.values(x.bodyComposition || {}).some((v) => v !== null)).length);
});

test("体重の記録が1件も無いデータでも、件数 0・期間なしになる", () => {
  const env = loadEnv();
  const s = env.get("createDefaultState()");
  s.profile.startDate = "2026-10-01";
  const e = env.get("createEmptyDailyRecord")("2026-10-02");
  e.bodyComposition.bmi = 25;
  s.dailyRecords.push(e);
  const r = env.Backup.parse(exportText(env, s), null);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.summary.weightDays.incoming, 0);
  assert.equal(r.summary.range, null);
});
