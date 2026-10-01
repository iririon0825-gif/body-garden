// Body Garden — テスト共通: ブラウザ用のグローバルスクリプトを vm に読み込み、偽の localStorage で動かす。
// 実データには一切触れない（すべてメモリ上のダミー）。

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const JS_DIR = path.join(__dirname, "..", "js");

class FakeStorage {
  constructor() {
    this.map = new Map();
    this.failSetKeys = new Set(); // これらのキーへの setItem は例外
    this.failAllSet = false;
    this.setCalls = [];
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.setCalls.push(k);
    if (this.failAllSet || this.failSetKeys.has(k)) throw new Error("QuotaExceededError (fake)");
    this.map.set(k, String(v));
  }
  removeItem(k) {
    this.map.delete(k);
  }
}

function loadEnv() {
  const ls = new FakeStorage();
  const ctx = vm.createContext({
    localStorage: ls,
    console: { log() {}, warn() {}, error() {} },
    TextEncoder,
    Date,
    JSON,
    Math,
  });
  for (const f of ["data.js", "calc.js", "storage.js", "logic.js", "protein-logic.js", "injection-logic.js", "body-composition-logic.js", "condition-logic.js", "backup.js"]) {
    vm.runInContext(fs.readFileSync(path.join(JS_DIR, f), "utf8"), ctx, { filename: f });
  }
  const get = (expr) => vm.runInContext(expr, ctx);
  return { ls, ctx, get, Backup: get("Backup"), Storage: get("Storage"), STORAGE_KEY: get("STORAGE_KEY") };
}

// 実データ相当のダミー状態（v5）
function sampleState(env) {
  const s = env.get("createDefaultState()");
  s.profile.startDate = "2026-09-29";
  s.dailyRecords = [
    { date: "2026-09-29", weight: 67.3, bodyComposition: { bodyFatPct: null, muscleMass: 40.5 }, comment: "" },
    { date: "2026-09-30", weight: 66.9, bodyComposition: {}, comment: "メモ <b>強調</b>" },
    { date: "2026-10-01", weight: 66.2, comment: "" },
  ];
  s.proteinEntries = [
    { id: 1, date: "2026-10-01", time: "08:10", sourceType: "whey", sourceId: "whey-default", sourceName: "ホエイプロテイン", quantity: 3, unitProtein: 20.8, servingScoops: 3, proteinTotal: 20.8, memo: null, createdAt: "2026-10-01T08:10:00.000Z" },
    { id: 2, date: "2026-10-01", time: null, sourceType: "meal", sourceId: null, sourceName: "サラダチキン", quantity: null, unitProtein: null, servingScoops: null, proteinTotal: 24, memo: "半分", createdAt: "2026-10-01T12:00:00.000Z" },
  ];
  s.conditionEntries = [{ id: 1, date: "2026-10-01", time: "21:10", level: "mild", symptoms: ["nausea"], comment: "", createdAt: "2026-10-01T12:10:00.000Z" }];
  s.injections = [Object.assign(env.get("createEmptyInjection()"), { id: 1, scheduledAt: "2026-10-08", regularDate: "2026-10-08", scheduledTime: "09:00", kind: "regular", status: "scheduled" })];
  s.injectionSchedule = { regular: { id: 1, weekday: 4, time: "09:00", effectiveFrom: "2026-10-08" }, baseDoseMg: null, history: [{ id: 1, changedAt: "2026-10-01T00:00:00.000Z", type: "set", from: null, to: { weekday: 4, time: "09:00", effectiveFrom: "2026-10-08" }, check: null, replacedScheduledId: null }] };
  s.goals.goalHistory = [{ id: 1, timestamp: "2026-10-01T00:00:00.000Z", type: "achieved", goalKey: "goal1", detail: { date: "2026-10-01", weight: 66.2 } }];
  return s;
}

const clone = (o) => JSON.parse(JSON.stringify(o));

function exportText(env, state, now) {
  return env.Backup.serialize(state, now || new Date("2026-10-01T12:00:00Z"));
}

function envelopeOf(env, state) {
  return clone(JSON.parse(exportText(env, state)));
}

module.exports = { FakeStorage, loadEnv, sampleState, clone, exportText, envelopeOf };
