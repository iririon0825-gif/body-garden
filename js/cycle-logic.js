// Body Garden — 月経周期の記録ロジック（純粋関数。DOM・localStorageには触れない）
//
// 目的は「月経周期を予測すること」ではなく「体重変動を月経周期の文脈と一緒に見ること」。
// 排卵日の確定・医療的な診断は行わない。14日（黄体期の目安）は表示上の基準値であり、
// 実際の排卵日を確定するものではない。
//
// 保存するのは月経期（startDate〜endDate）の記録だけ（cycleEntries、1件＝1回の月経）。
// 卵胞期・黄体期は保存せず、都度 bandsFor() で計算する（アルゴリズムを調整しても過去データの
// 移行が要らないようにするため）。症状・経血量の専用項目は持たない（体調タブと役割を分ける）。
//
// 用語（このファイル内の呼び方）:
//   記録済み(recorded) … 本人が記録した月経期そのもの
//   実績(derived)      … 次の月経の開始日が既に分かっている「完了済み周期」から計算した卵胞期・黄体期
//   推定(estimated)    … まだ次の月経が始まっていない「現在の周期」について、過去の周期日数の
//                        中央値から見積もった卵胞期・黄体期（今日より未来の部分は描かない）

const CycleLogic = {
  COMMENT_MAX: 500,
  LUTEAL_DAYS: 14, // 黄体期の長さの目安（表示上の基準値。排卵日を確定しない）
  CYCLES_FOR_ESTIMATE: 3, // 現在の周期を推定するのに必要な「完了済み周期」の件数

  // ============ 小さな部品 ============

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
  _addDays(iso, n) {
    const [y, m, d] = iso.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + n);
    return this._ymd(dt);
  },
  _diffDays(fromIso, toIso) {
    const [y1, m1, d1] = fromIso.split("-").map(Number);
    const [y2, m2, d2] = toIso.split("-").map(Number);
    const a = Date.UTC(y1, m1 - 1, d1);
    const b = Date.UTC(y2, m2 - 1, d2);
    return Math.round((b - a) / 86400000);
  },
  _clone(o) {
    return JSON.parse(JSON.stringify(o));
  },
  _commentOk(s) {
    return typeof s === "string" && [...s].length <= this.COMMENT_MAX && !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(s);
  },

  // ============ 並び・取り出し ============

  list(state) {
    return Array.isArray(state.cycleEntries) ? state.cycleEntries : [];
  },
  sorted(state) {
    return this.list(state)
      .slice()
      .sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : (a.id || 0) - (b.id || 0)));
  },
  // 現在「月経中」の記録（endDateがnull）。同時に2件以上は作らせない
  openEntry(state) {
    return this.list(state).find((e) => e && e.endDate == null) || null;
  },
  findById(state, id) {
    return this.list(state).find((e) => e && e.id === id) || null;
  },
  sourceOf(e) {
    return { id: e.id, startDate: e.startDate, endDate: e.endDate === undefined ? null : e.endDate, comment: e.comment || "" };
  },
  _sourceMatches(e, source) {
    if (!source || !e) return false;
    const s = this.sourceOf(e);
    return s.id === source.id && s.startDate === source.startDate && s.endDate === source.endDate && s.comment === source.comment;
  },

  // ============ 検証 ============

  _checkDate(d, now, { futureBlocked = true } = {}) {
    if (!this.isRealDate(d)) return { code: "INVALID_DATE", message: "日付を確認してください（2000〜2100年の日付）。" };
    if (futureBlocked && d > this._ymd(now)) return { code: "FUTURE_DATE", message: "未来の日付は記録できません。" };
    return null;
  },
  _checkComment(c) {
    if (!this._commentOk(c)) return { code: "INVALID_COMMENT", message: `メモは${this.COMMENT_MAX}字以内で入力してください。` };
    return null;
  },
  // 2つの期間が重なるか（endがnullの記録は「今日まで」とみなして比較する＝過去に閉じた期間が、
  // まだ続いている記録に食い込んでいないかを判定できるようにするため）
  _overlaps(aStart, aEnd, bStart, bEnd, now) {
    const today = this._ymd(now);
    const ae = aEnd || today;
    const be = bEnd || today;
    return aStart <= be && bStart <= ae;
  },
  _findOverlap(state, startDate, endDate, excludeId, now) {
    for (const e of this.list(state)) {
      if (!e || e.id === excludeId) continue;
      if (this._overlaps(startDate, endDate, e.startDate, e.endDate, now)) return e;
    }
    return null;
  },
  _fail(code, message) {
    return { ok: false, code, message };
  },

  // ============ 追加（月経が始まった） ============
  // input: { date, comment }。date省略時は今日（呼び出し側がnowから作って渡す想定。ここでは必須にする）

  applyStart(state, input, now = new Date()) {
    if (this.openEntry(state)) return this._fail("ALREADY_OPEN", "すでに「月経中」の記録があります。先にその記録を終了してください。");
    const i = input || {};
    const comment = i.comment == null ? "" : i.comment;
    const err = this._checkDate(i.date, now) || this._checkComment(comment);
    if (err) return this._fail(err.code, err.message);
    const overlap = this._findOverlap(state, i.date, null, null, now);
    if (overlap) return this._fail("OVERLAP", "この日は、別の月経記録の期間と重なっています。");

    const snapshot = this.list(state).slice();
    const nowIso = now.toISOString();
    const entry = { id: nextSequentialId(this.list(state)), startDate: i.date, endDate: null, comment, createdAt: nowIso, updatedAt: nowIso };
    state.cycleEntries = [...snapshot, entry];
    return { ok: true, entry, snapshot };
  },

  // ============ 終了（月経が終わった） ============

  applyEnd(state, id, input, now = new Date()) {
    const cur = this.findById(state, id);
    if (!cur) return this._fail("NOT_FOUND", "対象の記録が見つかりません。");
    if (cur.endDate != null) return this._fail("ALREADY_CLOSED", "この記録は、すでに終了が記録されています。");
    const i = input || {};
    const err = this._checkDate(i.date, now);
    if (err) return this._fail(err.code, err.message);
    if (i.date < cur.startDate) return this._fail("END_BEFORE_START", "終了日は、開始日より前にできません。");
    const overlap = this._findOverlap(state, cur.startDate, i.date, cur.id, now);
    if (overlap) return this._fail("OVERLAP", "この期間は、別の月経記録と重なっています。");

    const snapshot = this.list(state).slice();
    const next = { ...cur, endDate: i.date, updatedAt: now.toISOString() };
    state.cycleEntries = state.cycleEntries.map((e) => (e === cur ? next : e));
    return { ok: true, entry: next, snapshot };
  },

  // ============ 編集（履歴から） ============
  // patch: 変えたい項目だけ { startDate, endDate, comment }。endDateをnullに戻すことはできない
  // （「月経中」に戻す操作は、この編集では行わない＝同時に複数の月経中記録を作らせない設計と整合させるため）

  applyEdit(state, id, patch, source, now = new Date()) {
    const cur = this.findById(state, id);
    if (!cur) return this._fail("NOT_FOUND", "編集する記録が見つかりません（削除された可能性があります）。");
    if (source && !this._sourceMatches(cur, source)) return this._fail("STALE_SOURCE", "編集を始めたあとで、この記録が変わりました。もう一度、記録を開いてから編集してください。");
    const p = patch || {};
    const next = { ...cur };
    let changed = false;

    if ("startDate" in p && p.startDate !== cur.startDate) {
      const err = this._checkDate(p.startDate, now);
      if (err) return this._fail(err.code, err.message);
      next.startDate = p.startDate;
      changed = true;
    }
    if ("endDate" in p) {
      if (p.endDate == null) return this._fail("INVALID_DECISION", "終了日を未入力には戻せません。");
      if (p.endDate !== cur.endDate) {
        const err = this._checkDate(p.endDate, now);
        if (err) return this._fail(err.code, err.message);
        next.endDate = p.endDate;
        changed = true;
      }
    }
    if (next.endDate != null && next.endDate < next.startDate) return this._fail("END_BEFORE_START", "終了日は、開始日より前にできません。");
    if ("comment" in p) {
      const c = p.comment == null ? "" : p.comment;
      if (c !== (cur.comment || "")) {
        const err = this._checkComment(c);
        if (err) return this._fail(err.code, err.message);
        next.comment = c;
        changed = true;
      }
    }
    if (!changed) return this._fail("NO_CHANGE", "変更がありません。");
    if (next.startDate !== cur.startDate || next.endDate !== cur.endDate) {
      const overlap = this._findOverlap(state, next.startDate, next.endDate, cur.id, now);
      if (overlap) return this._fail("OVERLAP", "この期間は、別の月経記録と重なっています。");
    }

    const snapshot = this.list(state).slice();
    next.updatedAt = now.toISOString();
    state.cycleEntries = state.cycleEntries.map((e) => (e === cur ? next : e));
    return { ok: true, entry: next, snapshot };
  },

  // ============ 削除 ============

  applyDelete(state, id, source) {
    const cur = this.findById(state, id);
    if (!cur) return this._fail("NOT_FOUND", "削除する記録が見つかりません。");
    if (source && !this._sourceMatches(cur, source)) return this._fail("STALE_SOURCE", "この記録は、表示したあとで変わりました。もう一度開いてから操作してください。");
    const snapshot = this.list(state).slice();
    state.cycleEntries = state.cycleEntries.filter((e) => e !== cur);
    return { ok: true, entry: cur, snapshot };
  },

  revert(state, snapshot) {
    state.cycleEntries = snapshot;
    return { ok: true };
  },

  // ============ 周期の判定（表示専用。stateを変えない） ============

  // 「完了済み周期」＝ある月経の開始日から、次の月経の開始日まで（＝次回開始日の実績がある）。
  // 周期日数は開始日どうしの差（一般的な定義）。並びはstartDate昇順
  completedCycles(state) {
    const list = this.sorted(state);
    const out = [];
    for (let i = 0; i < list.length - 1; i++) {
      const cur = list[i];
      const next = list[i + 1];
      if (cur.endDate == null) continue; // 開始したその記録がまだ終わっていない（通常は起こらない：次の記録があるのに終了日が無い状態）
      out.push({ entry: cur, nextStart: next.startDate, lengthDays: this._diffDays(cur.startDate, next.startDate) });
    }
    return out;
  },

  _median(nums) {
    const a = nums.slice().sort((x, y) => x - y);
    const mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  },

  // 直近3つの「完了済み周期」の周期日数の中央値。外れ値（単発の長い/短い周期）の影響を受けにくくする
  // ため平均ではなく中央値を使う。3件に満たない場合はnull（＝現在の周期を推定しない）
  estimateCycleLength(state) {
    const completed = this.completedCycles(state);
    if (completed.length < this.CYCLES_FOR_ESTIMATE) return null;
    const lastN = completed.slice(-this.CYCLES_FOR_ESTIMATE);
    return this._median(lastN.map((c) => c.lengthDays));
  },

  // 体重グラフに渡す背景帯。{from, to, phase, source} の配列（色はcharts.js側で解決する）。
  // phase: 'period' | 'follicular' | 'luteal'　source: 'recorded' | 'derived' | 'estimated'
  // 今日より未来の部分は一切含めない（v1.0では未来の予測帯を作らない。X軸も伸ばさない）
  bands(state, now = new Date()) {
    const today = this._ymd(now);
    const clip = (b) => {
      if (b.from > today) return null;
      return { ...b, to: b.to > today ? today : b.to };
    };
    const out = [];

    // 1) 記録済みの月経期（実績）。終了未記録は「今日まで」として表示する
    for (const e of this.sorted(state)) {
      const b = clip({ from: e.startDate, to: e.endDate || today, phase: "period", source: "recorded" });
      if (b) out.push(b);
    }

    // 2) 完了済み周期の卵胞期・黄体期（次の月経の実績から計算。推測ではなく実績ベース）
    for (const c of this.completedCycles(state)) {
      const lutealStart = this._addDays(c.nextStart, -this.LUTEAL_DAYS);
      const lutealEnd = this._addDays(c.nextStart, -1);
      const follicularStart = this._addDays(c.entry.endDate, 1);
      const follicularEnd = this._addDays(lutealStart, -1);
      if (follicularStart <= follicularEnd) {
        const b = clip({ from: follicularStart, to: follicularEnd, phase: "follicular", source: "derived" });
        if (b) out.push(b);
      }
      if (lutealStart <= lutealEnd) {
        const b = clip({ from: lutealStart, to: lutealEnd, phase: "luteal", source: "derived" });
        if (b) out.push(b);
      }
    }

    // 3) 現在の周期（まだ次の月経が始まっていない、記録済みの中で最後の1件）の推定。
    //    直近3つの完了済み周期が無ければ、推定はしない（記録済みの月経期だけを表示する）
    const list = this.sorted(state);
    const current = list.length ? list[list.length - 1] : null;
    const currentIsOpenOrLatest = current && !this.completedCycles(state).some((c) => c.entry.id === current.id);
    if (currentIsOpenOrLatest) {
      const estLen = this.estimateCycleLength(state);
      if (estLen != null) {
        const predictedNextStart = this._addDays(current.startDate, Math.round(estLen));
        const lutealStart = this._addDays(predictedNextStart, -this.LUTEAL_DAYS);
        const lutealEnd = this._addDays(predictedNextStart, -1);
        if (lutealStart <= lutealEnd) {
          const b = clip({ from: lutealStart, to: lutealEnd, phase: "luteal", source: "estimated" });
          if (b) out.push(b);
        }
        // 卵胞期は、この周期の月経が実際に終わっている（終了日が分かっている）ときだけ示す。
        // まだ月経中（endDateがnull）で、いつ終わるか分からない間は、卵胞期の開始点を作れないため出さない
        if (current.endDate != null) {
          const follicularStart = this._addDays(current.endDate, 1);
          const follicularEnd = this._addDays(lutealStart, -1);
          if (follicularStart <= follicularEnd) {
            const b = clip({ from: follicularStart, to: follicularEnd, phase: "follicular", source: "estimated" });
            if (b) out.push(b);
          }
        }
      }
    }

    return out;
  },
};
