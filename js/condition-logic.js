// Body Garden — 今日の体調・副作用の記録ロジック（純粋関数。DOM・localStorageには触れない）
//
// 体調・副作用は、本人による日々の状態の記録。医療の判断・診断・助言は行わない。
// conditionEntries（1日に複数件）をそのまま使う。新しいフィールド・スキーマ変更はない。
//
// 方針
//  - HOMEの3段階: なし=none / 軽い=mild / あり=moderate。既存の severe は削除せず、表示は「あり」。
//    元の保存値(severe)は、本人が明示的に別の段階へ変えない限り moderate に変えない。
//  - 「最新」「並び順」は1つの基準にそろえる: 入力した順（id。アプリが最大値+1で振る）。time は本人が付ける任意の時刻、createdAt は記録の作成時刻で、並べ替えには使わない。
//  - 入力の検証は「今回変えた項目」にだけ掛ける（既存の長いメモ・未知の症状・未来日などの記録を、触っていない項目のせいで編集できなくしない）。切り捨てはしない。
//  - apply* は検証してから変更する（失敗時は state を変えない）。保存(Storage.save)は呼び出し側。保存に失敗したら revert で戻す。
//  - 編集・削除は、下書きが指す記録の写し(source: id・createdAt・level・comment)と照合する（id が再利用されても別の記録を上書きしない）。

const ConditionLogic = {
  COMMENT_MAX: 500,
  SELECTABLE: ["none", "mild", "moderate"],
  LABELS: { none: "なし", mild: "軽い", moderate: "あり", severe: "あり" },

  // ============ 小さな部品 ============

  _ymd(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  },
  _hm(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  },
  // バックアップの検証（Backup._isRealISODate）と同じ範囲（2000〜2100年）。ここで通した日付は、書き出し・復元でも通る
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
  _clone(o) {
    return JSON.parse(JSON.stringify(o));
  },
  symptomIds() {
    return CONDITION_SYMPTOMS.map((s) => s.id);
  },
  symptomLabel(id) {
    const s = CONDITION_SYMPTOMS.find((x) => x.id === id);
    return s ? s.label : String(id);
  },
  levelLabel(level) {
    return this.LABELS[level] || "未選択";
  },
  // 画面に出す段階。severe は「あり」と同じ扱い（保存値は変えない）
  displayLevel(level) {
    return level === "severe" ? "moderate" : level;
  },
  hasNewline(s) {
    return typeof s === "string" && /[\r\n]/.test(s);
  },
  // 貼り付けで入るタブは空白に、改行コードは \n にそろえる（それ以外の制御文字は検証で拒否）
  normalizeComment(s) {
    return typeof s === "string" ? s.replace(/\r\n?/g, "\n").replace(/\t/g, " ") : s;
  },
  _commentOk(s) {
    return typeof s === "string" && [...s].length <= this.COMMENT_MAX && !/[\u0000-\u0009\u000b-\u001f\u007f\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/.test(s);
  },
  // HOMEの1行メモで、そのまま編集してよいメモか（改行・長文は「詳しく記録」で編集する）
  memoEditableOnHome(entry) {
    const c = entry && typeof entry.comment === "string" ? entry.comment : "";
    return !this.hasNewline(c) && [...c].length <= this.COMMENT_MAX;
  },

  // ============ 並び順・取り出し ============

  _ts(e) {
    const t = Date.parse(e && e.createdAt);
    return Number.isFinite(t) ? t : -Infinity;
  },
  _id(e) {
    return typeof (e && e.id) === "number" ? e.id : 0;
  },
  // 入力した順。id はアプリが「いまある最大値+1」で振るので、端末の時計が戻っても入力順に増える。
  // 同じ id（壊れたデータ）のときだけ createdAt で決める。HOMEの「最新」も、履歴の並びも、これ1つ
  compare(a, b) {
    const d = this._id(a) - this._id(b);
    if (d !== 0) return d;
    const ta = this._ts(a);
    const tb = this._ts(b);
    return ta === tb ? 0 : ta < tb ? -1 : 1;
  },
  entriesForDate(state, date) {
    return (state.conditionEntries || []).filter((e) => e && e.date === date).sort((a, b) => this.compare(a, b));
  },
  latestForDate(state, date) {
    const list = this.entriesForDate(state, date);
    return list.length ? list[list.length - 1] : null;
  },
  findById(state, id) {
    return (state.conditionEntries || []).find((e) => e && e.id === id) || null;
  },
  sourceOf(entry) {
    return { id: entry.id, createdAt: entry.createdAt === undefined ? null : entry.createdAt, level: entry.level === undefined ? null : entry.level, comment: entry.comment || "" };
  },
  _sourceMatches(entry, source) {
    if (!source || !entry) return false;
    const s = this.sourceOf(entry);
    return s.id === source.id && s.createdAt === source.createdAt && s.level === source.level && s.comment === source.comment;
  },
  // 日付ごとのまとまり（新しい日付から）。dates 日分。次を見るには dates を増やす
  historyGroups(state, dates = 30) {
    const byDate = new Map();
    for (const e of state.conditionEntries || []) {
      if (!e || typeof e.date !== "string") continue;
      if (!byDate.has(e.date)) byDate.set(e.date, []);
      byDate.get(e.date).push(e);
    }
    const all = [...byDate.keys()].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    const groups = all.slice(0, dates).map((date) => ({ date, entries: byDate.get(date).sort((a, b) => this.compare(a, b)) }));
    return { groups, totalDates: all.length, hasMore: all.length > dates, indexOfDate: (d) => all.indexOf(d) };
  },

  // ============ 検証 ============
  // 返り値: null（問題なし）| { code, message }

  _checkDate(date, now) {
    if (!this.isRealDate(date)) return { code: "INVALID_DATE", message: "日付を確認してください（2000〜2100年の日付）。" };
    if (date > this._ymd(now)) return { code: "FUTURE_DATE", message: "未来の日付は記録できません。" };
    return null;
  },
  _checkTime(time) {
    if (time === null || time === undefined || time === "") return null;
    return this.isTime(time) ? null : { code: "INVALID_TIME", message: "時刻は HH:MM の形で入力してください。" };
  },
  _checkSymptoms(symptoms, keep = []) {
    if (!Array.isArray(symptoms)) return { code: "INVALID_SYMPTOMS", message: "症状の選択が正しくありません。" };
    const known = this.symptomIds();
    if (!symptoms.every((x) => typeof x === "string" && (known.includes(x) || keep.includes(x))) || new Set(symptoms).size !== symptoms.length) {
      return { code: "INVALID_SYMPTOMS", message: "症状の選択が正しくありません。" };
    }
    return null;
  },
  _checkComment(comment) {
    if (!this._commentOk(comment)) return { code: "INVALID_COMMENT", message: `メモは${this.COMMENT_MAX}字以内で入力してください（特殊な制御文字は使えません）。` };
    return null;
  },
  _noneWithSymptoms() {
    return { code: "NONE_WITH_SYMPTOMS", message: "症状が選ばれているため、「なし」にはできません。症状を外してから変更してください。" };
  },

  _fail(code, message) {
    return { ok: false, code, message };
  },

  // ============ 追加 ============
  // input: { date, time, level, symptoms, comment }。level は none/mild/moderate のどれか（未選択は保存しない）
  applyAdd(state, input, now = new Date()) {
    const i = input || {};
    const comment = this.normalizeComment(i.comment === undefined || i.comment === null ? "" : i.comment);
    const symptoms = i.symptoms === undefined ? [] : i.symptoms;
    const time = i.time === undefined || i.time === "" ? null : i.time;
    const err =
      this._checkDate(i.date, now) ||
      this._checkTime(time) ||
      (this.SELECTABLE.includes(i.level) ? null : { code: "LEVEL_REQUIRED", message: "「なし／軽い／あり」のどれかを選んでください。" }) ||
      this._checkSymptoms(symptoms) ||
      this._checkComment(comment) ||
      (i.level === "none" && symptoms.length > 0 ? this._noneWithSymptoms() : null);
    if (err) return this._fail(err.code, err.message);

    const snapshot = (state.conditionEntries || []).slice();
    const entry = { id: nextSequentialId(state.conditionEntries), date: i.date, time, level: i.level, symptoms: [...symptoms], comment, createdAt: now.toISOString() };
    state.conditionEntries = [...snapshot, entry];
    return { ok: true, entry, snapshot };
  },

  // ============ 編集 ============
  // patch は、変えたい項目だけ（date/time/level/symptoms/comment）。source は、編集の下書きを作った時点の写し
  applyEdit(state, id, patch, source, now = new Date()) {
    const cur = this.findById(state, id);
    if (!cur) return this._fail("NOT_FOUND", "編集する記録が見つかりません（削除された可能性があります）。");
    if (source && !this._sourceMatches(cur, source)) return this._fail("STALE_SOURCE", "編集を始めたあとで、この記録が変わりました。もう一度、記録を開いてから編集してください。");
    const p = patch || {};
    const next = { ...cur };
    let changed = false;
    const levelWas = cur.level === undefined ? null : cur.level;

    if ("date" in p && p.date !== cur.date) {
      const e = this._checkDate(p.date, now);
      if (e) return this._fail(e.code, e.message);
      next.date = p.date;
      changed = true;
    }
    if ("time" in p) {
      const t = p.time === undefined || p.time === "" ? null : p.time;
      if (t !== (cur.time === undefined ? null : cur.time)) {
        const e = this._checkTime(t);
        if (e) return this._fail(e.code, e.message);
        next.time = t;
        changed = true;
      }
    }
    let levelChanged = false;
    if ("level" in p && p.level !== levelWas) {
      // severe のまま「あり」を押し直しても、severe を moderate に書き換えない
      if (!(levelWas === "severe" && p.level === "moderate")) {
        if (!this.SELECTABLE.includes(p.level)) return this._fail("LEVEL_REQUIRED", "「なし／軽い／あり」のどれかを選んでください。");
        next.level = p.level;
        levelChanged = true;
        changed = true;
      }
    }
    let symptomsChanged = false;
    if ("symptoms" in p) {
      const curS = Array.isArray(cur.symptoms) ? cur.symptoms : [];
      const same = p.symptoms && Array.isArray(p.symptoms) && p.symptoms.length === curS.length && p.symptoms.every((x, k) => x === curS[k]);
      if (!same) {
        const e = this._checkSymptoms(p.symptoms, curS); // 元からあった未知のIDは、そのまま残せる（外すのも自由）
        if (e) return this._fail(e.code, e.message);
        next.symptoms = [...p.symptoms];
        symptomsChanged = true;
        changed = true;
      }
    }
    if ("comment" in p) {
      const c = this.normalizeComment(p.comment === undefined || p.comment === null ? "" : p.comment);
      if (c !== (cur.comment || "")) {
        const e = this._checkComment(c);
        if (e) return this._fail(e.code, e.message);
        next.comment = c;
        changed = true;
      }
    }
    if ((levelChanged || symptomsChanged) && next.level === "none" && (next.symptoms || []).length > 0) {
      const e = this._noneWithSymptoms();
      return this._fail(e.code, e.message);
    }
    if (!changed) return this._fail("NO_CHANGE", "変更がありません。");

    const snapshot = state.conditionEntries.slice();
    state.conditionEntries = state.conditionEntries.map((x) => (x === cur ? next : x));
    return { ok: true, entry: next, snapshot };
  },

  // ============ 削除 ============
  applyDelete(state, id, source) {
    const cur = this.findById(state, id);
    if (!cur) return this._fail("NOT_FOUND", "削除する記録が見つかりません。");
    if (source && !this._sourceMatches(cur, source)) return this._fail("STALE_SOURCE", "この記録は、表示したあとで変わりました。もう一度開いてから操作してください。");
    const snapshot = state.conditionEntries.slice();
    state.conditionEntries = state.conditionEntries.filter((x) => x !== cur);
    return { ok: true, entry: cur, snapshot };
  },

  // 保存に失敗したとき、メモリ上の配列を元に戻す
  revert(state, snapshot) {
    state.conditionEntries = snapshot;
    return { ok: true };
  },
};
