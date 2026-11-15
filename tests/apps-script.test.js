// Google Sheets 自動バックアップ（受け皿の Apps Script）: 認証・検証・書き込み・最新1世代・ログ・全体の往復

const test = require("node:test");
const assert = require("node:assert/strict");
const { sampleState, clone } = require("./helpers");
const { setupClient, readable, loadAppsScript, FakeSheet, SNAPSHOT_HEADER, CONN_KEY } = require("./sheets-helpers");

// スナップショットの世代（snapshotCreatedAt）。n が大きいほど新しい。サーバーは未来すぎる世代を拒否するので、過去の時刻から始める
const BASE_MS = Date.now() - 60 * 60 * 1000;
const gen = (n) => new Date(BASE_MS + n * 1000).toISOString();

// ブラウザ側が実際に送る本文を作る（SheetsSync の本物のコードで）
async function makePayload(c, state, key = CONN_KEY, at = gen(1)) {
  const snap = await c.S.snapshotFromRaw(JSON.stringify(state));
  return c.S.buildPayload(snap, key, at);
}

function snapshotRowsOf(sheet) {
  return sheet.dataRows().map((r) => ({ key: r[0], chunk_index: Number(r[1]), chunk_count: Number(r[2]), json_chunk: r[3] }));
}

test("正しい接続キーと正しい本文: latest_snapshot を更新し、backup_log に1行追記する", async () => {
  const c = setupClient();
  const gs = loadAppsScript();
  const s = sampleState(c.env);
  const r = gs.post(await makePayload(c, s));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(gs.snapshot.dataRows().length > 0);
  assert.equal(gs.log.dataRows().length, 1);
  const row = gs.log.dataRows()[0];
  const snap = await c.S.snapshotFromRaw(JSON.stringify(s));
  assert.equal(row[1], 7, "schema_version");
  assert.equal(row[2], "2026-10-01", "latest_record_date（予定の注射は含まない）");
  assert.equal(row[3], 3, "daily_records");
  assert.equal(row[4], 2, "protein_entries");
  assert.equal(row[5], 1, "condition_entries");
  assert.equal(row[6], 0, "cycle_entries");
  assert.equal(row[7], 1, "injections");
  assert.equal(row[8], snap.sha256, "snapshot_sha256");
  assert.equal(row[9], "body-garden-pwa", "source");
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(row[0]), "synced_at");
  assert.equal(row.length, 10);
  assert.equal(gs.calls.tryLock, 1, "LockService を使う");
  assert.equal(gs.calls.release, 1, "ロックを解放する");
  assert.deepEqual(gs.calls.opened, ["test-spreadsheet-id"]);
});

test("backup_log に完全なJSONを重複して保存しない（完全データは latest_snapshot だけ）", async () => {
  const c = setupClient();
  const gs = loadAppsScript();
  gs.post(await makePayload(c, sampleState(c.env)));
  const logText = JSON.stringify(gs.log.rows);
  assert.ok(!logText.includes("ホエイプロテイン"));
  assert.ok(!logText.includes("dailyRecords"));
});

test("接続キーが違えば、何も書かない（スプレッドシートを開きもしない）", async () => {
  const c = setupClient();
  const gs = loadAppsScript();
  const r = gs.post(await makePayload(c, sampleState(c.env), "wrong-key-0123456789"));
  assert.equal(r.ok, false);
  assert.equal(r.error, "unauthorized");
  assert.equal(gs.snapshot.dataRows().length, 0);
  assert.equal(gs.log.dataRows().length, 0);
  assert.deepEqual(gs.calls.opened, []);
  assert.equal(gs.calls.tryLock, 0);
});

test("接続キーが無い・空・型違いでも、何も書かない", async () => {
  const c = setupClient();
  const gs = loadAppsScript();
  const p = await makePayload(c, sampleState(c.env));
  for (const key of [undefined, "", null, 123, ["x"]]) {
    const r = gs.post({ ...p, key });
    assert.equal(r.ok, false);
    assert.equal(r.error, "unauthorized");
  }
  assert.equal(gs.snapshot.dataRows().length, 0);
});

test("スクリプトプロパティが未設定（キー・スプレッドシートID）なら、何も書かない", async () => {
  const c = setupClient();
  const p = await makePayload(c, sampleState(c.env));
  for (const props of [{}, { BG_SYNC_KEY: CONN_KEY }, { SPREADSHEET_ID: "x" }, { BG_SYNC_KEY: "short", SPREADSHEET_ID: "x" }]) {
    const gs = loadAppsScript({ props });
    const r = gs.post(p);
    assert.equal(r.ok, false);
    assert.equal(r.error, "not_configured");
    assert.equal(gs.snapshot.dataRows().length, 0);
    assert.deepEqual(gs.calls.opened, []);
  }
});

test("本文が壊れている・大きすぎる・空のときは、何も書かない", () => {
  const gs = loadAppsScript();
  assert.equal(gs.post("not json").error, "bad_json");
  assert.equal(gs.post("").error, "bad_body");
  assert.equal(gs.post("x".repeat(5 * 1024 * 1024 + 1)).error, "bad_body");
  assert.equal(gs.post("null").error, "unauthorized");
  assert.equal(gs.snapshot.dataRows().length, 0);
});

test("チャンクの欠け・重複・番号違い・不正なキー名・長すぎるチャンクは、書かずに拒否する", async () => {
  const c = setupClient();
  const gs = loadAppsScript();
  const s = sampleState(c.env);
  s.dailyRecords = Array.from({ length: 700 }, (_, i) => ({ date: `2025-01-01#${i}`, weight: 60, comment: "日本語のメモ".repeat(4) }));
  const p = await makePayload(c, s);
  const daily = p.rows.filter((r) => r.key === "dailyRecords");
  assert.ok(daily.length > 1);

  const cases = {
    chunk_missing: { ...p, rows: p.rows.filter((r) => r !== daily[1]) },
    chunk_mismatch: { ...p, rows: p.rows.concat([clone(daily[0])]) },
    bad_chunk_number: { ...p, rows: p.rows.map((r) => (r === daily[0] ? { ...r, chunk_index: 0 } : r)) },
    bad_key: { ...p, rows: p.rows.concat([{ key: "__proto__", chunk_index: 1, chunk_count: 1, json_chunk: "{}" }]) },
    bad_chunk: { ...p, rows: p.rows.map((r) => (r === daily[0] ? { ...r, json_chunk: "x".repeat(45001) } : r)) },
    bad_chunk_json: { ...p, rows: p.rows.map((r) => (r === daily[0] ? { ...r, json_chunk: "{broken" } : r)) },
    bad_rows: { ...p, rows: [] },
    bad_version: { ...p, v: 2 },
  };
  for (const [expected, payload] of Object.entries(cases)) {
    const r = gs.post(payload);
    assert.equal(r.ok, false, expected);
    assert.equal(r.error, expected);
  }
  assert.equal(gs.snapshot.dataRows().length, 0, "どれも書かれていない");
  assert.equal(gs.log.dataRows().length, 0);
});

test("SHA-256が一致しなければ書かない（内容の改ざん・取り違え）", async () => {
  const c = setupClient();
  const gs = loadAppsScript();
  const p = await makePayload(c, sampleState(c.env));
  const tampered = clone(p);
  const row = tampered.rows.find((r) => r.key === "profile");
  row.json_chunk = row.json_chunk.replace(/\d/, (d) => String((Number(d) + 1) % 10));
  assert.equal(gs.post(tampered).error, "hash_mismatch");
  assert.equal(gs.post({ ...p, sha256: "0".repeat(64) }).error, "hash_mismatch");
  assert.equal(gs.post({ ...p, sha256: "XYZ" }).error, "bad_sha");
  assert.equal(gs.post({ ...p, schemaVersion: 6 }).error, "schema_mismatch");
  assert.equal(gs.snapshot.dataRows().length, 0);
});

test("latest_record_date が日付の形でなければ、書かない", async () => {
  const c = setupClient();
  const gs = loadAppsScript();
  const p = await makePayload(c, sampleState(c.env));
  assert.equal(gs.post({ ...p, latestRecordDate: "<script>" }).error, "bad_latest_record_date");
  assert.equal(gs.post({ ...p, latestRecordDate: undefined }).error, "bad_latest_record_date");
  assert.equal(gs.post({ ...p, latestRecordDate: "" }).ok, true, "記録が1件も無いときは空でよい");
});

test("ロックを取れなかったときは、何も書かない", async () => {
  const c = setupClient();
  const gs = loadAppsScript({ lockOk: false });
  const r = gs.post(await makePayload(c, sampleState(c.env)));
  assert.equal(r.error, "busy");
  assert.equal(gs.snapshot.dataRows().length, 0);
  assert.equal(gs.calls.release, 0, "取れていないロックは解放しない");
});

test("latest_snapshot は最新1世代だけ: 2回目に短くなっても、古い行が残らない", async () => {
  const c = setupClient();
  const gs = loadAppsScript();
  const big = sampleState(c.env);
  big.dailyRecords = Array.from({ length: 700 }, (_, i) => ({ date: `2025-01-01#${i}`, weight: 60, comment: "日本語のメモ".repeat(4) }));
  assert.equal(gs.post(await makePayload(c, big, CONN_KEY, gen(1))).ok, true);
  const bigRows = gs.snapshot.dataRows().length;
  assert.ok(bigRows > 14);

  const small = sampleState(c.env);
  assert.equal(gs.post(await makePayload(c, small, CONN_KEY, gen(2))).ok, true);
  const rows = snapshotRowsOf(gs.snapshot);
  assert.ok(rows.length < bigRows);
  assert.equal(rows.length, c.S.buildRows(small).length, "今回の内容と同じ行数だけ（旧世代は残らない）");
  assert.equal(gs.log.dataRows().length, 2, "ログは1同期につき1行");
});

test("書式: 文字の列は「書式なしテキスト」にしてから書く（JSONの断片が数値・日付・式にならない）", async () => {
  const c = setupClient();
  const gs = loadAppsScript();
  const s = sampleState(c.env);
  s.profile.name = "=1+1"; // 先頭が = や数字・日付に見える内容でも、そのまま残る
  s.dailyRecords[0].comment = "-5,2026-10-01,+9";
  assert.equal(gs.post(await makePayload(c, s)).ok, true);
  assert.deepEqual(gs.snapshot.unsafe, [], "snapshot の文字列セルは、すべて書式なしテキスト");
  assert.deepEqual(gs.log.unsafe, [], "log の文字列セルも同じ");
  // 全チャンクを数値・日付の解釈なしに読み戻せる
  const back = c.S.reconstruct(snapshotRowsOf(gs.snapshot));
  assert.equal(back.ok, true);
  assert.equal(back.state.profile.name, "=1+1");
});

test("書いたあとの読み戻しが一致しなければ、エラーにして backup_log に行を足さない", async () => {
  const c = setupClient();
  const snapshot = new FakeSheet("latest_snapshot", SNAPSHOT_HEADER);
  const orig = snapshot.getRange.bind(snapshot);
  // 表計算がセルの値を勝手に変えた場合を再現する（先頭に ' が付く・値が変わる）
  snapshot.getRange = (r, col, nr, nc) => {
    const rg = orig(r, col, nr, nc);
    if (r === 2 && col === 1 && nc === 4) {
      const gv = rg.getValues;
      rg.getValues = () => gv().map((row) => [row[0], row[1], row[2], "'" + row[3]]);
    }
    return rg;
  };
  const gs = loadAppsScript({ sheets: { snapshot } });
  const r = gs.post(await makePayload(c, sampleState(c.env)));
  assert.equal(r.ok, false);
  assert.equal(r.error, "readback_mismatch");
  assert.equal(gs.log.dataRows().length, 0, "成功としてのログは残さない");
  assert.equal(gs.calls.release, 1, "失敗してもロックは解放する");
  assert.equal(snapshot.dataRows().length, 0, "変わってしまった内容を、最新として残さない（空にする）");
  // 空にしてあるので、同じ内容・同じ世代でも、次の送信で書き直せる（世代の比較で止まらない）
  snapshot.getRange = orig;
  const again = gs.post(await makePayload(c, sampleState(c.env)));
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(gs.log.dataRows().length, 1);
});

test("受け皿のタブが無い・ヘッダーが違うときは、何も書かない", async () => {
  const c = setupClient();
  const p = await makePayload(c, sampleState(c.env));
  const badHeader = new FakeSheet("latest_snapshot", ["a", "b", "c", "d", "e"]);
  let gs = loadAppsScript({ sheets: { snapshot: badHeader } });
  assert.equal(gs.post(p).error, "internal");
  assert.equal(badHeader.writes, 0);
  assert.equal(gs.log.dataRows().length, 0, "snapshot の前に失敗するので log も書かない");
});

test("空のタブ（ヘッダー未作成）は、ヘッダーを作ってから書く", async () => {
  const c = setupClient();
  const snapshot = new FakeSheet("latest_snapshot", null);
  const gs = loadAppsScript({ sheets: { snapshot } });
  assert.equal(gs.post(await makePayload(c, sampleState(c.env))).ok, true);
  assert.deepEqual(snapshot.rows[0], SNAPSHOT_HEADER);
});

test("シートの最大行数を超える内容でも、行を足して書ける", async () => {
  const c = setupClient();
  const snapshot = new FakeSheet("latest_snapshot", SNAPSHOT_HEADER, 5);
  const gs = loadAppsScript({ sheets: { snapshot } });
  const r = gs.post(await makePayload(c, sampleState(c.env)));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(snapshot.getMaxRows() >= snapshot.dataRows().length + 1);
});

test("doGet はデータを返さない（動作確認用）", () => {
  const gs = loadAppsScript();
  const out = JSON.parse(gs.ctx.doGet().getContent());
  assert.deepEqual(out, { ok: true, service: "body-garden-backup" });
});

test("canonical JSON: ブラウザ側と Apps Script 側で同じ文字列・同じSHA-256になる", async () => {
  const c = setupClient();
  const gs = loadAppsScript();
  const s = sampleState(c.env);
  s.dailyRecords[1].comment = 'a"b\\c\n日本語😀</script>';
  const canonicalGs = gs.ctx.canonicalJSON_(JSON.parse(JSON.stringify(s)));
  assert.equal(canonicalGs, c.S.canonicalJSON(s));
  assert.equal(gs.ctx.sha256Hex_(canonicalGs), (await c.S.snapshotFromRaw(JSON.stringify(s))).sha256);
});

test("全体の往復: 送信 → シート → 行を読み戻して再構成 → 元のstateと完全一致・SHA-256一致・Backup.parse を通る", async () => {
  const c = setupClient();
  const gs = loadAppsScript();
  const s = sampleState(c.env);
  // Backup.parse を通すため、実在する日付・範囲内の体重にする（700日分）
  s.dailyRecords = Array.from({ length: 700 }, (_, i) => ({
    date: new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10),
    weight: 60 + (i % 9) / 10,
    comment: "日本語😀のメモ".repeat(4),
  }));
  const p = await makePayload(c, s);
  assert.equal(gs.post(p).ok, true);

  const rows = snapshotRowsOf(gs.snapshot);
  const back = c.S.reconstruct(rows);
  assert.equal(back.ok, true);
  assert.equal(c.S.canonicalJSON(back.state), c.S.canonicalJSON(s), "元のstateと完全一致");
  assert.equal(await c.S.sha256Hex(c.S.canonicalJSON(back.state)), p.sha256, "SHA-256一致");
  assert.equal(gs.log.dataRows()[0][8], p.sha256, "backup_log の hash とも一致");

  // 将来の復元は、既存の安全検証（Backup.parse）をそのまま通せる
  const parsed = c.env.Backup.parse(c.env.Backup.serialize(back.state), null);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.message || parsed));
  assert.equal(parsed.state.dailyRecords.length, 700);
});

test("実際の保存 → 送信 → シートの流れ（Storage.save から）", async () => {
  const c = setupClient();
  const gs = loadAppsScript();
  c.S.init();
  // 本物のサーバーコードへ、ブラウザが送った本文をそのまま渡し、サーバーの答えをそのまま返す（応答を読める環境）
  c.net.impl = async (_url, opts) => readable(gs.post(opts.body));
  const s = sampleState(c.env);
  assert.equal(c.env.Storage.save(s), true);
  const r = await c.S.flush();
  assert.equal(r.ok, true);
  assert.equal(r.confirmed, true, "サーバーが受け付けた応答を読めたので、確認済み");
  assert.ok(c.S.status().lastConfirmedAt);
  assert.equal(gs.log.dataRows().length, 1);
  const back = c.S.reconstruct(snapshotRowsOf(gs.snapshot));
  assert.equal(c.S.canonicalJSON(back.state), c.S.canonicalJSON(JSON.parse(c.env.ls.getItem(c.env.STORAGE_KEY))));
});
