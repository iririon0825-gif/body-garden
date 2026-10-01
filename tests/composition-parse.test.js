// 体組成: 登録用テキストの解析。推測・補完・四捨五入をしない。単位の不一致・数値でない値・あり得ない値は保存しない。
// 機種差・丸め方の差で判断できない値は、警告（suspect）として本人確認つきで保存できる。

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadEnv, clone } = require("./helpers");

const NOW = new Date(2026, 9, 15, 12, 0);
const setup = () => {
  const env = loadEnv();
  return { env, B: env.get("BodyCompositionLogic") };
};
const KEYS = ["measuredWeight", "bmi", "bodyFatPct", "heartRate", "muscleMass", "bmr", "waterPct", "bodyFatMass", "leanMass", "boneMass", "visceralFat", "proteinPct", "skeletalMuscleMass", "subcutaneousFat", "bodyAge", "bodyType"];
const item = (r, k) => r.items.find((i) => i.key === k);
// サンプルの1行だけを差し替えた登録用テキスト
const withLine = (B, label, newLine) =>
  B.sampleText()
    .split("\n")
    .map((l) => (l.startsWith(label + ":") ? newLine : l))
    .join("\n");

test("サンプルの16項目が、すべて ok で読み取れる（日付・時刻・警告なし）", () => {
  const { B } = setup();
  const r = B.parse(B.sampleText(), NOW);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.date, "2026-10-01");
  assert.equal(r.dateStatus, "ok");
  assert.equal(r.time, "07:12");
  assert.deepEqual(clone(r.items.map((i) => i.key)), KEYS);
  assert.equal(r.items.length, 16);
  assert.ok(r.items.every((i) => i.status === "ok"), JSON.stringify(r.items.filter((i) => i.status !== "ok")));
  assert.equal(item(r, "measuredWeight").value, 66.8);
  assert.equal(item(r, "bmr").value, 1312);
  assert.equal(item(r, "bodyType").value, "標準型");
  assert.deepEqual(clone(r.counts), { ok: 16, suspect: 0, missing: 0, absent: 0, problem: 0 });
  assert.equal(r.warnings.length, 0);
  assert.equal(r.unrecognizedLines.length, 0);
});

test("アプリ内に表示する仕様文の例を、そのまま貼っても16項目すべて ok になる（仕様と解析が食い違わない）", () => {
  const { B } = setup();
  const spec = B.specText();
  const sample = spec.slice(spec.lastIndexOf("【Body Garden 体組成 v1】")); // 仕様文の最後にある「例」
  const r = B.parse(sample, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.counts.ok, 16);
  assert.match(spec, /未読取/);
  for (const f of ["体重", "BMI", "体脂肪率", "心拍数", "筋肉量", "基礎代謝量", "水分量", "体脂肪量", "除脂肪体重", "骨量", "内臓脂肪", "タンパク質率", "骨格筋量", "皮下脂肪", "体内年齢", "ボディタイプ"]) {
    assert.ok(spec.includes(f), `仕様文に ${f} がある`);
  }
});

test("表記ゆれ: 全角数字・全角コロン・％・㎏・Kcal・㎉・行頭の記号・コードブロック・別名", () => {
  const { B } = setup();
  const text = [
    "```",
    "【Body Garden 体組成 v1】",
    "測定日：2026年10月1日",
    "測定時刻：7:05",
    "- 体重：６６．８０　ｋｇ",
    "・BMI：２５．５",
    "体脂肪率: 31.2 ％",
    "脈拍: 68 回/分",
    "筋肉量: 43.70 ㎏",
    "基礎代謝: 1312 Kcal",
    "水分率: 49.8 %",
    "体脂肪量: 20.84 kg",
    "除脂肪量: 45.96 kg",
    "推定骨量: 2.30 kg",
    "内臓脂肪レベル: 9",
    "たんぱく質率: 16.1 %",
    "骨格筋量: 25.40 kg",
    "皮下脂肪率: 27.8 %",
    "体年齢: 44 歳",
    "体型: 標準型",
    "【ここまで】",
    "```",
  ].join("\n");
  const r = B.parse(text, NOW);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.date, "2026-10-01");
  assert.equal(r.time, "07:05");
  assert.equal(item(r, "measuredWeight").value, 66.8);
  assert.equal(item(r, "heartRate").value, 68);
  assert.equal(item(r, "bmr").value, 1312);
  assert.equal(item(r, "bodyAge").value, 44);
  assert.ok(r.items.every((i) => i.status === "ok"), JSON.stringify(r.items.filter((i) => i.status !== "ok")));
  const d2 = B.parse(text.replace("2026年10月1日", "2026/10/1"), NOW);
  assert.equal(d2.date, "2026-10-01");
});

test("単位の不一致・欠落は保存しない（換算も補完もしない）", () => {
  const { B } = setup();
  const t = (line, key) => B.parse(withLine(B, line.split(":")[0], line), NOW).items.find((i) => i.key === key);
  assert.equal(t("体重: 147.3 lb", "measuredWeight").status, "unitMismatch");
  assert.equal(t("体重: 66.8", "measuredWeight").status, "unitMissing", "単位のない体重は lb かもしれないので保存しない");
  assert.equal(t("体重: 10.5 st", "measuredWeight").status, "unitMismatch");
  assert.equal(t("体重: 66.8 kg(推定)", "measuredWeight").status, "unitMismatch");
  assert.equal(t("体脂肪率: 31.2", "bodyFatPct").status, "unitMissing");
  assert.equal(t("水分量: 32.1 kg", "waterPct").status, "unitMismatch", "% の項目に kg は使えない（推測で換算しない）");
  assert.equal(t("心拍数: 68", "heartRate").status, "unitMissing");
  assert.equal(t("基礎代謝量: 1312", "bmr").status, "unitMissing");
  assert.equal(t("内臓脂肪: 9 kg", "visceralFat").status, "unitMismatch");
  assert.equal(t("BMI: 25.5 %", "bmi").status, "unitMismatch");
  assert.equal(t("体内年齢: 44", "bodyAge").status, "ok", "単位が任意の項目は、単位なしでよい");
  assert.equal(t("内臓脂肪: 9 レベル", "visceralFat").status, "ok");
  assert.equal(t("体重: 66.8 kg", "measuredWeight").value, 66.8, "正しい単位は通る");
  const lb = t("体重: 147.3 lb", "measuredWeight");
  assert.equal(lb.value, null, "値は保存対象にならない");
});

test("数値として読めない値は保存しない: カンマ・約・符号・指数・桁数・文字", () => {
  const { B } = setup();
  const st = (line, label, key) => B.parse(withLine(B, label, line), NOW).items.find((i) => i.key === key).status;
  assert.equal(st("基礎代謝量: 1,312 kcal", "基礎代謝量", "bmr"), "invalidValue");
  assert.equal(st("体重: 約66.8 kg", "体重", "measuredWeight"), "invalidValue");
  assert.equal(st("体重: ≒66.8 kg", "体重", "measuredWeight"), "invalidValue");
  assert.equal(st("体重: -66.8 kg", "体重", "measuredWeight"), "invalidValue", "符号付き");
  assert.equal(st("体重: +66.8 kg", "体重", "measuredWeight"), "invalidValue");
  assert.equal(st("体重: abc kg", "体重", "measuredWeight"), "invalidValue");
  assert.equal(st("体重: 66.8.1 kg", "体重", "measuredWeight"), "invalidValue", "小数点が2つ");
  assert.equal(st("体重: 66.12345 kg", "体重", "measuredWeight"), "invalidValue", "小数5桁は桁数が多すぎる");
  assert.equal(st("体重: 123456 kg", "体重", "measuredWeight"), "invalidValue", "整数部6桁");
  assert.equal(st("体重: 66,8 kg", "体重", "measuredWeight"), "invalidValue");
});

test("未読取の書き方: 未読取・空欄・ダッシュ・不明は missing。値は null のまま（推測しない）", () => {
  const { B } = setup();
  for (const v of ["未読取", "", "-", "—", "―", "–", "不明", "読み取れず", "未読取 kg"]) {
    const r = B.parse(withLine(B, "体脂肪率", `体脂肪率: ${v}`), NOW);
    const i = item(r, "bodyFatPct");
    assert.equal(i.status, "missing", `「${v}」`);
    assert.equal(i.value, null);
  }
  const r = B.parse(withLine(B, "ボディタイプ", "ボディタイプ: 未読取"), NOW);
  assert.equal(item(r, "bodyType").status, "missing");
  assert.equal(r.counts.missing, 1);
  assert.equal(r.counts.ok, 15);
});

test("行そのものが無い項目は absent（「記載なし」）。未読取(missing)と区別する", () => {
  const { B } = setup();
  const text = B.sampleText().split("\n").filter((l) => !l.startsWith("骨量:")).join("\n");
  const r = B.parse(text, NOW);
  assert.equal(item(r, "boneMass").status, "absent");
  assert.equal(item(r, "boneMass").message, "記載なし");
  assert.equal(r.counts.absent, 1);
});

test("あり得ない値(hard)は保存しない: 体脂肪率0・120、体重19・251、BMI9、心拍数0", () => {
  const { B } = setup();
  const st = (line, label, key) => B.parse(withLine(B, label, line), NOW).items.find((i) => i.key === key);
  assert.equal(st("体脂肪率: 0 %", "体脂肪率", "bodyFatPct").status, "outOfRange");
  assert.equal(st("体脂肪率: 120 %", "体脂肪率", "bodyFatPct").status, "outOfRange");
  assert.equal(st("体重: 19.9 kg", "体重", "measuredWeight").status, "outOfRange", "既存の体重の範囲（20〜250）と同じ");
  assert.equal(st("体重: 251 kg", "体重", "measuredWeight").status, "outOfRange");
  assert.equal(st("体重: 20 kg", "体重", "measuredWeight").status, "ok", "境界は通る");
  assert.equal(st("体重: 250 kg", "体重", "measuredWeight").status, "ok");
  assert.equal(st("BMI: 9.9", "BMI", "bmi").status, "outOfRange");
  assert.equal(st("心拍数: 0 bpm", "心拍数", "heartRate").status, "outOfRange");
  assert.equal(st("体内年齢: 4", "体内年齢", "bodyAge").status, "outOfRange");
});

test("通常の範囲外(soft)・桁数の違いは suspect（警告つきで保存できる）。機種差や丸め方を考慮する", () => {
  const { B } = setup();
  const st = (line, label, key) => B.parse(withLine(B, label, line), NOW).items.find((i) => i.key === key);
  const a = st("内臓脂肪: 45", "内臓脂肪", "visceralFat");
  assert.equal(a.status, "suspect");
  assert.equal(a.value, 45, "値は保持される（本人が確認すれば保存できる）");
  assert.match(a.message, /機種/);
  assert.equal(st("体脂肪率: 62 %", "体脂肪率", "bodyFatPct").status, "suspect");
  assert.equal(st("体脂肪率: 2.5 %", "体脂肪率", "bodyFatPct").status, "suspect");
  const dec = st("体脂肪率: 31.25 %", "体脂肪率", "bodyFatPct");
  assert.equal(dec.status, "suspect", "小数2桁（通常は1桁）");
  assert.equal(dec.value, 31.25, "丸めない");
  assert.equal(st("心拍数: 68.0 bpm", "心拍数", "heartRate").status, "ok", "末尾が0の小数は問題にしない");
  assert.equal(st("心拍数: 68.5 bpm", "心拍数", "heartRate").status, "suspect");
  assert.equal(st("内臓脂肪: 30", "内臓脂肪", "visceralFat").status, "ok");
});

test("未認識の行は明示する（推測で項目に割り当てない）。あいまいな名前は直し方を示す", () => {
  const { B } = setup();
  const text = ["雑談です", ...B.sampleText().split("\n").slice(0, 4), "体脂肪: 31.2 %", "筋肉: 43.7 kg", "代謝年齢: 44", "骨格筋: 25.4 kg", "なぞの項目: 5", "コロンのない行", ...B.sampleText().split("\n").slice(4)].join("\n");
  const r = B.parse(text, NOW);
  assert.equal(r.ok, false, "1行目がヘッダーでないので致命的エラー");
  assert.equal(r.errors[0].code, "NO_HEADER");
  const ok = B.parse(
    ["【Body Garden 体組成 v1】", "測定日: 2026-10-01", "体重: 66.8 kg", "体脂肪: 31.2 %", "筋肉: 43.7 kg", "代謝年齢: 44", "骨格筋: 25.4 kg", "なぞの項目: 5", "コロンのない行", "【ここまで】", "後ろの行: 1"].join("\n"),
    NOW
  );
  assert.equal(ok.ok, true);
  assert.equal(item(ok, "bodyFatPct").status, "absent", "「体脂肪」は体脂肪率に割り当てない");
  assert.equal(item(ok, "muscleMass").status, "absent");
  assert.equal(item(ok, "bodyAge").status, "absent");
  assert.equal(item(ok, "skeletalMuscleMass").status, "absent");
  assert.equal(ok.unrecognizedLines.length, 7, "体脂肪・筋肉・代謝年齢・骨格筋・なぞの項目・コロンのない行・【ここまで】より後");
  assert.match(ok.unrecognizedLines.find((u) => u.text.startsWith("体脂肪")).hint, /体脂肪率.*体脂肪量/);
  assert.match(ok.unrecognizedLines.find((u) => u.text.startsWith("後ろの行")).hint, /ここまで/);
});

test("重複した項目: 同じ値ならそのまま、違う値ならどちらも使わない（duplicate）", () => {
  const { B } = setup();
  const lines = B.sampleText().split("\n");
  const same = B.parse([...lines.slice(0, -1), "体重: 66.8 kg", "【ここまで】"].join("\n"), NOW);
  assert.equal(item(same, "measuredWeight").status, "ok", "66.80 と 66.8 は同じ値");
  const diff = B.parse([...lines.slice(0, -1), "体重: 67.0 kg", "【ここまで】"].join("\n"), NOW);
  assert.equal(item(diff, "measuredWeight").status, "duplicate");
  assert.equal(item(diff, "measuredWeight").value, null);
  assert.equal(diff.counts.problem, 1);
});

test("致命的エラー: 空・ヘッダーなし・版違い・ヘッダー2つ・測定日が複数・巨大入力", () => {
  const { B } = setup();
  assert.equal(B.parse("", NOW).errors[0].code, "EMPTY");
  assert.equal(B.parse("   \n  ", NOW).errors[0].code, "EMPTY");
  assert.equal(B.parse("体重: 66.8 kg", NOW).errors[0].code, "NO_HEADER");
  assert.equal(B.parse("【Body Garden 体組成 v2】\n体重: 66.8 kg", NOW).errors[0].code, "UNSUPPORTED_VERSION");
  assert.equal(B.parse("【Body Garden 体組成 v1】\n【Body Garden 体組成 v1】", NOW).errors[0].code, "DUPLICATE_HEADER");
  assert.equal(B.parse("【Body Garden 体組成 v1】\n測定日: 2026-10-01\n測定日: 2026-10-02", NOW).errors[0].code, "MULTIPLE_DATES");
  assert.equal(B.parse("x".repeat(5001), NOW).errors[0].code, "TOO_LARGE");
  assert.equal(B.parse(Array(81).fill("a: 1").join("\n"), NOW).errors[0].code, "TOO_MANY_LINES");
  assert.equal(B.parse("【Body Garden 体組成 v1】\n" + "あ".repeat(201), NOW).errors[0].code, "LINE_TOO_LONG");
  assert.equal(B.parse("【Body Garden 体組成 v1】\n測定日: 2026-10-01\n測定日: 2026-10-01\n体重: 66.8 kg", NOW).ok, true, "同じ測定日の繰り返しは問題ない");
  assert.equal(B.parse(B.sampleText(), NOW).items.length, 16, "致命的でないとき items は常に16件");
  const fatal = B.parse("", NOW);
  assert.equal(fatal.ok, false);
  assert.equal(fatal.items.length, 16, "致命的エラーでも items は16件（すべて absent）");
});

test("測定日: 未読取・年なし・存在しない日付は、日付を勝手に補わない（date は null）", () => {
  const { B } = setup();
  const t = (d) => B.parse(`【Body Garden 体組成 v1】\n測定日: ${d}\n体重: 66.8 kg\n【ここまで】`, NOW);
  assert.deepEqual([t("未読取").date, t("未読取").dateStatus], [null, "missing"]);
  assert.deepEqual([t("10/1").date, t("10/1").dateStatus], [null, "invalid"], "年を推測しない");
  assert.deepEqual([t("2026-02-30").date, t("2026-02-30").dateStatus], [null, "invalid"]);
  assert.deepEqual([t("2026-10-1").date, t("2026-10-1").dateStatus], ["2026-10-01", "ok"]);
  const none = B.parse("【Body Garden 体組成 v1】\n体重: 66.8 kg\n【ここまで】", NOW);
  assert.deepEqual([none.date, none.dateStatus], [null, "absent"]);
  assert.equal(B.parse("【Body Garden 体組成 v1】\n測定時刻: 25:00\n体重: 66.8 kg", NOW).timeStatus, "invalid");
});

test("ボディタイプ: 20字以内の文字列。HTML・制御文字・数式の先頭文字・21字は拒否", () => {
  const { B } = setup();
  const st = (v) => item(B.parse(withLine(B, "ボディタイプ", `ボディタイプ: ${v}`), NOW), "bodyType");
  assert.equal(st("標準型").status, "ok");
  assert.equal(st("あ".repeat(20)).status, "ok", "20字は通る");
  assert.equal(st("あ".repeat(21)).status, "invalidValue");
  assert.equal(st("<img src=x onerror=alert(1)>").status, "invalidValue");
  assert.equal(st("a&b").status, "invalidValue");
  assert.equal(st('a"b').status, "invalidValue");
  assert.equal(st("=1+1").status, "invalidValue", "表計算で数式として実行される先頭文字");
  assert.equal(st("+cmd").status, "invalidValue");
  assert.equal(st("@x").status, "invalidValue");
  assert.equal(st("-1").status, "invalidValue");
  assert.equal(st("標準​型").value, "標準型", "ゼロ幅文字は除去される");
});

test("XSS: 項目名・値にHTMLがあっても、未認識の行として扱われ、保存対象にならない", () => {
  const { B } = setup();
  const r = B.parse(["【Body Garden 体組成 v1】", "<img src=x onerror=alert(1)>: 5", "体重: <script>alert(1)</script> kg", "【ここまで】"].join("\n"), NOW);
  assert.equal(r.ok, true);
  assert.equal(item(r, "measuredWeight").status, "invalidValue");
  assert.equal(r.unrecognizedLines.length, 1);
  assert.ok(r.unrecognizedLines[0].text.length <= 80);
  assert.ok(r.items.every((i) => !["ok", "suspect"].includes(i.status)), "保存対象になる項目がない");
});

test("項目どうしの確認（警告のみ）: 体脂肪量・除脂肪体重の取り違え、骨格筋量≧筋肉量、体重以上", () => {
  const { B } = setup();
  const swapped = B.parse(withLine(B, "体脂肪量", "体脂肪量: 45.96 kg").replace("除脂肪体重: 45.96 kg", "除脂肪体重: 20.84 kg"), NOW);
  assert.ok(swapped.warnings.some((w) => w.code === "FAT_MASS_MISMATCH"));
  assert.equal(item(swapped, "bodyFatMass").status, "ok", "警告でも値は保存できる");
  const lean = B.parse(withLine(B, "除脂肪体重", "除脂肪体重: 30.00 kg"), NOW);
  assert.ok(lean.warnings.some((w) => w.code === "LEAN_MASS_MISMATCH"));
  const sk = B.parse(withLine(B, "骨格筋量", "骨格筋量: 44.00 kg"), NOW);
  assert.ok(sk.warnings.some((w) => w.code === "SKELETAL_GE_MUSCLE"));
  const noEnd = B.parse(B.sampleText().replace("【ここまで】", ""), NOW);
  assert.ok(noEnd.warnings.some((w) => w.code === "NO_END"));
  const big = B.parse(withLine(B, "筋肉量", "筋肉量: 70.00 kg"), NOW);
  assert.ok(big.warnings.some((w) => w.code === "PART_GE_WEIGHT"));
});

test("備考は表示用に最大5行（保存しない）", () => {
  const { B } = setup();
  const r = B.parse(B.sampleText().replace("【ここまで】", "備考: 1\n備考: 2\n備考: 3\n備考: 4\n備考: 5\n備考: 6\n【ここまで】"), NOW);
  assert.equal(r.notes.length, 5);
});
