// Body Garden — Protein関連の業務ロジック
// 商品マスター（proteinProducts/registeredFoods）の現在値からエントリを作る際は
// ここでsnapshotを確定する。一度作られたエントリはマスターの変更・archiveの影響を
// 受けない（過去の摂取量は不変）。

const ProteinLogic = {
  activeProducts(state) {
    return state.proteinProducts.filter((p) => p.status === "active");
  },
  activeFoods(state) {
    return state.registeredFoods.filter((f) => f.status === "active");
  },

  // 選択不要にできるデフォルト商品（ACTIVEが1件ならそれ、複数ならisDefaultのもの）
  defaultProduct(state) {
    const active = this.activeProducts(state);
    if (active.length === 1) return active[0];
    return active.find((p) => p.isDefault) || active[0] || null;
  },

  createWheyEntry(state, date, productId, scoops) {
    const product = findById(state.proteinProducts, productId);
    if (!product) return null;
    const proteinTotal = Calc.round1((scoops / product.servingScoops) * product.proteinPerServing);
    return createProteinEntrySnapshot({
      date,
      sourceType: "whey",
      sourceId: product.id,
      sourceName: product.name,
      quantity: scoops,
      unitProtein: product.proteinPerServing,
      servingScoops: product.servingScoops,
      proteinTotal,
    });
  },

  createFoodEntry(state, date, foodId, qty) {
    const food = findById(state.registeredFoods, foodId);
    if (!food) return null;
    const proteinTotal = Calc.round1(food.proteinPerUnit * qty);
    return createProteinEntrySnapshot({
      date,
      sourceType: "food",
      sourceId: food.id,
      sourceName: food.name,
      quantity: qty,
      unitProtein: food.proteinPerUnit,
      proteinTotal,
    });
  },

  createMealEntry(date, name, proteinG, memo) {
    return createProteinEntrySnapshot({
      date,
      sourceType: "meal",
      sourceName: name,
      proteinTotal: Calc.round1(proteinG),
      memo,
    });
  },

  // 編集時：エントリ自身が保持するsnapshot比率(unitProtein/servingScoops)で再計算する。
  // 現在の商品マスターは参照しない（マスターが変わっていても記録時のレートを使う）。
  recalcEntryTotal(entry) {
    if (entry.sourceType === "whey") {
      return Calc.round1((entry.quantity / entry.servingScoops) * entry.unitProtein);
    }
    if (entry.sourceType === "food") {
      return Calc.round1(entry.quantity * entry.unitProtein);
    }
    return entry.proteinTotal; // meal: proteinTotal自体が直接入力値
  },

  isProductUsed(state, productId) {
    return state.proteinEntries.some((e) => e.sourceType === "whey" && String(e.sourceId) === String(productId));
  },
  isFoodUsed(state, foodId) {
    return state.proteinEntries.some((e) => e.sourceType === "food" && String(e.sourceId) === String(foodId));
  },

  // ============ トレンド（記録タブ：読み取り専用の日別推移） ============
  // 既存のproteinEntriesを読むだけ。保存・schema変更は一切しない。
  // 「件数0＝未記録」で判定する（合計値だけでは「未記録」と「0gと記録された」が
  // 区別できないため）。未記録日はnull（0へ補完しない）

  _ymd(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  },
  _addDays(iso, n) {
    const [y, m, d] = iso.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + n);
    return this._ymd(dt);
  },
  _enumerateDays(startIso, endIso) {
    const [y1, m1, d1] = startIso.split("-").map(Number);
    const [y2, m2, d2] = endIso.split("-").map(Number);
    const out = [];
    for (let dt = new Date(y1, m1 - 1, d1), end = new Date(y2, m2 - 1, d2); dt <= end; dt.setDate(dt.getDate() + 1)) {
      out.push(this._ymd(dt));
    }
    return out;
  },

  // 記録のある日だけを、日付昇順で返す（件数>0の日だけ。whey/food/mealは区別せず合算）
  trendPoints(state) {
    const byDate = new Map();
    for (const e of state.proteinEntries || []) {
      if (!e || !e.date) continue;
      byDate.set(e.date, (byDate.get(e.date) || 0) + 1);
    }
    return [...byDate.keys()]
      .sort()
      .map((date) => ({ date, value: Calc.proteinTotalForDate(date, state.proteinEntries) }));
  },

  // 表示期間（"7"|"30"|"all"）の日付列と、その範囲内の値（未記録日はnull＝0に補完しない）
  trendSeries(state, range, now = new Date()) {
    const points = this.trendPoints(state);
    if (points.length === 0) return { points: [], days: [], data: [] };
    const today = this._ymd(now);
    const lastDate = points[points.length - 1].date;
    const endDate = lastDate > today ? lastDate : today;
    const period = range === "7" || range === "30" ? Number(range) : null;
    const startDate = period ? this._addDays(today, -(period - 1)) : points[0].date;
    const days = this._enumerateDays(startDate, period ? today : endDate);
    const inWindow = points.filter((p) => p.date >= days[0] && p.date <= days[days.length - 1]);
    const byDay = {};
    inWindow.forEach((p) => (byDay[p.date] = p.value));
    const data = days.map((d) => (d in byDay ? byDay[d] : null));
    return { points: inWindow, days, data };
  },
};
