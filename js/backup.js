// Body Garden — JSONバックアップ（書き出し・読み込み検証・復元・ロールバック）
// DOMには触れない。localStorage操作と検証だけを担当する（UIは ui-backup.js）。
//
// 方針
//  - 外部ファイルへの書き出しが主。localStorage内の退避（preRestore）は補助。
//  - 読み込みは localStorage に触れる前にすべて検証する。1つでも失敗したら何も変えない。
//  - 現在より新しい schemaVersion のファイルは拒否する。古い版は strict な移行を通す。
//  - 取り込むデータは innerHTML に入る経路があるため、日付・時刻・id・列挙値は厳密な書式で検証する。

const Backup = {
  APP_ID: "body-garden",
  KIND: "full-backup",
  FORMAT_VERSION: 1,
  MAX_BYTES: 5 * 1024 * 1024,
  MAX_ITEMS: 20000,
  // 文字数の上限は「巨大入力の抑止」が目的。通常の入力欄（maxlengthなし）で作れるデータを拒否しないよう緩くしてある
  LIMITS: { name: 500, unit: 100, text: 5000 },
  PRE_RESTORE_KEY: `${STORAGE_KEY}.preRestore`, // 値は退避した生データそのもの
  PRE_RESTORE_AT_KEY: `${STORAGE_KEY}.preRestoreAt`, // 退避した日時（ISO）
  META_LAST_BACKUP_KEY: "bodyGarden.meta.lastBackupAt", // state外に置く（バックアップ自身に含めない）
  COUNT_KEYS: ["dailyRecords", "proteinEntries", "conditionEntries", "injections", "proteinProducts", "registeredFoods"],
  KNOWN_TOP_KEYS: [
    "schemaVersion", "profile", "goals", "dailyRecords", "proteinEntries", "conditionEntries",
    "guardrails", "injections", "injectionSchedule", "injectionStock", "proteinProducts", "registeredFoods", "ui",
  ],
  SCREENS: ["home", "records", "injection", "composition", "settings"],

  // ============ 書き出し ============

  counts(state) {
    const out = {};
    for (const k of this.COUNT_KEYS) out[k] = Array.isArray(state[k]) ? state[k].length : 0;
    return out;
  },

  // 生データ（新しい版のデータの書き出し等）を、将来のアプリが読める包みに入れる。中身は検証しない
  wrapRaw(raw, now = new Date()) {
    let state;
    try {
      state = JSON.parse(raw);
    } catch (_) {
      return raw;
    }
    if (!this._isObj(state) || !Number.isInteger(state.schemaVersion)) return raw;
    return JSON.stringify(this.buildEnvelope(state, now), null, 2);
  },

  buildEnvelope(state, now = new Date()) {
    return {
      app: this.APP_ID,
      kind: this.KIND,
      formatVersion: this.FORMAT_VERSION,
      schemaVersion: state.schemaVersion,
      exportedAt: now.toISOString(),
      counts: this.counts(state),
      state,
    };
  },

  fileName(now = new Date()) {
    const p = (n) => String(n).padStart(2, "0");
    return `body-garden-backup-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.json`;
  },

  serialize(state, now = new Date()) {
    return JSON.stringify(this.buildEnvelope(state, now), null, 2);
  },

  getLastBackupAt() {
    try {
      return localStorage.getItem(this.META_LAST_BACKUP_KEY);
    } catch (_) {
      return null;
    }
  },

  setLastBackupAt(iso) {
    try {
      localStorage.setItem(this.META_LAST_BACKUP_KEY, iso);
    } catch (_) {
      // 記録できなくてもバックアップ自体は有効
    }
  },

  // 書き出す内容を、復元時と同じ検証にかけてみる。通らないデータは、書き出せても復元できない。
  selfCheck(json) {
    const r = this.parse(json, null);
    return r.ok ? { ok: true } : { ok: false, message: r.message, details: r.details || [] };
  },

  // ファイルとして書き出す。iOS等ではファイルを共有シートへ、それ以外はダウンロード。
  // 戻り値: { ok, method: "share"|"download", cancelled?, fileName, selfCheck }
  async exportFile(state) {
    const now = new Date();
    const json = this.serialize(state, now);
    const fileName = this.fileName(now);
    const selfCheck = this.selfCheck(json);

    const ua = navigator.userAgent || "";
    const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (isIOS && typeof File === "function" && navigator.canShare && navigator.share) {
      try {
        const file = new File([json], fileName, { type: "application/json" });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: "Body Garden バックアップ" });
          this.setLastBackupAt(now.toISOString());
          return { ok: true, method: "share", fileName, selfCheck };
        }
      } catch (e) {
        if (e && e.name === "AbortError") return { ok: false, cancelled: true, method: "share", fileName, selfCheck };
        // 共有に失敗したらダウンロードへ進む
      }
    }

    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    this.setLastBackupAt(now.toISOString());
    return { ok: true, method: "download", fileName, selfCheck };
  },

  // ============ 読み込み検証 ============
  // parse() は localStorage に一切触れない。成功すると取り込み候補の state（変換済みの複製）を返す。
  // 戻り値: { ok:true, state, envelope, summary, warnings } | { ok:false, code, message, details }

  parse(text, currentState) {
    const fail = (code, message, details) => ({ ok: false, code, message, details: details || [] });

    if (typeof text !== "string" || text.trim() === "") {
      return fail("EMPTY", "ファイルが空です。");
    }
    // 1文字は1バイト以上なので、文字数だけで上限を超える入力は、全量をコピーせずに弾く
    if (text.length > this.MAX_BYTES) {
      return fail("TOO_LARGE", "ファイルが大きすぎます（上限5MB）。Body Gardenのバックアップではない可能性があります。");
    }
    // 文字数ではなくUTF-8バイト数で上限を判定する
    const bytes = typeof TextEncoder === "function" ? new TextEncoder().encode(text).length : text.length;
    if (bytes > this.MAX_BYTES) {
      return fail("TOO_LARGE", "ファイルが大きすぎます（上限5MB）。Body Gardenのバックアップではない可能性があります。");
    }

    let env;
    try {
      env = JSON.parse(text);
    } catch (_) {
      return fail("NOT_JSON", "JSONとして読み込めませんでした。ファイルが壊れているか、別の形式です。");
    }

    if (!this._isObj(env) || env.app !== this.APP_ID || env.kind !== this.KIND || !this._isObj(env.state)) {
      return fail("NOT_BODY_GARDEN", "Body Gardenのバックアップファイルではありません。");
    }
    if (env.formatVersion !== this.FORMAT_VERSION) {
      return fail("UNSUPPORTED_FORMAT", "このバックアップの形式（formatVersion）には対応していません。");
    }

    const fileVersion = env.state.schemaVersion;
    if (!Number.isInteger(fileVersion) || fileVersion < 1) {
      return fail("INVALID_SCHEMA_VERSION", "データの版（schemaVersion）が正しくありません。");
    }
    if (env.schemaVersion !== fileVersion) {
      return fail("INVALID_SCHEMA_VERSION", "ファイル情報とデータの版（schemaVersion）が一致しません。");
    }
    if (fileVersion > SCHEMA_VERSION) {
      return fail(
        "NEWER_SCHEMA",
        `新しいバージョンのアプリ（データ形式 v${fileVersion}）で作成されたファイルです。このアプリ（v${SCHEMA_VERSION}）では読み込めません。アプリを更新してから読み込んでください。`
      );
    }

    // 件数の整合（ファイルの一部が欠けた・書き換えられたことの検出）。移行前のデータで比較する。
    if (!this._isObj(env.counts)) {
      return fail("INVALID_STRUCTURE", "ファイルの件数情報（counts）がありません。");
    }
    const actual = this.counts(env.state);
    const mismatches = [];
    for (const k of this.COUNT_KEYS) {
      if (env.counts[k] !== actual[k]) mismatches.push(`${k}: 記載 ${env.counts[k]} 件／実際 ${actual[k]} 件`);
    }
    if (mismatches.length > 0) {
      return fail("INTEGRITY", "件数がファイル情報と一致しません。ファイルが欠けているか、書き換えられています。", mismatches);
    }

    // 移行は複製に対して行う（元のオブジェクトは変えない）
    let candidate;
    try {
      candidate = Storage.migrate(JSON.parse(JSON.stringify(env.state)), { strict: true });
    } catch (e) {
      return fail("MIGRATION_FAILED", "古い形式のデータを現在の形式へ変換できませんでした。", [String(e && e.message)]);
    }

    const warnings = [];
    // 在庫の設定が無いバックアップ（開発中の形式）は、初期値を入れる。既存の投与済みの記録は削除せず、
    // 実記録かテスト用か判別できないので「要確認」にする（24本から自動で差し引かない）
    if (this._isObj(candidate) && candidate.schemaVersion === SCHEMA_VERSION) {
      if (!candidate.injectionSchedule && typeof createDefaultInjectionSchedule === "function") candidate.injectionSchedule = createDefaultInjectionSchedule();
      if (!candidate.injectionStock && typeof applyStockBaseline === "function") {
        applyStockBaseline(candidate);
        warnings.push("在庫（残本数）の設定がないため、初期値を入れました。既存の投与記録は、使用本数に含めるかどうかの確認が必要な状態にしています。");
      }
    }
    // 古い形式（v4など）の移行で、在庫の確認待ちの記録ができたときも、取り込む前に知らせる
    if (this._isObj(candidate) && Array.isArray(candidate.injections) && fileVersion < SCHEMA_VERSION) {
      const n = candidate.injections.filter((r) => r && r.status === "administered" && r.stockCount === "review").length;
      if (n > 0) warnings.push(`投与済みの記録が${n}件あります。在庫（残本数）への数え方は、取り込み後に本人が確認する状態（要確認）になります。`);
    }
    // 未知の最上位キーは取り込まない
    for (const k of Object.keys(candidate)) {
      if (!this.KNOWN_TOP_KEYS.includes(k)) {
        delete candidate[k];
        warnings.push(`未知の項目「${String(k).slice(0, 40)}」は取り込みません。`);
      }
    }

    const result = this.validateState(candidate);
    warnings.push(...result.warnings);
    if (result.errors.length > 0) {
      return fail("INVALID_STRUCTURE", "データの内容に問題があるため読み込めません。", result.errors.slice(0, 5).concat(result.errors.length > 5 ? [`ほか ${result.errors.length - 5} 件`] : []));
    }

    if (candidate.schemaVersion !== SCHEMA_VERSION) {
      return fail("MIGRATION_FAILED", "変換後のデータの版が現在の版と一致しません。");
    }

    return {
      ok: true,
      state: candidate,
      envelope: { exportedAt: env.exportedAt, schemaVersion: fileVersion, counts: env.counts },
      summary: this.summarize(candidate, currentState, fileVersion),
      warnings,
    };
  },

  // 体組成が1項目でも入っている日の数（確認画面の表示用）
  _compositionDays(state) {
    return (Array.isArray(state.dailyRecords) ? state.dailyRecords : []).filter(
      (r) => r && r.bodyComposition && typeof r.bodyComposition === "object" && Object.values(r.bodyComposition).some((v) => v !== null && v !== undefined)
    ).length;
  },

  summarize(candidate, currentState, fileVersion) {
    const dates = (candidate.dailyRecords || []).map((r) => r.date).sort();
    return {
      fileVersion,
      currentVersion: SCHEMA_VERSION,
      migrated: fileVersion !== SCHEMA_VERSION,
      incoming: this.counts(candidate),
      current: currentState ? this.counts(currentState) : null,
      compositionDays: { incoming: this._compositionDays(candidate), current: currentState ? this._compositionDays(currentState) : null },
      range: dates.length > 0 ? { from: dates[0], to: dates[dates.length - 1] } : null,
    };
  },

  // ---- 構造・書式の検証 ----
  validateState(s) {
    const errors = [];
    const warnings = [];
    const err = (m) => errors.push(m);
    const warn = (m) => warnings.push(m);
    const isObj = (v) => this._isObj(v);
    const num = (v) => typeof v === "number" && Number.isFinite(v);
    const numOrNull = (v) => v === null || num(v);
    const str = (v, max) => typeof v === "string" && v.length <= max;
    const strOrNull = (v, max) => v === null || str(v, max);
    const date = (v) => this._isRealISODate(v);
    const dateOrNull = (v) => v === null || date(v);
    const time = (v) => v === null || (typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v));
    const id = (v) => (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v));
    // 記録・履歴のidはアプリが連番で振る正の整数。編集・削除が parseInt で動くため、それ以外は拒否する
    const intId = (v) => Number.isSafeInteger(v) && v > 0;
    const ts = (v) => typeof v === "string" && v.length <= 40 && /^[0-9TZ:.+-]+$/.test(v);
    const tsOrNull = (v) => v === null || ts(v);
    const oneOf = (v, list) => list.includes(v);

    if (!isObj(s)) return { errors: ["データがオブジェクトではありません"], warnings };

    // profile
    if (!isObj(s.profile)) {
      err("profile がありません");
    } else {
      const p = s.profile;
      for (const k of ["heightCm", "startWeight", "proteinTarget", "bmiMaintenanceAlert", "bmiLowerLine"]) {
        if (!num(p[k])) err(`profile.${k} が数値ではありません`);
      }
      if (num(p.heightCm) && p.heightCm <= 0) err("profile.heightCm は0より大きい数値が必要です");
      if (num(p.startWeight) && p.startWeight <= 0) err("profile.startWeight は0より大きい数値が必要です");
      if (!dateOrNull(p.startDate === undefined ? null : p.startDate)) err("profile.startDate が日付(YYYY-MM-DD)ではありません");
      const R = typeof VALIDATION_RANGES !== "undefined" ? VALIDATION_RANGES : null;
      if (R && num(p.heightCm) && (p.heightCm < R.heightCm.min || p.heightCm > R.heightCm.max)) warn("身長が通常の範囲外です");
      if (R && num(p.startWeight) && (p.startWeight < R.weightKg.min || p.startWeight > R.weightKg.max)) warn("開始体重が通常の範囲外です");
    }

    // goals
    if (!isObj(s.goals)) {
      err("goals がありません");
    } else {
      const g = s.goals;
      const checkGoal = (goal, name, required) => {
        if (goal === null || goal === undefined) {
          if (required) err(`goals.${name} がありません`);
          return;
        }
        if (!isObj(goal)) return err(`goals.${name} がオブジェクトではありません`);
        if (!oneOf(goal.type, ["weight", "bmi"])) err(`goals.${name}.type が不正です`);
        if (!num(goal.value)) err(`goals.${name}.value が数値ではありません`);
        if (!dateOrNull(goal.achievedAt === undefined ? null : goal.achievedAt)) err(`goals.${name}.achievedAt が日付ではありません`);
        const c = goal.postAchievementChoice === undefined ? null : goal.postAchievementChoice;
        if (!(c === null || oneOf(c, ["nextGoal", "maintain"]))) err(`goals.${name}.postAchievementChoice が不正です`);
      };
      checkGoal(g.goal1, "goal1", true);
      checkGoal(g.goal2, "goal2", false);
      if (!oneOf(g.activeGoal, [1, 2])) err("goals.activeGoal が不正です");
      if (g.activeGoal === 2 && !g.goal2) err("goals.activeGoal が2ですが goal2 がありません");
      if (!oneOf(g.mode, ["reduction", "maintenancePrep", "maintenance"])) err("goals.mode が不正です");
      const mr = g.maintenanceReason === undefined ? null : g.maintenanceReason;
      if (!(mr === null || oneOf(mr, ["goalChoice", "bmi21", "bmi20"]))) err("goals.maintenanceReason が不正です");
      if (!Array.isArray(g.goalHistory)) {
        err("goals.goalHistory が配列ではありません");
      } else {
        if (g.goalHistory.length > this.MAX_ITEMS) err("goalHistory の件数が多すぎます");
        const seen = new Set();
        g.goalHistory.forEach((h, i) => {
          if (!isObj(h)) return err(`goalHistory[${i}] がオブジェクトではありません`);
          if (!intId(h.id)) err(`goalHistory[${i}].id が不正です`);
          else if (seen.has(h.id)) err(`goalHistory[${i}].id が重複しています`);
          else seen.add(h.id);
          if (!ts(h.timestamp)) err(`goalHistory[${i}].timestamp が不正です`);
          if (h.goalKey !== undefined && !oneOf(h.goalKey, ["goal1", "goal2"])) err(`goalHistory[${i}].goalKey が不正です`);
          if (!oneOf(h.type, ["achieved", "choiceMade", "edited"])) err(`goalHistory[${i}].type が不正です`);
        });
      }
    }

    // 配列の共通チェック（件数上限・id重複）
    const list = (name) => {
      const arr = s[name];
      if (!Array.isArray(arr)) {
        err(`${name} が配列ではありません`);
        return [];
      }
      if (arr.length > this.MAX_ITEMS) {
        err(`${name} の件数が多すぎます（${arr.length}件）`);
        return [];
      }
      return arr;
    };
    const uniqueIds = (name, arr, intOnly) => {
      const seen = new Set();
      arr.forEach((e, i) => {
        if (!isObj(e)) return err(`${name}[${i}] がオブジェクトではありません`);
        if (!(intOnly ? intId(e.id) : id(e.id))) return err(`${name}[${i}].id が不正です`);
        const k = String(e.id);
        if (seen.has(k)) err(`${name}[${i}].id が重複しています`);
        seen.add(k);
      });
    };

    // dailyRecords
    const compositionByKey = typeof COMPOSITION_FIELDS !== "undefined" ? Object.fromEntries(COMPOSITION_FIELDS.map((f) => [f.key, f])) : {};
    const daily = list("dailyRecords");
    const dates = new Set();
    daily.forEach((r, i) => {
      if (!isObj(r)) return err(`dailyRecords[${i}] がオブジェクトではありません`);
      if (!date(r.date)) err(`dailyRecords[${i}].date が日付(YYYY-MM-DD)ではありません`);
      else if (dates.has(r.date)) err(`dailyRecords[${i}].date が重複しています（${r.date}）`);
      else dates.add(r.date);
      if (date(r.date) && typeof todayISODate === "function" && r.date > todayISODate()) warn(`dailyRecords[${i}] が未来の日付です（${r.date}）`);
      if (!numOrNull(r.weight === undefined ? null : r.weight)) err(`dailyRecords[${i}].weight が数値ではありません`);
      else if (num(r.weight) && typeof VALIDATION_RANGES !== "undefined" && (r.weight < VALIDATION_RANGES.weightKg.min || r.weight > VALIDATION_RANGES.weightKg.max)) {
        warn(`dailyRecords[${i}] の体重が通常の範囲外です（${r.date}）`);
      }
      if (r.comment !== undefined && !str(r.comment, this.LIMITS.text)) err(`dailyRecords[${i}].comment が不正です`);
      if (r.bodyComposition !== undefined) {
        if (!isObj(r.bodyComposition)) {
          err(`dailyRecords[${i}].bodyComposition が不正です`);
        } else {
          for (const [k, v] of Object.entries(r.bodyComposition)) {
            const f = compositionByKey[k];
            const where = `dailyRecords[${i}].bodyComposition.${String(k).slice(0, 30)}`;
            if (f && f.type === "string") {
              // ボディタイプ: 文字列（20字以内。制御文字・HTML用の文字・先頭の = + - @ は不可）
              if (!(v === null || (typeof isValidBodyType === "function" && isValidBodyType(v)))) err(`${where} が不正です`);
            } else if (!numOrNull(v)) {
              err(`${where} が数値ではありません`);
            } else if (f && num(v) && f.hard && (v < f.hard[0] || v > f.hard[1])) {
              warn(`${where} が通常あり得る範囲外です（${r.date}）`); // 取り込みは止めず、警告にとどめる
            }
          }
        }
      }
      // compositionMeta: 一括貼り付けで取り込んだ記録のメモ（新設のため、知らない項目は拒否する）
      if (r.compositionMeta !== undefined && r.compositionMeta !== null) {
        const mt = r.compositionMeta;
        const mp = `dailyRecords[${i}].compositionMeta`;
        if (!isObj(mt)) {
          err(`${mp} が不正です`);
        } else {
          for (const k of Object.keys(mt)) if (!["measuredTime", "source", "formatVersion", "importedAt", "updatedAt", "mixed"].includes(k)) err(`${mp} に未知の項目があります`);
          if (!time(mt.measuredTime === undefined ? null : mt.measuredTime)) err(`${mp}.measuredTime が時刻(HH:MM)ではありません`);
          if (!oneOf(mt.source, ["paste"])) err(`${mp}.source が不正です`);
          if (!(Number.isInteger(mt.formatVersion) && mt.formatVersion >= 1 && mt.formatVersion <= 99)) err(`${mp}.formatVersion が不正です`);
          if (!ts(mt.importedAt) || !ts(mt.updatedAt)) err(`${mp} の日時が不正です`);
          if (typeof mt.mixed !== "boolean") err(`${mp}.mixed が真偽値ではありません`);
        }
      }
    });

    // proteinEntries
    const pe = list("proteinEntries");
    uniqueIds("proteinEntries", pe, true);
    pe.forEach((e, i) => {
      if (!isObj(e)) return;
      if (!date(e.date)) err(`proteinEntries[${i}].date が日付ではありません`);
      if (!time(e.time === undefined ? null : e.time)) err(`proteinEntries[${i}].time が時刻(HH:MM)ではありません`);
      if (!oneOf(e.sourceType, ["whey", "food", "meal"])) err(`proteinEntries[${i}].sourceType が不正です`);
      if (!(e.sourceId === null || e.sourceId === undefined || id(e.sourceId))) err(`proteinEntries[${i}].sourceId が不正です`);
      if (!strOrNull(e.sourceName === undefined ? null : e.sourceName, this.LIMITS.name)) err(`proteinEntries[${i}].sourceName が不正です`);
      for (const k of ["quantity", "unitProtein", "servingScoops"]) {
        if (!numOrNull(e[k] === undefined ? null : e[k])) err(`proteinEntries[${i}].${k} が数値ではありません`);
      }
      if (!num(e.proteinTotal)) err(`proteinEntries[${i}].proteinTotal が数値ではありません`);
      if (!strOrNull(e.memo === undefined ? null : e.memo, this.LIMITS.text)) err(`proteinEntries[${i}].memo が不正です`);
      if (e.createdAt !== undefined && !ts(e.createdAt)) err(`proteinEntries[${i}].createdAt が不正です`);
    });

    // conditionEntries
    const ce = list("conditionEntries");
    uniqueIds("conditionEntries", ce, true);
    // data.js の createConditionEntry のコメントにある症状ID（未知のIDは拒否せず警告のみ）
    const knownSymptoms = ["nausea", "indigestion", "constipation", "diarrhea", "abdominalPain", "appetiteLoss", "other"];
    ce.forEach((e, i) => {
      if (!isObj(e)) return;
      if (!date(e.date)) err(`conditionEntries[${i}].date が日付ではありません`);
      if (!time(e.time === undefined ? null : e.time)) err(`conditionEntries[${i}].time が時刻(HH:MM)ではありません`);
      const lv = e.level === undefined ? null : e.level;
      if (!(lv === null || oneOf(lv, ["none", "mild", "moderate", "severe"]))) err(`conditionEntries[${i}].level が不正です`);
      if (!Array.isArray(e.symptoms)) {
        err(`conditionEntries[${i}].symptoms が配列ではありません`);
      } else if (e.symptoms.length > 30 || !e.symptoms.every((x) => typeof x === "string" && /^[A-Za-z0-9_]{1,32}$/.test(x))) {
        err(`conditionEntries[${i}].symptoms の値が不正です`);
      } else if (knownSymptoms && !e.symptoms.every((x) => knownSymptoms.includes(x))) {
        warn(`conditionEntries[${i}] に未知の症状IDがあります`);
      }
      if (e.comment !== undefined && !str(e.comment, this.LIMITS.text)) err(`conditionEntries[${i}].comment が不正です`);
      if (e.createdAt !== undefined && !ts(e.createdAt)) err(`conditionEntries[${i}].createdAt が不正です`);
    });

    // guardrails
    if (!isObj(s.guardrails) || !isObj(s.guardrails.bmi21) || !isObj(s.guardrails.bmi20)) {
      err("guardrails の構造が不正です");
    } else {
      if (!dateOrNull(s.guardrails.bmi21.acknowledgedForDate === undefined ? null : s.guardrails.bmi21.acknowledgedForDate)) err("guardrails.bmi21.acknowledgedForDate が日付ではありません");
      if (!tsOrNull(s.guardrails.bmi20.acknowledgedAt === undefined ? null : s.guardrails.bmi20.acknowledgedAt)) err("guardrails.bmi20.acknowledgedAt が不正です");
    }

    // injections（v5）。形式を変えるときは、この検証とテストを同じ変更で更新すること
    const doseOptions = typeof INJECTION_DOSE_OPTIONS_MG !== "undefined" ? INJECTION_DOSE_OPTIONS_MG : null;
    const inj = list("injections");
    uniqueIds("injections", inj, true);
    const nullable = (v) => (v === undefined ? null : v);
    const checkSnapshotCheck = (c, where) => {
      // 72時間判定のスナップショット（missedCheck / history[].check）。表示用の値なので、型と範囲だけを確認する
      if (c === null || c === undefined) return;
      if (!isObj(c)) return err(`${where} が不正です`);
      if (c.result !== undefined && !oneOf(c.result, ["ge72", "lt72", "unknown", "noHistory"])) err(`${where}.result が不正です`);
      for (const k of ["minMs", "maxMs"]) if (c[k] !== undefined && !numOrNull(c[k])) err(`${where}.${k} が数値ではありません`);
      for (const k of ["firstDate", "target"]) if (c[k] !== undefined && !dateOrNull(c[k])) err(`${where}.${k} が日付ではありません`);
      for (const k of ["lastAdministered", "next", "now"]) {
        if (c[k] === undefined || c[k] === null) continue;
        if (!isObj(c[k]) || !date(c[k].date) || !(c[k].time === null || c[k].time === undefined || /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(c[k].time))) err(`${where}.${k} が不正です`);
      }
      if (c.judgedAt !== undefined && !ts(c.judgedAt)) err(`${where}.judgedAt が不正です`);
    };
    let scheduledCount = 0;
    inj.forEach((e, i) => {
      if (!isObj(e)) return;
      const p = `injections[${i}]`;
      if (!oneOf(e.status, ["scheduled", "administered", "skipped"])) err(`${p}.status が不正です`);
      if (e.kind !== undefined && !oneOf(e.kind, ["regular", "oneOffChange", "makeup", "manual", "legacy"])) err(`${p}.kind が不正です`);
      for (const k of ["regularDate", "scheduledAt", "administeredAt"]) {
        if (!dateOrNull(nullable(e[k]))) err(`${p}.${k} が日付(YYYY-MM-DD)ではありません`);
      }
      for (const k of ["scheduledTime", "administeredTime"]) {
        if (!time(nullable(e[k]))) err(`${p}.${k} が時刻(HH:MM)ではありません`);
      }
      if (!numOrNull(nullable(e.dose))) err(`${p}.dose が数値ではありません`);
      else if (num(e.dose) && doseOptions && !doseOptions.includes(e.dose)) warn(`${p} の用量(${e.dose}mg)が製剤規格の選択肢にありません`);
      if (e.doseConfirmedDifferent !== undefined && typeof e.doseConfirmedDifferent !== "boolean") err(`${p}.doseConfirmedDifferent が真偽値ではありません`);
      if (e.skipReason !== undefined && !(e.skipReason === null || oneOf(e.skipReason, ["missedUnder72h", "missedUnknown", "userChoice"]))) err(`${p}.skipReason が不正です`);
      if (e.stockCount !== undefined && !(e.stockCount === null || oneOf(e.stockCount, ["counts", "excluded", "review"]))) err(`${p}.stockCount が不正です`);
      checkSnapshotCheck(e.missedCheck, `${p}.missedCheck`);
      if (e.scheduleVersionId !== undefined && e.scheduleVersionId !== null && !intId(e.scheduleVersionId)) err(`${p}.scheduleVersionId が不正です`);
      if (e.comment !== undefined && !str(e.comment, this.LIMITS.text)) err(`${p}.comment が不正です`);
      for (const k of ["createdAt", "updatedAt"]) if (e[k] !== undefined && !tsOrNull(e[k])) err(`${p}.${k} が不正です`);
      // 以前のデータ（v4以前）に実施日のない投与済みがありうる。計算からは除外されるが、復元は止めず警告にとどめる
      if (e.status === "administered" && !e.administeredAt) warn(`${p} は投与済みですが実施日がありません（計算からは除外されます）`);
      if (e.status === "administered" && e.dose === null) warn(`${p} は投与済みですが用量がありません`);
      if (e.status === "scheduled") {
        scheduledCount += 1;
        if (!e.scheduledAt) warn(`${p} は予定ですが予定日がありません`);
      }
    });
    if (scheduledCount > 1) warn("未投与の予定が複数あります（最も早いものを使います）");

    // injectionStock（在庫の設定。残本数は保存せず、投与記録から計算する）
    if (!isObj(s.injectionStock)) {
      err("injectionStock がありません");
    } else {
      const k = s.injectionStock;
      if (!(Number.isInteger(k.initialPens) && k.initialPens >= 0 && k.initialPens <= 10000)) err("injectionStock.initialPens が不正です");
      if (!tsOrNull(k.setupAt === undefined ? null : k.setupAt)) err("injectionStock.setupAt が不正です");
    }

    // injectionSchedule（v5。定例スケジュールのルールと変更履歴）
    if (!isObj(s.injectionSchedule)) {
      err("injectionSchedule がありません");
    } else {
      const sch = s.injectionSchedule;
      const r = sch.regular;
      if (r !== null && r !== undefined) {
        if (!isObj(r)) {
          err("injectionSchedule.regular が不正です");
        } else {
          if (!intId(r.id)) err("injectionSchedule.regular.id が不正です");
          if (!(Number.isInteger(r.weekday) && r.weekday >= 0 && r.weekday <= 6)) err("injectionSchedule.regular.weekday が不正です");
          if (!time(nullable(r.time))) err("injectionSchedule.regular.time が時刻(HH:MM)ではありません");
          if (!date(r.effectiveFrom)) err("injectionSchedule.regular.effectiveFrom が日付ではありません");
          else if (Number.isInteger(r.weekday)) {
            const [y, m, d] = r.effectiveFrom.split("-").map(Number);
            if (new Date(y, m - 1, d).getDay() !== r.weekday) err("injectionSchedule.regular.effectiveFrom の曜日が weekday と一致しません");
          }
        }
      }
      if (!(sch.baseDoseMg === null || sch.baseDoseMg === undefined || num(sch.baseDoseMg))) err("injectionSchedule.baseDoseMg が数値ではありません");
      else if (num(sch.baseDoseMg) && doseOptions && !doseOptions.includes(sch.baseDoseMg)) warn("基準用量が製剤規格の選択肢にありません");
      if (!Array.isArray(sch.history)) {
        err("injectionSchedule.history が配列ではありません");
      } else if (sch.history.length > this.MAX_ITEMS) {
        err("injectionSchedule.history の件数が多すぎます");
      } else {
        const seen = new Set();
        sch.history.forEach((h, i) => {
          const p = `injectionSchedule.history[${i}]`;
          if (!isObj(h)) return err(`${p} がオブジェクトではありません`);
          if (!intId(h.id)) err(`${p}.id が不正です`);
          else if (seen.has(h.id)) err(`${p}.id が重複しています`);
          else seen.add(h.id);
          if (!ts(h.changedAt)) err(`${p}.changedAt が不正です`);
          if (!oneOf(h.type, ["set", "weekdayChange", "timeChange", "clear"])) err(`${p}.type が不正です`);
          for (const k of ["from", "to"]) {
            const v = h[k];
            if (v === null || v === undefined) continue;
            if (!isObj(v) || !(Number.isInteger(v.weekday) && v.weekday >= 0 && v.weekday <= 6) || !time(nullable(v.time)) || !(v.effectiveFrom === undefined || date(v.effectiveFrom))) err(`${p}.${k} が不正です`);
          }
          checkSnapshotCheck(h.check, `${p}.check`);
          if (h.replacedScheduledId !== undefined && h.replacedScheduledId !== null && !intId(h.replacedScheduledId)) err(`${p}.replacedScheduledId が不正です`);
        });
      }
    }

    // proteinProducts / registeredFoods
    const pp = list("proteinProducts");
    uniqueIds("proteinProducts", pp);
    pp.forEach((e, i) => {
      if (!isObj(e)) return;
      if (!str(e.name, this.LIMITS.name) || e.name === "") err(`proteinProducts[${i}].name が不正です`);
      if (!num(e.servingScoops) || e.servingScoops <= 0) err(`proteinProducts[${i}].servingScoops は0より大きい数値が必要です`);
      if (!num(e.proteinPerServing) || e.proteinPerServing < 0) err(`proteinProducts[${i}].proteinPerServing は0以上の数値が必要です`);
      if (!oneOf(e.status, ["active", "archived"])) err(`proteinProducts[${i}].status が不正です`);
      if (typeof e.isDefault !== "boolean") err(`proteinProducts[${i}].isDefault が真偽値ではありません`);
    });
    if (pp.filter((e) => isObj(e) && e.isDefault === true).length > 1) warn("既定のホエイ商品が複数あります");
    const rf = list("registeredFoods");
    uniqueIds("registeredFoods", rf);
    rf.forEach((e, i) => {
      if (!isObj(e)) return;
      if (!str(e.name, this.LIMITS.name) || e.name === "") err(`registeredFoods[${i}].name が不正です`);
      if (!str(e.unit, this.LIMITS.unit)) err(`registeredFoods[${i}].unit が不正です`);
      if (!num(e.proteinPerUnit) || e.proteinPerUnit < 0) err(`registeredFoods[${i}].proteinPerUnit は0以上の数値が必要です`);
      if (!oneOf(e.status, ["active", "archived"])) err(`registeredFoods[${i}].status が不正です`);
    });

    // ui（不正・欠落は初期値に直す）
    if (!isObj(s.ui)) {
      s.ui = { lastScreen: "home" };
      warn("画面の状態(ui)がないため初期値にしました");
    } else if (!this.SCREENS.includes(s.ui.lastScreen)) {
      s.ui.lastScreen = "home";
      warn("最後に開いた画面の値が不正なため HOME にしました");
    }

    return { errors, warnings };
  },

  // ============ 復元・ロールバック（localStorageに書く唯一の場所） ============
  // 手順: ①現行の生データを preRestore に退避（失敗したら中止）→ ②新データを書く
  //       → ③読み戻して検証 → ②③が失敗したら、本体も退避も「操作前の状態」へ書き戻す。
  // 退避(preRestore)は補助。同じブラウザの中にあるため、ブラウザのデータ削除には効かない。
  // 戻り値: { ok:true } | { ok:false, code, message, rolledBack }

  applyRestore(newState) {
    const key = STORAGE_KEY;
    let prevRaw;
    try {
      prevRaw = localStorage.getItem(key);
    } catch (_) {
      return { ok: false, code: "STORAGE_UNAVAILABLE", message: "ブラウザの保存領域にアクセスできません。何も変更していません。", rolledBack: false };
    }

    // 別タブなどで、より新しい版のデータが保存されていたら上書きしない
    const stored = this._storedVersion(prevRaw);
    if (stored !== null && stored > SCHEMA_VERSION) {
      return {
        ok: false,
        code: "NEWER_STORED",
        message: "いま保存されているデータの方が新しい版です。上書きを防ぐため、復元を中止しました。何も変更していません。アプリを更新してから操作してください。",
        rolledBack: false,
      };
    }

    const preSnap = this._snapshotPre();
    if (prevRaw !== null && !this._writePre(prevRaw)) {
      this._restorePre(preSnap);
      return {
        ok: false,
        code: "PRE_RESTORE_FAILED",
        message: "復元前のデータを退避できませんでした（保存領域の不足など）。何も変更していません。先に現在のデータをファイルへ書き出してください。",
        rolledBack: false,
      };
    }

    // schemaVersion を先頭に置いて保存する（Storage.save の版の判定が先頭の項目を見るため）
    const json = JSON.stringify({ schemaVersion: newState.schemaVersion, ...newState });
    try {
      localStorage.setItem(key, json);
      const back = localStorage.getItem(key);
      if (back !== json) throw new Error("書き込み内容が一致しません");
      const parsed = JSON.parse(back);
      const a = this.counts(parsed);
      const b = this.counts(newState);
      if (parsed.schemaVersion !== newState.schemaVersion || this.COUNT_KEYS.some((k) => a[k] !== b[k])) {
        throw new Error("読み戻した件数または版が一致しません");
      }
    } catch (e) {
      const rolledBack = this._restoreRaw(prevRaw);
      this._restorePre(preSnap); // 退避も操作前の世代に戻す（失敗した復元で、以前の退避を失わない）
      return {
        ok: false,
        code: "WRITE_FAILED",
        message: rolledBack
          ? "復元の書き込みに失敗したため、元のデータに戻しました。"
          : "復元の書き込みに失敗し、元のデータへも自動では戻せませんでした。先に書き出したファイルから復元してください。",
        rolledBack,
        detail: String(e && e.message),
      };
    }
    return { ok: true };
  },

  hasPreRestore() {
    try {
      return localStorage.getItem(this.PRE_RESTORE_KEY) !== null;
    } catch (_) {
      return false;
    }
  },

  preRestoreInfo() {
    try {
      if (localStorage.getItem(this.PRE_RESTORE_KEY) === null) return null;
      return { savedAt: localStorage.getItem(this.PRE_RESTORE_AT_KEY) };
    } catch (_) {
      return null;
    }
  },

  // 「復元前のデータに戻す」。現在のデータと退避を入れ替える（もう一度押せば元に戻る）。
  // 書き込みに失敗したら、本体も退避も操作前の状態へ戻す。
  rollbackToPreRestore() {
    const key = STORAGE_KEY;
    let preRaw;
    let currentRaw;
    try {
      preRaw = localStorage.getItem(this.PRE_RESTORE_KEY);
      currentRaw = localStorage.getItem(key);
    } catch (_) {
      return { ok: false, code: "NO_PRE_RESTORE", message: "戻せる退避データがありません。", rolledBack: false };
    }
    if (preRaw === null) {
      return { ok: false, code: "NO_PRE_RESTORE", message: "戻せる退避データがありません。", rolledBack: false };
    }
    // 退避データは、書き戻す前に最低限の確認をする（壊れたもの・新しい版のものを書き戻さない）
    const preVersion = this._storedVersion(preRaw);
    if (preVersion === null || preVersion > SCHEMA_VERSION) {
      return { ok: false, code: "PRE_RESTORE_INVALID", message: "退避データが壊れているか、このアプリでは扱えない版のため戻せません。何も変更していません。", rolledBack: false };
    }
    const curVersion = this._storedVersion(currentRaw);
    if (curVersion !== null && curVersion > SCHEMA_VERSION) {
      return { ok: false, code: "NEWER_STORED", message: "いま保存されているデータの方が新しい版です。上書きを防ぐため、中止しました。何も変更していません。", rolledBack: false };
    }

    const preSnap = this._snapshotPre(); // 失敗したときに退避を元へ戻すための控え
    if (currentRaw !== null && !this._writePre(currentRaw)) {
      this._restorePre(preSnap);
      return { ok: false, code: "PRE_RESTORE_FAILED", message: "入れ替えの準備に失敗しました（保存領域の不足など）。何も変更していません。", rolledBack: false };
    }
    try {
      localStorage.setItem(key, preRaw);
      if (localStorage.getItem(key) !== preRaw) throw new Error("書き込み内容が一致しません");
    } catch (_) {
      const rolledBack = this._restoreRaw(currentRaw);
      this._restorePre(preSnap);
      return {
        ok: false,
        code: "WRITE_FAILED",
        message: rolledBack ? "戻す処理に失敗したため、現在のデータと退避を、操作前の状態に保ちました。" : "戻す処理に失敗しました。先に書き出したファイルから復元してください。",
        rolledBack,
      };
    }
    return { ok: true };
  },

  // ---- 退避(preRestore)の読み書き ----

  _snapshotPre() {
    try {
      return { raw: localStorage.getItem(this.PRE_RESTORE_KEY), at: localStorage.getItem(this.PRE_RESTORE_AT_KEY) };
    } catch (_) {
      return { raw: null, at: null };
    }
  },

  _restorePre(snap) {
    try {
      if (snap.raw === null) localStorage.removeItem(this.PRE_RESTORE_KEY);
      else localStorage.setItem(this.PRE_RESTORE_KEY, snap.raw);
      if (snap.at === null) localStorage.removeItem(this.PRE_RESTORE_AT_KEY);
      else localStorage.setItem(this.PRE_RESTORE_AT_KEY, snap.at);
      return true;
    } catch (_) {
      return false;
    }
  },

  _writePre(raw) {
    try {
      localStorage.setItem(this.PRE_RESTORE_KEY, raw);
      if (localStorage.getItem(this.PRE_RESTORE_KEY) !== raw) return false;
      try {
        localStorage.setItem(this.PRE_RESTORE_AT_KEY, new Date().toISOString()); // 日時は参考情報。失敗しても退避は有効
      } catch (_) {
        // 日時を書けなくても退避自体は有効
      }
      return true;
    } catch (_) {
      return false;
    }
  },

  _restoreRaw(raw) {
    try {
      if (raw === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, raw);
      return localStorage.getItem(STORAGE_KEY) === raw;
    } catch (_) {
      return false;
    }
  },

  // 保存済みの生データから schemaVersion を取り出す。読めなければ null（データ無しも null）
  _storedVersion(raw) {
    if (raw === null || raw === undefined) return null;
    try {
      const o = JSON.parse(raw);
      return this._isObj(o) && Number.isInteger(o.schemaVersion) ? o.schemaVersion : null;
    } catch (_) {
      return null;
    }
  },

  // ============ 小さな判定ヘルパー ============

  _isObj(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  },

  // YYYY-MM-DD で、実在するカレンダー日であること
  _isRealISODate(v) {
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    const [y, m, d] = v.split("-").map(Number);
    if (y < 2000 || y > 2100) return false;
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  },
};
