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
};
