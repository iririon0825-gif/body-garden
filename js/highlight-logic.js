// Body Garden — 週刊・月刊ハイライトの集計ロジック（純粋関数。DOM・localStorageには触れない）
//
// 方針
//  - 保存項目の追加・スキーマ変更はしない。すべて表示のたびに、いまの state から計算する
//    （過去の記録を直せば、次の表示で自動的に集計し直される。キャッシュを持たない）。
//  - state を書き換えない（読むだけ）。profile.startWeight なども一切変えない。
//  - 日付は端末のローカル日付の "YYYY-MM-DD" 文字列。toISOString() で日付を作らない。
//  - 記録の無い日は 0 として扱わず、平均の母数にも入れない。体重は typeof number && finite だけを有効とする。
//  - 体組成は記録済みの値だけを使う。推定値（体重×体脂肪率など）は作らない。
//  - 「からだの発見」は固定の文の型に数値を差し込むだけ（AI・通信なし）。最大3文。
//    理由・原因の言い切り、月経／体調／注射と体重を同じ文で結ぶ表現、スコア・合否・速度の評価、
//    減ったことを良いこととして書く表現は使わない（FORBIDDEN_WORDS をテストで確認する）。
//  - このファイルのトップレベルには HighlightLogic だけを置く（他のスクリプトと同じグローバルを共有するため）。

const HighlightLogic = {
  WEEK_MIN_DAYS: 3, // 週：この日数未満は傾向判断を参考程度にする
  MONTH_MIN_DAYS: 8, // 月：同上
  COMPOSITION_KEYS: ["bodyFatMass", "skeletalMuscleMass", "bodyFatPct"],
  // 骨格筋量の最初と最後の差が、これ未満なら「大きな差はありませんでした」と書く（kg）
  SKELETAL_SMALL_DIFF_KG: 0.2,
  // 平均の差が、これ未満なら「ほぼ同じくらい」と書く（kg）
  SAME_DIFF_KG: 0.1,

  LOW_COUNT_NOTE: "記録が少ないため傾向判断は参考程度です",
  GOAL_NOTE: "Goal・身長は現在の設定で計算しています",
  PROTEIN_NOTE: "過去の期間も、現在設定している目標量で判定しています",
  START_WEIGHT_UNSET: "開始体重が未設定です",
  COMPOSITION_NOTE: "体組成は、記録された値だけを表示しています",
  SOFT_NOTE: "いまは体重の数字を、からだの状態を知る手がかりとして並べています",
  NO_DATA: "データなし",
  CLOSING: { week: "整える、続ける、好きになる。", month: "整える、続ける、好きになる。" },

  // 「からだの発見」の文に入れてはいけない語。generateDiscoveries の出力はテストでこれを確認する。
  // 原因の言い切り／月経・排便・注射と体重の結び付け／速度の評価／点数・合否／停滞・失敗／良し悪しの評価／
  // 傾向の断定（下降・上昇・安定）／筋肉・脂肪についての断定
  FORBIDDEN_WORDS: [
    "ため", "ので", "せいで", "おかげ", "影響", "効果", "原因", "によって",
    "速い", "遅い", "早い", "順調", "ペース", "停滞", "失敗", "成功", "伸び悩み",
    "点数", "スコア", "採点", "順位", "ランキング", "合格", "不合格", "達成率",
    "すごい", "素晴らしい", "えらい", "頑張", "がんばり", "良い", "よい", "良く", "悪い", "悪化", "改善",
    "下降", "上昇", "安定", "横ばい", "減少傾向", "増加傾向",
    "維持できて", "維持でき", "脂肪だけ", "筋肉を", "月経前", "便秘が", "下痢が",
  ],

  SKIP_REASON_LABELS: { missedUnder72h: "打ち忘れ・72時間未満", missedUnknown: "打ち忘れ・時刻不明", userChoice: "本人の確認で見送り" },

  // ============ 日付の部品（すべてローカル日付。toISOString は使わない） ============

  _pad(n) {
    return String(n).padStart(2, "0");
  },
  ymd(d) {
    return `${d.getFullYear()}-${this._pad(d.getMonth() + 1)}-${this._pad(d.getDate())}`;
  },
  isYmd(s) {
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  },
  addDays(iso, n) {
    const [y, m, d] = iso.split("-").map(Number);
    return this.ymd(new Date(y, m - 1, d + n));
  },
  weekdayOf(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d).getDay(); // 0=日 … 6=土
  },
  weekStart(iso) {
    return this.addDays(iso, -((this.weekdayOf(iso) + 6) % 7)); // 月曜始まり
  },
  monthEnd(iso) {
    const [y, m] = iso.split("-").map(Number);
    return `${y}-${this._pad(m)}-${this._pad(new Date(y, m, 0).getDate())}`;
  },
  enumerateDays(from, to) {
    const out = [];
    for (let d = from; d <= to; d = this.addDays(d, 1)) out.push(d);
    return out;
  },
  wd(iso) {
    return "日月火水木金土"[this.weekdayOf(iso)];
  },
  md(iso) {
    const [, m, d] = iso.split("-").map(Number);
    return `${m}/${d}`;
  },
  mdw(iso) {
    return `${this.md(iso)}（${this.wd(iso)}）`;
  },
  _validNum(v) {
    return typeof v === "number" && Number.isFinite(v);
  },

  // ============ 期間 ============

  // kind: "week" | "month"。iso を含む期間
  periodContaining(kind, iso) {
    if (kind === "month") {
      const from = `${iso.slice(0, 7)}-01`;
      return { kind: "month", from, to: this.monthEnd(from) };
    }
    const from = this.weekStart(iso);
    return { kind: "week", from, to: this.addDays(from, 6) };
  },
  prevPeriod(period) {
    return this.periodContaining(period.kind, this.addDays(period.from, -1));
  },
  nextPeriod(period) {
    return this.periodContaining(period.kind, this.addDays(period.to, 1));
  },
  // 今日が期間に含まれる（集計途中）
  isInProgress(period, today) {
    return today >= period.from && today <= period.to;
  },
  // 期間の見出し。年をまたぐ期間・今年以外の期間は年も出す。今日を含む期間は「途中経過」を付ける
  label(period, today) {
    const y = (iso) => Number(iso.slice(0, 4));
    const todayYear = today ? y(today) : y(period.from);
    const tail = today && this.isInProgress(period, today) ? "・途中経過" : "";
    if (period.kind === "month") {
      const [yy, mm] = period.from.split("-").map(Number);
      return `${yy}年${mm}月${tail}`;
    }
    const withYear = y(period.from) !== y(period.to) || y(period.from) !== todayYear;
    const fmt = (iso) => (withYear ? `${y(iso)}/${this.mdw(iso)}` : this.mdw(iso));
    return `${fmt(period.from)}〜${fmt(period.to)}${tail}`;
  },

  // さかのぼれる最も古い日付：体重・体組成（dailyRecords）・たんぱく質・注射（投与済み／見送り）・体調・月経のいずれかの
  // 最も古い記録、または利用開始日。どれも無ければ today
  earliestDate(state, today) {
    const s = state || {};
    const cands = [];
    const add = (d) => {
      if (this.isYmd(d)) cands.push(d);
    };
    for (const r of s.dailyRecords || []) if (r) add(r.date);
    for (const e of s.proteinEntries || []) if (e) add(e.date);
    for (const e of s.conditionEntries || []) if (e) add(e.date);
    for (const e of s.cycleEntries || []) if (e) add(e.startDate);
    for (const r of s.injections || []) {
      if (!r) continue;
      if (r.status === "administered") add(r.administeredAt);
      else if (r.status === "skipped") add(r.regularDate || r.scheduledAt);
    }
    if (s.profile) add(s.profile.startDate);
    if (!cands.length) return today;
    cands.sort();
    return cands[0] < today ? cands[0] : today;
  },
  canGoPrev(state, period, today) {
    return this.prevPeriod(period).to >= this.earliestDate(state, today);
  },
  // 未来の期間には進めない
  canGoNext(period, today) {
    return this.nextPeriod(period).from <= today;
  },
  // 未来の期間・不正な期間は、今日を含む期間に戻す
  normalizePeriod(period, kind, today) {
    if (!period || period.kind !== kind || !this.isYmd(period.from) || !this.isYmd(period.to) || period.from > today) {
      return this.periodContaining(kind, today);
    }
    return period;
  },

  // ============ 体重 ============

  // 期間内の有効な体重（日付昇順。1日1件）
  weightPoints(state, from, to) {
    const byDate = new Map();
    for (const r of (state && state.dailyRecords) || []) {
      if (!r || !this.isYmd(r.date) || r.date < from || r.date > to) continue;
      if (!this._validNum(r.weight)) continue;
      byDate.set(r.date, r.weight);
    }
    return [...byDate.keys()].sort().map((date) => ({ date, value: byDate.get(date) }));
  },
  _weightStats(points) {
    const n = points.length;
    if (n === 0) return { n: 0, avg: null, min: null, max: null, first: null, last: null };
    let sum = 0;
    let min = points[0];
    let max = points[0];
    for (const p of points) {
      sum += p.value;
      if (p.value < min.value) min = p;
      if (p.value > max.value) max = p;
    }
    return { n, avg: sum / n, min: { ...min }, max: { ...max }, first: { ...points[0] }, last: { ...points[n - 1] } };
  },
  minDays(kind) {
    return kind === "month" ? this.MONTH_MIN_DAYS : this.WEEK_MIN_DAYS;
  },

  // ============ 各項目の集計 ============

  _compositionField(key) {
    const f = typeof COMPOSITION_FIELDS !== "undefined" ? COMPOSITION_FIELDS.find((x) => x.key === key) : null;
    return f || { key, label: key, unit: "", decimals: 1 };
  },
  // 記録された値だけ（推定しない）。無い日は含めない
  compositionPoints(state, key, from, to) {
    const byDate = new Map();
    for (const r of (state && state.dailyRecords) || []) {
      if (!r || !this.isYmd(r.date) || r.date < from || r.date > to) continue;
      const v = r.bodyComposition ? r.bodyComposition[key] : null;
      if (this._validNum(v)) byDate.set(r.date, v);
    }
    return [...byDate.keys()].sort().map((date) => ({ date, value: byDate.get(date) }));
  },
  _compositionSummary(state, from, to) {
    const fields = this.COMPOSITION_KEYS.map((key) => {
      const f = this._compositionField(key);
      const points = this.compositionPoints(state, key, from, to);
      const values = points.map((p) => p.value);
      return {
        key,
        label: f.label,
        unit: f.unit,
        decimals: f.decimals,
        points,
        count: points.length,
        first: points.length ? { ...points[0] } : null,
        last: points.length ? { ...points[points.length - 1] } : null,
        min: values.length ? Math.min(...values) : null,
        max: values.length ? Math.max(...values) : null,
      };
    });
    // 体組成を1項目でも記録した日の数（全16項目のうち、値が入っている日）
    let recordedDays = 0;
    for (const r of (state && state.dailyRecords) || []) {
      if (!r || !this.isYmd(r.date) || r.date < from || r.date > to || !r.bodyComposition) continue;
      const has = Object.keys(r.bodyComposition).some((k) => {
        const v = r.bodyComposition[k];
        return v != null && v !== "" && !(typeof v === "number" && !Number.isFinite(v));
      });
      if (has) recordedDays++;
    }
    return { recordedDays, fields };
  },

  _proteinSummary(state, from, to) {
    const entries = (state && state.proteinEntries) || [];
    const dates = new Set();
    for (const e of entries) if (e && this.isYmd(e.date) && e.date >= from && e.date <= to) dates.add(e.date);
    const target = state && state.profile && this._validNum(state.profile.proteinTarget) && state.profile.proteinTarget > 0 ? state.profile.proteinTarget : null;
    const days = [...dates].sort().map((date) => ({ date, total: Calc.proteinTotalForDate(date, entries) }));
    const achievedDays = target == null ? null : days.filter((d) => d.total >= target).length;
    return { target, recordedDays: days.length, achievedDays, days };
  },

  _injectionSummary(state, from, to) {
    const administered = [];
    const skipped = [];
    for (const r of (state && state.injections) || []) {
      if (!r) continue;
      if (r.status === "administered" && this.isYmd(r.administeredAt) && r.administeredAt >= from && r.administeredAt <= to) {
        administered.push({ date: r.administeredAt, time: r.administeredTime || null, dose: this._validNum(r.dose) ? r.dose : null });
      } else if (r.status === "skipped") {
        const d = r.regularDate || r.scheduledAt;
        if (this.isYmd(d) && d >= from && d <= to) skipped.push({ date: d, reason: this.SKIP_REASON_LABELS[r.skipReason] || "見送り" });
      }
    }
    const cmp = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.time || "") < (b.time || "") ? -1 : (a.time || "") > (b.time || "") ? 1 : 0);
    administered.sort(cmp);
    skipped.sort(cmp);
    return { administered, skipped };
  },

  _conditionSummary(state, from, to) {
    const list = ((state && state.conditionEntries) || []).filter((e) => e && this.isYmd(e.date) && e.date >= from && e.date <= to);
    const days = new Set(list.map((e) => e.date));
    const levels = { none: 0, mild: 0, moderate: 0 };
    const symptomCounts = {};
    for (const e of list) {
      const lv = e.level === "severe" ? "moderate" : e.level; // 保存値 severe は「あり」と同じ扱い
      if (lv in levels) levels[lv]++;
      for (const s of Array.isArray(e.symptoms) ? e.symptoms : []) symptomCounts[s] = (symptomCounts[s] || 0) + 1;
    }
    const order = typeof CONDITION_SYMPTOMS !== "undefined" ? CONDITION_SYMPTOMS.map((s) => s.id) : [];
    const ids = Object.keys(symptomCounts).sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
    const symptoms = ids.map((id) => {
      const s = typeof CONDITION_SYMPTOMS !== "undefined" ? CONDITION_SYMPTOMS.find((x) => x.id === id) : null;
      return { id, label: s ? s.label : String(id), count: symptomCounts[id] };
    });
    return { entries: list.length, days: days.size, levels, symptoms };
  },

  // 期間と重なる月経の記録を並べるだけ（周期単位の分析はしない）。endDate が無い記録は「月経中」
  _cycleSummary(state, from, to) {
    return ((state && state.cycleEntries) || [])
      .filter((e) => e && this.isYmd(e.startDate) && e.startDate <= to && (e.endDate == null ? true : e.endDate >= from))
      .sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0))
      .map((e) => ({ startDate: e.startDate, endDate: e.endDate == null ? null : e.endDate, isOpen: e.endDate == null }));
  },

  // BMIがガードレール（21／20）以下、または維持準備・維持モードのとき true。このとき、体重が減ったことを
  // 前向きな進みとして書かない（比べる文を出さない）
  isSoftMode(state, lastWeightInPeriod) {
    const p = (state && state.profile) || {};
    const g = (state && state.goals) || {};
    if (g.mode === "maintenancePrep" || g.mode === "maintenance") return true;
    const alert = this._validNum(p.bmiMaintenanceAlert) ? p.bmiMaintenanceAlert : 21;
    const check = (w) => {
      if (!this._validNum(w)) return false;
      const bmi = Calc.bmi(w, p.heightCm);
      return bmi != null && bmi <= alert;
    };
    let latestAll = null;
    for (const r of (state && state.dailyRecords) || []) {
      if (r && this.isYmd(r.date) && this._validNum(r.weight) && (latestAll == null || r.date > latestAll.date)) latestAll = r;
    }
    return check(lastWeightInPeriod) || check(latestAll && latestAll.weight);
  },

  // 開始からの累計（月刊）。その月で最後に測った体重 − profile.startWeight。startWeight は変更しない
  _sinceStart(state, lastPoint) {
    const start = state && state.profile ? state.profile.startWeight : null;
    if (!this._validNum(start) || start <= 0) return { available: false, reason: "startWeightUnset", startWeight: null };
    if (!lastPoint) return { available: false, reason: "noWeight", startWeight: start };
    return {
      available: true,
      startWeight: start,
      lastWeight: lastPoint.value,
      lastDate: lastPoint.date,
      changeKg: Calc.changeKg(lastPoint.value, start),
      changePct: Calc.changePct(lastPoint.value, start),
    };
  },

  // Goal1/Goal2 への進捗（月刊）。その月で最後に測った体重を「現在」として、HOME（ui.js）と同じ式
  _goalProgress(state, lastPoint) {
    const profile = (state && state.profile) || {};
    const goals = (state && state.goals) || {};
    const rows = [];
    const make = (key, label, goal) => {
      const targetKg = Calc.goalToWeightKg(goal, profile.heightCm);
      if (targetKg == null || !Number.isFinite(targetKg)) return { key, label, status: "noTarget", targetKg: null, remainingKg: null, progressPct: null };
      if (!lastPoint) return { key, label, status: "noData", targetKg, remainingKg: null, progressPct: null };
      const remainingKg = Calc.remainingToGoalKg(lastPoint.value, targetKg);
      let progressPct = null;
      const start = profile.startWeight;
      if (this._validNum(start)) {
        progressPct = 0;
        if (start !== targetKg) {
          progressPct = ((start - lastPoint.value) / (start - targetKg)) * 100;
          progressPct = Math.max(0, Math.min(100, progressPct));
        }
      }
      return { key, label, status: "ok", targetKg, remainingKg, progressPct, reached: remainingKg <= 0 };
    };
    if (goals.goal1) rows.push(make("goal1", "Goal1", goals.goal1));
    if (goals.goal2) rows.push(make("goal2", "Goal2", goals.goal2)); // Goal2 が無ければ行ごと出さない
    return { lastWeight: lastPoint ? { ...lastPoint } : null, rows, note: this.GOAL_NOTE };
  },

  // ============ まとめ ============

  // period: { kind, from, to }。today: "YYYY-MM-DD"。state は読むだけ
  summarize(state, period, today) {
    const t = this.isYmd(today) ? today : this.ymd(new Date());
    const { kind, from, to } = period;
    const isMonth = kind === "month";
    const minDays = this.minDays(kind);

    const points = this.weightPoints(state, from, to);
    const st = this._weightStats(points);
    const prevP = this.prevPeriod(period);
    const prevSt = this._weightStats(this.weightPoints(state, prevP.from, prevP.to));
    const lowCount = st.n < minDays;
    const prevLow = prevSt.n < minDays;
    const diff = st.avg != null && prevSt.avg != null ? st.avg - prevSt.avg : null;

    const firstLast =
      st.n >= 2
        ? { available: true, from: { ...st.first }, to: { ...st.last }, diff: st.last.value - st.first.value }
        : { available: false, from: null, to: null, diff: null };

    const inProgress = this.isInProgress(period, t);
    const softMode = this.isSoftMode(state, st.last ? st.last.value : null);

    const summary = {
      kind,
      from,
      to,
      today: t,
      label: this.label(period, t),
      inProgress,
      minDays,
      softMode,
      days: this.enumerateDays(from, to),
      weight: {
        n: st.n,
        points,
        avg: st.avg,
        min: st.min,
        max: st.max,
        first: st.first,
        last: st.last,
        lowCount,
        lowCountNote: lowCount ? this.LOW_COUNT_NOTE : null,
        prev: { from: prevP.from, to: prevP.to, n: prevSt.n, avg: prevSt.avg, lowCount: prevLow },
        diff,
        diffReferenceOnly: diff != null && (lowCount || prevLow),
      },
      firstLast,
      sinceStart: isMonth ? this._sinceStart(state, st.last) : null,
      goals: isMonth ? this._goalProgress(state, st.last) : null,
      composition: this._compositionSummary(state, from, to),
      protein: this._proteinSummary(state, from, to),
      injections: this._injectionSummary(state, from, to),
      condition: this._conditionSummary(state, from, to),
      cycle: this._cycleSummary(state, from, to),
      softNote: softMode ? this.SOFT_NOTE : null,
      proteinNote: this.PROTEIN_NOTE,
      compositionNote: this.COMPOSITION_NOTE,
      closing: this.CLOSING[kind],
    };
    summary.discoveries = this.generateDiscoveries(summary);
    summary.affirmation = this.generateAffirmation(summary);
    return summary;
  },

  // ============ 「今週／今月のからだの発見」（固定の文の型。最大3文） ============

  _f(v, d) {
    return Number(v).toFixed(d);
  },

  // 最大3文に切る前の、すべての候補（優先順）
  discoveryCandidates(s) {
    const isMonth = s.kind === "month";
    const current = s.inProgress;
    const w = isMonth ? (current ? "今月" : "この月") : current ? "今週" : "この週";
    const prevW = isMonth ? "前の月" : "前の週";
    const n = s.weight.n;
    const out = [];

    // ① 記録を続けたこと
    if (n === 0) out.push(`${w}は体重の記録がありませんでした。`);
    else if (isMonth && n >= this.MONTH_MIN_DAYS) out.push(`${w}は${n}日、記録が続きました。`);
    else out.push(isMonth ? `${w}は${n}日、体重を記録しました。` : `${w}は${n}日、体重を記録できました。`);

    // 集計途中
    if (s.inProgress) out.push(`${w}はまだ途中です。`);

    // 記録が少ないとき：傾向は読み取らない
    if (n > 0 && s.weight.lowCount) out.push(`記録が${n}日分で、${w}の傾向はまだ読み取らずにおきます。`);

    // ② 事実としての数値
    const w0 = s.weight;
    const canCompare = w0.diff != null && !w0.lowCount && !w0.prev.lowCount;
    if (canCompare && !s.softMode) {
      if (Math.abs(w0.diff) < this.SAME_DIFF_KG) out.push(`${w}の平均は${this._f(w0.avg, 2)}kgで、${prevW}とほぼ同じくらいでした。`);
      else out.push(`${w}の平均は${this._f(w0.avg, 2)}kgで、${prevW}より${this._f(Math.abs(w0.diff), 2)}kg${w0.diff < 0 ? "低め" : "高め"}でした。`);
    } else if (canCompare && s.softMode) {
      out.push(`${w}の平均は${this._f(w0.avg, 2)}kgでした。`);
    } else if (n >= 2) {
      out.push(`${w}の体重は${this._f(w0.min.value, 2)}〜${this._f(w0.max.value, 2)}kgの範囲で推移しました。`);
    } else if (n === 1) {
      out.push(`${w}の体重記録は${this._f(w0.first.value, 2)}kgでした。`);
    }

    // たんぱく質（記録日のうち、現在の目標に届いた日）
    const p = s.protein;
    if (p.recordedDays > 0) {
      if (p.target != null) out.push(`たんぱく質は記録日${p.recordedDays}日のうち、現在の目標${p.target}gに${p.achievedDays}日届きました。`);
      else out.push(`たんぱく質は${p.recordedDays}日記録されました。`);
    }

    // 体組成
    if (s.composition.recordedDays > 0) out.push(`体組成は${w}${s.composition.recordedDays}回記録されました。`);

    // 骨格筋量（記録された値が、別々の日に2つ以上あるときだけ）
    const sk = s.composition.fields.find((f) => f.key === "skeletalMuscleMass");
    if (sk && sk.count >= 2) {
      const d = sk.last.value - sk.first.value;
      if (Math.abs(d) < this.SKELETAL_SMALL_DIFF_KG) out.push("骨格筋量は期間の最初と最後で大きな差はありませんでした。");
      else out.push(`骨格筋量は期間の最初が${this._f(sk.first.value, 2)}kg、最後が${this._f(sk.last.value, 2)}kgでした。`);
    }

    // 並べて書く（体重の文とは混ぜない）
    if (s.cycle.length > 0) out.push("この期間には月経の記録があります。");
    if (s.condition.days > 0) out.push(`体調の記録は${s.condition.days}日ありました。`);
    if (s.injections.administered.length > 0) out.push(`注射は${s.injections.administered.length}回記録されています。`);

    return out;
  },

  // 最大3文（優先順：①記録を続けたこと ②事実としての数値 ③同じ期間にあった記録を並べること）
  generateDiscoveries(s) {
    return this.discoveryCandidates(s).slice(0, 3);
  },

  // ============ 肯定メッセージ（週・月に1文。ルールで選ぶだけ。AIは使わない） ============
  // 記録そのもの・続けてきたことを肯定する文だけ。点数・成功失敗・「頑張ったから減った」のような努力との結び付けはしない。
  // 選び方：記録が少ない（週<3日／月<8日）→ 記録できた日を肯定／体重が前の週（月は最初→最新）より減っていて、
  // 記録が十分あり、維持・ガードレール中（softMode）でないとき → 積み重ねを肯定／それ以外で記録が十分 → 記録の積み重ねを肯定。
  // 同じ期間では同じ文になるよう、期間の開始日から文を選ぶ（乱数は使わない）
  AFFIRM_NONE: "記録できた日が増えると、ここで振り返りやすくなります。",
  AFFIRM_FEW: "記録できた日だけでも、からだを振り返る大事な手がかりです。",

  // 「ほぼ同じ」（SAME_DIFF_KG 未満）は減ったことにしない（からだの発見の「ほぼ同じくらい」と食い違わせない。浮動小数の誤差も除く）
  affirmationDecreased(s) {
    if (s.kind === "month") return s.firstLast.available && s.firstLast.diff <= -this.SAME_DIFF_KG;
    return s.weight.diff != null && !s.weight.diffReferenceOnly && s.weight.diff <= -this.SAME_DIFF_KG;
  },

  generateAffirmation(s) {
    const isMonth = s.kind === "month";
    const n = s.weight.n;
    if (n === 0) return this.AFFIRM_NONE;
    if (n < s.minDays) return this.AFFIRM_FEW;
    const w = isMonth ? (s.inProgress ? "今月" : "この月") : s.inProgress ? "今週" : "この週";
    const pick = (list) => {
      const seed = String(s.from).replace(/\D/g, "").split("").reduce((a, c) => a + Number(c), 0);
      return list[seed % list.length];
    };
    if (!s.softMode && this.affirmationDecreased(s)) {
      return pick(["少しずつ積み重ねた変化が、数字にも表れています。", `${w}の記録には、ここまで続けてきた変化が見えています。`]);
    }
    return pick([isMonth ? `${w}も丁寧に記録を重ねられています。` : `${w}もからだの変化をしっかり残せています。`, "変化が見えるくらい、記録が積み上がりました。"]);
  },
};
