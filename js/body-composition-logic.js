// Body Garden — 体組成の一括貼り付け登録のロジック（純粋関数。DOM・localStorageには触れない）
//
// 運用: 体組成計のスクリーンショット → オルグレイ（ChatGPT）が16項目を読み取る → 「登録用テキスト」を作る
//       → ユーザーが貼り付け → 内容を確認して保存。アプリ内OCRは無い。項目ごとの手入力を基本操作にしない。
//
// 方針
//  - 読み取れなかった項目・解釈できない値を、推測・補完・四捨五入しない（未読取・未認識として明示する）。
//  - 単位の不一致・単位の欠落・数値として読めない値・あり得ない値(hard)は保存しない。
//    機種差・丸め方の違いで妥当性が一概に言えない値(soft範囲外・桁数)は、警告＋本人の確認で保存できる。
//  - 同じ測定日に既存の値があるときは、無断で上書きしない（既定は既存を残す。上書きは本人が項目ごとに選ぶ）。
//  - 1日1件（dailyRecords に紐づく）。1テキスト＝1測定。
//  - BMI・体組成計の体重は測定の記録として bodyComposition に保存する。HOME・Goal・ガードレールの判定は従来どおり
//    dailyRecords.weight と Calc.bmi（アプリ計算）を使う。
//  - apply* は検証してから変更する（失敗時は state を変えない）。保存(Storage.save)・afterWeightSave は呼び出し側。

const BodyCompositionLogic = {
  FORMAT_VERSION: 1,
  HEADER_RE: /^[【\[]\s*body\s*garden\s*体組成\s*v\s*(\d+)\s*[】\]]$/i,
  END_RE: /^[【\[]\s*ここまで\s*[】\]]$/,
  // 解釈できない（あいまいな）項目名と、直し方
  AMBIGUOUS: {
    体脂肪: "「体脂肪率（%）」か「体脂肪量（kg）」かを明記してください",
    脂肪: "「体脂肪率（%）」「体脂肪量（kg）」「皮下脂肪（%）」「内臓脂肪」のどれかを明記してください",
    筋肉: "「筋肉量（kg）」か「骨格筋量（kg）」かを明記してください",
    骨格筋: "「骨格筋量（kg）」と書いてください",
    代謝年齢: "「体内年齢」と書いてください",
    体水分: "「水分量（kg）」か「水分量（%）」かを明記してください",
  },

  // ============ 小さな部品 ============

  _fields() {
    return COMPOSITION_FIELDS;
  },
  _ymd(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  },
  isRealDate(s) {
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split("-").map(Number);
    if (y < 2000 || y > 2100) return false;
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  },
  isTime(t) {
    return typeof t === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
  },
  _isMissingWord(v) {
    const t = v.trim();
    if (t === "") return true;
    const m = /^(未読取|不明|読み取れず|[-—―–]+)\s*(.*)$/.exec(t);
    return !!m && !/\d/.test(m[2]); // 「-5」のように数字が続くものは未読取ではない（数値として不正）
  },
  _clone(o) {
    return JSON.parse(JSON.stringify(o));
  },

  // 日付の読み取り。年の無い日付は不可（年を推測しない）
  _parseDate(raw) {
    const v = raw.trim();
    if (this._isMissingWord(v)) return { status: "missing", value: null };
    const m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/.exec(v) || /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(v);
    if (!m) return { status: "invalid", value: null };
    const s = `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
    return this.isRealDate(s) ? { status: "ok", value: s } : { status: "invalid", value: null };
  },
  _parseTime(raw) {
    const v = raw.trim();
    if (this._isMissingWord(v)) return { status: "missing", value: null };
    const m = /^(\d{1,2}):(\d{2})$/.exec(v);
    if (!m) return { status: "invalid", value: null };
    const s = `${String(m[1]).padStart(2, "0")}:${m[2]}`;
    return this.isTime(s) ? { status: "ok", value: s } : { status: "invalid", value: null };
  },

  // 1項目の値の解釈。丸め・補完・推測をしない
  _parseValue(f, raw) {
    const v = raw.trim();
    if (this._isMissingWord(v)) return { status: "missing", value: null, message: "未読取" };
    if (f.type === "string") {
      return isValidBodyType(v)
        ? { status: "ok", value: v }
        : { status: "invalidValue", value: null, message: "ボディタイプは20字以内の文字列にしてください（記号 < > & \" ' ` や、先頭の = + - @ は使えません）" };
    }
    const m = /^(\d+)(?:\.(\d+))?\s*(.*)$/.exec(v);
    if (!m) return { status: "invalidValue", value: null, message: "数値として読めません（カンマ・符号・「約」などは使えません）" };
    const intPart = m[1];
    const dec = m[2] || "";
    if (intPart.length > 5 || dec.length > 4) return { status: "invalidValue", value: null, message: "桁数が多すぎます" };
    const value = Number(dec ? `${intPart}.${dec}` : intPart);
    const unitRaw = m[3].trim();
    // 数字・カンマ・小数点が続くものは、単位ではなく数値の書式の誤り（1,312 / 66.8.1 など）。推測しない
    if (/^[\d,.]/.test(unitRaw)) return { status: "invalidValue", value: null, message: "数値として読めません（カンマ・符号・「約」などは使えません）" };
    const unit = unitRaw.replace(/\s+/g, "").toLowerCase();
    if (unit === "") {
      if (f.unitRequired) return { status: "unitMissing", value: null, message: `単位がありません（${f.unit}）。ポンド等の見落としを防ぐため、単位のない値は保存しません` };
    } else if (!f.units.includes(unit)) {
      return { status: "unitMismatch", value: null, message: `単位「${unitRaw}」は使えません（${f.unit || "単位なし"}）。換算はしません` };
    }
    if (f.hard && (value < f.hard[0] || value > f.hard[1])) {
      return { status: "outOfRange", value: null, message: `${value} は通常あり得ない値です（${f.hard[0]}〜${f.hard[1]}）。保存しません` };
    }
    const notes = [];
    if (f.soft && (value < f.soft[0] || value > f.soft[1])) {
      notes.push(`通常の範囲（${f.soft[0]}〜${f.soft[1]}）の外です。機種や表示方法による違いの可能性があります`);
    }
    const extraDecimals = dec.length > f.decimals && Number(dec) !== 0;
    if (extraDecimals) notes.push(`小数${dec.length}桁です（通常は${f.decimals}桁）。丸めずにそのまま扱います`);
    if (notes.length) return { status: "suspect", value, message: notes.join("／") };
    return { status: "ok", value };
  },

  // ============ 解析 ============
  // 返り値: { ok, formatVersion, date, dateStatus, time, timeStatus, items[16], unrecognizedLines[], notes[], errors[], warnings[], counts }
  // ok=false は「致命的エラー」（貼り付けの全体を使わない）。個々の項目の問題は items[].status に出る。

  parse(text, now = new Date()) {
    const F = this._fields();
    const result = {
      ok: false,
      formatVersion: null,
      date: null,
      dateStatus: "absent",
      time: null,
      timeStatus: "absent",
      items: F.map((f) => ({ key: f.key, label: f.label, unit: f.unit, status: "absent", value: null, raw: null, lineNo: null, message: "記載なし" })),
      unrecognizedLines: [],
      notes: [],
      errors: [],
      warnings: [],
      counts: { ok: 0, suspect: 0, missing: 0, absent: 0, problem: 0 },
    };
    const fail = (code, message) => {
      result.errors.push({ code, message });
      return result;
    };
    if (typeof text !== "string" || text.trim() === "") return fail("EMPTY", "貼り付けが空です。");
    if (text.length > COMPOSITION_TEXT_MAX_CHARS) return fail("TOO_LARGE", `文字数が多すぎます（上限${COMPOSITION_TEXT_MAX_CHARS}字）。`);
    const norm = text.normalize("NFKC").replace(/[​-‍﻿]/g, "");
    if (norm.length > COMPOSITION_TEXT_MAX_CHARS) return fail("TOO_LARGE", `文字数が多すぎます（上限${COMPOSITION_TEXT_MAX_CHARS}字）。`);
    const lines = norm.split(/\r\n|\r|\n/);
    if (lines.length > COMPOSITION_TEXT_MAX_LINES) return fail("TOO_MANY_LINES", `行数が多すぎます（上限${COMPOSITION_TEXT_MAX_LINES}行）。`);
    if (lines.some((l) => l.length > COMPOSITION_TEXT_MAX_LINE_CHARS && !/^[\-・*•]?\s*備考\s*:/.test(l.trim()))) return fail("LINE_TOO_LONG", `長すぎる行があります（1行${COMPOSITION_TEXT_MAX_LINE_CHARS}字まで）。`);

    // 項目名 → 定義（別名を含む。空白を除いて小文字化して照合）
    const keyOf = (s) => s.replace(/\s+/g, "").toLowerCase();
    const byName = new Map();
    F.forEach((f) => [f.label, ...(f.aliases || [])].forEach((n) => byName.set(keyOf(n), f)));

    const addUnrecognized = (lineNo, line, hint) => result.unrecognizedLines.push({ lineNo, text: line.slice(0, 80), hint: hint || "" });
    let headerSeen = false;
    let endSeen = false;
    let firstContent = true;
    let dateSeen = null;
    let dateLines = 0;
    let timeLines = 0;
    const seen = new Set(); // 出てきた項目のkey

    for (let n = 0; n < lines.length; n++) {
      const lineNo = n + 1;
      let line = lines[n].trim();
      if (line === "" || /^```/.test(line)) continue;

      const h = this.HEADER_RE.exec(line);
      if (firstContent) {
        firstContent = false;
        if (!h) return fail("NO_HEADER", "1行目が「【Body Garden 体組成 v1】」ではありません。登録用テキストの形式（仕様）を確認してください。");
      }
      if (h) {
        if (headerSeen) return fail("DUPLICATE_HEADER", "ヘッダーが2つあります。1回の測定につき、登録用テキストは1つにしてください。");
        if (Number(h[1]) !== this.FORMAT_VERSION) return fail("UNSUPPORTED_VERSION", `形式の版（v${h[1]}）には対応していません（v${this.FORMAT_VERSION}）。`);
        headerSeen = true;
        result.formatVersion = this.FORMAT_VERSION;
        continue;
      }
      if (this.END_RE.test(line)) {
        endSeen = true;
        continue;
      }
      if (endSeen) {
        addUnrecognized(lineNo, line, "【ここまで】より後の行です");
        continue;
      }
      line = line.replace(/^[\-・*•]\s*/, "");
      const idx = line.indexOf(":");
      if (idx < 0) {
        addUnrecognized(lineNo, line, "「項目名: 値」の形ではありません");
        continue;
      }
      const label = line.slice(0, idx).trim();
      const rawValue = line.slice(idx + 1).trim();
      const lk = keyOf(label).replace(/\([^)]*\)$/, ""); // 「体脂肪率(%)」のような末尾の括弧は照合に使わない

      if (lk === "測定日") {
        const d = this._parseDate(rawValue);
        dateLines += 1;
        if (d.status === "ok" && dateSeen && dateSeen !== d.value) return fail("MULTIPLE_DATES", "測定日が複数あります。測定日が違う場合は、別々の登録用テキストにしてください。");
        if (dateLines > 1 && d.status !== "ok") result.warnings.push({ code: "DATE_LINE_IGNORED", message: `${lineNo}行目の測定日は読み取れなかったため、使っていません。` });
        if (d.status === "ok") dateSeen = d.value;
        if (!result.date || d.status === "ok") {
          result.date = d.value;
          result.dateStatus = d.status;
        }
        continue;
      }
      if (lk === "測定時刻") {
        const t = this._parseTime(rawValue);
        timeLines += 1;
        if (timeLines > 1) {
          // 2つ目以降は使わない（最初の行を採用）。違う値のときは知らせる
          if (t.value !== result.time) result.warnings.push({ code: "TIME_LINE_IGNORED", message: `${lineNo}行目の測定時刻は、最初の測定時刻と違うため使っていません。1回の測定につき、時刻は1つにしてください。` });
          continue;
        }
        result.time = t.value;
        result.timeStatus = t.status;
        continue;
      }
      if (lk === "備考") {
        if (result.notes.length < 5) result.notes.push(rawValue.slice(0, 200));
        continue;
      }

      const f = byName.get(lk);
      if (!f) {
        addUnrecognized(lineNo, line, this.AMBIGUOUS[lk] || "知らない項目名です");
        continue;
      }
      const item = result.items.find((i) => i.key === f.key);
      const r = this._parseValue(f, rawValue);
      if (seen.has(f.key)) {
        // 同じ項目が2回: 解釈した結果が同じ（66.8 と 66.80 など）ならそのまま。違うときは、どちらも使わない
        if (item.status !== "duplicate" && !(r.status === item.status && r.value === item.value)) {
          item.status = "duplicate";
          item.value = null;
          item.message = "同じ項目が違う値で2回あります。どちらも使いません";
        }
        continue;
      }
      seen.add(f.key);
      Object.assign(item, { status: r.status, value: r.value === undefined ? null : r.value, raw: rawValue.slice(0, 60), lineNo, message: r.message || "" });
    }

    if (!headerSeen) return fail("NO_HEADER", "ヘッダー「【Body Garden 体組成 v1】」が見つかりません。");
    if (result.timeStatus === "invalid") result.warnings.push({ code: "TIME_INVALID", message: "測定時刻を読み取れませんでした（HH:MM の形で書かれていません）。必要なら、画面で入力してください。" });
    if (!endSeen) result.warnings.push({ code: "NO_END", message: "最後の行「【ここまで】」がありません。コピーが途中で切れていないか確認してください。" });

    // 項目どうしの確認（警告のみ。値は保存できる）
    const val = (k) => {
      const i = result.items.find((x) => x.key === k);
      return i && (i.status === "ok" || i.status === "suspect") ? i.value : null;
    };
    const w = val("measuredWeight");
    const fatPct = val("bodyFatPct");
    const fatMass = val("bodyFatMass");
    const lean = val("leanMass");
    const muscle = val("muscleMass");
    const skeletal = val("skeletalMuscleMass");
    if (w !== null && fatPct !== null && fatMass !== null && Math.abs(fatMass - (w * fatPct) / 100) > 0.6) {
      result.warnings.push({ code: "FAT_MASS_MISMATCH", key: "bodyFatMass", message: "体脂肪量が「体重×体脂肪率」と合いません。体脂肪量と除脂肪体重を取り違えていないか確認してください。" });
    }
    if (w !== null && fatMass !== null && lean !== null && Math.abs(lean - (w - fatMass)) > 0.6) {
      result.warnings.push({ code: "LEAN_MASS_MISMATCH", key: "leanMass", message: "除脂肪体重が「体重−体脂肪量」と合いません。取り違えていないか確認してください。" });
    }
    if (muscle !== null && skeletal !== null && skeletal >= muscle) {
      result.warnings.push({ code: "SKELETAL_GE_MUSCLE", key: "skeletalMuscleMass", message: "骨格筋量が筋肉量以上です。筋肉量と骨格筋量を取り違えていないか確認してください。" });
    }
    if (w !== null) {
      for (const [k, v] of [["bodyFatMass", fatMass], ["muscleMass", muscle], ["leanMass", lean]]) {
        if (v !== null && v >= w) result.warnings.push({ code: "PART_GE_WEIGHT", key: k, message: `${F.find((x) => x.key === k).label}が体重以上です。値を確認してください。` });
      }
    }

    for (const i of result.items) {
      if (i.status === "ok") result.counts.ok += 1;
      else if (i.status === "suspect") result.counts.suspect += 1;
      else if (i.status === "missing") result.counts.missing += 1;
      else if (i.status === "absent") result.counts.absent += 1;
      else result.counts.problem += 1;
    }
    result.ok = true;
    return result;
  },

  // ============ 確認（同じ日の既存データとの差分） ============
  // 測定日を本人が決めたあと、その日の既存の体重・体組成と並べる。保存する前の確認用で、state は変えない。

  _savable(item) {
    return item.status === "ok" || item.status === "suspect";
  },
  _existingOn(state, date) {
    return (state.dailyRecords || []).find((r) => r.date === date) || null;
  },

  assess(state, parsed, date, now = new Date()) {
    const F = this._fields();
    const rec = this._existingOn(state, date);
    const existingBc = (rec && rec.bodyComposition) || {};
    const rows = F.map((f) => {
      const item = parsed.items.find((i) => i.key === f.key);
      const existing = existingBc[f.key] === undefined ? null : existingBc[f.key];
      const incoming = this._savable(item) ? item.value : null;
      let kind;
      if (incoming === null) kind = existing !== null ? "keep" : "none";
      else if (existing === null) kind = "add";
      else if (existing === incoming) kind = "same";
      else kind = "conflict";
      return { key: f.key, label: f.label, unit: f.unit, status: item.status, message: item.message, existing, incoming, kind };
    });

    const measuredItem = parsed.items.find((i) => i.key === "measuredWeight");
    const measured = this._savable(measuredItem) ? measuredItem.value : null;
    const existingWeight = rec && rec.weight !== undefined ? rec.weight : null;
    let weightKind = "none";
    if (measured !== null) weightKind = existingWeight === null ? "add" : existingWeight === measured ? "same" : "conflict";
    const weight = { existing: existingWeight, measured, kind: weightKind, diff: measured !== null && existingWeight !== null ? Math.round((measured - existingWeight) * 100) / 100 : null };

    const blocking = [];
    const warnings = [];
    const today = this._ymd(now);
    if (!this.isRealDate(date)) blocking.push({ code: "DATE_REQUIRED", message: "測定日を入力してください。" });
    else if (date > today) blocking.push({ code: "FUTURE_DATE", message: "未来の日付は登録できません。" });
    else {
      const [y, m, d] = date.split("-").map(Number);
      const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(y, m - 1, d)) / 86400000);
      if (days > 30) warnings.push({ code: "OLD_DATE", message: `測定日が${days}日前です。年や日付の読み間違いがないか確認してください。` });
      if (state.profile && state.profile.startDate && date < state.profile.startDate) warnings.push({ code: "BEFORE_START", message: "測定日が、開始日より前です。" });
    }
    const anySavable = parsed.items.some((i) => this._savable(i));
    if (!anySavable) blocking.push({ code: "NOTHING_TO_SAVE", message: "保存できる項目がありません。" });

    // 体組成計のBMIと、体重・身長から計算したBMIの差（警告のみ。判定には常にアプリ計算のBMIを使う）
    let bmiCheck = null;
    const bmiItem = parsed.items.find((i) => i.key === "bmi");
    if (this._savable(bmiItem) && measured !== null && state.profile && state.profile.heightCm) {
      const calc = Calc.bmi(measured, state.profile.heightCm);
      if (calc !== null && Math.abs(calc - bmiItem.value) > 0.2) {
        bmiCheck = { measured: bmiItem.value, calculated: Math.round(calc * 10) / 10 };
        warnings.push({ code: "BMI_DIFF", message: `体組成計のBMI（${bmiItem.value}）と、アプリで計算したBMI（${bmiCheck.calculated}）が違います。体組成計の身長設定とアプリの身長（${state.profile.heightCm}cm）が違う可能性があります。HOME・Goalの判定にはアプリ計算のBMIを使います。` });
      }
    }

    const allWarnings = [...parsed.warnings, ...warnings];
    const unsaved = parsed.items.filter((i) => !this._savable(i)).length;
    const needsAck = allWarnings.length > 0 || parsed.counts.suspect > 0 || unsaved > 0 || parsed.unrecognizedLines.length > 0 || parsed.dateStatus !== "ok";
    return {
      date,
      existing: rec,
      rows,
      weight,
      bmiCheck,
      blocking,
      warnings: allWarnings,
      needsAck,
      // プレビュー時点の既存値。保存の直前に再評価して食い違えば保存しない（別の操作で変わった場合の保護）
      basis: { exists: !!rec, weight: existingWeight, bc: Object.fromEntries(F.map((f) => [f.key, existingBc[f.key] === undefined ? null : existingBc[f.key]])) },
    };
  },

  // ============ 保存（検証してから変更。保存・afterWeightSave は呼び出し側） ============
  // decisions: { date, time, overwrite:{key:true}, weight:"keep"|"set", acknowledged, basis }

  _fail(code, message) {
    return { ok: false, code, message };
  },

  applyImport(state, parsed, decisions, now = new Date()) {
    if (!parsed || !parsed.ok) return this._fail("INVALID_PARSE", "貼り付けの内容を確認できていません。");
    const d = decisions || {};
    const date = d.date;
    if (!this.isRealDate(date)) return this._fail("DATE_REQUIRED", "測定日を入力してください。");
    if (d.time !== undefined && d.time !== null && d.time !== "" && !this.isTime(d.time)) return this._fail("INVALID_TIME", "測定時刻は HH:MM の形で入力してください。");
    const a = this.assess(state, parsed, date, now);
    if (a.blocking.length) return this._fail(a.blocking[0].code, a.blocking[0].message);
    if (JSON.stringify(a.basis) !== JSON.stringify(d.basis)) return this._fail("STALE_PREVIEW", "確認のあとで、この日の記録が変わりました。もう一度、内容を確認してください。");
    if (a.needsAck && !d.acknowledged) return this._fail("ACK_REQUIRED", "保存されない項目や警告があります。内容を確認したことにチェックを入れてください。");

    const overwrite = d.overwrite || {};
    for (const [k, on] of Object.entries(overwrite)) {
      if (!on) continue;
      const row = a.rows.find((r) => r.key === k);
      if (!row || row.kind !== "conflict") return this._fail("INVALID_DECISION", "上書きの選択が正しくありません。");
    }
    const weightDecision = d.weight === "set" ? "set" : "keep";
    if (weightDecision === "set" && a.weight.kind === "none") return this._fail("INVALID_DECISION", "体重として登録できる値がありません。");

    // 既存の記録の複製から作る（実物には触れない）。置き換えは最後に1回だけ
    const existing = a.existing ? this._clone(a.existing) : createEmptyDailyRecord(date);
    const bc = { ...EMPTY_BODY_COMPOSITION, ...(existing.bodyComposition || {}) };
    const written = [];
    const overwritten = [];
    const kept = [];
    for (const row of a.rows) {
      if (row.kind === "add") {
        bc[row.key] = row.incoming;
        written.push(row.key);
      } else if (row.kind === "conflict") {
        if (overwrite[row.key]) {
          bc[row.key] = row.incoming;
          overwritten.push(row.key);
        } else kept.push(row.key);
      }
    }
    const weightChanged = weightDecision === "set" && a.weight.measured !== null && existing.weight !== a.weight.measured;
    if (!written.length && !overwritten.length && !weightChanged) return this._fail("NOTHING_TO_SAVE", "変更される項目がありません（同じ値、または既存の値を残す選択です）。");

    const nowIso = now.toISOString();
    const prevMeta = existing.compositionMeta || null;
    const wroteComposition = written.length + overwritten.length > 0;
    const hadValues = Object.values(a.basis.bc).some((v) => v !== null);
    let meta = prevMeta;
    if (wroteComposition) {
      // 今回の値で置き換わらずに残る既存の値（今回違う値・今回未記載）があるか。同じ値の項目は「残っている」に数えない
      const leftover = a.rows.filter((r) => r.kind === "keep" || (r.kind === "conflict" && !overwrite[r.key])).length;
      const prevTime = prevMeta ? prevMeta.measuredTime : null;
      const timesDiffer = !!(prevTime && d.time && prevTime !== d.time);
      const conflictKept = a.rows.some((r) => r.kind === "conflict" && !overwrite[r.key]);
      const mixedNow = hadValues && leftover > 0 && (conflictKept || timesDiffer || !prevMeta);
      const mixed = !!(prevMeta && prevMeta.mixed) || mixedNow;
      meta = {
        // 時刻が分からない（今回未記載）・2回分が混ざるときは、以前の時刻を消さない
        measuredTime: mixed ? (prevTime || d.time || null) : d.time ? d.time : prevTime || null,
        source: "paste",
        formatVersion: this.FORMAT_VERSION,
        importedAt: prevMeta ? prevMeta.importedAt : nowIso,
        updatedAt: nowIso,
        // 既存を残した項目（今回と値が違う）と、新しく書いた項目が両方あるときは、2回分の測定が混ざる
        mixed,
      };
    }
    const record = { ...existing, bodyComposition: bc, compositionMeta: meta };
    if (weightChanged) record.weight = a.weight.measured;

    const prevRecord = a.existing ? this._clone(a.existing) : null;
    const idx = state.dailyRecords.findIndex((r) => r.date === date);
    if (idx >= 0) state.dailyRecords[idx] = record;
    else {
      state.dailyRecords.push(record);
      state.dailyRecords.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
    }
    return { ok: true, record, prevRecord, written, overwritten, kept, weightChanged };
  },

  // 保存に失敗したとき、メモリ上の記録と goals（afterWeightSave が書き換える）を元に戻す
  revertImport(state, snapshot) {
    const idx = state.dailyRecords.findIndex((r) => r.date === snapshot.date);
    if (snapshot.prevRecord) {
      if (idx >= 0) state.dailyRecords[idx] = snapshot.prevRecord;
      else state.dailyRecords.push(snapshot.prevRecord);
    } else if (idx >= 0) {
      state.dailyRecords.splice(idx, 1);
    }
    state.dailyRecords.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
    if (snapshot.goals) state.goals = snapshot.goals;
    return { ok: true };
  },

  // その日の体組成だけを削除する。体重・メモ・goals・注射・在庫・Protein には触れない
  applyDeleteComposition(state, date) {
    const idx = state.dailyRecords.findIndex((r) => r.date === date);
    if (idx < 0) return this._fail("NOT_FOUND", "この日の記録がありません。");
    const rec = state.dailyRecords[idx];
    const had = Object.values(rec.bodyComposition || {}).some((v) => v !== null) || !!rec.compositionMeta;
    if (!had) return this._fail("NO_COMPOSITION", "この日に体組成の記録はありません。");
    const next = { ...rec, bodyComposition: { ...EMPTY_BODY_COMPOSITION }, compositionMeta: null };
    // 体重もメモも無い（体組成だけの）日は、記録そのものを取り除く
    if ((next.weight === null || next.weight === undefined) && !next.comment) {
      state.dailyRecords.splice(idx, 1);
      return { ok: true, removedRecord: true };
    }
    state.dailyRecords[idx] = next;
    return { ok: true, removedRecord: false };
  },

  // 履歴（体組成のある日を新しい順に）
  historyRows(state, limit = 20) {
    return (state.dailyRecords || [])
      .filter((r) => r.compositionMeta || Object.values(r.bodyComposition || {}).some((v) => v !== null))
      .slice()
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
      .slice(0, limit)
      .map((r) => ({ ...r, bodyComposition: { ...EMPTY_BODY_COMPOSITION, ...(r.bodyComposition && typeof r.bodyComposition === "object" ? r.bodyComposition : {}) } }));
  },

  // ============ 登録用テキストの仕様（オルグレイに渡す）と、サンプル ============

  SAMPLE_VALUES: {
    measuredWeight: "66.80 kg", bmi: "25.5", bodyFatPct: "31.2 %", heartRate: "68 bpm", muscleMass: "43.70 kg", bmr: "1312 kcal",
    waterPct: "49.8 %", bodyFatMass: "20.84 kg", leanMass: "45.96 kg", boneMass: "2.30 kg", visceralFat: "9", proteinPct: "16.1 %",
    skeletalMuscleMass: "25.40 kg", subcutaneousFat: "27.8 %", bodyAge: "44", bodyType: "標準型",
  },

  sampleText() {
    const lines = ["【Body Garden 体組成 v1】", "測定日: 2026-10-01", "測定時刻: 07:12"];
    for (const f of this._fields()) lines.push(`${f.label}: ${this.SAMPLE_VALUES[f.key]}`);
    lines.push("【ここまで】");
    return lines.join("\n");
  },

  specText() {
    const F = this._fields();
    const fieldLine = (f) => {
      const u = f.type === "string" ? "画面の文字をそのまま・20字以内" : f.unit ? `${f.unit}${f.decimals === 0 ? "・整数" : `・小数${f.decimals}桁まで`}` : f.key === "bodyAge" ? "歳・整数" : f.key === "visceralFat" ? "単位なし・レベルの数値" : "単位なし";
      return `${f.label}(${u})`;
    };
    return [
      "Body Garden 体組成 登録用テキスト 仕様 v1",
      "体組成計の測定結果の画像から、次の形式のテキストを作ってください。",
      "",
      "■ 基本ルール",
      "1. 1回の測定につきテキストは1つ。1行目は【Body Garden 体組成 v1】、最後の行は【ここまで】。",
      "2. 1行に1項目、「項目名: 値 単位」。項目名は下の一覧の表記をそのまま使い、言い換えない。",
      "3. 数字は半角、小数点は「.」。カンマ（1,312 など）は使わない。「約」「≒」などを付けない。",
      "4. 単位は一覧のとおりに付ける（BMI・内臓脂肪・ボディタイプは単位なし）。ポンド(lb)などへの換算はしない。",
      "5. 画面の値をそのまま書く。四捨五入・計算・補完をしない。",
      "6. 読み取れない項目や画面に無い項目も、行を消さずに「未読取」と書く。推測で埋めない。",
      "7. 測定日は YYYY-MM-DD。年が見えない・日付が無いときは「測定日: 未読取」（日付はアプリで本人が入力します）。",
      "   測定時刻は HH:MM（24時間制）。分からなければ「未読取」。",
      "8. 補足は「備考: 」の行に書く（最大5行。アプリには保存されません）。",
      "9. 前置きや説明文、表は付けない。出力はテキスト（コードブロック1つ）だけ。",
      "",
      `■ 項目（この順番・この表記で${F.length}行）`,
      F.map(fieldLine).join(" / "),
      "",
      "■ 間違えやすい点",
      "・体脂肪率(%) と 体脂肪量(kg) は別の項目。「体脂肪」だけの表記は使わない。",
      "・体脂肪量 と 除脂肪体重 を取り違えない（体脂肪量 ≒ 体重×体脂肪率÷100、除脂肪体重 ≒ 体重−体脂肪量）。",
      "・筋肉量 と 骨格筋量 は別の項目（通常は 骨格筋量 < 筋肉量）。",
      "・水分量・タンパク質率・皮下脂肪 は % で書く。画面が kg 表示なら「未読取」にし、備考に kg の値を書く。",
      "・内臓脂肪は「レベル」の数値。kg や % は付けない。",
      "・体重が lb 表示なら換算せず「未読取」にし、備考に書く。",
      "",
      "■ 複数の画像",
      "・同じ1回の測定なら、1つのテキストにまとめる。",
      "・画像どうしで値が違う項目は、どちらかを選ばず「未読取」にし、備考に両方の値を書く。",
      "・測定日が違う画像は、別々のテキストにする。",
      "",
      "■ 例",
      this.sampleText(),
    ].join("\n");
  },
};
