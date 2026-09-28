// Body Garden — データモデル定義・初期値
// ハードコード禁止の対象（身長・目標値・BMIガードレール等）は
// すべて profile / goals / proteinProducts / registeredFoods に保持し、
// UI側は必ずこれらを参照する。

const SCHEMA_VERSION = 4;

// 入力バリデーションの範囲（単純な入力ミス防止。医療的な適正範囲判定ではない）
const VALIDATION_RANGES = {
  heightCm: { min: 100, max: 250 },
  weightKg: { min: 20, max: 250 },
  bmi: { min: 10, max: 60 },
  proteinTarget: { min: 0, max: 300 },
  wheyScoops: { min: 0.1, max: 10 },
  foodQty: { min: 0.25, max: 20 },
  mealProteinG: { min: 0.1, max: 200 },
  productServingScoops: { min: 0.1, max: 20 },
  productProteinPerServing: { min: 0.1, max: 200 },
  foodProteinPerUnit: { min: 0.1, max: 200 },
};

const DEFAULT_PROFILE = {
  heightCm: 162,
  startDate: null, // 初回起動日を自動設定（storage.js）
  startWeight: 67.3,
  proteinTarget: 75,
  // BMI21/BMI20はBody Gardenのシステム基準値。Goalのような自由な達成目標ではなく、
  // 「これ以上は積極的に減らさない」ためのガードレール閾値として扱う。
  bmiMaintenanceAlert: 21,
  bmiLowerLine: 20,
};

// goalHistory: [{ id, timestamp, type: 'achieved'|'choiceMade'|'edited', goalKey, detail }]
// BMI21(維持準備アラート)/BMI20(下限ライン)はGoalではないため、ここには混在させない。
//
// mode / maintenanceReason:
// 「Goal達成後に維持を選ぶ」ことと「BMIガードレールから維持準備に入る」ことは
// 意味が異なるため区別する。
//   mode: 'reduction'（通常の減量中） | 'maintenancePrep'（維持準備の説明を見ている状態）
//         | 'maintenance'（維持モード確定）
//   maintenanceReason: null | 'goalChoice' | 'bmi21' | 'bmi20'
//     何をきっかけに現在のmodeになったかを後から区別するための記録。
const DEFAULT_GOALS = {
  goal1: { type: "weight", value: 60, achievedAt: null, postAchievementChoice: null },
  goal2: { type: "weight", value: 57, achievedAt: null, postAchievementChoice: null },
  activeGoal: 1, // 1 | 2
  mode: "reduction",
  maintenanceReason: null,
  goalHistory: [],
};

// BMIガードレールの表示制御用の状態。
// bmi21: 体重記録保存のたびに再判定するため「最後に確認済みの記録日」を持つ
//        （同じ日の再保存で毎回は出さないが、次の新しい記録では再度出しうる）
// bmi20: 生涯で初回到達時のみ表示するため「初めて確認した日時」を持つ
function createDefaultGuardrails() {
  return {
    bmi21: { acknowledgedForDate: null },
    bmi20: { acknowledgedAt: null },
  };
}

// idでの検索共通ヘルパー。DOMのdataset経由で渡るidは常に文字列になるため、
// 数値id（新規追加分）と文字列id（"whey-default"等のシード分）が混在していても
// 一致判定できるようString化して比較する。
function findById(list, id) {
  return (list || []).find((item) => String(item.id) === String(id));
}

// id採番付きリストへの追記で共通に使う（goalHistory, proteinEntries, injections,
// proteinProducts, registeredFoods等）。既存idに"whey-default"のような文字列idが
// 混ざっていても、数値idだけを見て採番する（文字列が混ざるとMath.maxがNaN化するため）。
function nextSequentialId(list) {
  const maxId = (list || []).reduce((max, item) => {
    const id = typeof item.id === "number" ? item.id : 0;
    return Math.max(max, id);
  }, 0);
  return maxId + 1;
}

// 体組成の詳細項目。weight 以外はすべて任意（null許容）。
const EMPTY_BODY_COMPOSITION = {
  bodyFatPct: null,
  muscleMass: null,
  waterPct: null,
  bodyFatMass: null,
  leanMass: null,
  boneMass: null,
  visceralFat: null,
  proteinPct: null,
  skeletalMuscleMass: null,
  subcutaneousFat: null,
  bodyAge: null,
  bmr: null,
};

// dailyRecords は「1日1回の身体スナップショット」の要約のみを持つ。
// Protein・体調は1日に複数回記録されうるため、別テーブル（proteinEntries /
// conditionEntries）の個別イベントとして持ち、dailyRecordsには含めない。
// BMI / changeKg / changePct / elapsedDays は保存せず calc.js で都度算出する。
function createEmptyDailyRecord(date) {
  return {
    date, // "YYYY-MM-DD"
    weight: null,
    bodyComposition: { ...EMPTY_BODY_COMPOSITION },
    comment: "",
  };
}

// proteinEntriesは「記録時点のsnapshot」を保持する。
// 商品マスター（proteinProducts/registeredFoods）を後から編集・archiveしても、
// 過去に記録したProtein量・表示名は変化しない（マスターの現在値を都度参照しない）。
//
// sourceType: 'whey' | 'food' | 'meal'
//   whey: sourceId=商品id, quantity=scoops, unitProtein=記録時のproteinPerServing,
//         servingScoops=記録時のservingScoops
//   food: sourceId=食品id, quantity=数量(個数等), unitProtein=記録時のproteinPerUnit
//   meal: sourceId=null, quantity=null, unitProtein=null, memoに自由記述
// proteinTotal は記録時に計算したProtein量(g)そのもの（都度再計算しない一次データ）。
function createProteinEntrySnapshot({ date, time, sourceType, sourceId, sourceName, quantity, unitProtein, servingScoops, proteinTotal, memo }) {
  return {
    id: null, // storage.js で採番
    date,
    time: time || null,
    sourceType,
    sourceId: sourceId ?? null,
    sourceName: sourceName ?? null,
    quantity: quantity ?? null,
    unitProtein: unitProtein ?? null,
    servingScoops: servingScoops ?? null,
    proteinTotal,
    memo: memo || null,
    createdAt: new Date().toISOString(),
  };
}

function createConditionEntry(date) {
  return {
    id: null, // storage.js で採番
    date,
    time: null, // "HH:MM"（任意）
    level: null, // 'none' | 'mild' | 'moderate' | 'severe'
    symptoms: [], // ['nausea','indigestion','constipation','diarrhea','abdominalPain','appetiteLoss','other']
    comment: "",
    createdAt: new Date().toISOString(),
  };
}

// 予定日(scheduledAt)と実施日(administeredAt)は必ず別フィールドに保持する。
// status: 'scheduled' | 'administered' | 'skipped'
function createEmptyInjection() {
  return {
    id: null, // storage.js で採番
    scheduledAt: null,
    administeredAt: null,
    dose: null,
    status: "scheduled",
    comment: "",
  };
}

// status: 'active' | 'archived'。使用済み商品は物理削除せずarchiveする（過去記録保護のため）。
// isDefault: ACTIVEな商品が複数ある場合に自動選択される既定商品（常に高々1件のみtrue）。
const DEFAULT_PROTEIN_PRODUCTS = [
  { id: "whey-default", name: "ホエイプロテイン", servingScoops: 3, proteinPerServing: 20.8, status: "active", isDefault: true },
];

const DEFAULT_REGISTERED_FOODS = [
  { id: "food-oikos", name: "オイコス（プレーン）", unit: "個", proteinPerUnit: 10, status: "active" },
];

function createDefaultState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    profile: { ...DEFAULT_PROFILE },
    goals: JSON.parse(JSON.stringify(DEFAULT_GOALS)),
    dailyRecords: [], // createEmptyDailyRecord() の配列。date昇順を保証しない（storage側でソート）
    proteinEntries: [], // createProteinEntry() の配列。1日に複数件持てる
    conditionEntries: [], // createConditionEntry() の配列。1日に複数件持てる
    guardrails: createDefaultGuardrails(),
    injections: [],
    proteinProducts: JSON.parse(JSON.stringify(DEFAULT_PROTEIN_PRODUCTS)),
    registeredFoods: JSON.parse(JSON.stringify(DEFAULT_REGISTERED_FOODS)),
    ui: {
      lastScreen: "home",
    },
  };
}

const IMAGE_ASSETS = {
  heroMorning: "assets/body-garden/hero-morning.webp",
  heroMaintenance: "assets/body-garden/hero-maintenance.webp",
  brandSymbol: "assets/body-garden/brand-symbol.png",
  iconWeight: "assets/body-garden/icon-weight.png",
  iconProtein: "assets/body-garden/icon-protein.png",
  iconInjection: "assets/body-garden/icon-injection.png",
  iconCondition: "assets/body-garden/icon-condition.png",
  iconComposition: "assets/body-garden/icon-composition.png",
  iconRecord: "assets/body-garden/icon-record.png",
  milestoneGoal1: "assets/body-garden/milestone-goal1.png",
  milestoneGoal2: "assets/body-garden/milestone-goal2.png",
  milestoneMaintenance: "assets/body-garden/milestone-maintenance.png",
};

const CONDITION_SYMPTOMS = [
  { id: "nausea", label: "悪心" },
  { id: "indigestion", label: "胃もたれ" },
  { id: "constipation", label: "便秘" },
  { id: "diarrhea", label: "下痢" },
  { id: "abdominalPain", label: "腹痛" },
  { id: "appetiteLoss", label: "食欲低下" },
  { id: "other", label: "その他" },
];
