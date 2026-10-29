// 週刊・月刊ハイライト: js/highlight-logic.js（純粋関数）
// すべて vm 上のメモリ内の状態だけで確かめる（本物の localStorage・実データには触れない）

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadEnv, clone } = require("./helpers");

const env = loadEnv();
const H = env.get("HighlightLogic");

// 2026-10-29 は木曜。この週は 10/26（月）〜 11/1（日）
const TODAY = "2026-10-29";

function baseState() {
  const s = env.get("createDefaultState()");
  s.profile.startDate = "2026-09-01";
  return s;
}
function rec(date, weight, bodyComposition) {
  const r = env.get("createEmptyDailyRecord")(date);
  r.weight = weight;
  if (bodyComposition) Object.assign(r.bodyComposition, bodyComposition);
  return r;
}
let nextId = 1;
function prot(date, total) {
  return { id: nextId++, date, time: null, sourceType: "meal", sourceId: null, sourceName: "テスト", quantity: null, unitProtein: null, servingScoops: null, proteinTotal: total, memo: null, createdAt: `${date}T00:00:00.000Z` };
}
function cond(date, level, symptoms) {
  return { id: nextId++, date, time: null, level, symptoms: symptoms || [], comment: "", createdAt: `${date}T00:00:00.000Z` };
}
function cycle(startDate, endDate) {
  return { id: nextId++, startDate, endDate: endDate === undefined ? null : endDate, comment: "", createdAt: null, updatedAt: null };
}
function inj(over) {
  return Object.assign(env.get("createEmptyInjection")(), { id: nextId++, ...over });
}
const week = (iso) => H.periodContaining("week", iso);
const month = (iso) => H.periodContaining("month", iso);
const sum = (state, period, today = TODAY) => H.summarize(state, period, today);
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≒ ${b}`);

// ---------- 期間 ----------

test("週は月曜〜日曜。日曜は、その日で終わる週に属する", () => {
  const p = clone(week("2026-10-29")); // 木曜
  assert.equal(p.from, "2026-10-26");
  assert.equal(p.to, "2026-11-01"); // 月をまたぐ
  assert.equal(clone(week("2026-11-01")).from, "2026-10-26"); // 日曜 → 前の月曜が始まりの週
  assert.equal(clone(week("2026-11-01")).to, "2026-11-01");
  assert.equal(clone(week("2026-11-02")).from, "2026-11-02"); // 月曜は新しい週の始まり
  assert.equal(clone(week("2026-10-26")).from, "2026-10-26");
});

test("週が年をまたぐ（2026-12-28 〜 2027-01-03）。前後の週へ移動できる", () => {
  const p = clone(week("2027-01-01"));
  assert.equal(p.from, "2026-12-28");
  assert.equal(p.to, "2027-01-03");
  assert.equal(clone(H.prevPeriod(week("2027-01-01"))).from, "2026-12-21");
  assert.equal(clone(H.nextPeriod(week("2026-12-28"))).from, "2027-01-04");
  assert.equal(H.enumerateDays(p.from, p.to).length, 7);
});

test("月は1日〜末日（うるう日 2028-02-29 を含む）", () => {
  assert.equal(clone(month("2028-02-10")).to, "2028-02-29");
  assert.equal(clone(month("2027-02-10")).to, "2027-02-28");
  assert.equal(clone(month("2026-10-29")).from, "2026-10-01");
  assert.equal(clone(month("2026-10-29")).to, "2026-10-31");
  assert.equal(H.enumerateDays("2028-02-01", "2028-02-29").length, 29);
  assert.equal(clone(H.prevPeriod(month("2028-03-05"))).to, "2028-02-29");
  assert.equal(clone(H.nextPeriod(month("2028-02-29"))).from, "2028-03-01");
  assert.equal(clone(H.prevPeriod(month("2027-01-15"))).from, "2026-12-01"); // 年をまたぐ
});

test("途中経過: 今日を含む週・月だけ立つ。過去の期間では立たない。見出しにも「途中経過」が付く", () => {
  const cur = sum(baseState(), week(TODAY));
  assert.equal(cur.inProgress, true);
  assert.ok(cur.label.endsWith("・途中経過"), cur.label);
  assert.equal(cur.label, "10/26（月）〜11/1（日）・途中経過");
  const past = sum(baseState(), week("2026-10-20"));
  assert.equal(past.inProgress, false);
  assert.ok(!past.label.includes("途中経過"));
  assert.equal(sum(baseState(), month(TODAY)).inProgress, true);
  assert.equal(sum(baseState(), month("2026-09-10")).inProgress, false);
  // 日曜が今日のとき（週の最終日）も、その週は途中経過
  assert.equal(sum(baseState(), week("2026-11-01"), "2026-11-01").inProgress, true);
  // 年をまたぐ期間・今年以外の期間は年も出す
  assert.equal(H.label(week("2027-01-01"), "2027-01-01"), "2026/12/28（月）〜2027/1/3（日）・途中経過");
});

test("前後の期間へ移動: 未来には進めない。最も古い記録（どの種類でも）・開始日より前には戻れない", () => {
  const s = baseState();
  s.profile.startDate = null;
  s.dailyRecords = [rec("2026-10-14", 66)]; // 水曜
  assert.equal(H.canGoNext(week(TODAY), TODAY), false);
  assert.equal(H.canGoNext(week("2026-10-20"), TODAY), true);
  assert.equal(H.canGoNext(month(TODAY), TODAY), false);
  // 10/14 の記録がある週（10/12〜10/18）より前には戻れない
  assert.equal(H.canGoPrev(s, week("2026-10-14"), TODAY), false);
  assert.equal(H.canGoPrev(s, week("2026-10-20"), TODAY), true);
  // 体重以外の記録（体調・月経・注射・たんぱく質）も「最も古い記録」に数える
  s.conditionEntries = [cond("2026-10-05", "none")];
  assert.equal(H.earliestDate(s, TODAY), "2026-10-05");
  s.cycleEntries = [cycle("2026-09-20", "2026-09-24")];
  assert.equal(H.earliestDate(s, TODAY), "2026-09-20");
  s.proteinEntries = [prot("2026-09-15", 20)];
  assert.equal(H.earliestDate(s, TODAY), "2026-09-15");
  s.injections = [inj({ status: "administered", administeredAt: "2026-09-10", dose: 2.5 })];
  assert.equal(H.earliestDate(s, TODAY), "2026-09-10");
  s.profile.startDate = "2026-09-01";
  assert.equal(H.earliestDate(s, TODAY), "2026-09-01");
  // 未来の期間が指定されたら今日を含む期間に戻す
  assert.equal(clone(H.normalizePeriod(week("2026-11-10"), "week", TODAY)).from, "2026-10-26");
  assert.equal(clone(H.normalizePeriod(null, "month", TODAY)).from, "2026-10-01");
});

// ---------- 体重 ----------

test("記録の無い日は平均に入れず、0としても扱わない。無効な値（null・文字列・NaN）は数えない", () => {
  const s = baseState();
  s.dailyRecords = [rec("2026-10-26", 66.0), rec("2026-10-28", 65.0), rec("2026-10-30", 67.0), rec("2026-10-27", null), rec("2026-10-29", "66"), rec("2026-10-31", NaN)];
  const r = sum(s, week(TODAY));
  assert.equal(r.weight.n, 3);
  near(r.weight.avg, 66.0);
  assert.equal(r.weight.min.value, 65.0);
  assert.equal(r.weight.min.date, "2026-10-28");
  assert.equal(r.weight.max.value, 67.0);
  assert.equal(r.weight.max.date, "2026-10-30");
  assert.ok(r.weight.points.every((p) => p.value > 0));
  // 1件も無い週: 平均・最小・最大は null（0ではない）
  const e = sum(s, week("2026-09-07"));
  assert.equal(e.weight.n, 0);
  assert.equal(e.weight.avg, null);
  assert.equal(e.weight.min, null);
  assert.equal(e.weight.max, null);
});

test("前の期間との差: 両方に平均があれば、記録が少なくても数字は出す（参考のみの印が付く）", () => {
  const s = baseState();
  // 前の週(10/19〜25): 3日 平均 67 ／ 今週: 2日 平均 66
  s.dailyRecords = [rec("2026-10-19", 67), rec("2026-10-21", 66.5), rec("2026-10-23", 67.5), rec("2026-10-27", 65.5), rec("2026-10-28", 66.5)];
  const r = sum(s, week(TODAY), "2026-11-10"); // 今週を過ぎてから見たとき（途中経過の文が入らない）
  assert.equal(r.weight.n, 2);
  near(r.weight.avg, 66);
  near(r.weight.diff, -1); // 数字は隠さない
  assert.equal(r.weight.lowCount, true);
  assert.equal(r.weight.diffReferenceOnly, true);
  assert.equal(r.weight.lowCountNote, "記録が少ないため傾向判断は参考程度です");
  // 評価の文は書かない（比べる文・傾向の文を出さない）
  assert.ok(r.discoveries.every((t) => !t.includes("より") && !t.includes("低め") && !t.includes("高め")));
  assert.ok(r.discoveries.some((t) => t.includes("傾向はまだ読み取らず")));
  assert.ok(r.discoveries.some((t) => t.includes("65.50〜66.50kg")), "範囲の数値は書く");
  // 前の週に記録が無ければ、差そのものを出さない
  const s2 = baseState();
  s2.dailyRecords = [rec("2026-10-27", 65.5)];
  assert.equal(sum(s2, week(TODAY)).weight.diff, null);
});

test("週: 3日から比べる文を書く（2日では書かない）", () => {
  const mk = (days) => {
    const s = baseState();
    s.dailyRecords = [rec("2026-10-19", 67), rec("2026-10-20", 67), rec("2026-10-21", 67)];
    for (let i = 0; i < days; i++) s.dailyRecords.push(rec(`2026-10-${26 + i}`, 66));
    return s;
  };
  const r2 = sum(mk(2), week(TODAY));
  assert.equal(r2.weight.lowCount, true);
  assert.ok(r2.discoveries.every((t) => !t.includes("前の週")));
  const r3 = sum(mk(3), week(TODAY));
  assert.equal(r3.weight.lowCount, false);
  assert.equal(r3.weight.lowCountNote, null);
  assert.equal(r3.weight.diffReferenceOnly, false);
  assert.ok(r3.discoveries.some((t) => t.includes("前の週より1.00kg低めでした")), r3.discoveries.join("|"));
  assert.ok(r3.discoveries.every((t) => !t.includes("読み取らず")));
});

test("月: 8日から比べる文を書く（7日では書かない）。数字は7日でも出る", () => {
  const mk = (days) => {
    const s = baseState();
    for (let i = 1; i <= 8; i++) s.dailyRecords.push(rec(`2026-09-${String(i).padStart(2, "0")}`, 68));
    for (let i = 1; i <= days; i++) s.dailyRecords.push(rec(`2026-10-${String(i).padStart(2, "0")}`, 67));
    return s;
  };
  const r7 = sum(mk(7), month(TODAY));
  assert.equal(r7.weight.n, 7);
  assert.equal(r7.weight.lowCount, true);
  near(r7.weight.diff, -1);
  assert.equal(r7.weight.diffReferenceOnly, true);
  assert.ok(r7.discoveries.every((t) => !t.includes("前の月")));
  const r8 = sum(mk(8), month(TODAY));
  assert.equal(r8.weight.lowCount, false);
  assert.equal(r8.weight.diffReferenceOnly, false);
  assert.ok(r8.discoveries.some((t) => t.includes("前の月より1.00kg低めでした")), r8.discoveries.join("|"));
});

test("平均がほぼ同じ（0.1kg未満の差）のときは「ほぼ同じくらい」と書く", () => {
  const s = baseState();
  s.dailyRecords = [66, 66, 66].map((w, i) => rec(`2026-10-${19 + i}`, w)).concat([66.05, 66.05, 66.05].map((w, i) => rec(`2026-10-${26 + i}`, w)));
  const r = sum(s, week(TODAY));
  assert.ok(r.discoveries.some((t) => t.includes("ほぼ同じくらい")));
});

test("最初と最後の差は、体重を記録した日が2日以上のときだけ（1日なら差を出さない）", () => {
  const s = baseState();
  s.dailyRecords = [rec("2026-10-03", 67)];
  const one = sum(s, month(TODAY));
  assert.equal(one.firstLast.available, false);
  assert.equal(one.firstLast.diff, null);
  s.dailyRecords.push(rec("2026-10-20", 66.2), rec("2026-10-10", 66.8));
  const three = sum(s, month(TODAY));
  assert.equal(three.firstLast.available, true);
  near(three.firstLast.diff, 66.2 - 67); // 最後(10/20) − 最初(10/3)
  assert.equal(three.firstLast.from.date, "2026-10-03");
  assert.equal(three.firstLast.to.date, "2026-10-20");
});

// ---------- 月刊：開始からの累計・Goal ----------

test("開始からの累計 = その月で最後に測った体重 − 開始体重（Calc と同じ式）。startWeight は書き換えない", () => {
  const s = baseState();
  s.profile.startWeight = 70;
  s.dailyRecords = [rec("2026-10-02", 68), rec("2026-10-20", 66)]; // 月末の記録ではない
  const before = JSON.stringify(s);
  const r = sum(s, month(TODAY));
  assert.equal(r.sinceStart.available, true);
  assert.equal(r.sinceStart.lastDate, "2026-10-20");
  near(r.sinceStart.changeKg, -4);
  near(r.sinceStart.changePct, (-4 / 70) * 100);
  assert.equal(r.sinceStart.startWeight, 70);
  assert.equal(JSON.stringify(s), before, "state を書き換えない");
  assert.equal(s.profile.startWeight, 70);
  // 週刊には出さない
  assert.equal(sum(s, week(TODAY)).sinceStart, null);
});

test("開始体重が未設定なら値を出さない（「開始体重が未設定です」）。最初の体重記録で代用しない", () => {
  const s = baseState();
  s.profile.startWeight = null;
  s.dailyRecords = [rec("2026-10-02", 68), rec("2026-10-20", 66)];
  const before = JSON.stringify(s);
  const r = sum(s, month(TODAY));
  assert.equal(r.sinceStart.available, false);
  assert.equal(r.sinceStart.reason, "startWeightUnset");
  assert.equal(r.sinceStart.changeKg === undefined || r.sinceStart.changeKg === null, true);
  assert.equal(H.START_WEIGHT_UNSET, "開始体重が未設定です");
  assert.equal(JSON.stringify(s), before);
  assert.equal(s.profile.startWeight, null);
});

test("Goal進捗: その月で最後に測った体重で、HOMEと同じ式（0〜100に丸める）。主な文は「あとx.xkg」", () => {
  const s = baseState();
  s.profile.startWeight = 70;
  s.goals.goal1 = { type: "weight", value: 60 };
  s.goals.goal2 = { type: "weight", value: 56 };
  s.dailyRecords = [rec("2026-10-03", 68), rec("2026-10-17", 65)]; // 月末ではない
  const g = sum(s, month(TODAY)).goals;
  assert.equal(g.lastWeight.date, "2026-10-17");
  const [g1, g2] = g.rows;
  assert.equal(g1.label, "Goal1");
  near(g1.remainingKg, 5);
  near(g1.progressPct, ((70 - 65) / (70 - 60)) * 100);
  assert.equal(g2.label, "Goal2");
  near(g2.remainingKg, 9);
  near(g2.progressPct, ((70 - 65) / (70 - 56)) * 100);
  assert.equal(g.note, "Goal・身長は現在の設定で計算しています");
  // 範囲外は 0〜100 に丸める
  s.dailyRecords = [rec("2026-10-03", 72)];
  assert.equal(sum(s, month(TODAY)).goals.rows[0].progressPct, 0);
  s.dailyRecords = [rec("2026-10-03", 58)];
  assert.equal(sum(s, month(TODAY)).goals.rows[0].progressPct, 100);
});

test("Goal進捗: BMI目標は現在の身長で体重に換算する／Goal2が無ければ行を出さない／体重の無い月は「データなし」", () => {
  const s = baseState();
  s.profile.heightCm = 160;
  s.profile.startWeight = 70;
  s.goals.goal1 = { type: "bmi", value: 23 };
  s.goals.goal2 = null;
  s.dailyRecords = [rec("2026-10-03", 66)];
  const g = sum(s, month(TODAY)).goals;
  assert.equal(g.rows.length, 1, "Goal2 の行は無い");
  near(g.rows[0].targetKg, 23 * 1.6 * 1.6);
  s.profile.heightCm = 170; // 身長を変えると、いまの身長で計算し直す
  near(sum(s, month(TODAY)).goals.rows[0].targetKg, 23 * 1.7 * 1.7);
  // 体重の記録が無い月
  const none = sum(s, month("2026-09-10")).goals;
  assert.equal(none.lastWeight, null);
  assert.equal(none.rows[0].status, "noData");
  assert.equal(none.rows[0].remainingKg, null);
  assert.equal(none.rows[0].progressPct, null);
  assert.equal(H.NO_DATA, "データなし");
  assert.equal(sum(s, month("2026-09-10")).sinceStart.available, false);
});

// ---------- 体組成 ----------

test("体組成: 記録された値だけを使う。体脂肪量が無い日を 体重×体脂肪率 で推定しない（データなし）", () => {
  const s = baseState();
  s.dailyRecords = [
    rec("2026-10-26", 66, { bodyFatPct: 30, measuredWeight: 66 }), // 体脂肪量は未記録
    rec("2026-10-28", 65, { bodyFatMass: 19.5, bodyFatPct: 30, skeletalMuscleMass: 24.1 }),
  ];
  const r = sum(s, week(TODAY));
  const f = Object.fromEntries(r.composition.fields.map((x) => [x.key, x]));
  assert.equal(f.bodyFatMass.count, 1);
  assert.equal(f.bodyFatMass.points[0].value, 19.5);
  assert.equal(f.bodyFatMass.points[0].date, "2026-10-28");
  assert.ok(f.bodyFatMass.points.every((p) => p.value !== 66 * 0.3), "推定値(19.8)は入らない");
  assert.equal(f.bodyFatPct.count, 2);
  assert.equal(f.skeletalMuscleMass.count, 1);
  assert.equal(r.composition.recordedDays, 2);
  // 体脂肪量がどの日にも無い週: 点を作らない
  const s2 = baseState();
  s2.dailyRecords = [rec("2026-10-26", 66, { bodyFatPct: 30, measuredWeight: 66 })];
  const f2 = sum(s2, week(TODAY)).composition.fields.find((x) => x.key === "bodyFatMass");
  assert.equal(f2.count, 0);
  assert.equal(f2.first, null);
  assert.equal(f2.min, null);
  // 期間内の記録が無い月は、すべて count 0
  assert.ok(sum(s2, month("2026-09-10")).composition.fields.every((x) => x.count === 0));
});

// ---------- たんぱく質 ----------

test("たんぱく質: 記録日のうち、現在の目標に届いた日。記録の無い日は母数に入れない。文言は現在の目標を明記", () => {
  const s = baseState();
  s.profile.proteinTarget = 75;
  s.proteinEntries = [
    prot("2026-10-26", 40), prot("2026-10-26", 40), // 80g 到達
    prot("2026-10-27", 60), // 未達
    prot("2026-10-28", 75), // ちょうど到達
    prot("2026-10-30", 90), // 到達
    prot("2026-10-20", 99), // 期間外
  ];
  const p = sum(s, week(TODAY)).protein;
  assert.equal(p.recordedDays, 4, "7日中ではなく、記録のある4日");
  assert.equal(p.achievedDays, 3);
  assert.equal(p.target, 75);
  const d = sum(s, week(TODAY)).discoveries.join("");
  assert.ok(d.includes("記録日4日のうち、現在の目標75gに3日届きました"), d);
  assert.ok(!d.includes("全7日"));
  // 過去の期間も現在の目標で判定する（目標を変えると判定も変わる）
  s.profile.proteinTarget = 50;
  assert.equal(sum(s, week(TODAY)).protein.achievedDays, 4);
  // 記録が1日も無い期間
  const none = sum(s, week("2026-09-07")).protein;
  assert.equal(none.recordedDays, 0);
  assert.equal(none.achievedDays, 0);
  assert.ok(sum(s, week("2026-09-07")).discoveries.every((t) => !t.includes("たんぱく質")));
  // 目標が未設定なら到達日数は出さない
  s.profile.proteinTarget = null;
  assert.equal(sum(s, week(TODAY)).protein.achievedDays, null);
});

// ---------- 注射・体調・月経 ----------

test("注射: 期間の境目（月曜・日曜）を含めて抽出し、予定は出さない。見送りは定例日で数える。部位は扱わない", () => {
  const s = baseState();
  s.injections = [
    inj({ status: "administered", administeredAt: "2026-10-25", administeredTime: "08:00", dose: 2.5 }), // 前の週の日曜
    inj({ status: "administered", administeredAt: "2026-10-26", administeredTime: "08:30", dose: 5, site: "rightThigh", comment: "メモ" }), // 月曜
    inj({ status: "administered", administeredAt: "2026-11-01", administeredTime: null, dose: 5 }), // 日曜
    inj({ status: "administered", administeredAt: "2026-11-02", dose: 5 }), // 次の週
    inj({ status: "scheduled", scheduledAt: "2026-10-29" }), // 予定
    inj({ status: "skipped", regularDate: "2026-10-27", skipReason: "userChoice" }),
  ];
  const r = sum(s, week(TODAY)).injections;
  assert.deepEqual(clone(r.administered.map((x) => x.date)), ["2026-10-26", "2026-11-01"]);
  assert.equal(r.administered[0].time, "08:30");
  assert.equal(r.administered[0].dose, 5);
  assert.equal(r.administered[1].time, null);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].date, "2026-10-27");
  assert.equal(r.skipped[0].reason, "本人の確認で見送り");
  const json = JSON.stringify(clone(sum(s, week(TODAY)).injections));
  assert.ok(!json.includes("rightThigh") && !json.includes("メモ"), "部位・メモは出力に含めない");
  // 月の集計
  assert.equal(sum(s, month(TODAY)).injections.administered.length, 2); // 10/25・10/26（11/1 以降は11月）
  assert.equal(sum(s, month("2026-11-05"), "2026-11-05").injections.administered.length, 2); // 11/1・11/2
});

test("体調: 期間内の日数・件数・段階（severe は「あり」）・症状を数える。期間外は入れない", () => {
  const s = baseState();
  s.conditionEntries = [
    cond("2026-10-25", "mild", ["nausea"]), // 期間外
    cond("2026-10-26", "mild", ["nausea", "constipation"]),
    cond("2026-10-26", "severe", ["nausea"]),
    cond("2026-11-01", "none", []),
    cond("2026-11-02", "moderate", ["diarrhea"]), // 期間外
  ];
  const c = sum(s, week(TODAY)).condition;
  assert.equal(c.days, 2);
  assert.equal(c.entries, 3);
  assert.equal(c.levels.mild, 1);
  assert.equal(c.levels.moderate, 1);
  assert.equal(c.levels.none, 1);
  const sym = Object.fromEntries(c.symptoms.map((x) => [x.id, x.count]));
  assert.equal(sym.nausea, 2);
  assert.equal(sym.constipation, 1);
  assert.equal(sym.diarrhea, undefined);
  assert.equal(c.symptoms.find((x) => x.id === "nausea").label, "悪心");
});

test("月経: 期間と重なる記録（前から続く・後へ続く・終了日なし＝月経中）を並べるだけ", () => {
  const s = baseState();
  s.cycleEntries = [
    cycle("2026-09-20", "2026-09-24"), // 重ならない
    cycle("2026-10-22", "2026-10-26"), // 週の前から始まり、月曜に終わる
    cycle("2026-10-30", null), // 月経中（今週の途中から）
    cycle("2026-11-03", "2026-11-07"), // 次の週
  ];
  const w = sum(s, week(TODAY)).cycle;
  assert.deepEqual(clone(w.map((x) => x.startDate)), ["2026-10-22", "2026-10-30"]);
  assert.equal(w[0].isOpen, false);
  assert.equal(w[1].isOpen, true);
  assert.equal(w[1].endDate, null);
  // 終了日なしの記録は、それより後の期間にも「月経中」として重なる
  assert.equal(sum(s, week("2026-11-03"), "2026-11-03").cycle.some((x) => x.isOpen), true);
  // 終わった記録が、後の期間に出ない／前の期間境目の1日前に終わったものは重ならない
  const s2 = baseState();
  s2.cycleEntries = [cycle("2026-10-20", "2026-10-25")];
  assert.equal(sum(s2, week(TODAY)).cycle.length, 0);
  assert.equal(sum(s2, week("2026-10-20")).cycle.length, 1);
  assert.equal(sum(s2, month(TODAY)).cycle.length, 1);
});

// ---------- 修正の反映・不変 ----------

test("過去の記録を直すと、次の集計に反映される（キャッシュしない）", () => {
  const s = baseState();
  s.dailyRecords = [rec("2026-10-20", 67), rec("2026-10-21", 67), rec("2026-10-22", 67)];
  const before = sum(s, week("2026-10-20"));
  near(before.weight.avg, 67);
  s.dailyRecords.find((r) => r.date === "2026-10-21").weight = 64;
  const after = sum(s, week("2026-10-20"));
  near(after.weight.avg, (67 + 64 + 67) / 3);
  assert.equal(after.weight.min.value, 64);
  s.proteinEntries.push(prot("2026-10-20", 80));
  assert.equal(sum(s, week("2026-10-20")).protein.recordedDays, 1);
  s.dailyRecords = s.dailyRecords.filter((r) => r.date !== "2026-10-22"); // 削除も反映
  assert.equal(sum(s, week("2026-10-20")).weight.n, 2);
});

test("state を書き換えない（ディープフリーズしても、前後で完全に同じ）", () => {
  const s = baseState();
  s.dailyRecords = [rec("2026-10-20", 67, { bodyFatMass: 20 }), rec("2026-10-27", 66)];
  s.proteinEntries = [prot("2026-10-27", 80)];
  s.conditionEntries = [cond("2026-10-27", "mild", ["nausea"])];
  s.cycleEntries = [cycle("2026-10-25", null)];
  s.injections = [inj({ status: "administered", administeredAt: "2026-10-27", dose: 2.5 })];
  const snap = JSON.stringify(s);
  const deepFreeze = (o) => {
    if (o && typeof o === "object" && !Object.isFrozen(o)) {
      Object.freeze(o);
      Object.values(o).forEach(deepFreeze);
    }
    return o;
  };
  deepFreeze(s);
  for (const p of [week(TODAY), month(TODAY), week("2026-10-20"), month("2026-09-01")]) {
    assert.doesNotThrow(() => sum(s, p));
  }
  H.canGoPrev(s, week(TODAY), TODAY);
  H.earliestDate(s, TODAY);
  assert.equal(JSON.stringify(s), snap);
  // 保存先にも触れない
  assert.equal(env.ls.setCalls.length, 0);
});

// ---------- 発見の文：禁止語・形・ガードレール ----------

function pseudoRandom(seed) {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

test("発見の文: どの入力の組み合わせでも禁止語が入らず、最大3文。月経・体調・注射と体重を同じ文に結ばない", () => {
  const rnd = pseudoRandom(20261029);
  const FORBIDDEN = clone(H.FORBIDDEN_WORDS);
  assert.ok(FORBIDDEN.length > 20);
  for (const must of ["ため", "ので", "原因", "影響", "効果", "速い", "遅い", "順調", "ペース", "停滞", "失敗", "伸び悩み", "によって", "せいで", "おかげ"]) {
    assert.ok(FORBIDDEN.includes(must), `${must} が禁止語に入っている`);
  }
  let combos = 0;
  for (let i = 0; i < 400; i++) {
    const s = baseState();
    const isMonth = rnd() < 0.5;
    const today = ["2026-10-29", "2026-11-01", "2026-12-31", "2028-02-29"][Math.floor(rnd() * 4)];
    const period = isMonth ? month(rnd() < 0.5 ? today : H.addDays(today, -40)) : week(rnd() < 0.5 ? today : H.addDays(today, -20));
    const prev = H.prevPeriod(period);
    const fill = (p, count, base) => {
      const days = H.enumerateDays(p.from, p.to);
      for (let k = 0; k < count && k < days.length; k++) {
        const day = days[Math.floor(rnd() * days.length)];
        if (s.dailyRecords.some((r) => r.date === day)) continue;
        const bc = rnd() < 0.5 ? { bodyFatMass: 15 + rnd() * 10, skeletalMuscleMass: 22 + rnd() * 3, bodyFatPct: 25 + rnd() * 5 } : null;
        s.dailyRecords.push(rec(day, Math.round((base + (rnd() - 0.5) * 3) * 100) / 100, bc));
      }
    };
    const n = Math.floor(rnd() * 12);
    fill(period, n, 50 + rnd() * 25);
    fill(prev, Math.floor(rnd() * 12), 50 + rnd() * 25);
    if (rnd() < 0.5) {
      const days = H.enumerateDays(period.from, period.to);
      s.proteinEntries.push(prot(days[Math.floor(rnd() * days.length)], Math.round(rnd() * 120)));
    }
    s.profile.proteinTarget = rnd() < 0.2 ? null : 75;
    if (rnd() < 0.5) s.cycleEntries.push(cycle(period.from, rnd() < 0.5 ? null : period.to));
    if (rnd() < 0.5) s.conditionEntries.push(cond(period.from, "mild", ["constipation", "diarrhea"]));
    if (rnd() < 0.5) s.injections.push(inj({ status: "administered", administeredAt: period.to, dose: 5 }));
    const mode = rnd();
    if (mode < 0.2) s.goals.mode = "maintenance";
    else if (mode < 0.3) s.goals.mode = "maintenancePrep";
    if (rnd() < 0.2) s.profile.heightCm = 130; // BMI を高く／低く振る
    const out = sum(s, period, today);
    combos++;
    assert.ok(out.discoveries.length >= 1 && out.discoveries.length <= 3, `文の数: ${out.discoveries.length}`);
    // 画面に出す固定文を含めて確認する。ただし LOW_COUNT_NOTE は指定どおりの固定文言（「…少ないため…」）で、
    // 体重の変化の理由を言い切る文ではないので、禁止語の対象から外す
    for (const t of [...H.discoveryCandidates(out), out.closing, out.softNote, out.proteinNote, out.compositionNote, out.goals && out.goals.note].filter(Boolean)) {
      for (const word of FORBIDDEN) assert.ok(!t.includes(word), `禁止語「${word}」が入っている: ${t}`);
      assert.ok(t.length > 0);
    }
    for (const t of H.discoveryCandidates(out)) {
      assert.equal(t.split("。").length - 1, 1, `1文ずつ: ${t}`);
      if (/月経|便秘|下痢|注射|体調/.test(t)) assert.ok(!/体重|kg|平均/.test(t), `体重と結んでいる: ${t}`);
    }
  }
  assert.equal(combos, 400);
  // 具体的な禁止例が、定数に含まれる語として検出できる
  for (const bad of ["月経前だから体重が増えました", "便秘が原因です", "筋肉を維持できています", "脂肪だけが減りました"]) {
    assert.ok(FORBIDDEN.some((w) => bad.includes(w)), bad);
  }
});

test("発見の文: 体重の文に原因を書かない／固定の型だけ（週の例）", () => {
  const s = baseState();
  s.dailyRecords = [rec("2026-10-26", 66), rec("2026-10-27", 65.5), rec("2026-10-28", 66.5)];
  s.cycleEntries = [cycle("2026-10-27", null)];
  s.conditionEntries = [cond("2026-10-27", "mild", ["constipation"])];
  s.injections = [inj({ status: "administered", administeredAt: "2026-10-27", dose: 5 })];
  const r = sum(s, week(TODAY));
  assert.deepEqual(clone(r.discoveries).slice(0, 2), ["今週は3日、体重を記録できました。", "今週はまだ途中です。"]);
  assert.equal(r.discoveries[2], "今週の体重は65.50〜66.50kgの範囲で推移しました。");
  // 過去の週では「今週」「途中」と書かない
  const past = sum(s, week("2026-10-20"));
  assert.ok(past.discoveries.every((t) => !t.includes("今週") && !t.includes("途中")));
  // 並べて書く文は体重と混ぜない
  const s3 = baseState();
  s3.cycleEntries = [cycle("2026-10-27", null)];
  s3.conditionEntries = [cond("2026-10-27", "mild", ["constipation"])];
  s3.injections = [inj({ status: "administered", administeredAt: "2026-10-27", dose: 5 })];
  const all = sum(s3, week("2026-10-26"), "2026-11-10").discoveries.join("");
  assert.ok(all.includes("この期間には月経の記録があります。"));
  assert.ok(all.includes("体調の記録は1日ありました。") || all.includes("注射は1回記録されています。"));
});

test("骨格筋量の文: 別々の日に2つ以上あるときだけ。差が小さければ「大きな差はありませんでした」、そうでなければ数値のみ", () => {
  const mk = (a, b) => {
    const s = baseState();
    s.dailyRecords = [rec("2026-10-19", 66, { skeletalMuscleMass: a })];
    if (b != null) s.dailyRecords.push(rec("2026-10-25", 66, { skeletalMuscleMass: b }));
    return s;
  };
  // 3文に切る前の全候補で確かめる（記録が少ない週は、ほかの文が先に3文を埋めるため）
  const skel = (s) => clone(H.discoveryCandidates(sum(s, week("2026-10-19"))).filter((t) => t.includes("骨格筋量")));
  assert.deepEqual(skel(mk(24.1, null)), []); // 1つだけ
  assert.deepEqual(skel(mk(24.1, 24.2)), ["骨格筋量は期間の最初と最後で大きな差はありませんでした。"]);
  assert.deepEqual(skel(mk(24.1, 23.0)), ["骨格筋量は期間の最初が24.10kg、最後が23.00kgでした。"]);
  // 同じ日に複数の値があっても、1日1件なので「別々の日」にならない
  const s = baseState();
  s.dailyRecords = [rec("2026-10-19", 66, { skeletalMuscleMass: 24.1 })];
  assert.deepEqual(skel(s), []);
  assert.ok(!skel(mk(24.1, 24.2)).join("").includes("維持"));
});

test("ガードレール（BMI21／20以下）・維持準備・維持モードでは、減ったことを前向きな進みとして書かない（比べる文を出さない）", () => {
  const build = (weightPrev, weightNow, mut) => {
    const s = baseState();
    s.profile.heightCm = 162; // BMI21 ≒ 55.1kg
    s.dailyRecords = [];
    for (let i = 0; i < 3; i++) s.dailyRecords.push(rec(`2026-10-${19 + i}`, weightPrev), rec(`2026-10-${26 + i}`, weightNow));
    if (mut) mut(s);
    return s;
  };
  // 通常（BMI > 21）: 比べる文を書く
  const normal = sum(build(66, 65), week(TODAY));
  assert.equal(normal.softMode, false);
  assert.ok(normal.discoveries.some((t) => t.includes("前の週より")));
  assert.equal(normal.softNote, null);
  // BMI21以下
  const low21 = sum(build(56, 54), week(TODAY));
  assert.equal(low21.softMode, true);
  // BMI20以下
  const low20 = sum(build(54, 52), week(TODAY));
  assert.equal(low20.softMode, true);
  for (const r of [low21, low20, sum(build(66, 65, (s) => (s.goals.mode = "maintenance")), week(TODAY)), sum(build(66, 65, (s) => (s.goals.mode = "maintenancePrep")), week(TODAY))]) {
    assert.equal(r.softMode, true);
    const text = r.discoveries.join("");
    assert.ok(!text.includes("前の週より") && !text.includes("低め") && !text.includes("高め") && !text.includes("ほぼ同じ"), text);
    assert.ok(r.softNote && r.softNote.length > 0);
    // 数値そのものは隠さない
    assert.equal(typeof r.weight.diff, "number");
    assert.equal(typeof r.weight.avg, "number");
    assert.ok(text.includes("の平均は"), text);
  }
  // 過去の週を見ていても、いまの状態（直近の体重・モード）で判断する
  assert.equal(sum(build(66, 65, (s) => (s.goals.mode = "maintenance")), week("2026-10-19")).softMode, true);
});

test("記録の無い期間: 0扱いにせず、「データなし」相当（null）。文は破綻しない", () => {
  const r = sum(baseState(), month("2026-09-10"));
  assert.equal(r.weight.n, 0);
  assert.equal(r.weight.avg, null);
  assert.equal(r.weight.diff, null);
  assert.equal(r.weight.lowCountNote, "記録が少ないため傾向判断は参考程度です");
  assert.equal(r.discoveries[0], "この月は体重の記録がありませんでした。");
  assert.equal(r.firstLast.available, false);
});

// ---------- 肯定メッセージ（週・月に1文。ルールで選ぶ。AIなし） ----------

const AFFIRM_BANNED = ["成功", "優秀", "頑張", "がんばり", "失敗", "停滞", "もっと", "のおかげ", "のせい"];

function affirmState(weightsOct, opts) {
  const s = baseState();
  s.dailyRecords = weightsOct.map(([d, w]) => rec(d, w));
  if (opts && opts.maintenance) s.goals.mode = "maintenance";
  return s;
}
const OCT_DAYS_10 = ["02", "05", "08", "10", "12", "15", "18", "20", "25", "29"].map((d) => `2026-10-${d}`);

test("肯定メッセージ: 月・記録が十分で体重が減っている → 積み重ねを肯定する文（努力と結び付けない）", () => {
  const s = affirmState(OCT_DAYS_10.map((d, i) => [d, 67.8 - i * 0.26]));
  const r = sum(s, month(TODAY));
  assert.equal(r.firstLast.diff < 0, true);
  assert.ok(["少しずつ積み重ねた変化が、数字にも表れています。", "今月の記録には、ここまで続けてきた変化が見えています。"].includes(r.affirmation), r.affirmation);
});

test("肯定メッセージ: 月・記録が十分で体重が増えている → 減ったことに触れない、記録の積み重ねの文", () => {
  const s = affirmState(OCT_DAYS_10.map((d, i) => [d, 65 + i * 0.2]));
  const r = sum(s, month(TODAY));
  assert.equal(r.firstLast.diff > 0, true);
  assert.ok(["今月も丁寧に記録を重ねられています。", "変化が見えるくらい、記録が積み上がりました。"].includes(r.affirmation), r.affirmation);
});

test("肯定メッセージ: 記録が少ない（月8日未満・週3日未満）／ない → 少なさを責めない固定の文", () => {
  const few = affirmState([["2026-10-02", 67.8], ["2026-10-20", 66.5], ["2026-10-29", 65.4]]);
  assert.equal(sum(few, month(TODAY)).affirmation, H.AFFIRM_FEW);
  assert.equal(sum(few, week(TODAY)).affirmation, H.AFFIRM_FEW); // 10/26〜11/1 は1日だけ（10/29）
  assert.equal(sum(affirmState([]), month(TODAY)).affirmation, H.AFFIRM_NONE);
  assert.equal(sum(affirmState([]), week(TODAY)).affirmation, H.AFFIRM_NONE);
});

test("肯定メッセージ: 週・前の週より平均が下がっていて記録が十分なときだけ「減った」系。参考程度（記録が少ない週が相手）は出さない", () => {
  const dec = affirmState([["2026-10-19", 66.5], ["2026-10-20", 66.4], ["2026-10-21", 66.5], ["2026-10-26", 65.6], ["2026-10-27", 65.5], ["2026-10-28", 65.4]]);
  const rd = sum(dec, week(TODAY));
  assert.ok(rd.weight.diff < 0 && rd.weight.diffReferenceOnly === false);
  assert.ok(["少しずつ積み重ねた変化が、数字にも表れています。", "今週の記録には、ここまで続けてきた変化が見えています。"].includes(rd.affirmation), rd.affirmation);
  const refOnly = affirmState([["2026-10-19", 66.5], ["2026-10-26", 65.6], ["2026-10-27", 65.5], ["2026-10-28", 65.4]]); // 前の週は1日だけ
  const rr = sum(refOnly, week(TODAY));
  assert.equal(rr.weight.diffReferenceOnly, true);
  assert.ok(["今週もからだの変化をしっかり残せています。", "変化が見えるくらい、記録が積み上がりました。"].includes(rr.affirmation), rr.affirmation);
});

test("肯定メッセージ: 維持モード・ガードレール中（softMode）は、体重が減っていても「減った」系を出さない", () => {
  const s = affirmState(OCT_DAYS_10.map((d, i) => [d, 67.8 - i * 0.26]), { maintenance: true });
  const r = sum(s, month(TODAY));
  assert.equal(r.softMode, true);
  assert.equal(r.firstLast.diff < 0, true);
  assert.ok(["今月も丁寧に記録を重ねられています。", "変化が見えるくらい、記録が積み上がりました。"].includes(r.affirmation), r.affirmation);
});

test("肯定メッセージ: 過去の期間は「この月／この週」。同じ期間・同じ記録なら必ず同じ文（乱数なし）", () => {
  const s = affirmState([["2026-09-02", 67], ["2026-09-04", 67], ["2026-09-08", 67], ["2026-09-10", 67], ["2026-09-12", 67], ["2026-09-15", 67], ["2026-09-20", 67], ["2026-09-28", 67]]);
  const a = sum(s, month("2026-09-15")).affirmation;
  assert.equal(sum(s, month("2026-09-15")).affirmation, a);
  assert.ok(!a.includes("今月") && !a.includes("今週"), a);
});

test("肯定メッセージ: 全パターンで禁止語・評価語・「もっと」「頑張」を含まない。1文で、state を書き換えない", () => {
  const forb = clone(H.FORBIDDEN_WORDS);
  const states = [
    affirmState([]),
    affirmState([["2026-10-29", 65.4]]),
    affirmState(OCT_DAYS_10.map((d, i) => [d, 67.8 - i * 0.26])),
    affirmState(OCT_DAYS_10.map((d, i) => [d, 65 + i * 0.2])),
    affirmState(OCT_DAYS_10.map((d, i) => [d, 67.8 - i * 0.26]), { maintenance: true }),
  ];
  const periods = [month(TODAY), week(TODAY), month("2026-09-15"), week("2026-10-19"), month("2026-08-10")];
  const seen = new Set();
  for (const st of states) {
    for (const p of periods) {
      const before = JSON.stringify(st);
      const a = sum(st, p).affirmation;
      assert.equal(JSON.stringify(st), before);
      assert.equal(typeof a, "string");
      assert.ok(a.length > 0 && a.endsWith("。") && a.split("。").length === 2, a);
      for (const w of [...forb, ...AFFIRM_BANNED]) assert.ok(!a.includes(w), `${a} に ${w}`);
      seen.add(a);
    }
  }
  for (const t of [H.AFFIRM_FEW, H.AFFIRM_NONE]) for (const w of [...forb, ...AFFIRM_BANNED]) assert.ok(!t.includes(w), `${t} に ${w}`);
  assert.ok(seen.size >= 4);
});

test("肯定メッセージ: 平均がほぼ同じ（0.1kg未満の差・浮動小数の誤差を含む）なら「減った」系を出さない（からだの発見の「ほぼ同じ」と食い違わない）", () => {
  const DEC = ["少しずつ積み重ねた変化が、数字にも表れています。", "今週の記録には、ここまで続けてきた変化が見えています。", "今月の記録には、ここまで続けてきた変化が見えています。"];
  // 前の週・今週とも平均66.2（3日ずつ）。0.1+0.2 のような浮動小数の誤差が差に出る組み合わせ
  const same = affirmState([["2026-10-19", 66.1], ["2026-10-20", 66.2], ["2026-10-21", 66.3], ["2026-10-26", 66.3], ["2026-10-27", 66.2], ["2026-10-28", 66.1]]);
  const w = sum(same, week(TODAY));
  assert.ok(Math.abs(w.weight.diff) < H.SAME_DIFF_KG);
  assert.ok(w.discoveries.some((t) => t.includes("ほぼ同じくらい")));
  assert.ok(!DEC.includes(w.affirmation), w.affirmation);
  // 月：最初→最新が -0.03kg
  const tiny = affirmState(OCT_DAYS_10.map((d, i) => [d, i === 9 ? 67.77 : 67.8]));
  const m = sum(tiny, month(TODAY));
  assert.ok(m.firstLast.diff < 0 && m.firstLast.diff > -H.SAME_DIFF_KG);
  assert.ok(!DEC.includes(m.affirmation), m.affirmation);
  // ちょうど0.1kg以上減っていれば「減った」系になる（境界）
  const edge = affirmState(OCT_DAYS_10.map((d, i) => [d, i === 9 ? 67.5 : 67.8]));
  assert.ok(DEC.includes(sum(edge, month(TODAY)).affirmation));
});
