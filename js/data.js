// Body Garden — データモデル定義・初期値
// ハードコード禁止の対象（身長・目標値・BMIガードレール等）は
// すべて profile / goals / proteinProducts / registeredFoods に保持し、
// UI側は必ずこれらを参照する。

const SCHEMA_VERSION = 5;

// ============ 注射管理の定数 ============
// 製剤規格（マンジャロ皮下注アテオス、各0.5mL）。出典: 日本イーライリリー電子添付文書
// https://medical.lilly.com/jp/mounjaro/mounjaro-package-insert（2026年9月改訂 第11版）、KEGG(JAPIC)。
// 2026-10-01 に一次情報で再照合済み。選択式で、自由入力はしない。アプリは増量・減量を勧めない。
const INJECTION_DOSE_OPTIONS_MG = [2.5, 5, 7.5, 10, 12.5, 15];
const INJECTION_INITIAL_DOSE_MG = 2.5; // 入力画面の初期選択。推奨用量ではない
// 電子添付文書 7.2: 投与を忘れた場合・投与曜日を変更する場合の「3日間（72時間）」
const INJECTION_THRESHOLD_MS = 72 * 60 * 60 * 1000;
// 電子添付文書 7.1: 週1回投与（同一曜日）
const INJECTION_CYCLE_DAYS = 7;
// アプリ独自の注意表示基準（添付文書の基準ではなく、再開可否の判断基準でもない）
const INJECTION_LONG_GAP_DAYS = 28;
// 予定日として登録できる範囲（入力ミス防止。医療上の基準ではない）
const INJECTION_SCHEDULE_MAX_DAYS_AHEAD = 90;
const INJECTION_COMMENT_MAX = 500;
// 手持ちの注射の本数（初期在庫）。入庫・購入の管理はしない。実際の投与記録（1回につき1本）から残りを計算する
const INJECTION_STOCK_INITIAL_PENS = 24;

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

// 注射の1件分の記録（v5）。予定日(scheduledAt)と実施日(administeredAt)は必ず別フィールドに保持する。
//
// status（状態）: 'scheduled'（予定。未投与）| 'administered'（実際に投与した記録）| 'skipped'（見送りの記録）
// kind（種別。statusとは別の軸）:
//   'regular'      定例の系列にある回
//   'oneOffChange' 定例回の日程を、その1回だけ変更した予定（regularDateは元の定例日のまま）
//   'makeup'       打ち忘れ後の臨時投与（定例曜日は変わらない）
//   'manual'       定例スケジュールに紐づかない記録・予定
//   'legacy'       v4以前から引き継いだ記録
// regularDate: この記録が属する定例日。定例曜日を変更しても、過去の記録の解釈は変わらない。
// scheduledTime / administeredTime: "HH:MM" または null（時刻不明は許容）。
// skipReason: 'missedUnder72h' | 'missedUnknown' | 'userChoice'（本人が確認して記録した見送りのみ）
// missedCheck: 見送りを記録した時点の72時間判定のスナップショット（後から確認するため）
function createEmptyInjection() {
  return {
    id: null, // storage.js で採番
    status: "scheduled",
    kind: "manual",
    regularDate: null,
    scheduledAt: null,
    scheduledTime: null,
    administeredAt: null,
    administeredTime: null,
    dose: null, // mg（INJECTION_DOSE_OPTIONS_MG のいずれか）
    doseConfirmedDifferent: false,
    skipReason: null,
    missedCheck: null,
    scheduleVersionId: null,
    // 在庫（使用本数）への数え方。null＝通常（投与済みなら1本として数える）、
    // 'review'＝在庫の設定時点ですでにあった投与記録。実記録かテスト用か判別できないため、本人が確認するまで数えない、
    // 'counts'＝本人が「使用した分」と確認した、'excluded'＝本人が「使用本数に含めない」と確認した
    stockCount: null,
    comment: "",
    createdAt: null,
    updatedAt: null,
  };
}

// 在庫（残本数）の設定。残りは保存せず、投与記録（status='administered'）から毎回計算する
// （投与のたびに数値を減らすと、二重減算・修正や削除との食い違いが起きるため）。
//   initialPens: 初期在庫（本）。実際の使用済みは0本から数え始める。
function createDefaultInjectionStock() {
  return { initialPens: INJECTION_STOCK_INITIAL_PENS, setupAt: null };
}

// 在庫の設定がまだ無い状態（v4からの移行・開発中のv5データ）に、初期値を入れる。
// このとき既にある「投与済み」の記録は、実記録かテスト用か判別できないので、24本から自動で差し引かず、
// stockCount='review'（本人が確認するまで数えない）にする。既存の記録は削除も上書きもしない。
function applyStockBaseline(state, nowIso) {
  if (state.injectionStock) return state;
  state.injectionStock = createDefaultInjectionStock();
  state.injectionStock.setupAt = nowIso || new Date().toISOString();
  for (const rec of Array.isArray(state.injections) ? state.injections : []) {
    if (rec && rec.status === "administered" && (rec.stockCount === undefined || rec.stockCount === null)) rec.stockCount = "review";
  }
  return state;
}

// 定例スケジュール（ルール）。定例予定日そのものは保存せず、ここから導出する。
//   regular: { id, weekday(0=日〜6=土), time("HH:MM"|null), effectiveFrom("YYYY-MM-DD") } | null
//   baseDoseMg: 用量の基準（未設定なら直近の投与の用量にフォールバック）
//   history: 定例の設定・曜日変更・時刻変更の履歴（変更時の72時間判定の結果つき）
function createDefaultInjectionSchedule() {
  return { regular: null, baseDoseMg: null, history: [] };
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
    injections: [], // createEmptyInjection() の配列
    injectionSchedule: createDefaultInjectionSchedule(),
    injectionStock: createDefaultInjectionStock(),
    proteinProducts: JSON.parse(JSON.stringify(DEFAULT_PROTEIN_PRODUCTS)),
    registeredFoods: JSON.parse(JSON.stringify(DEFAULT_REGISTERED_FOODS)),
    ui: {
      lastScreen: "home",
    },
  };
}

const IMAGE_ASSETS = {
  heroMorning: "assets/body-garden/hero-morning.webp",
  heroMorningDesktop: "assets/body-garden/hero-morning-desktop.png",
  heroMaintenance: "assets/body-garden/hero-maintenance.webp",
  brandSymbol: "assets/body-garden/brand-symbol.png",
  iconWeight: "assets/body-garden/icon-weight.png",
  iconProtein: "assets/body-garden/icon-protein.png",
  iconInjection: "assets/body-garden/icon-injection.png",
  iconCondition: "assets/body-garden/icon-condition.png",
  iconComposition: "assets/body-garden/icon-composition.png",
  iconRecord: "assets/body-garden/icon-record.png",
  iconSettings: "assets/body-garden/icon-settings.png",
  iconLowerLine: "assets/body-garden/icon-lower-line.png",
  iconGoal1: "assets/body-garden/icon-goal1.png",
  iconGoal2: "assets/body-garden/icon-goal2.png",
  iconMaintenance: "assets/body-garden/icon-maintenance.png",
  iconHome: "assets/body-garden/icon-home.png",
  decoWeightBouquet: "assets/body-garden/deco-weight-bouquet.png",
  decoInjectionVase: "assets/body-garden/deco-injection-vase.png",
  decoYurariFigure: "assets/body-garden/deco-yurari-figure.png",
  decoEnisha: "assets/body-garden/deco-enisha.png",
  homeBgDesktopNoDog: "assets/body-garden/home-bg-desktop-no-dog-v1.png",
  homeBgMobile: "assets/body-garden/home-bg-mobile-v1.png",
  homeBgDesktop: "assets/body-garden/home-bg-desktop-v1.png",
  foodWhey: "assets/body-garden/food-whey.png",
  foodOikos: "assets/body-garden/food-oikos.png",
  foodMeal: "assets/body-garden/food-meal.png",
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
