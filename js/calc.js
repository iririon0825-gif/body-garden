// Body Garden — 計算ロジック
// dailyRecords / profile の一次データから毎回算出する値をここに集約する。
// 「保存値と算出値の不整合」を避けるため、changeKg/changePct/BMI/elapsedDaysは
// このモジュール経由でのみ取得し、state側には保存しない。

const Calc = {
  // BMI = 体重kg ÷ (身長m × 身長m)
  bmi(weightKg, heightCm) {
    if (weightKg == null || !heightCm) return null;
    const heightM = heightCm / 100;
    return weightKg / (heightM * heightM);
  },

  // 指定BMIに対応する体重(kg)を身長から逆算
  weightForBmi(bmiValue, heightCm) {
    if (bmiValue == null || !heightCm) return null;
    const heightM = heightCm / 100;
    return bmiValue * heightM * heightM;
  },

  // goal(type: 'weight'|'bmi', value) を体重kgに正規化
  goalToWeightKg(goal, heightCm) {
    if (!goal) return null;
    if (goal.type === "weight") return goal.value;
    if (goal.type === "bmi") return this.weightForBmi(goal.value, heightCm);
    return null;
  },

  // goal(type: 'weight'|'bmi', value) をBMIに正規化
  goalToBmi(goal, heightCm) {
    if (!goal) return null;
    if (goal.type === "bmi") return goal.value;
    if (goal.type === "weight") return this.bmi(goal.value, heightCm);
    return null;
  },

  changeKg(currentWeight, startWeight) {
    if (currentWeight == null || startWeight == null) return null;
    return currentWeight - startWeight;
  },

  changePct(currentWeight, startWeight) {
    if (currentWeight == null || !startWeight) return null;
    return ((currentWeight - startWeight) / startWeight) * 100;
  },

  remainingToGoalKg(currentWeight, goalWeightKg) {
    if (currentWeight == null || goalWeightKg == null) return null;
    return currentWeight - goalWeightKg;
  },

  elapsedDays(startDateStr, todayDateStr) {
    if (!startDateStr) return null;
    const start = new Date(startDateStr + "T00:00:00");
    const today = new Date((todayDateStr || todayISODate()) + "T00:00:00");
    const diffMs = today.getTime() - start.getTime();
    return Math.floor(diffMs / (1000 * 60 * 60 * 24)) + 1; // 開始日を DAY 1 とする
  },

  // 指定日のタンパク質合計(g)。各エントリのproteinTotalは記録時点のsnapshotであり、
  // 商品マスターの現在値を都度参照しない（マスター編集で過去合計が変わらないようにするため）
  proteinTotalForDate(date, proteinEntries) {
    const total = (proteinEntries || [])
      .filter((e) => e.date === date)
      .reduce((sum, e) => sum + (e.proteinTotal || 0), 0);
    return Math.round(total * 10) / 10;
  },

  round1(value) {
    return Math.round(value * 10) / 10;
  },

  // 指定日の体調記録一覧（複数件ありうる。時系列順）
  conditionEntriesForDate(date, conditionEntries) {
    return (conditionEntries || [])
      .filter((e) => e.date === date)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  },

  // 最新の体重を持つ記録を取得（weightがnullの記録は無視）
  latestWeightRecord(dailyRecords) {
    const withWeight = (dailyRecords || []).filter((r) => r.weight != null);
    if (withWeight.length === 0) return null;
    return withWeight.reduce((latest, r) => (r.date > latest.date ? r : latest));
  },

  // Body Gardenは減量方向のGoalのみを扱うため、達成 = 現在体重が目標体重以下
  isGoalAchieved(currentWeight, goal, heightCm) {
    if (currentWeight == null || !goal) return false;
    const goalWeight = this.goalToWeightKg(goal, heightCm);
    if (goalWeight == null) return false;
    return currentWeight <= goalWeight;
  },

  // Goal2はGoal1よりさらに減らす方向（体重換算で小さい）場合のみ有効
  isGoal2DirectionValid(goal1, goal2, heightCm) {
    if (!goal1 || !goal2) return true; // goal2未設定なら判定不要
    const w1 = this.goalToWeightKg(goal1, heightCm);
    const w2 = this.goalToWeightKg(goal2, heightCm);
    if (w1 == null || w2 == null) return true;
    return w2 < w1;
  },

  isFutureDate(dateStr, todayDateStr) {
    if (!dateStr) return false;
    return dateStr > (todayDateStr || todayISODate());
  },
};

function todayISODate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
