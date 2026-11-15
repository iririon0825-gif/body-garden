/**
 * Body Garden — Google Sheets 自動バックアップの受け皿（Apps Script Web App）
 *
 * ・接続キー（BG_SYNC_KEY）と対象スプレッドシートのID（SPREADSHEET_ID）は「スクリプト プロパティ」に置く。
 *   このファイルには書かない（GitHub に載せない）。
 * ・書き込む前に、本文の形式・接続キー・分割した JSON の完全性（SHA-256）を検証する。
 *   どれか1つでも合わなければ、シートには何も書かない。
 * ・latest_snapshot は最新1世代だけ（成功時に置き換え）。backup_log は1回の同期につき1行追記する（完全JSONは入れない）。
 * ・応答（{ok:true} など）は、ブラウザが読める環境では、アプリが「受け付けを確認できた」の根拠にする。
 *   読めない環境（no-cors）では、アプリは確認できたとは扱わない。応答の内容は、動作確認（手動実行・ログ）にも使える。
 * ・古い世代の送信（snapshotCreatedAt が、いま保存されている世代以下で内容が違うもの）は、latest_snapshot を書き換えない。
 */

var SHEET_SNAPSHOT = "latest_snapshot";
var SHEET_LOG = "backup_log";
var SNAPSHOT_HEADER = ["key", "chunk_index", "chunk_count", "json_chunk", "updated_at"];
var LOG_HEADER = [
  "synced_at", "schema_version", "latest_record_date", "daily_records", "protein_entries",
  "condition_entries", "cycle_entries", "injections", "snapshot_sha256", "source",
];

var PAYLOAD_VERSION = 1;
var MAX_BODY_CHARS = 5 * 1024 * 1024; // アプリ側のバックアップの上限（5MB）と同じ
var MAX_ROWS = 2000;
var MAX_CHUNKS_PER_KEY = 1000;
var MAX_CHUNK_CHARS = 45000; // アプリは35,000文字で分割する。1セルの上限（50,000文字）に余裕を残す
var KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
var DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
var SHA_PATTERN = /^[0-9a-f]{64}$/;
var GENERATION_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/; // snapshotCreatedAt（端末が付ける世代。文字列のまま大小を比べられる形）
var MAX_FUTURE_MS = 10 * 60 * 1000; // 世代が、サーバーの現在時刻よりこれ以上先なら拒否（時計のずれ・不正で、以後の更新が止まらないように）
var MIN_SECRET_LENGTH = 16;

function doPost(e) {
  var lock = LockService.getScriptLock();
  var locked = false;
  try {
    var props = PropertiesService.getScriptProperties();
    var secret = props.getProperty("BG_SYNC_KEY");
    var spreadsheetId = props.getProperty("SPREADSHEET_ID");
    if (!secret || secret.length < MIN_SECRET_LENGTH || !spreadsheetId) {
      return respond_({ ok: false, error: "not_configured" });
    }

    var body = e && e.postData && e.postData.contents;
    if (typeof body !== "string" || body.length === 0 || body.length > MAX_BODY_CHARS) {
      return respond_({ ok: false, error: "bad_body" });
    }
    var payload;
    try {
      payload = JSON.parse(body);
    } catch (err) {
      return respond_({ ok: false, error: "bad_json" });
    }

    // 接続キーが合わなければ、他の検証にも進まず何も書かない
    if (!payload || typeof payload.key !== "string" || !safeEqual_(payload.key, secret)) {
      return respond_({ ok: false, error: "unauthorized" });
    }

    var checked = validatePayload_(payload);
    if (!checked.ok) return respond_({ ok: false, error: checked.error });

    locked = lock.tryLock(20000);
    if (!locked) return respond_({ ok: false, error: "busy" });

    var result = writeSheets_(spreadsheetId, checked);
    // いま保存されている世代より古い送信は、latest_snapshot を書き換えない（遅れて届いた古い送信で最新が戻らない）
    if (result.stale) return respond_({ ok: false, error: "stale_snapshot" });
    // シートの内容の世代を読めない（手で書き換えられた等）ときは、古さを判断できないので書かない
    if (result.unknown) return respond_({ ok: false, error: "unknown_generation" });
    // すでに同じ内容が保存されている場合（再送・二重送信）は、書き直さず、受け付け済みとして返す
    if (result.duplicate) return respond_({ ok: true, duplicate: true });
    return respond_({ ok: true, rows: result.rows, syncedAt: result.syncedAt });
  } catch (err2) {
    console.error(String(err2));
    var msg = String((err2 && err2.message) || err2);
    return respond_({ ok: false, error: msg.indexOf("readback_mismatch") === 0 ? "readback_mismatch" : "internal" });
  } finally {
    if (locked) lock.releaseLock();
  }
}

// 動作確認用（ブラウザで開いたとき）。データは返さない。
function doGet() {
  return respond_({ ok: true, service: "body-garden-backup" });
}

// ---------- 検証 ----------

function validatePayload_(payload) {
  if (payload.v !== PAYLOAD_VERSION) return { ok: false, error: "bad_version" };
  var gen = payload.snapshotCreatedAt;
  if (typeof gen !== "string" || !GENERATION_PATTERN.test(gen) || isNaN(Date.parse(gen))) return { ok: false, error: "bad_snapshot_created_at" };
  if (Date.parse(gen) > Date.now() + MAX_FUTURE_MS) return { ok: false, error: "future_snapshot" };
  if (typeof payload.sha256 !== "string" || !SHA_PATTERN.test(payload.sha256)) return { ok: false, error: "bad_sha" };
  var latest = payload.latestRecordDate;
  if (latest !== "" && !(typeof latest === "string" && DATE_PATTERN.test(latest))) return { ok: false, error: "bad_latest_record_date" };
  if (!Array.isArray(payload.rows) || payload.rows.length === 0 || payload.rows.length > MAX_ROWS) return { ok: false, error: "bad_rows" };

  // キーごとにチャンクを集める
  var groups = {};
  var order = [];
  for (var i = 0; i < payload.rows.length; i++) {
    var r = payload.rows[i];
    if (!r || typeof r.key !== "string" || !KEY_PATTERN.test(r.key)) return { ok: false, error: "bad_key" };
    var idx = r.chunk_index;
    var cnt = r.chunk_count;
    if (typeof idx !== "number" || typeof cnt !== "number" || idx % 1 !== 0 || cnt % 1 !== 0) return { ok: false, error: "bad_chunk_number" };
    if (idx < 1 || cnt < 1 || idx > cnt || cnt > MAX_CHUNKS_PER_KEY) return { ok: false, error: "bad_chunk_number" };
    if (typeof r.json_chunk !== "string" || r.json_chunk.length === 0 || r.json_chunk.length > MAX_CHUNK_CHARS) return { ok: false, error: "bad_chunk" };
    if (!Object.prototype.hasOwnProperty.call(groups, r.key)) {
      groups[r.key] = { count: cnt, parts: {}, seen: 0 };
      order.push(r.key);
    }
    var g = groups[r.key];
    if (g.count !== cnt || Object.prototype.hasOwnProperty.call(g.parts, idx)) return { ok: false, error: "chunk_mismatch" };
    g.parts[idx] = r.json_chunk;
    g.seen += 1;
  }

  // 結合して JSON として読み、全体の canonical JSON の SHA-256 が申告と一致することを確かめる
  var state = {};
  var rows = [];
  for (var k = 0; k < order.length; k++) {
    var key = order[k];
    var grp = groups[key];
    if (grp.seen !== grp.count) return { ok: false, error: "chunk_missing" };
    var json = "";
    for (var n = 1; n <= grp.count; n++) {
      json += grp.parts[n];
      rows.push([key, n, grp.count, grp.parts[n]]);
    }
    try {
      state[key] = JSON.parse(json);
    } catch (err) {
      return { ok: false, error: "bad_chunk_json" };
    }
  }
  if (typeof state.schemaVersion !== "number" || state.schemaVersion % 1 !== 0) return { ok: false, error: "no_schema_version" };
  if (payload.schemaVersion !== state.schemaVersion) return { ok: false, error: "schema_mismatch" };

  var computed = sha256Hex_(canonicalJSON_(state));
  if (computed !== payload.sha256) return { ok: false, error: "hash_mismatch" };

  return {
    ok: true,
    rows: rows,
    sha256: computed,
    snapshotCreatedAt: gen,
    schemaVersion: state.schemaVersion,
    latestRecordDate: latest,
    counts: {
      dailyRecords: countOf_(state.dailyRecords),
      proteinEntries: countOf_(state.proteinEntries),
      conditionEntries: countOf_(state.conditionEntries),
      cycleEntries: countOf_(state.cycleEntries),
      injections: countOf_(state.injections),
    },
    source: typeof payload.source === "string" ? payload.source.slice(0, 40) : "",
  };
}

function countOf_(v) {
  return Array.isArray(v) ? v.length : "";
}

// ---------- 書き込み ----------

function writeSheets_(spreadsheetId, c) {
  var ss = SpreadsheetApp.openById(spreadsheetId);
  var snap = getSheet_(ss, SHEET_SNAPSHOT, SNAPSHOT_HEADER);
  var log = getSheet_(ss, SHEET_LOG, LOG_HEADER);
  var now = new Date().toISOString();

  // 世代の比較（ロックの中で行う。順不同・同時に届いても、ここで1件ずつ判定される）
  // ・いまシートにある内容そのもの（行を読み直したハッシュ）が同じなら、重複。ログの記録には頼らない。
  // ・内容が違い、世代が同じか古ければ、古い送信として拒否する。
  // ・シートに内容があるのに世代を読めないときは、古さを判断できないので、書かずに止める
  //   （手で書き換えられた場合など。latest_snapshot を空にしてから送り直すと、再開できる）。
  var current = readCurrent_(snap);
  if (current.sha && current.sha === c.sha256) return { duplicate: true };
  if (current.hasRows && !current.at) return { unknown: true };
  if (current.at && c.snapshotCreatedAt <= current.at) return { stale: true };

  // latest_snapshot: 新しい内容を先に書いてから、余った古い行だけを消す（途中で失敗しても、全消しにならない）
  // updated_at には、端末が付けたスナップショットの世代（snapshotCreatedAt）を入れる。次の送信との比較に使う。
  var values = c.rows.map(function (r) {
    return [r[0], r[1], r[2], r[3], c.snapshotCreatedAt];
  });
  var n = values.length;
  if (snap.getMaxRows() < n + 1) snap.insertRowsAfter(snap.getMaxRows(), n + 1 - snap.getMaxRows());
  // JSONの断片が数値・日付・式として解釈されないように、文字の列は「書式なしテキスト」にしてから書く
  snap.getRange(2, 1, n, 1).setNumberFormat("@");
  snap.getRange(2, 4, n, 1).setNumberFormat("@");
  snap.getRange(2, 5, n, 1).setNumberFormat("@");
  snap.getRange(2, 1, n, 5).setValues(values);
  // 書いた内容を読み戻して照合する（表計算がセルの値を変えていないか）。違えば、ここで止める（ログも残さない）。
  var back = snap.getRange(2, 1, n, 4).getValues();
  for (var b = 0; b < n; b++) {
    if (
      String(back[b][0]) !== values[b][0] ||
      Number(back[b][1]) !== values[b][1] ||
      Number(back[b][2]) !== values[b][2] ||
      back[b][3] !== values[b][3]
    ) {
      // 変わってしまった内容を、最新として残さない（空にして、次の送信で書き直せるようにする）
      var written = snap.getLastRow();
      if (written >= 2) snap.getRange(2, 1, written - 1, 5).clearContent();
      SpreadsheetApp.flush();
      throw new Error("readback_mismatch");
    }
  }
  var last = snap.getLastRow();
  if (last > n + 1) snap.getRange(n + 2, 1, last - (n + 1), 5).clearContent();

  // backup_log: 1回の同期につき1行（完全なJSONは入れない）
  var row = log.getLastRow() + 1;
  if (row > log.getMaxRows()) log.insertRowsAfter(log.getMaxRows(), 1);
  log.getRange(row, 1).setNumberFormat("@");
  log.getRange(row, 3).setNumberFormat("@");
  log.getRange(row, 9).setNumberFormat("@");
  log.getRange(row, 10).setNumberFormat("@");
  log.getRange(row, 1, 1, LOG_HEADER.length).setValues([[
    now,
    c.schemaVersion,
    c.latestRecordDate,
    c.counts.dailyRecords,
    c.counts.proteinEntries,
    c.counts.conditionEntries,
    c.counts.cycleEntries,
    c.counts.injections,
    c.sha256,
    c.source,
  ]]);
  // ロックを外す前に、書いた内容をシートへ確定させる（次の送信が、反映前の古い状態を読まないように）
  SpreadsheetApp.flush();
  return { rows: n, syncedAt: now };
}

// いまシートにある内容の世代（latest_snapshot の updated_at）と、行そのものから計算したハッシュ。
// 世代が読めなければ at は空（hasRows が true のままなので、呼び出し側で止める）。ハッシュが作れなければ空。
function readCurrent_(snap) {
  var last = snap.getLastRow();
  if (last < 2) return { hasRows: false, at: "", sha: "" };
  var values = snap.getRange(2, 1, last - 1, 5).getValues();
  return { hasRows: true, at: normalizeGeneration_(values[0][4]), sha: snapshotSha_(values) };
}

function normalizeGeneration_(v) {
  // 表計算が日付に変えていた場合も読めるようにする（別のスクリプト環境の Date でも判定できる形）
  if (Object.prototype.toString.call(v) === "[object Date]") v = v.toISOString();
  return typeof v === "string" && GENERATION_PATTERN.test(v) ? v : "";
}

// latest_snapshot の行（2行目以降）を組み立て直して、全体の canonical JSON の SHA-256 を返す。壊れていれば空。
function snapshotSha_(values) {
  var groups = {};
  var order = [];
  for (var i = 0; i < values.length; i++) {
    var r = values[i];
    if (r[0] === "" && r[3] === "") continue; // 空行は読み飛ばす
    var key = String(r[0]);
    var idx = Number(r[1]);
    var cnt = Number(r[2]);
    if (!KEY_PATTERN.test(key) || typeof r[3] !== "string" || r[3] === "") return "";
    if (idx % 1 !== 0 || cnt % 1 !== 0 || idx < 1 || idx > cnt) return "";
    if (!Object.prototype.hasOwnProperty.call(groups, key)) {
      groups[key] = { count: cnt, parts: {}, seen: 0 };
      order.push(key);
    }
    var g = groups[key];
    if (g.count !== cnt || Object.prototype.hasOwnProperty.call(g.parts, idx)) return "";
    g.parts[idx] = r[3];
    g.seen += 1;
  }
  if (order.length === 0) return "";
  var state = {};
  for (var k = 0; k < order.length; k++) {
    var grp = groups[order[k]];
    if (grp.seen !== grp.count) return "";
    var json = "";
    for (var n = 1; n <= grp.count; n++) json += grp.parts[n];
    try {
      state[order[k]] = JSON.parse(json);
    } catch (err) {
      return "";
    }
  }
  return sha256Hex_(canonicalJSON_(state));
}

// 受け皿のタブとヘッダーは作成済みの前提。見つからない・ヘッダーが違うときは、何も書かずに止める。
function getSheet_(ss, name, header) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error("sheet_missing:" + name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
    return sheet;
  }
  var actual = sheet.getRange(1, 1, 1, header.length).getValues()[0];
  for (var i = 0; i < header.length; i++) {
    if (String(actual[i]) !== header[i]) throw new Error("header_mismatch:" + name);
  }
  return sheet;
}

// ---------- 共通 ----------

// アプリ側（js/sheets-sync.js の canonicalJSON）と同じ規則: キーを昇順に並べた JSON
function canonicalJSON_(value) {
  if (value === null || typeof value !== "object") {
    var s = JSON.stringify(value);
    return s === undefined ? "null" : s;
  }
  if (Array.isArray(value)) {
    return "[" + value.map(function (v) {
      return v === undefined || typeof v === "function" ? "null" : canonicalJSON_(v);
    }).join(",") + "]";
  }
  var parts = [];
  Object.keys(value).sort().forEach(function (k) {
    var v = value[k];
    if (v === undefined || typeof v === "function") return;
    parts.push(JSON.stringify(k) + ":" + canonicalJSON_(v));
  });
  return "{" + parts.join(",") + "}";
}

function sha256Hex_(str) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  var hex = "";
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
    hex += (b < 16 ? "0" : "") + b.toString(16);
  }
  return hex;
}

// 長さが違っても、最後まで比べる（先頭の一致数で時間が変わらないように）
function safeEqual_(a, b) {
  var diff = a.length ^ b.length;
  var len = Math.max(a.length, b.length);
  for (var i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function respond_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
