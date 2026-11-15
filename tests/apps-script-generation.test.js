// Google Sheets 自動バックアップ（受け皿の Apps Script）: スナップショットの世代 — 古い送信が最新を巻き戻さない

const test = require("node:test");
const assert = require("node:assert/strict");
const { sampleState } = require("./helpers");
const { setupClient, readable, loadAppsScript, CONN_KEY, ENDPOINT } = require("./sheets-helpers");

// スナップショットの世代（snapshotCreatedAt）。n が大きいほど新しい。サーバーは未来すぎる世代を拒否するので、過去の時刻から始める
const BASE_MS = Date.now() - 60 * 60 * 1000;
const gen = (n) => new Date(BASE_MS + n * 1000).toISOString();

async function makePayload(c, state, key = CONN_KEY, at = gen(1)) {
  const snap = await c.S.snapshotFromRaw(JSON.stringify(state));
  return c.S.buildPayload(snap, key, at);
}

function snapshotRowsOf(sheet) {
  return sheet.dataRows().map((r) => ({ key: r[0], chunk_index: Number(r[1]), chunk_count: Number(r[2]), json_chunk: r[3] }));
}

// 内容の違うstateを作る（記録を n 件足す）
function stateWith(c, n) {
  const s = sampleState(c.env);
  for (let i = 0; i < n; i++) s.dailyRecords.push({ date: `2026-10-${String(2 + i).padStart(2, "0")}`, weight: 66 - i / 10, comment: "" });
  return s;
}

const canon = (c, rows) => c.S.canonicalJSON(c.S.reconstruct(rows).state);

test("latest_snapshot の updated_at には、端末が付けた世代（snapshotCreatedAt）が入る", async () => {
  const c = setupClient();
  const gs = loadAppsScript();
  assert.equal(gs.post(await makePayload(c, sampleState(c.env), CONN_KEY, gen(5))).ok, true);
  assert.ok(gs.snapshot.dataRows().every((r) => r[4] === gen(5)));
});

test("新しいスナップショットのあとに、古いスナップショットが遅れて届いても、最新が維持される", async () => {
  const c = setupClient();
  const gs = loadAppsScript();
  const older = stateWith(c, 1);
  const newer = stateWith(c, 3);
  assert.equal(gs.post(await makePayload(c, newer, CONN_KEY, gen(20))).ok, true);
  const before = JSON.stringify(gs.snapshot.rows);
  const logRows = gs.log.dataRows().length;
  const writes = gs.snapshot.writes;

  const r = gs.post(await makePayload(c, older, CONN_KEY, gen(10))); // 遅れて届いた古い送信
  assert.equal(r.ok, false);
  assert.equal(r.error, "stale_snapshot");
  assert.equal(JSON.stringify(gs.snapshot.rows), before, "latest_snapshot は1文字も変わらない");
  assert.equal(gs.snapshot.writes, writes, "書き込み自体をしていない");
  assert.equal(gs.log.dataRows().length, logRows, "成功のログも残さない");
  assert.equal(canon(c, snapshotRowsOf(gs.snapshot)), c.S.canonicalJSON(newer));
});

test("同じ世代で内容が違うものは受け付けない（新しい世代だけが上書きできる）", async () => {
  const c = setupClient();
  const gs = loadAppsScript();
  assert.equal(gs.post(await makePayload(c, stateWith(c, 1), CONN_KEY, gen(7))).ok, true);
  const r = gs.post(await makePayload(c, stateWith(c, 2), CONN_KEY, gen(7)));
  assert.equal(r.error, "stale_snapshot");
  assert.equal(gs.log.dataRows().length, 1);
});

test("順不同・重複して届いても、最後は最も新しい世代が残る（複数の並び順で確認）", async () => {
  const c = setupClient();
  const payloads = [];
  for (let i = 1; i <= 5; i++) payloads.push(await makePayload(c, stateWith(c, i), CONN_KEY, gen(i * 10)));
  const orders = [
    [0, 1, 2, 3, 4],
    [4, 3, 2, 1, 0],
    [2, 0, 4, 1, 3],
    [3, 3, 1, 4, 0, 4, 2],
    [1, 4, 0, 4, 2, 3],
  ];
  for (const order of orders) {
    const gs = loadAppsScript();
    let highest = -1;
    let accepted = 0;
    for (const i of order) {
      const r = gs.post(payloads[i]);
      if (i > highest) {
        assert.equal(r.ok, true, `${order.join(",")}: ${i} は、いまより新しいので受け付ける`);
        assert.ok(!r.duplicate);
        highest = i;
        accepted += 1;
      } else if (i === highest) {
        assert.equal(r.duplicate, true, "同じ内容の再送は、重複として受け付ける");
      } else {
        assert.equal(r.error, "stale_snapshot", `${order.join(",")}: ${i} は古いので拒否`);
      }
      assert.equal(canon(c, snapshotRowsOf(gs.snapshot)), c.S.canonicalJSON(stateWith(c, highest + 1)), "途中でも、これまでで最も新しいものになっている");
    }
    assert.equal(canon(c, snapshotRowsOf(gs.snapshot)), c.S.canonicalJSON(stateWith(c, Math.max(...order) + 1)), "最後に残るのは、届いたものの中で最も新しい世代");
    assert.equal(gs.log.dataRows().length, accepted, "ログは、実際に書き込んだ回数だけ");
  }
});

test("同時に届いた場合: ロックを取れなかった送信は何も書かず、取れたあとの判定は世代で決まる", async () => {
  const c = setupClient();
  const gs = loadAppsScript();
  const newer = await makePayload(c, stateWith(c, 3), CONN_KEY, gen(30));
  const older = await makePayload(c, stateWith(c, 1), CONN_KEY, gen(10));
  gs.lock.ok = false; // 別の処理がロックを持っている間に、新旧の2つが届く
  assert.equal(gs.post(newer).error, "busy");
  assert.equal(gs.post(older).error, "busy");
  assert.equal(gs.snapshot.dataRows().length, 0);
  gs.lock.ok = true; // 古い方が先にロックを取れても、新しい方が後に届けば、新しい方が残る
  assert.equal(gs.post(older).ok, true);
  assert.equal(gs.post(newer).ok, true);
  assert.equal(canon(c, snapshotRowsOf(gs.snapshot)), c.S.canonicalJSON(stateWith(c, 3)));
  gs.lock.ok = false;
  assert.equal(gs.post(older).error, "busy", "ロックを取れないときは、世代の判定もせず、書かない");
  gs.lock.ok = true;
  assert.equal(gs.post(older).error, "stale_snapshot");
  assert.equal(canon(c, snapshotRowsOf(gs.snapshot)), c.S.canonicalJSON(stateWith(c, 3)));
});

test("同じ内容の二重送信（再送・読めない方式への切り替え時）は、書き直さず・ログも増やさず、受け付け済みとして返す", async () => {
  const c = setupClient();
  const gs = loadAppsScript();
  const p = await makePayload(c, sampleState(c.env), CONN_KEY, gen(1));
  assert.equal(gs.post(p).ok, true);
  const writes = gs.snapshot.writes;
  assert.deepEqual(gs.post(p), { ok: true, duplicate: true }); // まったく同じ本文
  assert.deepEqual(gs.post({ ...p, snapshotCreatedAt: gen(9) }), { ok: true, duplicate: true }); // 同じ内容を、後から送り直した
  assert.equal(gs.snapshot.writes, writes);
  assert.equal(gs.log.dataRows().length, 1);
});

test("世代が無い・形が違う・未来すぎる送信は、何も書かない", async () => {
  const c = setupClient();
  const gs = loadAppsScript();
  const p = await makePayload(c, sampleState(c.env), CONN_KEY, gen(1));
  const { snapshotCreatedAt: _omit, ...noGen } = p;
  assert.equal(gs.post(noGen).error, "bad_snapshot_created_at");
  assert.equal(gs.post({ ...p, snapshotCreatedAt: "2026-11-15" }).error, "bad_snapshot_created_at");
  assert.equal(gs.post({ ...p, snapshotCreatedAt: "2026-13-45T25:61:61.000Z" }).error, "bad_snapshot_created_at");
  assert.equal(gs.post({ ...p, snapshotCreatedAt: 12345 }).error, "bad_snapshot_created_at");
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  assert.equal(gs.post({ ...p, snapshotCreatedAt: future }).error, "future_snapshot");
  assert.equal(gs.snapshot.dataRows().length, 0);
  // 未来の世代を一度でも受け付けると、以後の正しい更新がすべて古い扱いになる。それを防ぐための拒否
  assert.equal(gs.post(p).ok, true);
});

test("シートの世代を読めない（手で書き換えられた）ときは、古さを判断できないので書かない。空にすれば再開できる", async () => {
  const c = setupClient();
  const gs = loadAppsScript();
  const kept = stateWith(c, 1);
  assert.equal(gs.post(await makePayload(c, kept, CONN_KEY, gen(5))).ok, true);
  gs.snapshot.rows[1][4] = "壊れた値";
  const before = JSON.stringify(gs.snapshot.rows);
  const writes = gs.snapshot.writes;
  // 古い内容でも新しい内容でも、判断できない間は書かない（古い状態へ戻らないことを優先する）
  assert.equal(gs.post(await makePayload(c, stateWith(c, 0), CONN_KEY, gen(1))).error, "unknown_generation");
  assert.equal(gs.post(await makePayload(c, stateWith(c, 2), CONN_KEY, gen(6))).error, "unknown_generation");
  assert.equal(JSON.stringify(gs.snapshot.rows), before);
  assert.equal(gs.snapshot.writes, writes);
  assert.equal(gs.log.dataRows().length, 1);
  // latest_snapshot のデータ行を空にすると、次の送信から再開できる
  gs.snapshot.rows.length = 1;
  assert.equal(gs.post(await makePayload(c, stateWith(c, 2), CONN_KEY, gen(6))).ok, true);
});

test("表計算が世代を日付に変えていても読める（別の環境の Date でも判定できる）", async () => {
  const c = setupClient();
  const gs = loadAppsScript();
  assert.equal(gs.post(await makePayload(c, stateWith(c, 1), CONN_KEY, gen(50))).ok, true);
  gs.snapshot.rows[1][4] = new Date(gen(50)); // 書式が日付になって、値が Date で返ってきた
  assert.equal(gs.post(await makePayload(c, stateWith(c, 0), CONN_KEY, gen(10))).error, "stale_snapshot");
  assert.equal(gs.post(await makePayload(c, stateWith(c, 2), CONN_KEY, gen(60))).ok, true);
});

test("同じ内容かどうかは、ログの記録ではなく、いまシートにある内容で判定する", async () => {
  const c = setupClient();
  const gs = loadAppsScript();
  const a = await makePayload(c, stateWith(c, 1), CONN_KEY, gen(10));
  const b = await makePayload(c, stateWith(c, 3), CONN_KEY, gen(20));
  assert.equal(gs.post(a).ok, true);
  assert.equal(gs.post(b).ok, true);
  // スナップショットを書いたあと、ログを書く前に失敗した状況（ログの最後の行は、1つ前の内容のまま）を再現する
  gs.log.rows[gs.log.rows.length - 1][8] = a.sha256;
  const r = gs.post(a); // 1つ前と同じ内容が、遅れて届いた
  assert.notEqual(r.duplicate, true, "シートにあるのは b なので、a を「保存済み」と答えない");
  assert.equal(r.error, "stale_snapshot");
  assert.equal(canon(c, snapshotRowsOf(gs.snapshot)), c.S.canonicalJSON(stateWith(c, 3)));
  assert.deepEqual(gs.post(b), { ok: true, duplicate: true }, "シートにある内容と同じなら、重複として受け付ける");
});

test("書き込み後は、ロックを外す前にシートへ確定させる（次の送信が古い状態を読まないように）", async () => {
  const c = setupClient();
  const gs = loadAppsScript();
  assert.equal(gs.calls.flush, 0);
  assert.equal(gs.post(await makePayload(c, stateWith(c, 1), CONN_KEY, gen(1))).ok, true);
  assert.ok(gs.calls.flush >= 1);
});

test("複数端末: 端末Aがオフラインで保存した古い内容を、端末Bの新しい内容のあとで送り直しても、巻き戻らない", async () => {
  const a = setupClient({ mode: "cors" });
  const b = setupClient({ mode: "cors" });
  const gs = loadAppsScript();
  const t0 = Date.now() - 3 * 60 * 60 * 1000;
  a.clock.t = t0;
  b.clock.t = t0 + 60 * 60 * 1000;
  a.S.init();
  b.S.init();
  // 端末Aは、オフライン（通信できない）の間に保存する
  a.net.impl = async () => {
    throw new TypeError("Failed to fetch");
  };
  const stateA = stateWith(a, 1);
  a.env.Storage.save(stateA);
  assert.equal((await a.S.flush()).ok, false);
  const aGeneration = a.env.ls.getItem(a.S.META.stateAt);

  // その間に、端末Bが新しい内容を送って、確認できた
  b.net.impl = async (_url, opts) => readable(gs.post(opts.body));
  const stateB = stateWith(b, 4);
  b.env.Storage.save(stateB);
  assert.equal((await b.S.flush()).confirmed, true);

  // 端末Aは、通信が戻る前に、画面を切り替える（ui だけの保存。記録は変えない）。時刻はBの保存よりずっと新しい
  a.clock.t = t0 + 2 * 60 * 60 * 1000;
  stateA.ui.lastScreen = "settings";
  a.env.Storage.save(stateA);
  await a.S._stamping;
  assert.equal(a.env.ls.getItem(a.S.META.stateAt), aGeneration, "画面を切り替えても、世代は進まない");

  // 通信が戻る（オンライン復帰・起動の経路でも、通常の再送の経路でも）
  a.net.impl = async (_url, opts) => readable(gs.post(opts.body));
  a.clock.t += 60 * 60 * 1000;
  a.listeners.online.forEach((fn) => fn());
  const viaOnline = await a.S.flush();
  assert.equal(JSON.parse(a.fetches[a.fetches.length - 1].opts.body).snapshotCreatedAt, aGeneration, "世代は、保存した時刻のまま");
  assert.equal(viaOnline.unconfirmed, true);
  assert.equal(viaOnline.serverError, "stale_snapshot");
  a.clock.t += 3 * 60 * 60 * 1000;
  await a.S._startupCheck();
  const viaStartup = await a.S.flush();
  assert.equal(JSON.parse(a.fetches[a.fetches.length - 1].opts.body).snapshotCreatedAt, aGeneration);
  assert.equal(viaStartup.serverError, "stale_snapshot");
  const forced = await a.S.flush({ force: true });
  assert.equal(forced.serverError, "stale_snapshot", "「今すぐ送信」でも、世代は保存の時刻のまま");
  assert.equal(canon(b, snapshotRowsOf(gs.snapshot)), b.S.canonicalJSON(stateB), "Bの新しい内容が、巻き戻されずに残る");
  assert.equal(a.S.status().lastConfirmedAt, null);
});

test("クライアントとサーバーの結合: 古い世代・拒否を、クライアントが「確認できた」とは扱わない", async () => {
  const c = setupClient();
  const gs = loadAppsScript();
  c.S.init();
  c.net.impl = async (_url, opts) => readable(gs.post(opts.body));
  const s = sampleState(c.env);
  c.env.Storage.save(s);
  assert.equal((await c.S.flush()).confirmed, true);

  // 別の端末が、より新しい世代を書いた（この端末の次の送信は、古い扱いになる）
  const other = stateWith(c, 4);
  assert.equal(gs.post(await makePayload(c, other, CONN_KEY, new Date(c.clock.t + 60 * 1000).toISOString())).ok, true);
  s.dailyRecords.push({ date: "2026-10-09", weight: 65, comment: "" });
  c.env.Storage.save(s);
  const r = await c.S.flush();
  assert.equal(r.ok, false);
  assert.equal(r.unconfirmed, true);
  assert.equal(r.serverError, "stale_snapshot");
  assert.match(c.S.status().lastError, /stale_snapshot/);
  assert.equal(c.S.status().pending, true, "確認できていないので、未確認のまま");
  assert.equal(canon(c, snapshotRowsOf(gs.snapshot)), c.S.canonicalJSON(other), "Sheets側は巻き戻っていない");

  // 接続キーが違う場合も、確認済みにならない
  c.S.setConnection(ENDPOINT, "another-wrong-key-0123456");
  c.env.Storage.save(s);
  const bad = await c.S.flush({ force: true });
  assert.equal(bad.serverError, "unauthorized");
  assert.equal(c.S.status().lastConfirmedAt, null);
});
