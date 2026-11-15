// Google Sheets 自動バックアップのテスト用ヘルパー。すべてメモリ上のダミー（実際の通信・Googleには一切つながない）。

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const nodeCrypto = require("node:crypto");
const { loadEnv } = require("./helpers");

const ROOT = path.join(__dirname, "..");
const ENDPOINT = "https://script.google.com/macros/s/AKfycbTEST_dummy-id/exec";
const CONN_KEY = "test-conn-key-0123456789";

// Apps Script が返す応答（CORS で読める場合）の偽物
function readable(obj, status = 200) {
  return { ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(obj); } };
}

// ブラウザ側（js/sheets-sync.js）を、偽のタイマー・fetch・オンライン状態つきで読み込む。
// mode: 通信方式の記録。"cors"（応答を読める。既定）／"blind"（読めない）／null（まだ分からない）
function setupClient({ configured = true, enabled = true, online = true, mode = "cors" } = {}) {
  const env = loadEnv();
  const timers = [];
  let nextId = 1;
  env.ctx.setTimeout = (fn, ms) => {
    const t = { id: nextId++, fn, ms, cleared: false };
    timers.push(t);
    return t.id;
  };
  env.ctx.clearTimeout = (id) => {
    const t = timers.find((x) => x.id === id);
    if (t) t.cleared = true;
  };
  const fetches = [];
  // 既定: 読める方式（cors）ではサーバーが受け付けた応答（{ok:true}）を返し、no-cors では不透明な応答を返す
  const net = { impl: async (_url, opts) => (opts.mode === "no-cors" ? { type: "opaque" } : readable({ ok: true })) };
  env.ctx.fetch = (url, opts) => {
    fetches.push({ url, opts });
    return net.impl(url, opts);
  };
  env.ctx.navigator = { onLine: online };
  const listeners = {};
  env.ctx.window = {
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
  };
  env.ctx.crypto = nodeCrypto.webcrypto;
  env.ctx.AbortController = AbortController;
  vm.runInContext(fs.readFileSync(path.join(ROOT, "js", "sheets-sync.js"), "utf8"), env.ctx, { filename: "sheets-sync.js" });
  const S = env.get("SheetsSync");

  // 時計は固定（テストで進める）。サーバー側は実際の時刻で「未来すぎる世代」を拒否するので、始まりは実際の現在時刻にする
  const clock = { t: Date.now() };
  S._now = () => clock.t;

  // 設定は端末のlocalStorageへ直接置く（setConnection / setEnabled の予約を起こさずに用意するため）
  if (configured) {
    env.ls.map.set(S.META.endpoint, ENDPOINT);
    env.ls.map.set(S.META.key, CONN_KEY);
  }
  if (enabled) env.ls.map.set(S.META.enabled, "1");
  if (mode) env.ls.map.set(S.META.sendMode, mode);

  // 応答を読めない環境: CORS は失敗し、no-cors だけ届く（不透明な応答）
  if (mode === "blind") {
    net.impl = async (_url, opts) => {
      if (opts.mode === "cors") throw new TypeError("Failed to fetch");
      return { type: "opaque" };
    };
  }

  const active = () => timers.filter((t) => !t.cleared);
  // 読めない環境では、1回の試行が「CORS → no-cors」の2回の通信になる。試行の回数は no-cors の回数で数える
  const noCors = () => fetches.filter((f) => f.opts.mode === "no-cors");
  return { env, S, timers, active, fetches, noCors, net, listeners, clock, ENDPOINT, CONN_KEY };
}

// 条件が満たされるまで待つ（実際のタイマーを使う）
async function waitFor(cond, ms = 2000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor: timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---- 偽のスプレッドシート ----

class FakeSheet {
  constructor(name, header, maxRows = 1000) {
    this.name = name;
    this.maxRows = maxRows;
    this.rows = []; // 0始まり。各行は配列
    this.formats = new Map(); // "r,c" -> 書式
    this.unsafe = []; // 書式なしテキストにせずに書かれた、数値・日付・式に見える文字列
    this.writes = 0;
    if (header) this.rows[0] = header.slice();
  }
  getLastRow() {
    let last = 0;
    this.rows.forEach((r, i) => {
      if (r && r.some((v) => v !== "" && v !== undefined && v !== null)) last = i + 1;
    });
    return last;
  }
  getMaxRows() {
    return this.maxRows;
  }
  // ※ getRange(...).getValue() は getValues()[0][0]（下の getRange を参照）
  insertRowsAfter(_pos, n) {
    this.maxRows += n;
  }
  getRange(r, c, nr = 1, nc = 1) {
    const sheet = this;
    return {
      getValue() {
        return this.getValues()[0][0];
      },
      getValues() {
        const out = [];
        for (let i = 0; i < nr; i++) {
          const row = [];
          for (let j = 0; j < nc; j++) {
            const v = (sheet.rows[r - 1 + i] || [])[c - 1 + j];
            row.push(v === undefined ? "" : v);
          }
          out.push(row);
        }
        return out;
      },
      setValues(vals) {
        if (r - 1 + nr > sheet.maxRows) throw new Error("range out of sheet");
        sheet.writes += 1;
        for (let i = 0; i < nr; i++) {
          sheet.rows[r - 1 + i] = sheet.rows[r - 1 + i] || [];
          for (let j = 0; j < nc; j++) {
            const v = vals[i][j];
            const fmt = sheet.formats.get(`${r + i},${c + j}`);
            // 書式なしテキストでない列へ、数値・日付・式に解釈されうる文字列を書くと、内容が変わってしまう
            if (typeof v === "string" && fmt !== "@" && /^([=+\-@]|\d)/.test(v)) sheet.unsafe.push({ row: r + i, col: c + j, v: v.slice(0, 20) });
            sheet.rows[r - 1 + i][c - 1 + j] = v;
          }
        }
      },
      setNumberFormat(fmt) {
        for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) sheet.formats.set(`${r + i},${c + j}`, fmt);
      },
      clearContent() {
        for (let i = 0; i < nr; i++) {
          for (let j = 0; j < nc; j++) {
            if (sheet.rows[r - 1 + i]) sheet.rows[r - 1 + i][c - 1 + j] = "";
          }
        }
      },
    };
  }
  // 2行目以降の、空でない行だけ
  dataRows() {
    return this.rows.slice(1).filter((r) => r && r.some((v) => v !== "" && v !== undefined));
  }
}

const SNAPSHOT_HEADER = ["key", "chunk_index", "chunk_count", "json_chunk", "updated_at"];
const LOG_HEADER = [
  "synced_at", "schema_version", "latest_record_date", "daily_records", "protein_entries",
  "condition_entries", "cycle_entries", "injections", "snapshot_sha256", "source",
];

// Apps Script（apps-script/Code.gs）を、偽の SpreadsheetApp / LockService / PropertiesService つきで読み込む
function loadAppsScript({ props = { BG_SYNC_KEY: CONN_KEY, SPREADSHEET_ID: "test-spreadsheet-id" }, lockOk = true, sheets } = {}) {
  const snapshot = sheets && sheets.snapshot ? sheets.snapshot : new FakeSheet("latest_snapshot", SNAPSHOT_HEADER);
  const log = sheets && sheets.log ? sheets.log : new FakeSheet("backup_log", LOG_HEADER);
  const calls = { opened: [], tryLock: 0, release: 0, flush: 0 };
  const lock = { ok: lockOk }; // テストの途中で、ロックを取れる／取れないを切り替えられる
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    SpreadsheetApp: {
      flush() {
        calls.flush += 1;
      },
      openById(id) {
        calls.opened.push(id);
        return { getSheetByName: (n) => (n === "latest_snapshot" ? snapshot : n === "backup_log" ? log : null) };
      },
    },
    LockService: {
      getScriptLock: () => ({
        tryLock() {
          calls.tryLock += 1;
          return lock.ok;
        },
        releaseLock() {
          calls.release += 1;
        },
      }),
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null) }) },
    ContentService: {
      MimeType: { JSON: "JSON" },
      createTextOutput: (s) => ({ s, setMimeType() { return this; }, getContent() { return this.s; } }),
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: "SHA_256" },
      Charset: { UTF_8: "UTF_8" },
      computeDigest: (_alg, str) => Array.from(nodeCrypto.createHash("sha256").update(str, "utf8").digest(), (b) => (b > 127 ? b - 256 : b)),
    },
  });
  const source = fs.readFileSync(path.join(ROOT, "apps-script", "Code.gs"), "utf8");
  vm.runInContext(source, ctx, { filename: "Code.gs" });
  const post = (payloadOrText) => {
    const contents = typeof payloadOrText === "string" ? payloadOrText : JSON.stringify(payloadOrText);
    return JSON.parse(vm.runInContext("doPost", ctx)({ postData: { contents } }).getContent());
  };
  return { ctx, snapshot, log, calls, lock, post, source };
}

module.exports = { setupClient, readable, waitFor, FakeSheet, loadAppsScript, ENDPOINT, CONN_KEY, SNAPSHOT_HEADER, LOG_HEADER, ROOT };
