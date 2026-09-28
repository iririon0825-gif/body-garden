// Body Garden — データモデル定義・初期値
// ハードコード禁止の対象（身長・目標値・BMIガードレール等）は
// すべて profile / goals / proteinProducts / registeredFoods に保持し、
// UI側は必ずこれらを参照する。

const SCHEMA_VERSION = 2;

const DEFAULT_PROFILE = {
  heightCm: 162,
  startDate: null, // 初回起動日を自動設定（storage.js）
  startWeight: 67.3,
  proteinTarget: 75,
  bmiMaintenanceAlert: 21,
  bmiLowerLine: 20,
};

// goalHistory: [{ id, timestamp, type: 'achieved'|'choiceMade'|'edited', goalKey, detail }]
// BMI21(維持準備アラート)/BMI20(下限ライン)はGoalではないため、ここには混在させない。
const DEFAULT_GOALS = {
  goal1: { type: "weight", value: 60, achievedAt: null, postAchievementChoice: null },
  goal2: { type: "weight", value: 57, achievedAt: null, postAchievementChoice: null },
  activeGoal: 1, // 1 | 2
  maintenanceMode: false, // BMI21アラートから「リバウンド対策を見る」で true
  goalHistory: [],
};

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

// source: 'whey' | 'food' | 'meal'
// whey  : { wheyProductId, scoops }
// food  : { foodId, qty }
// meal  : { name, proteinG, memo }
function createProteinEntry(date, source) {
  return {
    id: null, // storage.js で採番
    date,
    time: null, // "HH:MM"（任意）
    source,
    wheyProductId: null,
    scoops: null,
    foodId: null,
    qty: null,
    name: null,
    proteinG: null,
    memo: null,
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

const DEFAULT_PROTEIN_PRODUCTS = [
  { id: "whey-default", name: "ホエイプロテイン", servingScoops: 3, proteinPerServing: 20.8 },
];

const DEFAULT_REGISTERED_FOODS = [
  { id: "food-oikos", name: "オイコス（プレーン）", unit: "個", proteinPerUnit: 10 },
];

function createDefaultState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    profile: { ...DEFAULT_PROFILE },
    goals: JSON.parse(JSON.stringify(DEFAULT_GOALS)),
    dailyRecords: [], // createEmptyDailyRecord() の配列。date昇順を保証しない（storage側でソート）
    proteinEntries: [], // createProteinEntry() の配列。1日に複数件持てる
    conditionEntries: [], // createConditionEntry() の配列。1日に複数件持てる
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
