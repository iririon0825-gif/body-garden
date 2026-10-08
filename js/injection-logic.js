// Body Garden — 注射管理のロジック（純粋関数。DOM・localStorageには触れない）
//
// 根拠ラベル: 【7.1】【7.2】= 電子添付文書の「用法及び用量に関連する注意」（マンジャロ。2026年9月改訂 第11版）
//             【アプリ独自】= 添付文書に記載のない、アプリ独自の安全策・表示基準
//
// 区別して扱う概念（混同しない）
//   status（状態）: scheduled（予定）/ administered（実際の投与記録）/ skipped（見送りの記録）
//   kind（種別）  : regular（定例）/ oneOffChange（その1回だけの日程変更）/ makeup（打ち忘れ後の臨時投与）/ manual / legacy
//   定例曜日の変更 は injectionSchedule（ルール）側の変更。過去の記録は変わらない。
//   予定の取消（scheduled を消す）と、投与済み・見送り履歴の削除は、別の操作。
//
// 判定の分離
//   judgeMissedDose        … 打ち忘れ。基準は「現在時刻」と「次の定例投与日時」（【7.2】）
//   judgeWeekdayChange     … 曜日変更。基準は「前回の実投与日時」と「変更後の最初の予定日時」（【7.2】）
//   judgeScheduleInterval  … 単発変更・手動登録。【アプリ独自】
//   judgeActualInterval    … 実投与の間隔の確認。【アプリ独自】（記録そのものは拒否しない）
//   どれも「72時間以上」は 72時間ちょうどを含む。秒まで計算する。時刻不明の日付は 0:00:00.000〜23:59:59.999 の幅で扱い、
//   幅が72時間をまたぐときだけ「判定不能」とする。
//
// apply* は state を直接書き換える（保存は呼び出し側）。失敗時は state を変更しない。

const InjectionLogic = {
  WEEKDAYS: ["日", "月", "火", "水", "木", "金", "土"],

  // ============ 日付・時刻 ============

  _pad(n) {
    return String(n).padStart(2, "0");
  },
  ymd(d) {
    return `${d.getFullYear()}-${this._pad(d.getMonth() + 1)}-${this._pad(d.getDate())}`;
  },
  hm(d) {
    return `${this._pad(d.getHours())}:${this._pad(d.getMinutes())}`;
  },
  isYmd(s) {
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  },
  isTime(t) {
    return typeof t === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
  },
  weekdayOf(s) {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d).getDay();
  },
  // 日付の加算は new Date(y, m-1, d+n)（ミリ秒×日数の加算はしない）
  addDays(s, n) {
    const [y, m, d] = s.split("-").map(Number);
    return this.ymd(new Date(y, m - 1, d + n));
  },
  // b - a（日数）
  diffDays(a, b) {
    const [ay, am, ad] = a.split("-").map(Number);
    const [by, bm, bd] = b.split("-").map(Number);
    return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
  },
  _dateMs(s, h, mi, sec, ms) {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d, h, mi, sec, ms).getTime();
  },
  // 日付＋時刻(null可)の幅。時刻があれば1点（その分の0秒）、無ければその日の全体
  rangeOf(date, time) {
    if (this.isTime(time)) {
      const [h, mi] = time.split(":").map(Number);
      const t = this._dateMs(date, h, mi, 0, 0);
      return { min: t, max: t, known: true };
    }
    return { min: this._dateMs(date, 0, 0, 0, 0), max: this._dateMs(date, 23, 59, 59, 999), known: false };
  },
  // 現在時刻（秒・ミリ秒まで）。切り捨てない
  nowRange(now) {
    const t = now.getTime();
    return { min: t, max: t, known: true };
  },
  // 範囲 a → b の間隔（ms）の最小・最大
  _gap(a, b) {
    return { minMs: b.min - a.max, maxMs: b.max - a.min };
  },
  _classify(g) {
    if (g.minMs >= INJECTION_THRESHOLD_MS) return "ge72"; // 72時間ちょうどを含む
    if (g.maxMs < INJECTION_THRESHOLD_MS) return "lt72";
    return "unknown";
  },
  // ms → 「71時間59分59秒」。負の値は「0秒」扱い
  formatDuration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${h}時間${m}分${s}秒`;
  },
  formatGap(g) {
    return g.minMs === g.maxMs ? this.formatDuration(g.minMs) : `${this.formatDuration(g.minMs)}〜${this.formatDuration(g.maxMs)}`;
  },
  // 「10/14(水)」。年が今年と違うときだけ「2027/1/5(火)」
  formatShortDate(s, today) {
    const [y, m, d] = s.split("-").map(Number);
    const wd = this.WEEKDAYS[this.weekdayOf(s)];
    const thisYear = today ? Number(today.slice(0, 4)) : new Date().getFullYear();
    return y === thisYear ? `${m}/${d}（${wd}）` : `${y}/${m}/${d}（${wd}）`;
  },
  // 年を常に含む形（初回投与日のように、一度きりの基準日を明示したいとき）
  formatFullDate(s) {
    const [y, m, d] = s.split("-").map(Number);
    return `${y}/${m}/${d}（${this.WEEKDAYS[this.weekdayOf(s)]}）`;
  },

  // ============ 72時間の判定（4種類。それぞれ別の関数） ============

  // 打ち忘れ【7.2】: 現在時刻 → 次の定例投与日時 {date,time|null}。残り時間が72時間以上か。
  judgeMissedDose(now, next) {
    const g = this._gap(this.nowRange(now), this.rangeOf(next.date, next.time));
    return { result: this._classify(g), minMs: g.minMs, maxMs: g.maxMs };
  },

  // 曜日変更【7.2】: 前回の実投与日時 {date,time|null} → 変更後の最初の予定日時。間隔が72時間以上か。
  // 投与履歴が無いときは判定対象が無い（noHistory。確定できる）。判定不能・72時間未満は確定できない。
  judgeWeekdayChange(last, first) {
    if (!last) return { result: "noHistory", canConfirm: true, minMs: null, maxMs: null };
    const g = this._gap(this.rangeOf(last.date, last.time), this.rangeOf(first.date, first.time));
    const result = this._classify(g);
    return { result, canConfirm: result === "ge72", minMs: g.minMs, maxMs: g.maxMs };
  },

  // 単発の日程変更・手動での予定登録【アプリ独自】: 前回の実投与から72時間以上あるか
  judgeScheduleInterval(last, planned) {
    if (!last) return { result: "noHistory", canConfirm: true, minMs: null, maxMs: null };
    const g = this._gap(this.rangeOf(last.date, last.time), this.rangeOf(planned.date, planned.time));
    const result = this._classify(g);
    return { result, canConfirm: result === "ge72", minMs: g.minMs, maxMs: g.maxMs };
  },

  // 実際の投与どうしの間隔【アプリ独自】。事実の記録なので、72時間未満・判定不能でも拒否せず確認を求めるだけ
  judgeActualInterval(earlier, later) {
    const g = this._gap(this.rangeOf(earlier.date, earlier.time), this.rangeOf(later.date, later.time));
    return { result: this._classify(g), minMs: g.minMs, maxMs: g.maxMs };
  },

  // ============ 記録の取り出し ============

  schedule(state) {
    return state.injectionSchedule || createDefaultInjectionSchedule();
  },
  effectiveDate(r) {
    return r.administeredAt || r.scheduledAt || r.regularDate || "";
  },
  _cmpDt(a, b) {
    const ka = [this.effectiveDate(a), a.administeredTime || a.scheduledTime || "", typeof a.id === "number" ? a.id : 0];
    const kb = [this.effectiveDate(b), b.administeredTime || b.scheduledTime || "", typeof b.id === "number" ? b.id : 0];
    for (let i = 0; i < 3; i++) {
      if (ka[i] < kb[i]) return -1;
      if (ka[i] > kb[i]) return 1;
    }
    return 0;
  },
  administered(state, excludeId) {
    return state.injections
      .filter((r) => r.status === "administered" && r.administeredAt && String(r.id) !== String(excludeId))
      .sort((a, b) => this._cmpDt(a, b));
  },
  lastAdministered(state, excludeId) {
    const list = this.administered(state, excludeId);
    return list.length ? list[list.length - 1] : null;
  },
  closed(state) {
    return state.injections.filter((r) => r.status === "administered" || r.status === "skipped").sort((a, b) => this._cmpDt(a, b));
  },
  // 初回投与日（導出のみ・保存しない）。「初回」を示す専用フィールドは無いため、実際に「投与済み」の記録のうち
  // 最も古いものを使う。予定・見送り（打ち忘れ）は含めない。Body Garden開始日（profile.startDate）とは別の概念
  firstAdministered(state) {
    const list = this.administered(state);
    return list.length ? list[0] : null;
  },
  firstAdministeredDate(state) {
    const first = this.firstAdministered(state);
    return first ? first.administeredAt : null;
  },
  // 初回投与日から数えた日数（初回投与日＝0日）。初回投与日が無い・今日より後なら null
  daysSinceFirst(state, today) {
    const d = this.firstAdministeredDate(state);
    if (!d || !this.isYmd(today)) return null;
    const n = this.diffDays(d, today);
    return n >= 0 ? n : null;
  },
  scheduledRecords(state) {
    return state.injections.filter((r) => r.status === "scheduled" && r.scheduledAt).sort((a, b) => this._cmpDt(a, b));
  },
  // 今日以降の予定（0〜1件が原則。複数あれば最も早いもの）
  pendingFuture(state, today) {
    return this.scheduledRecords(state).find((r) => r.scheduledAt >= today) || null;
  },
  overdueScheduled(state, today) {
    return this.scheduledRecords(state).filter((r) => r.scheduledAt < today);
  },
  // 投与済み・見送りのうち、どこまでが「記録済み」か（実施日・予定日・定例日の最大値）
  cursor(state) {
    let c = "";
    for (const r of this.closed(state)) {
      for (const v of [r.administeredAt, r.scheduledAt, r.regularDate]) if (v && v > c) c = v;
    }
    return c || null;
  },
  daysSinceLast(state, today) {
    const last = this.lastAdministered(state);
    return last ? this.diffDays(last.administeredAt, today) : null;
  },
  // 【アプリ独自】28日以上は注意表示の基準。再開可否の基準ではない。72時間のルールを置き換えない
  isLongGap(state, today) {
    const d = this.daysSinceLast(state, today);
    return d !== null && d >= INJECTION_LONG_GAP_DAYS;
  },

  // ============ 定例の系列（保存せず導出する） ============

  // afterYmd より後で、定例曜日に当たる最初の日（effectiveFrom 以降）
  nextRegularDate(regular, afterYmd) {
    const floor = this.addDays(regular.effectiveFrom, -1);
    let d = this.addDays(afterYmd > floor ? afterYmd : floor, 1);
    for (let i = 0; i < 7; i++) {
      if (this.weekdayOf(d) === regular.weekday) return d;
      d = this.addDays(d, 1);
    }
    return null;
  },
  // (fromExclusive, toInclusive] にある定例日
  regularDatesBetween(regular, fromExclusive, toInclusive) {
    const out = [];
    let d = this.nextRegularDate(regular, fromExclusive);
    while (d && d <= toInclusive) {
      out.push(d);
      d = this.addDays(d, INJECTION_CYCLE_DAYS);
    }
    return out;
  },
  // 次に確定の対象になる定例日（これまでの記録の続き。今日より前にはしない）
  nextRegularFromState(state, now) {
    const regular = this.schedule(state).regular;
    if (!regular) return null;
    const today = this.ymd(now);
    const yesterday = this.addDays(today, -1);
    const c = this.cursor(state);
    return this.nextRegularDate(regular, c && c > yesterday ? c : yesterday);
  },

  // ============ 記録のない回（打ち忘れの対象になりうる回） ============
  // 記録がないことと、実際に投与しなかったことは同義ではない。ここでは「記録が無い回」を列挙するだけで、
  // 見送りとして保存することはしない（本人が確認して applySkip を呼ぶ）。

  uncoveredItems(state, now) {
    const today = this.ymd(now);
    const regular = this.schedule(state).regular;
    const items = [];
    // 期限切れの予定。date は「実際に予定していた日」（単発変更後はその日）、regularDate は属する定例日。
    // 同じ定例日がすでに投与済み・見送りとして記録されている予定は、記録のない回ではない（孤立した予定。取消の対象）
    for (const r of this.overdueScheduled(state, today)) {
      const key = r.regularDate || r.scheduledAt;
      const alreadyRecorded = state.injections.some((o) => String(o.id) !== String(r.id) && (o.status === "administered" || o.status === "skipped") && (o.regularDate || o.scheduledAt) === key);
      if (alreadyRecorded) continue;
      items.push({ date: r.scheduledAt, regularDate: key, scheduledAt: r.scheduledAt, recordId: r.id, kind: r.kind });
    }
    if (regular) {
      const c = this.cursor(state);
      const from = c || this.addDays(regular.effectiveFrom, -1);
      for (const d of this.regularDatesBetween(regular, from, this.addDays(today, -1))) {
        const represented = state.injections.some((r) => r.regularDate === d) || items.some((it) => it.date === d || it.regularDate === d);
        if (!represented) items.push({ date: d, regularDate: d, scheduledAt: null, recordId: null, kind: "regular" });
      }
    }
    return items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  },

  // 打ち忘れの評価。対象の回（最新の未記録回）と、その次の定例投与日時を明示する。
  evaluateMissedDose(state, now) {
    const today = this.ymd(now);
    const regular = this.schedule(state).regular;
    const base = { longGap: this.isLongGap(state, today), daysSinceLast: this.daysSinceLast(state, today) };
    const items = this.uncoveredItems(state, now);
    if (items.length === 0) return { status: "nothingMissed", items: [], ...base };
    if (!regular) return { status: "noSchedule", items, ...base };

    const target = items[items.length - 1];
    const older = items.slice(0, -1);
    let next = { date: this.nextRegularDate(regular, target.date), time: regular.time, source: "regular" };
    // 対象より後ろに、より早い日付の予定が登録されていれば、安全側でそちらを「次の投与」とする【アプリ独自】
    const fut = this.pendingFuture(state, today);
    if (fut && fut.scheduledAt < next.date) next = { date: fut.scheduledAt, time: fut.scheduledTime, source: "scheduledRecord" };
    return { status: "judged", items, target, older, next, judgment: this.judgeMissedDose(now, next), ...base };
  },

  // ============ 次回提案（保存しない。確定は本人の操作） ============
  // 通常の投与の後: 定例の系列の次回（通常は実施日+7日と同じ）。臨時投与・単発変更の後も定例の系列に戻る。
  // 見送りが最新のとき・28日以上の中断後・予定があるときは提案しない。

  suggestNext(state, now) {
    const today = this.ymd(now);
    if (this.pendingFuture(state, today)) return null;
    const closed = this.closed(state);
    const last = closed.length ? closed[closed.length - 1] : null;
    if (!last || last.status !== "administered") return null;
    if (this.isLongGap(state, today)) return null;
    // 定例スケジュールが未設定のときは提案しない（初回の予定を登録してもらう。確定できない提案を出さない）
    const regular = this.schedule(state).regular;
    if (!regular) return null;
    const baseDate = last.regularDate && last.regularDate > last.administeredAt ? last.regularDate : last.administeredAt;
    const date = this.nextRegularDate(regular, baseDate);
    if (!date || date < today) return null; // 過去の日付は提案しない（打ち忘れの扱いは evaluateMissedDose）
    // 前回の実投与から72時間以上あかない日付は、確定できない（アプリ独自）ので提案しない
    const gap = this.judgeScheduleInterval(this._lastRef(state), { date, time: regular.time });
    if (gap.result !== "ge72" && gap.result !== "noHistory") return null;
    return { date, time: regular.time, basis: "regular", regularDate: date };
  },

  // 用量の初期選択。28日以上の中断後は自動で選ばない（null）【ユーザー指定】
  defaultDose(state, now) {
    if (this.isLongGap(state, this.ymd(now))) return null;
    const base = this.schedule(state).baseDoseMg;
    if (INJECTION_DOSE_OPTIONS_MG.includes(base)) return base;
    const last = this.lastAdministered(state);
    if (last && INJECTION_DOSE_OPTIONS_MG.includes(last.dose)) return last.dose;
    return INJECTION_INITIAL_DOSE_MG;
  },
  // 用量変更の確認に使う基準（直近の投与の用量、なければ基準用量）。無ければ確認は不要
  referenceDose(state, excludeId) {
    const last = this.lastAdministered(state, excludeId);
    if (last && typeof last.dose === "number") return last.dose;
    const base = this.schedule(state).baseDoseMg;
    return typeof base === "number" ? base : null;
  },

  // ============ HOME・注射タブの表示用の要約 ============

  homeSummary(state, now) {
    const today = this.ymd(now);
    const last = this.lastAdministered(state);
    const longGap = this.isLongGap(state, today);
    const ev = this.evaluateMissedDose(state, now);
    const fut = this.pendingFuture(state, today);
    const proposal = this.suggestNext(state, now);
    const out = {
      today,
      mode: "unset",
      date: null,
      time: null,
      timeUnknown: false,
      chip: null,
      administeredToday: !!(last && last.administeredAt === today),
      lastAdministeredAt: last ? last.administeredAt : null,
      daysSinceLast: this.daysSinceLast(state, today),
      notices: [],
      eval: ev,
      proposal,
      stock: this.stockSummary(state),
    };
    if (longGap) out.notices.push("longGap");
    if (ev.status === "judged" || ev.status === "noSchedule") {
      const t = ev.status === "judged" ? ev.target : ev.items[ev.items.length - 1];
      out.mode = "missed";
      out.date = t.date;
      out.chip = "未記録";
      out.notices.push("missed");
    } else if (fut) {
      out.mode = fut.scheduledAt === today ? "today" : "scheduled";
      out.date = fut.scheduledAt;
      out.time = fut.scheduledTime;
      out.timeUnknown = !fut.scheduledTime;
      out.chip = "未投与";
      out.recordId = fut.id;
      if (out.timeUnknown) out.notices.push("timeUnset");
    } else if (proposal) {
      out.mode = "proposal";
      out.date = proposal.date;
      out.time = proposal.time;
      out.timeUnknown = !proposal.time;
      out.chip = "提案・未確定";
    }
    return out;
  },

  // ============ 在庫（残本数） ============
  // 残りは保存せず、投与記録から毎回計算する（二重減算・修正や削除との食い違いを起こさない）。
  //   使用本数 = 投与済み(administered)の記録の数（1回につき1本）。予定・打ち忘れ・見送り・曜日変更は数えない。
  //   在庫の設定時点ですでにあった記録(stockCount='review')は、実記録かテスト用か判別できないので、
  //   本人が確認する(counts / excluded)まで数えず、needsReview として「要確認」にする。
  stockSummary(state) {
    // 在庫の設定が無い状態では、全件を数えて差し引かない（要確認として扱う）
    if (!state.injectionStock) {
      const initial = INJECTION_STOCK_INITIAL_PENS;
      return { initial, used: 0, remaining: initial, over: false, needsReview: true, reviewRecords: [] };
    }
    const stock = state.injectionStock;
    const administered = state.injections.filter((r) => r.status === "administered");
    const reviewRecords = administered.filter((r) => r.stockCount === "review");
    const used = administered.filter((r) => r.stockCount !== "review" && r.stockCount !== "excluded").length;
    const remaining = stock.initialPens - used;
    return { initial: stock.initialPens, used, remaining, over: remaining < 0, needsReview: reviewRecords.length > 0, reviewRecords };
  },

  // 確認待ちの投与記録を、本人の選択で「使用本数に含める(counts)」「含めない(excluded)」にする
  applyStockReview(state, id, decision) {
    if (decision !== "counts" && decision !== "excluded") return this._fail("INVALID_DECISION", "選択が正しくありません。");
    const rec = state.injections.find((r) => String(r.id) === String(id));
    if (!rec || rec.status !== "administered" || rec.stockCount !== "review") return this._fail("NOT_REVIEW", "確認が必要な記録ではありません。");
    rec.stockCount = decision;
    return { ok: true, record: rec };
  },
  // 投与記録ごとの数え方を、いつでも切り替えられる（確認の取り消しにも使う）。記録そのものは変えない
  applyStockSet(state, id, decision) {
    if (decision !== "counts" && decision !== "excluded") return this._fail("INVALID_DECISION", "選択が正しくありません。");
    const rec = state.injections.find((r) => String(r.id) === String(id));
    if (!rec || rec.status !== "administered") return this._fail("NOT_ADMINISTERED", "投与済みの記録ではありません。");
    rec.stockCount = decision;
    return { ok: true, record: rec };
  },
  applyStockReviewAll(state, decision) {
    if (decision !== "counts" && decision !== "excluded") return this._fail("INVALID_DECISION", "選択が正しくありません。");
    const list = state.injections.filter((r) => r.status === "administered" && r.stockCount === "review");
    for (const r of list) r.stockCount = decision;
    return { ok: true, count: list.length };
  },

  // ============ 入力の検証（共通） ============

  _fail(code, message, extra) {
    return { ok: false, code, message, ...(extra || {}) };
  },
  _validDose(mg) {
    return INJECTION_DOSE_OPTIONS_MG.includes(mg);
  },
  _checkCommon(input) {
    if (input.comment !== undefined && input.comment !== null && (typeof input.comment !== "string" || input.comment.length > INJECTION_COMMENT_MAX)) {
      return this._fail("INVALID_COMMENT", `メモは${INJECTION_COMMENT_MAX}字以内で入力してください。`);
    }
    if (input.time !== undefined && input.time !== null && input.time !== "" && !this.isTime(input.time)) {
      return this._fail("INVALID_TIME", "時刻は HH:MM の形で入力してください（空欄でもかまいません）。");
    }
    return null;
  },
  _lastRef(state, excludeId) {
    const last = this.lastAdministered(state, excludeId);
    return last ? { date: last.administeredAt, time: last.administeredTime || null } : null;
  },
  _nextId(state) {
    return nextSequentialId(state.injections);
  },
  _stamp(now) {
    return now.toISOString();
  },

  // 予定日として登録できる日付か（今日〜今日+90日）
  _checkPlannedDate(date, now) {
    if (!this.isYmd(date)) return this._fail("INVALID_DATE", "予定日を入力してください。");
    const today = this.ymd(now);
    if (date < today) return this._fail("PAST_DATE", "予定日は今日以降の日付を選んでください。");
    if (this.diffDays(today, date) > INJECTION_SCHEDULE_MAX_DAYS_AHEAD) {
      return this._fail("TOO_FAR", `予定日は${INJECTION_SCHEDULE_MAX_DAYS_AHEAD}日以内で選んでください。`);
    }
    return null;
  },
  // 予定の間隔の確認結果をエラーに変換する（【アプリ独自】。確定できないときだけエラー）
  _scheduleIntervalError(judgment) {
    if (judgment.result === "lt72") {
      return this._fail("INTERVAL_UNDER_72H", "前回の実投与から72時間未満になる予定は、確定できません。", { judgment });
    }
    if (judgment.result === "unknown") {
      return this._fail("INTERVAL_UNKNOWN", "時刻が不明のため、前回の実投与から72時間以上あるか厳密に判定できません。前回の投与時刻（履歴の「修正」から入力）または予定時刻を入力してください。", { judgment });
    }
    return null;
  },

  // ============ 予定の登録・変更 ============

  // 初回の予定登録（定例スケジュールの設定）。初回予定日は手動登録【ユーザー指定】。
  // 曜日は予定日から決まる。既に定例が設定されている場合は、曜日変更（applyWeekdayChange）を使う。
  applyFirstSchedule(state, input, now) {
    const common = this._checkCommon(input);
    if (common) return common;
    const sch = this.schedule(state);
    if (sch.regular) return this._fail("ALREADY_SET", "定例スケジュールは設定済みです。曜日を変える場合は「投与曜日を変更」を使ってください。");
    const today = this.ymd(now);
    if (this.pendingFuture(state, today)) return this._fail("PENDING_EXISTS", "すでに次回の予定があります。");
    const dateErr = this._checkPlannedDate(input.date, now);
    if (dateErr) return dateErr;
    const time = input.time || null;
    const judgment = this.judgeScheduleInterval(this._lastRef(state), { date: input.date, time });
    const intervalErr = this._scheduleIntervalError(judgment);
    if (intervalErr) return intervalErr;
    if (input.baseDoseMg !== undefined && input.baseDoseMg !== null && !this._validDose(input.baseDoseMg)) {
      return this._fail("INVALID_DOSE", "用量は選択肢から選んでください。");
    }

    const hist = { id: nextSequentialId(sch.history), changedAt: this._stamp(now), type: "set", from: null, to: { weekday: this.weekdayOf(input.date), time, effectiveFrom: input.date }, check: this._checkSnapshot(judgment, this._lastRef(state), input.date), replacedScheduledId: null };
    const rec = Object.assign(createEmptyInjection(), {
      id: this._nextId(state),
      status: "scheduled",
      kind: "regular",
      regularDate: input.date,
      scheduledAt: input.date,
      scheduledTime: time,
      scheduleVersionId: hist.id,
      comment: input.comment || "",
      createdAt: this._stamp(now),
    });
    state.injectionSchedule = { regular: { id: hist.id, weekday: hist.to.weekday, time, effectiveFrom: input.date }, baseDoseMg: input.baseDoseMg ?? sch.baseDoseMg ?? null, history: [...sch.history, hist] };
    state.injections.push(rec);
    return { ok: true, record: rec };
  },

  _checkSnapshot(judgment, lastRef, firstDate) {
    return { lastAdministered: lastRef, firstDate, result: judgment.result, minMs: judgment.minMs, maxMs: judgment.maxMs };
  },

  // 次回の予定を確定する（提案の確定・見送り後や中断後の手動登録）。確定は必ず本人の操作で呼ばれる。
  //   regularDate: この予定が属する定例日。date と同じなら「定例」、違えば「その1回だけの変更」。
  applyScheduleNext(state, input, now) {
    const common = this._checkCommon(input);
    if (common) return common;
    const sch = this.schedule(state);
    if (!sch.regular) return this._fail("NO_SCHEDULE", "定例スケジュールが未設定です。先に初回の予定を登録してください。");
    const today = this.ymd(now);
    if (this.pendingFuture(state, today)) return this._fail("PENDING_EXISTS", "すでに次回の予定があります。予定を変更する場合は「この回だけ日程を変更」を使ってください。");
    const dateErr = this._checkPlannedDate(input.date, now);
    if (dateErr) return dateErr;
    const time = input.time || null;
    const regularDate = input.regularDate || this.nextRegularFromState(state, now);
    const oneOff = input.date !== regularDate;
    const gapErr = this._checkOneOffBounds(sch.regular, regularDate, input.date, time, oneOff, input.confirmNextGap);
    if (gapErr) return gapErr;
    const last = this._lastRef(state);
    const judgment = this.judgeScheduleInterval(last, { date: input.date, time });
    const intervalErr = this._scheduleIntervalError(judgment);
    if (intervalErr) return intervalErr;

    const rec = Object.assign(createEmptyInjection(), {
      id: this._nextId(state),
      status: "scheduled",
      kind: oneOff ? "oneOffChange" : "regular",
      regularDate,
      scheduledAt: input.date,
      scheduledTime: time,
      scheduleVersionId: sch.regular.id,
      comment: input.comment || "",
      createdAt: this._stamp(now),
    });
    state.injections.push(rec);
    return { ok: true, record: rec };
  },

  // 単発変更の範囲チェック。次の定例日以降へは動かせない（曜日変更を使う）。次の定例日まで72時間未満なら確認を求める
  _checkOneOffBounds(regular, regularDate, date, time, oneOff, confirmNextGap) {
    if (!oneOff) return null;
    const nextSeries = this.nextRegularDate(regular, regularDate);
    if (nextSeries && date >= nextSeries) {
      return this._fail("BEYOND_NEXT_REGULAR", "次の定例日以降には動かせません。定例曜日そのものを変える場合は「投与曜日を変更」を使ってください。");
    }
    if (nextSeries) {
      // 次の定例日時との間隔【アプリ独自】。72時間未満・判定不能は、警告として確認を求める（確定は止めない）
      const g = this._gap(this.rangeOf(date, time), this.rangeOf(nextSeries, regular.time));
      const result = this._classify(g);
      if (result !== "ge72" && !confirmNextGap) {
        return this._fail("CONFIRM_REQUIRED", "この日程だと、次の定例投与まで72時間未満（または判定不能）になります。内容を確認してください。", { needs: ["nextGap"], nextGap: { result, nextDate: nextSeries, minMs: g.minMs, maxMs: g.maxMs } });
      }
    }
    return null;
  },

  // 予定（scheduled）の日程を、その1回だけ変更する。定例曜日は変わらない。
  applyOneOffChange(state, id, input, now) {
    const common = this._checkCommon(input);
    if (common) return common;
    const rec = state.injections.find((r) => String(r.id) === String(id));
    if (!rec || rec.status !== "scheduled") return this._fail("NOT_SCHEDULED", "変更できる予定がありません。");
    const dateErr = this._checkPlannedDate(input.date, now);
    if (dateErr) return dateErr;
    const time = input.time || null;
    const sch = this.schedule(state);
    const regularDate = rec.regularDate || rec.scheduledAt;
    const isManual = !sch.regular || rec.kind === "manual" || rec.kind === "legacy";
    const oneOff = !isManual && input.date !== regularDate;
    if (!isManual) {
      const gapErr = this._checkOneOffBounds(sch.regular, regularDate, input.date, time, oneOff, input.confirmNextGap);
      if (gapErr) return gapErr;
    }
    const judgment = this.judgeScheduleInterval(this._lastRef(state), { date: input.date, time });
    const intervalErr = this._scheduleIntervalError(judgment);
    if (intervalErr) return intervalErr;

    rec.scheduledAt = input.date;
    rec.scheduledTime = time;
    if (!isManual) rec.kind = oneOff ? "oneOffChange" : "regular";
    rec.updatedAt = this._stamp(now);
    return { ok: true, record: rec };
  },

  // 予定の取消。scheduled の記録だけを消す。定例スケジュール・投与済み・見送りの履歴には触れない。
  applyCancelScheduled(state, id) {
    const idx = state.injections.findIndex((r) => String(r.id) === String(id));
    if (idx < 0 || state.injections[idx].status !== "scheduled") return this._fail("NOT_SCHEDULED", "取り消せる予定がありません。");
    const [removed] = state.injections.splice(idx, 1);
    return { ok: true, record: removed };
  },

  // ============ 実際の投与の記録 ============
  // 実投与は事実の記録。前回から72時間未満でも拒否しない（注意表示と確認を挟むだけ）【ユーザー指定】。
  // 確認が必要な項目（用量の変更・実投与の間隔）は needs に返り、confirm* が付いたときだけ保存する。

  // 予定（scheduled）の投与として結び付けてよいか。実施日が予定から離れすぎている（先週分を入力する等）と、
  // その予定が「投与済み」になって今後の予定が消えてしまうため、結び付けられない。
  //   ・予定日の6日前まで（前倒し）〜 次の定例日の前日まで
  //   ・同じ回がすでに投与済み・見送りで記録されている予定（孤立した予定）には結び付けられない
  _checkLink(state, rec, date) {
    const key = rec.regularDate || rec.scheduledAt;
    if (state.injections.some((o) => String(o.id) !== String(rec.id) && (o.status === "administered" || o.status === "skipped") && (o.regularDate || o.scheduledAt) === key)) {
      return this._fail("ALREADY_RECORDED", "この予定の回は、すでに投与済みまたは見送りとして記録されています。この予定は取り消してください。");
    }
    const due = rec.scheduledAt;
    if (!due || !this.isYmd(date)) return null;
    const regular = this.schedule(state).regular;
    const tooEarly = this.diffDays(date, due) > 6;
    const nextSeries = regular && (rec.kind === "regular" || rec.kind === "oneOffChange") ? this.nextRegularDate(regular, rec.regularDate || due) : null;
    const tooLate = nextSeries && date >= nextSeries;
    if (tooEarly || tooLate) {
      return this._fail("LINK_OUT_OF_RANGE", `選んだ予定（${this.formatShortDate(due)}）から離れた日付のため、この予定の投与としては記録できません。「結び付けない」を選ぶか、日付を確認してください。`);
    }
    return null;
  },
  // その実施日に結び付けてよい予定（画面の初期選択に使う）
  linkCandidates(state, date) {
    return this.scheduledRecords(state).filter((r) => this._checkLink(state, r, date) === null);
  },

  // 用量確認の比較基準: その記録の「時系列で直前の投与」（なければ直後の投与、なければ基準用量）。用量が数値の記録だけを見る
  referenceDoseFor(state, cur, excludeId) {
    const list = this.administered(state, excludeId).filter((r) => typeof r.dose === "number");
    const key = { administeredAt: cur.date, administeredTime: cur.time || null };
    const prev = [...list].reverse().find((r) => this._cmpDt(r, { ...key, id: Infinity }) <= 0);
    if (prev) return prev.dose;
    const next = list.find((r) => this._cmpDt(r, { ...key, id: -1 }) > 0);
    if (next) return next.dose;
    const base = this.schedule(state).baseDoseMg;
    return typeof base === "number" ? base : null;
  },

  // 保存前の評価（画面の警告表示にも使う）。errors があれば保存できない。
  assessAdministration(state, input, now) {
    const errors = [];
    const needs = { dose: null, interval: null };
    const today = this.ymd(now);
    const common = this._checkCommon(input);
    if (common) errors.push(common);
    // 予定と結び付ける場合は、日付の範囲・記録済みの回でないかを確認する
    if (input.recordId !== undefined && input.recordId !== null && input.recordId !== "") {
      const linked = state.injections.find((r) => String(r.id) === String(input.recordId) && r.status === "scheduled");
      if (linked && this.isYmd(input.date)) {
        const le = this._checkLink(state, linked, input.date);
        if (le) errors.push(le);
      }
    }
    if (!this.isYmd(input.date)) {
      errors.push(this._fail("INVALID_DATE", "実施日を入力してください。"));
    } else {
      if (input.date > today) errors.push(this._fail("FUTURE_DATE", "未来の日付には投与を記録できません。"));
      if (input.date === today && this.isTime(input.time) && input.time > this.hm(now)) {
        errors.push(this._fail("FUTURE_TIME", "今の時刻より後の時刻には投与を記録できません。"));
      }
    }
    if (!this._validDose(input.dose)) errors.push(this._fail("INVALID_DOSE", "用量を選択してください（自動では選びません）。"));
    if (errors.length) return { errors, needs, warnings: [] };

    const time = input.time || null;
    // 用量の確認: 基準（直近の投与・基準用量）と違うとき、または比べる基準が無い初回のとき（初期選択の2.5mgのまま
    // 実際は別の用量、ということがないよう、処方された用量どおりかを必ず確認する）
    const editing = input.editId !== undefined && input.editId !== null ? state.injections.find((r) => String(r.id) === String(input.editId)) : null;
    const ref = this.referenceDoseFor(state, { date: input.date, time }, input.editId);
    if (editing && editing.dose === input.dose) {
      // 修正で用量を変えていないなら、用量の確認は要らない（過去の記録のメモ等を直すだけで確認が出ないように）
    } else if (ref === null) {
      if (!editing) needs.dose = { from: null, to: input.dose, first: true };
    } else if (ref !== input.dose) {
      needs.dose = { from: ref, to: input.dose };
    }

    // 前後の実投与との間隔【アプリ独自】。72時間未満・判定不能は確認を求める
    const cur = { date: input.date, time };
    const others = this.administered(state, input.editId);
    const prev = [...others].reverse().find((r) => this._cmpDt(r, { administeredAt: cur.date, administeredTime: cur.time, id: Infinity }) <= 0);
    const next = others.find((r) => this._cmpDt(r, { administeredAt: cur.date, administeredTime: cur.time, id: -1 }) > 0);
    const checks = [];
    if (prev) checks.push({ with: "prev", other: { date: prev.administeredAt, time: prev.administeredTime || null }, ...this.judgeActualInterval({ date: prev.administeredAt, time: prev.administeredTime || null }, cur) });
    if (next) checks.push({ with: "next", other: { date: next.administeredAt, time: next.administeredTime || null }, ...this.judgeActualInterval(cur, { date: next.administeredAt, time: next.administeredTime || null }) });
    const bad = checks.filter((c) => c.result !== "ge72");
    if (bad.length) {
      needs.interval = bad[0];
      needs.intervals = bad; // 前後の両方が72時間未満・判定不能のときは、すべて表示する
    }
    return { errors, needs, warnings: [] };
  },

  // 投与の記録（新規）。recordId があれば、その予定（scheduled）を投与済みにする。
  //   regularDate: 打ち忘れの対象の定例日（臨時投与の場合）。
  applyAdministration(state, input, now) {
    const a = this.assessAdministration(state, input, now);
    if (a.errors.length) return a.errors[0];
    const needs = [];
    if (a.needs.dose && !input.confirmDose) needs.push("dose");
    if (a.needs.interval && !input.confirmInterval) needs.push("interval");
    if (needs.length) return this._fail("CONFIRM_REQUIRED", "保存前の確認が必要です。", { needs, assessment: a });

    const time = input.time || null;
    const sch = this.schedule(state);
    const explicit = input.recordId !== undefined && input.recordId !== null && input.recordId !== "";
    let rec = explicit ? state.injections.find((r) => String(r.id) === String(input.recordId)) : null;
    if (explicit && (!rec || rec.status !== "scheduled")) {
      return this._fail("NOT_SCHEDULED", "対象の予定が見つかりません。");
    }
    // 予定との結び付け: recordId が無くても、同じ日付（予定日・定例日）の予定が1件だけあれば、その予定の投与として記録する。
    // 結び付けないと、予定が未投与のまま残り、翌日に存在しない「打ち忘れ」が出てしまう。
    // 複数の予定が一致するとき・結び付けてはいけない予定のときは、結び付けない（曖昧なまま結び付けない）。
    if (!rec && !explicit && !input.noLink) {
      const keys = [input.date, input.regularDate].filter(Boolean);
      const matches = state.injections.filter((r) => r.status === "scheduled" && (keys.includes(r.scheduledAt) || keys.includes(r.regularDate)));
      if (matches.length === 1 && this._checkLink(state, matches[0], input.date) === null) rec = matches[0];
    }
    const stamp = this._stamp(now);
    if (rec) {
      // 種別: 予定日より後に投与したときだけ臨時投与(makeup)。予定日以前（前倒し・当日）は元の種別のまま
      let kind = rec.kind;
      if (rec.scheduledAt && input.date > rec.scheduledAt) kind = "makeup";
      rec.status = "administered";
      rec.kind = kind;
      rec.administeredAt = input.date;
      rec.administeredTime = time;
      rec.dose = input.dose;
      rec.doseConfirmedDifferent = !!(a.needs.dose && !a.needs.dose.first); // 初回の確認は「用量を変えた」ではない
      rec.skipReason = null;
      if (input.comment !== undefined) rec.comment = input.comment || "";
      rec.updatedAt = stamp;
    } else {
      let kind = "manual";
      let regularDate = null;
      if (input.regularDate) {
        regularDate = input.regularDate;
        kind = input.date > regularDate ? "makeup" : "regular";
      } else if (sch.regular) {
        const c = this.cursor(state);
        if (this.weekdayOf(input.date) === sch.regular.weekday && input.date >= sch.regular.effectiveFrom && (!c || input.date > c)) {
          kind = "regular";
          regularDate = input.date;
        }
      }
      rec = Object.assign(createEmptyInjection(), {
        id: this._nextId(state),
        status: "administered",
        kind,
        regularDate,
        administeredAt: input.date,
        administeredTime: time,
        dose: input.dose,
        doseConfirmedDifferent: !!(a.needs.dose && !a.needs.dose.first),
        scheduleVersionId: sch.regular ? sch.regular.id : null,
        comment: input.comment || "",
        createdAt: stamp,
      });
      state.injections.push(rec);
    }
    return { ok: true, record: rec, assessment: a };
  },

  // 投与記録の修正（実施日・時刻・用量・メモ）。予定日・定例日・種別は変えない。
  applyEditAdministration(state, id, input, now) {
    const rec = state.injections.find((r) => String(r.id) === String(id));
    if (!rec || rec.status !== "administered") return this._fail("NOT_ADMINISTERED", "修正できる投与記録がありません。");
    const full = { ...input, editId: rec.id };
    const a = this.assessAdministration(state, full, now);
    if (a.errors.length) return a.errors[0];
    const needs = [];
    if (a.needs.dose && !input.confirmDose) needs.push("dose");
    if (a.needs.interval && !input.confirmInterval) needs.push("interval");
    if (needs.length) return this._fail("CONFIRM_REQUIRED", "保存前の確認が必要です。", { needs, assessment: a });
    rec.administeredAt = input.date;
    rec.administeredTime = input.time || null;
    rec.dose = input.dose;
    rec.doseConfirmedDifferent = a.needs.dose ? !a.needs.dose.first : rec.doseConfirmedDifferent;
    if (input.comment !== undefined) rec.comment = input.comment || "";
    rec.updatedAt = this._stamp(now);
    return { ok: true, record: rec, assessment: a };
  },

  // ============ 見送り ============
  // 本人の確認を経て呼ぶ。記録の無い回を、自動で見送りにしてはならない。
  // missedCheck には、そのとき画面に表示した72時間判定をそのまま保存する。
  applySkip(state, input, now) {
    const common = this._checkCommon(input);
    if (common) return common;
    const today = this.ymd(now);
    const explicit = input.recordId !== undefined && input.recordId !== null && input.recordId !== "";
    let rec = explicit ? state.injections.find((r) => String(r.id) === String(input.recordId)) : null;
    if (explicit && (!rec || rec.status !== "scheduled")) {
      return this._fail("NOT_SCHEDULED", "対象の予定が見つかりません。");
    }
    // 見送れるのは「予定していた日が過ぎた回」だけ。単発変更した予定は、変更後の予定日で判断する
    const regularDate = input.regularDate || (rec ? rec.regularDate || rec.scheduledAt : null);
    const dueDate = rec ? rec.scheduledAt : regularDate;
    if (!this.isYmd(regularDate) || !this.isYmd(dueDate)) return this._fail("INVALID_DATE", "見送りの対象の日付が正しくありません。");
    if (dueDate >= today) return this._fail("NOT_PAST", "今日以降の回は、見送りとして記録できません。");
    if (!["missedUnder72h", "missedUnknown", "userChoice"].includes(input.reason)) return this._fail("INVALID_REASON", "見送りの理由が正しくありません。");
    if (state.injections.some((r) => (!rec || String(r.id) !== String(rec.id)) && (r.status === "administered" || r.status === "skipped") && (r.regularDate || r.scheduledAt) === regularDate)) {
      return this._fail("ALREADY_RECORDED", "この回は、すでに投与済みまたは見送りとして記録されています。");
    }
    const sch = this.schedule(state);
    const stamp = this._stamp(now);
    if (rec) {
      rec.status = "skipped";
      if (!rec.regularDate) rec.regularDate = regularDate;
      rec.skipReason = input.reason;
      rec.missedCheck = input.missedCheck || null;
      if (input.comment !== undefined) rec.comment = input.comment || "";
      rec.updatedAt = stamp;
    } else {
      rec = Object.assign(createEmptyInjection(), {
        id: this._nextId(state),
        status: "skipped",
        kind: "regular",
        regularDate,
        scheduledAt: regularDate,
        scheduledTime: sch.regular ? sch.regular.time : null,
        skipReason: input.reason,
        missedCheck: input.missedCheck || null,
        scheduleVersionId: sch.regular ? sch.regular.id : null,
        comment: input.comment || "",
        createdAt: stamp,
      });
      state.injections.push(rec);
    }
    return { ok: true, record: rec };
  },

  // 投与済み・見送りの履歴の削除（予定の取消とは別の操作。UI側で確認を挟む）
  applyDeleteHistory(state, id) {
    const idx = state.injections.findIndex((r) => String(r.id) === String(id));
    if (idx < 0 || state.injections[idx].status === "scheduled") return this._fail("NOT_HISTORY", "削除できる履歴がありません。");
    const [removed] = state.injections.splice(idx, 1);
    return { ok: true, record: removed };
  },

  // ============ 定例曜日の変更（打ち忘れとは別のロジック） ============

  // 曜日変更が可能か（過去に記録の無い回があるときは先に処理させる【アプリ独自】）
  canChangeSchedule(state, now) {
    if (!this.schedule(state).regular) return { ok: false, code: "NO_SCHEDULE", message: "定例スケジュールが未設定です。" };
    if (this.uncoveredItems(state, now).length > 0) {
      return { ok: false, code: "UNCOVERED_PAST", message: "記録のない過去の回があります。先に「打ち忘れた」から確認・記録してください。" };
    }
    return { ok: true };
  },

  // 変更後の曜日の、直近の候補日（今日以降）と、それぞれの72時間判定。判定不能・72時間未満の候補は確定できない。
  weekdayChangeCandidates(state, input, now, count = 3) {
    const today = this.ymd(now);
    const last = this._lastRef(state);
    const time = input.time || null;
    const out = [];
    const nowHm = this.hm(now);
    let d = today;
    for (let i = 0; i < 7 * count + 7 && out.length < count; i++) {
      // 今日の、すでに過ぎた時刻は候補にしない（過去の予定になってしまう）
      const passedToday = d === today && time && time <= nowHm;
      if (this.weekdayOf(d) === input.weekday && !passedToday) {
        // daysFromToday が8日以上のとき、1週間より先の予定になる（その間の1回分の投与日が無くなる）ことを画面で知らせる
        out.push({ date: d, time, daysFromToday: this.diffDays(today, d), judgment: this.judgeWeekdayChange(last, { date: d, time }) });
      }
      d = this.addDays(d, 1);
    }
    return out;
  },

  applyWeekdayChange(state, input, now) {
    const common = this._checkCommon(input);
    if (common) return common;
    const can = this.canChangeSchedule(state, now);
    if (!can.ok) return this._fail(can.code, can.message);
    const sch = this.schedule(state);
    if (!Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6) return this._fail("INVALID_WEEKDAY", "曜日が正しくありません。");
    const dateErr = this._checkPlannedDate(input.firstDate, now);
    if (dateErr) return dateErr;
    if (this.weekdayOf(input.firstDate) !== input.weekday) return this._fail("WEEKDAY_MISMATCH", "選んだ日付が、変更後の曜日と一致しません。");
    const time = input.time || null;
    const last = this._lastRef(state);
    const judgment = this.judgeWeekdayChange(last, { date: input.firstDate, time });
    if (!judgment.canConfirm) {
      if (judgment.result === "lt72") return this._fail("INTERVAL_UNDER_72H", "前回の実投与から72時間未満のため、この日には曜日を変更できません。", { judgment });
      return this._fail("INTERVAL_UNKNOWN", "時刻が不明のため、前回の実投与から72時間以上あるか厳密に判定できません。前回の投与時刻または予定時刻を確認・入力してください。", { judgment });
    }
    const today = this.ymd(now);
    // 未来の予定が2件以上あると、置き換えられない予定が旧曜日のまま残る。先に1件にしてもらう
    if (this.scheduledRecords(state).filter((r) => r.scheduledAt >= today).length > 1) {
      return this._fail("MULTIPLE_PENDING", "未投与の予定が複数あります。先に不要な予定を取り消して、1件にしてください。");
    }
    const fut = this.pendingFuture(state, today);
    const hist = {
      id: nextSequentialId(sch.history),
      changedAt: this._stamp(now),
      type: input.weekday === sch.regular.weekday ? "timeChange" : "weekdayChange",
      from: { weekday: sch.regular.weekday, time: sch.regular.time },
      to: { weekday: input.weekday, time, effectiveFrom: input.firstDate },
      check: this._checkSnapshot(judgment, last, input.firstDate),
      replacedScheduledId: fut ? fut.id : null,
    };
    state.injectionSchedule = { ...sch, regular: { id: hist.id, weekday: input.weekday, time, effectiveFrom: input.firstDate }, history: [...sch.history, hist] };
    if (fut) {
      // 未来の予定は、新しい最初の予定日へ置き換える（過去の記録には触れない）
      fut.scheduledAt = input.firstDate;
      fut.scheduledTime = time;
      fut.regularDate = input.firstDate;
      fut.kind = "regular";
      fut.scheduleVersionId = hist.id;
      fut.updatedAt = this._stamp(now);
    }
    return { ok: true, history: hist, replaced: fut || null };
  },

  // 定例の予定時刻だけを設定・変更する（曜日と開始日は変えない）。時刻不明で判定できないときに、時刻を入れて判定し直すための操作。
  // 記録のない過去の回があっても行える（曜日変更とは別の操作）。今日以降の予定の時刻も更新するので、
  // 前回の実投与から72時間以上あくかを確認する【アプリ独自】。過去の記録は変えない。
  applyRegularTime(state, time, now) {
    if (time !== null && !this.isTime(time)) return this._fail("INVALID_TIME", "時刻は HH:MM の形で入力してください。");
    const sch = this.schedule(state);
    if (!sch.regular) return this._fail("NO_SCHEDULE", "定例スケジュールが未設定です。");
    if ((sch.regular.time || null) === (time || null)) return this._fail("NO_CHANGE", "予定時刻は現在と同じです。");
    const today = this.ymd(now);
    const last = this._lastRef(state);
    const futs = this.scheduledRecords(state).filter((r) => r.scheduledAt >= today && r.kind === "regular");
    for (const f of futs) {
      const err = this._scheduleIntervalError(this.judgeScheduleInterval(last, { date: f.scheduledAt, time }));
      if (err) return err;
    }
    const hist = {
      id: nextSequentialId(sch.history),
      changedAt: this._stamp(now),
      type: "timeChange",
      from: { weekday: sch.regular.weekday, time: sch.regular.time },
      to: { weekday: sch.regular.weekday, time, effectiveFrom: sch.regular.effectiveFrom },
      check: null,
      replacedScheduledId: null,
    };
    state.injectionSchedule = { ...sch, regular: { ...sch.regular, id: hist.id, time }, history: [...sch.history, hist] };
    for (const f of futs) {
      f.scheduledTime = time;
      f.scheduleVersionId = hist.id;
      f.updatedAt = this._stamp(now);
    }
    return { ok: true, history: hist };
  },

  // 基準用量だけの設定変更（表示用の初期選択。72時間の判定対象外）
  applyBaseDose(state, baseDoseMg) {
    if (baseDoseMg !== null && !this._validDose(baseDoseMg)) return this._fail("INVALID_DOSE", "用量は選択肢から選んでください。");
    const sch = this.schedule(state);
    state.injectionSchedule = { ...sch, baseDoseMg };
    return { ok: true };
  },
};
