// 注射ロジックのテスト共通: 状態の組み立てと日時の生成
const { loadEnv } = require("./helpers");

// 月は1始まり。ミリ秒まで指定できる（ローカル時刻）
const D = (y, m, d, h = 0, mi = 0, s = 0, ms = 0) => new Date(y, m - 1, d, h, mi, s, ms);

function setup() {
  const env = loadEnv();
  const L = env.get("InjectionLogic");
  const T = env.get("INJECTION_THRESHOLD_MS");
  return { env, L, T };
}

// 定例: 水曜(3) 09:00、2026-09-30(水)から。2026-10-07・10-14・10-21 も水曜
function stateWith(env, { weekday = 3, time = "09:00", effectiveFrom = "2026-09-30", regular = true } = {}) {
  const s = env.get("createDefaultState()");
  s.profile.startDate = "2026-09-01";
  if (regular) {
    s.injectionSchedule.regular = { id: 1, weekday, time, effectiveFrom };
    s.injectionSchedule.history = [{ id: 1, changedAt: "2026-09-30T00:00:00.000Z", type: "set", from: null, to: { weekday, time, effectiveFrom }, check: null, replacedScheduledId: null }];
  }
  return s;
}

function rec(env, s, fields) {
  const r = Object.assign(env.get("createEmptyInjection()"), { id: s.injections.length + 1 }, fields);
  s.injections.push(r);
  return r;
}
// 投与済み（実施日と時刻は別フィールド）
function admin(env, s, date, time, extra = {}) {
  return rec(env, s, { status: "administered", kind: "regular", regularDate: date, administeredAt: date, administeredTime: time, dose: 2.5, ...extra });
}
function sched(env, s, date, time, extra = {}) {
  return rec(env, s, { status: "scheduled", kind: "regular", regularDate: date, scheduledAt: date, scheduledTime: time, ...extra });
}
const clone = (o) => JSON.parse(JSON.stringify(o));

module.exports = { D, setup, stateWith, rec, admin, sched, clone };
