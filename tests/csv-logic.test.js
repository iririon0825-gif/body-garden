// CSV書き出し（分析用）: 文字コード・改行・エスケープ・インジェクション対策・各シートの内容・非干渉

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadEnv, sampleState, clone } = require("./helpers");

function parseCsv(text) {
  // BOMを確認してから外す。テスト用の簡易パーサ（RFC4180のクォート規則だけ扱えればよい）
  assert.equal(text.charCodeAt(0), 0xfeff, "先頭にBOMが無い");
  const body = text.slice(1);
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inQuotes) {
      if (c === '"') {
        if (body[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\r" && body[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function setup() {
  const env = loadEnv();
  const C = env.get("CsvLogic");
  const s = sampleState(env);
  return { env, C, s };
}

// ---------- 文字コード・改行・RFC4180 ----------

test("BOM付きUTF-8、改行はCRLF、ヘッダーとデータ行が1行ずつ並ぶ", () => {
  const { C, s } = setup();
  const text = C.build(["a", "b"], [[1, 2], [3, 4]]);
  assert.equal(text.charCodeAt(0), 0xfeff);
  assert.ok(!/[^\r]\n/.test(text.slice(1)), "裸のLFが無い（必ずCRLF）");
  const rows = parseCsv(text);
  assert.deepEqual(rows, [["a", "b"], ["1", "2"], ["3", "4"]]);
});

test("カンマ・引用符・改行を含む値は引用符で囲み、内部の引用符は二重化する（RFC4180）", () => {
  const { C } = setup();
  const text = C.build(["x"], [["a,b"], ['say "hi"'], ["line1\nline2"], ["line1\r\nline2"]]);
  const rows = parseCsv(text);
  assert.deepEqual(rows.slice(1).map((r) => r[0]), ["a,b", 'say "hi"', "line1\nline2", "line1\r\nline2"]);
});

test("日本語・絵文字はそのまま通る", () => {
  const { C } = setup();
  const text = C.build(["x"], [["サラダチキン 🍗 ホエイ"]]);
  assert.equal(parseCsv(text)[1][0], "サラダチキン 🍗 ホエイ");
});

// ---------- CSVインジェクション対策 ----------

test("先頭が = + - @ タブ 復帰(CR) の文字列セルには ' を1つ前置する。数値セルには適用しない", () => {
  const { C } = setup();
  for (const bad of ["=1+1", "+1", "-1", "@SUM(A1)"]) {
    assert.equal(C.cell(bad), "'" + bad, bad);
  }
  // \t・\r で始まる値は、対策の前置のあと、RFC4180のクォート対象（制御文字を含む）にもなる。往復させて確認する
  for (const bad of ["\t=evil", "\revil"]) {
    const text = C.build(["x"], [[bad]]);
    assert.equal(parseCsv(text)[1][0], "'" + bad);
  }
  assert.equal(C.cell(-5), "-5", "数値の -5 はそのまま（文字列化で'-'始まりでも対策しない）");
  assert.equal(C.cell(0), "0");
  assert.equal(C.cell(null), "");
  assert.equal(C.cell(undefined), "");
  assert.equal(C.cell(NaN), "", "数値として不正なら空欄");
});

test("前置したあとでカンマ・引用符を含む値も、正しくエスケープされる（二重エスケープにならない）", () => {
  const { C } = setup();
  const text = C.build(["x"], [['=a,"b"'], ['"=evil']]);
  const rows = parseCsv(text);
  assert.equal(rows[1][0], "'=a,\"b\"");
  assert.equal(rows[2][0], '"=evil', "先頭が引用符は対策の対象外（CSVの引用符自体は実行されないため）そのまま通る");
});

// ---------- weight.csv ----------

test("weight: 体重のある日だけ、日付順。BMIはアプリ計算（小数1桁）、null安全", () => {
  const { C, s } = setup();
  const { headers, rows } = C.buildWeight(s);
  assert.deepEqual(clone(headers), ["日付", "体重_kg", "BMI_アプリ計算", "メモ"]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r[0]), ["2026-09-29", "2026-09-30", "2026-10-01"]);
  assert.equal(rows[2][1], 66.2);
  assert.ok(typeof rows[0][2] === "number");
  s.profile.heightCm = null;
  const r2 = C.buildWeight(s);
  assert.equal(r2.rows[0][2], null, "身長が無ければBMIは空欄（0にしない）");
});

// ---------- body_composition.csv ----------

test("body_composition: 列順はCOMPOSITION_FIELDS由来。測定体重は別名の列、メモは体重の無い日にも出る、2回分混在・取込/更新日時", () => {
  const { env, C, s } = setup();
  const F = env.get("COMPOSITION_FIELDS");
  s.dailyRecords.push({
    date: "2026-10-02",
    weight: null,
    comment: "体組成だけの日のメモ",
    bodyComposition: { ...Object.fromEntries(F.map((f) => [f.key, null])), measuredWeight: 65.9, bmi: 25.1 },
    compositionMeta: { measuredTime: "07:00", source: "paste", formatVersion: 1, importedAt: "2026-10-02T22:00:00.000Z", updatedAt: "2026-10-02T23:30:00.000Z", mixed: true },
  });
  const { headers, rows } = C.buildBodyComposition(s);
  assert.equal(headers[0], "日付");
  assert.equal(headers[1], "測定時刻");
  assert.equal(headers[2], "測定体重_kg", "dailyRecords.weightと混同しない列名");
  assert.ok(headers.includes("体内年齢_歳"));
  assert.ok(headers.includes("ボディタイプ"));
  assert.equal(headers[headers.length - 1], "更新日時");
  assert.equal(rows.length, 2, "サンプルの既存1件（2026-09-29）＋今回の1件");
  const r = rows.find((x) => x[0] === "2026-10-02");
  assert.equal(r[1], "07:00");
  assert.equal(r[2], 65.9);
  assert.equal(r[headers.indexOf("メモ")], "体組成だけの日のメモ");
  assert.equal(r[headers.indexOf("2回分混在")], "はい");
  const imp = new Date("2026-10-02T22:00:00.000Z");
  const p = (n) => String(n).padStart(2, "0");
  const expected = `${imp.getFullYear()}-${p(imp.getMonth() + 1)}-${p(imp.getDate())} ${p(imp.getHours())}:${p(imp.getMinutes())}:${p(imp.getSeconds())}`;
  assert.equal(r[headers.indexOf("取込日時")], expected);
});

test("body_composition: mixed=falseやmeta無しは空欄（0や文言「いいえ」にしない）", () => {
  const { env, C, s } = setup();
  const F = env.get("COMPOSITION_FIELDS");
  s.dailyRecords[0].bodyComposition = { ...Object.fromEntries(F.map((f) => [f.key, null])), bmi: 22 };
  s.dailyRecords[0].compositionMeta = { measuredTime: null, source: "paste", formatVersion: 1, importedAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", mixed: false };
  const { headers, rows } = C.buildBodyComposition(s);
  assert.equal(rows[0][headers.indexOf("2回分混在")], "");
});

// ---------- protein.csv ----------

test("protein: whey/food/meal の単位、同日複数件が欠落しない、記録日時の変換", () => {
  const { C, s } = setup();
  s.registeredFoods.push({ id: 99, name: "オイコス2", unit: "個", proteinPerUnit: 10, status: "active" });
  s.proteinEntries.push({ id: 3, date: "2026-10-01", time: "20:00", sourceType: "food", sourceId: 99, sourceName: "オイコス2", quantity: 2, unitProtein: 10, servingScoops: null, proteinTotal: 20, memo: null, createdAt: "2026-10-01T20:00:00.000Z" });
  const { headers, rows } = C.buildProtein(s);
  assert.equal(rows.length, 3, "同じ日の3件すべて行として出る");
  const whey = rows.find((r) => r[0] === 1);
  assert.equal(whey[headers.indexOf("種別")], "ホエイ");
  assert.equal(whey[headers.indexOf("数量単位（現在の登録）")], "スプーン");
  assert.equal(whey[headers.indexOf("基準量あたりg")], 20.8);
  assert.equal(whey[headers.indexOf("標準スプーン数")], 3);
  const meal = rows.find((r) => r[0] === 2);
  assert.equal(meal[headers.indexOf("種別")], "食事");
  assert.equal(meal[headers.indexOf("数量単位（現在の登録）")], "");
  assert.equal(meal[headers.indexOf("数量")], null);
  const food = rows.find((r) => r[0] === 3);
  assert.equal(food[headers.indexOf("数量単位（現在の登録）")], "個");
});

test("protein: 削除済み食品など、商品マスターから引けない食品は単位が空欄になる（0や仮の文字列にしない）", () => {
  const { C, s } = setup();
  s.proteinEntries.push({ id: 4, date: "2026-10-01", time: "09:00", sourceType: "food", sourceId: "removed-food", sourceName: "(削除済み)", quantity: 1, unitProtein: 5, servingScoops: null, proteinTotal: 5, memo: null, createdAt: "2026-10-01T09:00:00.000Z" });
  const { headers, rows } = C.buildProtein(s);
  const row = rows.find((r) => r[0] === 4);
  assert.equal(row[headers.indexOf("数量単位（現在の登録）")], "");
});

// ---------- injections.csv ----------

test("injections: 予定・見送りは集計対象・在庫の扱い・在庫算入が空欄。投与済みはstockCountの4値に対応する", () => {
  const { env, C, s } = setup();
  const mk = (over) => Object.assign(env.get("createEmptyInjection()"), { id: Math.floor(Math.random() * 100000) }, over);
  s.injections = [
    mk({ id: 10, status: "scheduled", kind: "regular", scheduledAt: "2026-10-08", scheduledTime: "09:00", regularDate: "2026-10-08" }),
    mk({ id: 11, status: "skipped", kind: "regular", regularDate: "2026-10-01", skipReason: "missedUnder72h", missedCheck: { result: "lt72" } }),
    mk({ id: 12, status: "administered", kind: "regular", administeredAt: "2026-09-24", administeredTime: "09:00", dose: 2.5, stockCount: null }),
    mk({ id: 13, status: "administered", kind: "regular", administeredAt: "2026-10-01", administeredTime: "09:05", dose: 5, stockCount: "counts" }),
    mk({ id: 14, status: "administered", kind: "makeup", administeredAt: "2026-10-02", administeredTime: "10:00", dose: 5, stockCount: "excluded" }),
    mk({ id: 15, status: "administered", kind: "oneOffChange", administeredAt: "2026-10-03", administeredTime: "09:00", dose: 5, stockCount: "review" }),
  ];
  const { headers, rows } = C.buildInjections(s);
  const byId = Object.fromEntries(rows.map((r) => [r[0], r]));
  const col = (name) => headers.indexOf(name);

  assert.equal(byId[10][col("状態")], "予定");
  assert.equal(byId[10][col("集計対象（投与済みのみ）")], "");
  assert.equal(byId[10][col("在庫の扱い")], "");
  assert.equal(byId[10][col("在庫算入")], "");

  assert.equal(byId[11][col("状態")], "見送り");
  assert.equal(byId[11][col("見送り理由")], "72時間未満のため見送り");
  assert.equal(byId[11][col("72時間判定")], "72時間未満");
  assert.equal(byId[11][col("在庫算入")], "");

  assert.equal(byId[12][col("在庫の扱い")], "数える", "stockCount=null は数える");
  assert.equal(byId[12][col("在庫算入")], 1);
  assert.equal(byId[13][col("在庫の扱い")], "数える");
  assert.equal(byId[13][col("在庫算入")], 1);
  assert.equal(byId[14][col("在庫の扱い")], "数えない");
  assert.equal(byId[14][col("在庫算入")], "", "数えないは空欄（0にしない）");
  assert.equal(byId[15][col("在庫の扱い")], "確認待ち");
  assert.equal(byId[15][col("在庫算入")], "");
  assert.equal(byId[15][col("集計対象（投与済みのみ）")], "投与済み", "集計対象は投与済み全件（在庫の扱いとは別軸）");
});

test("injections: 在庫算入の合計は、既存の在庫計算（stockSummary）と一致する", () => {
  const { env, C, s } = setup();
  const L = env.get("InjectionLogic");
  const mk = (over) => Object.assign(env.get("createEmptyInjection()"), over);
  s.injectionStock = { initialPens: 24, setupAt: "2026-10-01T00:00:00.000Z" };
  s.injections = [
    mk({ id: 1, status: "administered", administeredAt: "2026-09-10", stockCount: null }),
    mk({ id: 2, status: "administered", administeredAt: "2026-09-17", stockCount: "counts" }),
    mk({ id: 3, status: "administered", administeredAt: "2026-09-24", stockCount: "excluded" }),
    mk({ id: 4, status: "administered", administeredAt: "2026-10-01", stockCount: "review" }),
    mk({ id: 5, status: "scheduled", scheduledAt: "2026-10-08" }),
  ];
  const summary = L.stockSummary(s);
  const { headers, rows } = C.buildInjections(s);
  const col = headers.indexOf("在庫算入");
  const sum = rows.reduce((a, r) => a + (r[col] === "" ? 0 : r[col]), 0);
  assert.equal(sum, summary.used);
});

test("injections: 実施日が無い旧データでも例外にならず、空欄で出る", () => {
  const { env, C, s } = setup();
  s.injections = [Object.assign(env.get("createEmptyInjection()"), { id: 1, status: "administered", kind: "legacy", administeredAt: null, administeredTime: null, createdAt: null, updatedAt: null })];
  const { headers, rows } = C.buildInjections(s);
  assert.equal(rows[0][headers.indexOf("実施日")], null);
  assert.equal(rows[0][headers.indexOf("作成日時")], null);
});

// ---------- injection_schedule.csv ----------

test("injection_schedule: 変更前の適用開始日は常に空欄（仕様どおり）。種別ラベルと曜日の数値", () => {
  const { env, C, s } = setup();
  s.injectionSchedule.history.push({
    id: 2,
    changedAt: "2026-10-05T01:00:00.000Z",
    type: "weekdayChange",
    from: { weekday: 4, time: "09:00" },
    to: { weekday: 2, time: "09:00", effectiveFrom: "2026-10-13" },
    check: { result: "ge72" },
    replacedScheduledId: 1,
  });
  const { headers, rows } = C.buildInjectionSchedule(s);
  const col = (n) => headers.indexOf(n);
  const r = rows.find((x) => x[0] === 2);
  assert.equal(r[col("種別")], "曜日変更");
  assert.equal(r[col("変更前_曜日(0=日)")], 4);
  assert.equal(r[col("変更前_適用開始日")], null, "fromにeffectiveFromは記録されないため常に空欄");
  assert.equal(r[col("変更後_適用開始日")], "2026-10-13");
  assert.equal(r[col("72時間判定")], "72時間以上");
});

// ---------- conditions.csv ----------

test("conditions: 症状7列は選択=1・未選択=空欄（0は使わない）。severeは段階『あり』・保存値『severe』を区別できる", () => {
  const { env, C, s } = setup();
  s.conditionEntries = [
    { id: 1, date: "2026-10-01", time: "08:00", level: "mild", symptoms: ["nausea", "abdominalPain"], comment: "", createdAt: "2026-10-01T08:00:00.000Z" },
    { id: 2, date: "2026-10-01", time: "21:00", level: "severe", symptoms: [], comment: "強め", createdAt: "2026-10-01T21:00:00.000Z" },
  ];
  const { headers, rows } = C.buildConditions(s);
  assert.equal(rows.length, 2, "同じ日の2件とも欠落しない");
  const col = (n) => headers.indexOf(n);
  const r1 = rows[0];
  assert.equal(r1[col("悪心")], 1);
  assert.equal(r1[col("腹痛")], 1);
  assert.equal(r1[col("便秘")], "", "選んでいない症状は空欄");
  assert.equal(r1[col("症状一覧")], "悪心・腹痛");
  const r2 = rows.find((r) => r[0] === 2);
  assert.equal(r2[col("段階")], "あり");
  assert.equal(r2[col("保存値")], "severe");
  for (const label of ["悪心", "胃もたれ", "便秘", "下痢", "腹痛", "食欲低下", "その他"]) assert.equal(r2[col(label)], "");
});

test("conditions: levelがnullの記録は、段階・保存値とも空欄", () => {
  const { C, s } = setup();
  s.conditionEntries = [{ id: 1, date: "2026-10-01", time: null, level: null, symptoms: [], comment: "", createdAt: "2026-10-01T00:00:00.000Z" }];
  const { headers, rows } = C.buildConditions(s);
  assert.equal(rows[0][headers.indexOf("段階")], "");
  assert.equal(rows[0][headers.indexOf("保存値")], null);
});

// ---------- export_info.csv ----------

test("export_info: 件数・在庫の内訳がほかのシート・stockSummaryと一致する", () => {
  const { env, C, s } = setup();
  const L = env.get("InjectionLogic");
  const mk = (over) => Object.assign(env.get("createEmptyInjection()"), over);
  s.injectionStock = { initialPens: 24, setupAt: "2026-10-01T00:00:00.000Z" };
  s.injections = [
    mk({ id: 1, status: "administered", administeredAt: "2026-09-10", stockCount: null }),
    mk({ id: 2, status: "administered", administeredAt: "2026-09-17", stockCount: "excluded" }),
    mk({ id: 3, status: "administered", administeredAt: "2026-09-24", stockCount: "review" }),
    mk({ id: 4, status: "scheduled", scheduledAt: "2026-10-08" }),
    mk({ id: 5, status: "skipped", regularDate: "2026-10-01" }),
  ];
  const summary = L.stockSummary(s);
  const now = new Date(2026, 9, 10, 9, 30, 0);
  const { headers, rows } = C.buildExportInfo(s, now);
  assert.deepEqual(clone(headers), ["項目", "値"]);
  const val = (name) => rows.find((r) => r[0] === name)[1];
  assert.equal(val("weight 件数（体重のある日）"), C.buildWeight(s).rows.length);
  assert.equal(val("injections 件数（全件）"), 5);
  assert.equal(val("injections 内訳_予定"), 1);
  assert.equal(val("injections 内訳_投与済み"), 3);
  assert.equal(val("injections 内訳_見送り"), 1);
  assert.equal(val("在庫_数える本数"), summary.used);
  assert.equal(val("在庫_数えない本数"), 1);
  assert.equal(val("在庫_確認待ち本数"), 1);
  assert.equal(val("在庫_残り本数"), summary.remaining);
  assert.equal(val("タイムゾーン（この書き出しの基準）"), "UTC+09:00");
  assert.match(val("書き出し日時"), /^2026-10-10 09:30:00$/);
  assert.equal(rows.filter((r) => r[0] === "注記").length >= 1, true);
});

// ---------- 全体・非干渉 ----------

test("buildAll: 8シート、state・profile・goalsは一切変更しない", () => {
  const { C, s } = setup();
  const before = JSON.stringify(s);
  const defs = C.buildAll(s, new Date(2026, 9, 10, 9, 0));
  assert.equal(JSON.stringify(s), before, "state を変更しない");
  assert.deepEqual(clone(defs.map((d) => d.sheet)), ["weight", "body_composition", "protein", "injections", "injection_schedule", "conditions", "cycles", "export_info"]);
  for (const d of defs) {
    const file = C.toFile(d, new Date(2026, 9, 10, 9, 0));
    assert.match(file.fileName, /^body-garden-[a-z_]+-\d{8}-\d{4}\.csv$/);
    assert.equal(file.text.charCodeAt(0), 0xfeff);
  }
});

test("JSONバックアップの検証・件数（Backup.counts/validateState）は、CSV追加の影響を受けない", () => {
  const { env, s } = setup();
  const C = env.get("CsvLogic");
  const before = env.Backup.counts(s);
  C.buildAll(s, new Date());
  const after = env.Backup.counts(s);
  assert.deepEqual(before, after);
  const v = env.Backup.validateState(clone(s));
  assert.deepEqual(clone(v.errors), []);
});
