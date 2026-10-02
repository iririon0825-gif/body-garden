// Body Garden — 分析用CSV書き出し（純粋関数。DOM・localStorageには触れない）
//
// 方針
//  - JSONバックアップ（backup.js）とは完全に別の機能。CSVから復元する機能は作らない。state は一切変更しない。
//  - 1日複数回ありうる記録（Protein・注射・体調）は、1件＝1行で出す（1日1行に押し込まない）。
//  - 記録が無い・読み取れない項目は常に空欄（""）。0を代入しない。
//  - 文字コード: UTF-8（BOM付き）。改行: CRLF。区切り: カンマ。RFC 4180準拠（カンマ・引用符・改行を含む値は引用符で囲み、内部の引用符は二重化）。
//  - CSVインジェクション対策: すべての文字列セル（数値セル以外）について、NFKC正規化前の先頭1文字が = + - @ タブ 復帰(CR) のいずれかなら、
//    先頭に ' を1つ追加してから出す。数値セル（typeof value==="number" && isFinite）には適用しない（数式として壊れるため）。
//  - 日付(YYYY-MM-DD)・時刻(HH:MM)はアプリの保存値をそのまま出す（タイムゾーン変換はしない）。
//    createdAt等のISO(UTC)だけ、書き出す端末のローカル時刻 "YYYY-MM-DD HH:MM:SS" に変換する。

const CsvLogic = {
  BOM: "﻿",
  CRLF: "\r\n",

  // ============ 値の整形・エスケープ ============

  // CSVインジェクション対策の対象になる先頭文字
  _DANGEROUS_LEAD: /^[=+\-@\t\r]/,

  // 1セル分の値を文字列化する。number はそのまま数値文字列、null/undefined は空欄、それ以外は文字列として対策・エスケープする
  cell(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
    let s = typeof value === "string" ? value : String(value);
    if (this._DANGEROUS_LEAD.test(s)) s = "'" + s;
    if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
    return s;
  },

  // 1行分（配列）をCSVの1行に。最後は呼び出し側で CRLF を付ける
  row(cells) {
    return cells.map((v) => this.cell(v)).join(",");
  },

  // ヘッダー行＋データ行から、BOM付きCRLF区切りのCSVテキストを作る
  build(headers, rows) {
    const lines = [this.row(headers)];
    for (const r of rows) lines.push(this.row(r));
    return this.BOM + lines.join(this.CRLF) + this.CRLF;
  },

  // 小数の丸め（null安全。Calc.round1(null) は 0 になってしまうため、ここで null を先に弾く）
  _round1(v) {
    return v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10) / 10;
  },

  // ISO(UTC)文字列 → 書き出す端末のローカル時刻 "YYYY-MM-DD HH:MM:SS"。読めなければ null
  _localTs(iso) {
    if (typeof iso !== "string" || iso === "") return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  },

  _ymd(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  },
  _hm(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  },
  // UTCからのオフセット（分）を "+09:00" の形にする。export_info の注記用
  _tzOffsetLabel(d) {
    const m = -d.getTimezoneOffset();
    const sign = m >= 0 ? "+" : "-";
    const a = Math.abs(m);
    const p = (n) => String(n).padStart(2, "0");
    return `${sign}${p(Math.floor(a / 60))}:${p(a % 60)}`;
  },

  fileName(sheet, now = new Date()) {
    const p = (n) => String(n).padStart(2, "0");
    return `body-garden-${sheet}-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.csv`;
  },

  // ============ 各シートの定義 ============
  // { sheet, headers, build(state) } の配列。build は state を変更しない

  SHEET_LABELS: {
    weight: "体重",
    body_composition: "体組成",
    protein: "Protein",
    injections: "注射",
    injection_schedule: "注射の定例スケジュール変更",
    conditions: "体調・副作用",
    cycles: "月経",
    export_info: "書き出し情報",
  },

  _weightRecords(state) {
    return (state.dailyRecords || []).filter((r) => r && typeof r.weight === "number").slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  },
  buildWeight(state) {
    const headers = ["日付", "体重_kg", "BMI_アプリ計算", "メモ"];
    const rows = this._weightRecords(state).map((r) => [r.date, r.weight, this._round1(Calc.bmi(r.weight, state.profile && state.profile.heightCm)), r.comment || ""]);
    return { headers, rows };
  },

  _compositionRecords(state) {
    return (state.dailyRecords || [])
      .filter((r) => r && r.bodyComposition && typeof r.bodyComposition === "object" && Object.values(r.bodyComposition).some((v) => v !== null && v !== undefined))
      .slice()
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  },
  // 体組成の項目名（列ヘッダー）。COMPOSITION_FIELDS から機械的に作る（手書きしない）
  _compositionHeader(f) {
    if (f.key === "measuredWeight") return "測定体重_kg"; // dailyRecords.weight（weight.csvの体重）と別物だと分かる名前にする
    if (f.key === "bodyAge") return "体内年齢_歳";
    if (f.type === "string") return f.label;
    const unitSuffix = { kg: "_kg", "%": "_percent", bpm: "_bpm", kcal: "_kcal" }[f.unit] || "";
    return `${f.label}${unitSuffix}`;
  },
  buildBodyComposition(state) {
    const fields = typeof COMPOSITION_FIELDS !== "undefined" ? COMPOSITION_FIELDS : [];
    const headers = ["日付", "測定時刻", ...fields.map((f) => this._compositionHeader(f)), "メモ", "2回分混在", "取込日時", "更新日時"];
    const rows = this._compositionRecords(state).map((r) => {
      const meta = r.compositionMeta || null;
      const bc = r.bodyComposition || {};
      return [
        r.date,
        meta ? meta.measuredTime : null,
        ...fields.map((f) => (bc[f.key] === undefined ? null : bc[f.key])),
        r.comment || "", // 体重の無い日にも付きうるメモを、ここで欠落させない
        meta && meta.mixed ? "はい" : "",
        meta ? this._localTs(meta.importedAt) : null,
        meta ? this._localTs(meta.updatedAt) : null,
      ];
    });
    return { headers, rows };
  },

  _PROTEIN_TYPE_LABEL: { whey: "ホエイ", food: "食品", meal: "食事" },
  buildProtein(state) {
    const headers = ["ID", "日付", "時刻", "種別", "名称", "数量", "数量単位（現在の登録）", "基準量あたりg", "標準スプーン数", "タンパク質_g", "メモ", "記録日時"];
    const foods = new Map((state.registeredFoods || []).map((f) => [f.id, f]));
    const rows = (state.proteinEntries || [])
      .slice()
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.time < b.time ? -1 : a.time > b.time ? 1 : (a.id || 0) - (b.id || 0)))
      .map((e) => {
        let unit = "";
        if (e.sourceType === "whey") unit = "スプーン";
        else if (e.sourceType === "food") {
          const f = foods.get(e.sourceId);
          unit = f ? f.unit : "";
        }
        return [
          e.id,
          e.date,
          e.time || null,
          this._PROTEIN_TYPE_LABEL[e.sourceType] || e.sourceType || "",
          e.sourceName || "",
          e.quantity === undefined ? null : e.quantity,
          unit,
          e.unitProtein === undefined ? null : e.unitProtein,
          e.servingScoops === undefined ? null : e.servingScoops,
          e.proteinTotal === undefined ? null : e.proteinTotal,
          e.memo || "",
          this._localTs(e.createdAt),
        ];
      });
    return { headers, rows };
  },

  _INJ_STATUS_LABEL: { scheduled: "予定", administered: "投与済み", skipped: "見送り" },
  _INJ_KIND_LABEL: { regular: "定例", oneOffChange: "その回だけ変更", makeup: "臨時投与", manual: "手動", legacy: "旧データ" },
  _INJ_SKIP_LABEL: { missedUnder72h: "72時間未満のため見送り", missedUnknown: "判定不能のため見送り", userChoice: "本人の判断で見送り" },
  _INJ_CHECK_LABEL: { ge72: "72時間以上", lt72: "72時間未満", unknown: "判定できません", noHistory: "それまでの記録なし" },
  // 「在庫の扱い」。js/injection-logic.js の stockSummary（used = administered かつ stockCount が review/excluded 以外）と必ず一致させる
  _stockHandling(r) {
    if (r.status !== "administered") return "";
    if (r.stockCount === "excluded") return "数えない";
    if (r.stockCount === "review") return "確認待ち";
    return "数える"; // null・"counts"・未知の値は、stockSummaryと同じく「数える」側に倒す
  },
  buildInjections(state) {
    const headers = [
      "ID", "状態", "種別", "集計対象（投与済みのみ）", "定例日", "予定日", "予定時刻", "実施日", "実施時刻",
      "用量_mg", "用量を確認", "見送り理由", "72時間判定", "在庫の扱い", "在庫算入", "メモ", "作成日時", "更新日時",
    ];
    const rows = (state.injections || [])
      .slice()
      .sort((a, b) => {
        const ka = [a.administeredAt || a.scheduledAt || a.regularDate || "", a.administeredTime || a.scheduledTime || "", typeof a.id === "number" ? a.id : 0];
        const kb = [b.administeredAt || b.scheduledAt || b.regularDate || "", b.administeredTime || b.scheduledTime || "", typeof b.id === "number" ? b.id : 0];
        for (let i = 0; i < 3; i++) {
          if (ka[i] < kb[i]) return -1;
          if (ka[i] > kb[i]) return 1;
        }
        return 0;
      })
      .map((r) => {
        const handling = this._stockHandling(r);
        return [
          r.id,
          this._INJ_STATUS_LABEL[r.status] || r.status || "",
          this._INJ_KIND_LABEL[r.kind] || r.kind || "",
          r.status === "administered" ? "投与済み" : "",
          r.regularDate || null,
          r.scheduledAt || null,
          r.scheduledTime || null,
          r.administeredAt || null,
          r.administeredTime || null,
          r.dose === undefined ? null : r.dose,
          r.doseConfirmedDifferent ? "はい" : "",
          r.skipReason ? this._INJ_SKIP_LABEL[r.skipReason] || r.skipReason : "",
          r.missedCheck && r.missedCheck.result ? this._INJ_CHECK_LABEL[r.missedCheck.result] || r.missedCheck.result : "",
          handling,
          handling === "数える" ? 1 : "",
          r.comment || "",
          this._localTs(r.createdAt),
          this._localTs(r.updatedAt),
        ];
      });
    return { headers, rows };
  },

  _SCHEDULE_TYPE_LABEL: { set: "設定", weekdayChange: "曜日変更", timeChange: "時刻変更", clear: "解除" },
  buildInjectionSchedule(state) {
    const headers = [
      "変更ID", "変更日時", "種別",
      "変更前_曜日(0=日)", "変更前_時刻", "変更前_適用開始日",
      "変更後_曜日(0=日)", "変更後_時刻", "変更後_適用開始日",
      "72時間判定", "置き換えた予定ID",
    ];
    const sch = (state.injectionSchedule && state.injectionSchedule.history) || [];
    const rows = sch.map((h) => [
      h.id,
      this._localTs(h.changedAt),
      this._SCHEDULE_TYPE_LABEL[h.type] || h.type || "",
      h.from ? h.from.weekday : null,
      h.from ? h.from.time : null,
      h.from && h.from.effectiveFrom ? h.from.effectiveFrom : null, // from に適用開始日は記録されないため、常に空欄になる
      h.to ? h.to.weekday : null,
      h.to ? h.to.time : null,
      h.to && h.to.effectiveFrom ? h.to.effectiveFrom : null,
      h.check && h.check.result ? this._INJ_CHECK_LABEL[h.check.result] || h.check.result : "",
      h.replacedScheduledId === undefined ? null : h.replacedScheduledId,
    ]);
    return { headers, rows };
  },

  buildConditions(state) {
    const F = typeof CONDITION_SYMPTOMS !== "undefined" ? CONDITION_SYMPTOMS : [];
    const headers = ["ID", "日付", "時刻", "段階", "保存値", ...F.map((s) => s.label), "症状一覧", "メモ", "記録日時"];
    const CL = typeof ConditionLogic !== "undefined" ? ConditionLogic : null;
    const rows = (state.conditionEntries || [])
      .slice()
      .sort((a, b) => (typeof a.id === "number" && typeof b.id === "number" ? a.id - b.id : a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      .map((e) => {
        const syms = Array.isArray(e.symptoms) ? e.symptoms : [];
        const display = CL ? CL.displayLevel(e.level) : e.level;
        const label = display === null || display === undefined ? "" : CL ? CL.levelLabel(e.level) : display;
        return [
          e.id,
          e.date,
          e.time || null,
          label,
          e.level === undefined ? null : e.level,
          ...F.map((s) => (syms.includes(s.id) ? 1 : "")),
          syms.map((id) => (F.find((s) => s.id === id) || { label: id }).label).join("・"),
          e.comment || "",
          this._localTs(e.createdAt),
        ];
      });
    return { headers, rows };
  },

  buildCycles(state) {
    const headers = ["ID", "開始日", "終了日", "日数", "メモ", "記録日時", "更新日時"];
    const CL = typeof CycleLogic !== "undefined" ? CycleLogic : null;
    const rows = (state.cycleEntries || [])
      .slice()
      .sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : (a.id || 0) - (b.id || 0)))
      .map((e) => {
        const days = e.endDate && CL ? CL._diffDays(e.startDate, e.endDate) + 1 : null;
        return [e.id, e.startDate, e.endDate || null, days, e.comment || "", this._localTs(e.createdAt), this._localTs(e.updatedAt)];
      });
    return { headers, rows };
  },

  buildExportInfo(state, now = new Date()) {
    const weight = this._weightRecords(state);
    const comp = this._compositionRecords(state);
    const injections = state.injections || [];
    const byStatus = { scheduled: 0, administered: 0, skipped: 0 };
    for (const r of injections) if (byStatus[r.status] !== undefined) byStatus[r.status] += 1;
    let counts = 0;
    let excluded = 0;
    let review = 0;
    for (const r of injections) {
      if (r.status !== "administered") continue;
      const h = this._stockHandling(r);
      if (h === "数える") counts += 1;
      else if (h === "数えない") excluded += 1;
      else if (h === "確認待ち") review += 1;
    }
    const administeredNoDate = injections.filter((r) => r.status === "administered" && !r.administeredAt).length;
    const initial = state.injectionStock ? state.injectionStock.initialPens : null;
    const remaining = initial === null ? null : initial - counts;
    const reg = state.injectionSchedule && state.injectionSchedule.regular;
    const headers = ["項目", "値"];
    const rows = [
      ["書き出し日時", this._localTs(now.toISOString())],
      ["タイムゾーン（この書き出しの基準）", `UTC${this._tzOffsetLabel(now)}`],
      ["schemaVersion", state.schemaVersion === undefined ? null : state.schemaVersion],
      ["weight 件数（体重のある日）", weight.length],
      ["body_composition 件数（体組成のある日）", comp.length],
      ["protein 件数", (state.proteinEntries || []).length],
      ["injections 件数（全件）", injections.length],
      ["injections 内訳_予定", byStatus.scheduled],
      ["injections 内訳_投与済み", byStatus.administered],
      ["injections 内訳_見送り", byStatus.skipped],
      ["injections 投与済みのうち実施日なし（旧データ）", administeredNoDate],
      ["conditions 件数", (state.conditionEntries || []).length],
      ["cycles 件数", (state.cycleEntries || []).length],
      ["身長_cm", state.profile ? state.profile.heightCm : null],
      ["在庫_初期本数", initial],
      ["在庫_数える本数", counts],
      ["在庫_数えない本数", excluded],
      ["在庫_確認待ち本数", review],
      ["在庫_残り本数", remaining],
      ["定例_曜日(0=日)", reg ? reg.weekday : null],
      ["定例_時刻", reg ? reg.time : null],
      ["定例_適用開始日", reg ? reg.effectiveFrom : null],
      ["用量基準_mg", state.injectionSchedule ? state.injectionSchedule.baseDoseMg : null],
      ["注記", "体調の症状7列は「選択されていない」ことを示すだけで、「症状が無いことを確認した」ことは意味しません（HOMEからの記録は症状を選べません）。"],
      ["注記", "Protein『基準量あたりg』は、ホエイでは標準スプーン数（別列）に対しての量です。1スプーンあたりではありません。"],
      ["注記", "Protein『数量単位（現在の登録）』は書き出し時点の登録名です。記録当時の表記とは異なる場合があります。"],
      ["注記", "このCSVは分析用です。この内容からアプリへ復元する機能はありません。復元にはJSONバックアップを使ってください。"],
    ];
    return { headers, rows };
  },

  // 全シート（exportInfo込み）を {sheet, labelJa, headers, rows} の配列で返す
  buildAll(state, now = new Date()) {
    const w = this.buildWeight(state);
    const c = this.buildBodyComposition(state);
    const p = this.buildProtein(state);
    const i = this.buildInjections(state);
    const s = this.buildInjectionSchedule(state);
    const cd = this.buildConditions(state);
    const cy = this.buildCycles(state);
    const info = this.buildExportInfo(state, now);
    return [
      { sheet: "weight", ...w },
      { sheet: "body_composition", ...c },
      { sheet: "protein", ...p },
      { sheet: "injections", ...i },
      { sheet: "injection_schedule", ...s },
      { sheet: "conditions", ...cd },
      { sheet: "cycles", ...cy },
      { sheet: "export_info", ...info },
    ];
  },

  // {sheet, headers, rows} → {sheet, fileName, text}
  toFile(def, now = new Date()) {
    return { sheet: def.sheet, labelJa: this.SHEET_LABELS[def.sheet] || def.sheet, fileName: this.fileName(def.sheet, now), text: this.build(def.headers, def.rows) };
  },
};
