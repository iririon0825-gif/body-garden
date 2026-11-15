// Google Sheets 自動バックアップ（ブラウザ側）: 保存後の予約・デバウンス・失敗時の扱い・スナップショット・設定UI

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const nodeCrypto = require("node:crypto");
const { sampleState, clone } = require("./helpers");
const { setupClient, readable, waitFor, ROOT, CONN_KEY, ENDPOINT } = require("./sheets-helpers");

const sha256 = (s) => nodeCrypto.createHash("sha256").update(s, "utf8").digest("hex");

// ---------- 保存との結びつき ----------

test("localStorage保存が成功したら、同期が予約される（保存の時点では通信しない）", () => {
  const c = setupClient();
  c.S.init();
  assert.equal(c.env.Storage.save(sampleState(c.env)), true);
  assert.equal(c.active().length, 1);
  assert.equal(c.active()[0].ms, 2000);
  assert.equal(c.env.ls.getItem(c.S.META.pending), "1");
  assert.equal(c.fetches.length, 0);
});

test("localStorage保存が失敗したときは、同期を予約しない", () => {
  const c = setupClient();
  c.S.init();
  c.env.ls.failSetKeys.add(c.env.STORAGE_KEY);
  assert.equal(c.env.Storage.save(sampleState(c.env)), false);
  assert.equal(c.active().length, 0);
  assert.equal(c.env.ls.getItem(c.S.META.pending), null);
});

test("readOnly のときは、同期を予約せず、送信もしない", async () => {
  const c = setupClient();
  c.S.init();
  c.env.Storage.save(sampleState(c.env));
  assert.equal(c.active().length, 1);
  c.env.Storage.readOnly = true;
  assert.equal(c.env.Storage.save(sampleState(c.env)), false);
  assert.equal(c.active().length, 1, "readOnly の保存では、新しい予約は増えない");
  const r = await c.S.flush();
  assert.equal(r.skipped, "readOnly");
  assert.equal(c.fetches.length, 0);
});

test("連続した保存はデバウンスされ、最新の内容が1回だけ送られる", async () => {
  const c = setupClient();
  c.S.init();
  const s = sampleState(c.env);
  c.env.Storage.save(s);
  s.dailyRecords.push({ date: "2026-10-02", weight: 66.0, comment: "" });
  c.env.Storage.save(s);
  s.dailyRecords.push({ date: "2026-10-03", weight: 65.8, comment: "" });
  c.env.Storage.save(s);
  assert.equal(c.timers.length, 3);
  assert.equal(c.active().length, 1, "前の予約は取り消され、最後の1つだけが残る");
  assert.equal((await c.S.flush()).ok, true);
  assert.equal(c.fetches.length, 1);
  const sent = JSON.parse(c.fetches[0].opts.body);
  const dailyRows = sent.rows.filter((r) => r.key === "dailyRecords");
  const daily = JSON.parse(dailyRows.map((r) => r.json_chunk).join(""));
  assert.equal(daily.length, 5, "最新のstate（3回目の保存）が送られる");
});

test("予約したタイマーが実行されると、実際に送信される", async () => {
  const c = setupClient();
  c.S.init();
  c.env.Storage.save(sampleState(c.env));
  c.active()[0].fn();
  await waitFor(() => c.fetches.length === 1);
  await waitFor(() => c.env.ls.getItem(c.S.META.pending) === null);
  assert.ok(c.env.ls.getItem(c.S.META.lastConfirmedAt), "サーバーの応答で確認できたので、確認日時が入る");
  assert.ok(c.env.ls.getItem(c.S.META.lastAttemptAt));
});

test("同期に失敗しても、Storage.save() は true のまま・stateは消えず・readOnlyにならない", async () => {
  const c = setupClient();
  c.S.init();
  c.net.impl = async () => {
    throw new TypeError("Failed to fetch");
  };
  const s = sampleState(c.env);
  assert.equal(c.env.Storage.save(s), true);
  const before = c.env.ls.getItem(c.env.STORAGE_KEY);
  const r = await c.S.flush();
  assert.equal(r.ok, false);
  assert.equal(c.env.ls.getItem(c.env.STORAGE_KEY), before, "保存済みのデータは変わらない");
  assert.equal(c.env.Storage.readOnly, false);
  assert.equal(c.S.status().lastError, "Failed to fetch");
  assert.equal(c.S.status().pending, true);
  s.dailyRecords.push({ date: "2026-10-02", weight: 66.0, comment: "" });
  assert.equal(c.env.Storage.save(s), true, "同期の失敗のあとも、記録の保存は続けられる");
});

test("通信の例外・保存後フックの例外は、save() の結果に影響しない", () => {
  const c = setupClient();
  c.env.Storage.onSaved = () => {
    throw new Error("hook failed");
  };
  assert.equal(c.env.Storage.save(sampleState(c.env)), true);
});

test("未送信のstateは、次の保存・送信で再送される", async () => {
  const c = setupClient();
  c.S.init();
  c.net.impl = async () => {
    throw new TypeError("Failed to fetch");
  };
  const s = sampleState(c.env);
  c.env.Storage.save(s);
  await c.S.flush();
  assert.equal(c.S.status().pending, true);

  c.net.impl = async () => readable({ ok: true });
  s.dailyRecords.push({ date: "2026-10-02", weight: 66.0, comment: "" });
  c.env.Storage.save(s);
  const r = await c.S.flush();
  assert.equal(r.ok, true);
  assert.equal(r.confirmed, true);
  assert.equal(c.fetches.length, 2);
  assert.equal(c.S.status().pending, false);
  assert.equal(c.S.status().lastError, null);
  const sent = JSON.parse(c.fetches[1].opts.body);
  assert.equal(sent.sha256, sha256(c.S.canonicalJSON(JSON.parse(c.env.ls.getItem(c.env.STORAGE_KEY)))), "最新のstateだけを送る");
});

test("オフラインでは送らず、onlineに戻ったら再送される", async () => {
  const c = setupClient({ online: false });
  c.S.init();
  c.env.Storage.save(sampleState(c.env));
  const off = await c.S.flush();
  assert.equal(off.skipped, "offline");
  assert.equal(c.fetches.length, 0);
  assert.equal(c.S.status().pending, true);

  c.env.ctx.navigator.onLine = true;
  assert.equal(c.listeners.online.length, 1);
  c.listeners.online[0]();
  assert.ok(c.active().length >= 1, "online で再送が予約される");
  assert.equal((await c.S.flush()).ok, true);
  assert.equal(c.fetches.length, 1);
});

test("アプリ再起動後: 未送信が残っていれば再送を予約する", () => {
  const c = setupClient();
  c.env.ls.map.set(c.S.META.pending, "1");
  c.S.init();
  assert.equal(c.active().length, 1);
});

test("アプリ再起動後: 最後に送った内容と違えば（復元など）再送を予約する", async () => {
  const c = setupClient();
  c.env.ls.map.set(c.env.STORAGE_KEY, JSON.stringify(sampleState(c.env)));
  c.env.ls.map.set(c.S.META.confirmedSha, "0".repeat(64));
  await c.S._startupCheck();
  assert.equal(c.active().length, 1);
});

test("同じ内容は再送せず、「今すぐ送信」は同じ内容でも送る", async () => {
  const c = setupClient();
  c.S.init();
  c.env.Storage.save(sampleState(c.env));
  await c.S.flush();
  assert.equal(c.fetches.length, 1);
  c.env.Storage.save(JSON.parse(c.env.ls.getItem(c.env.STORAGE_KEY)));
  const again = await c.S.flush();
  assert.equal(again.skipped, "unchanged");
  assert.equal(c.fetches.length, 1);
  assert.equal((await c.S.sendNow()).ok, true);
  assert.equal(c.fetches.length, 2);
});

test("画面を切り替えただけ（ui.lastScreen の更新）では、再送もログの追加もしない。記録が変われば送る", async () => {
  const c = setupClient();
  c.S.init();
  const s = sampleState(c.env);
  s.ui.lastScreen = "home";
  c.env.Storage.save(s);
  assert.equal((await c.S.flush()).ok, true);
  assert.equal(c.fetches.length, 1);

  for (const screen of ["settings", "records", "home"]) {
    s.ui.lastScreen = screen;
    assert.equal(c.env.Storage.save(s), true);
    const r = await c.S.flush();
    assert.equal(r.skipped, "unchanged", `${screen}: 画面の切り替えだけでは送らない`);
  }
  assert.equal(c.fetches.length, 1);
  assert.equal(c.S.status().pending, false, "未送信として残らない");

  s.dailyRecords.push({ date: "2026-10-02", weight: 66.0, comment: "" });
  c.env.Storage.save(s);
  assert.equal((await c.S.flush()).ok, true, "記録が変われば送る");
  assert.equal(c.fetches.length, 2);
  const sent = JSON.parse(c.fetches[1].opts.body);
  assert.ok(sent.rows.some((r) => r.key === "ui"), "送るデータには ui も含める（state全体）");
});

test("起動時の再送判定も、画面の状態だけの違いでは再送しない", async () => {
  const c = setupClient();
  c.S.init();
  const s = sampleState(c.env);
  s.ui.lastScreen = "home";
  c.env.Storage.save(s);
  await c.S.flush();
  c.timers.length = 0;
  s.ui.lastScreen = "settings";
  c.env.ls.map.set(c.env.STORAGE_KEY, JSON.stringify(s)); // 保存の外で変わった体（ui だけ）
  await c.S._startupCheck();
  assert.equal(c.active().length, 0);
});

test("接続設定を変えると、確認・試行の記録が消え、同じ内容でも（上限に達していても）送り直せる", async () => {
  const c = setupClient({ configured: false, enabled: false });
  c.S.init();
  // サーバーは、正しい接続キーのときだけ受け付ける（応答を読める環境）
  c.net.impl = async (_url, opts) => (JSON.parse(opts.body).key === CONN_KEY ? readable({ ok: true }) : readable({ ok: false, error: "unauthorized" }));
  c.S.setConnection(ENDPOINT, "wrong-key-0123456789");
  c.S.setEnabled(true);
  c.env.Storage.save(sampleState(c.env));
  const bad = await c.S.flush();
  assert.equal(bad.ok, false);
  assert.equal(bad.unconfirmed, true);
  assert.equal(c.S.status().lastConfirmedAt, null, "拒否されたものを、受け付けたこととして扱わない");
  assert.equal(c.S.status().pending, true);
  assert.equal(c.S.status().attemptCount, 1);

  c.S.setConnection(ENDPOINT, CONN_KEY); // キーを直す
  const st = c.S.status();
  assert.equal(st.lastAttemptAt, null, "前の接続の試行の記録は消える");
  assert.equal(st.attemptCount, 0);
  assert.equal(st.lastError, null);
  const good = await c.S.flush(); // 待ち時間・回数の制限にもかからない
  assert.equal(good.ok, true);
  assert.equal(good.confirmed, true);
  assert.equal(c.fetches.length, 2);
  assert.equal(JSON.parse(c.fetches[1].opts.body).key, CONN_KEY);
});

test("チャンクの切れ目は、次のチャンクの先頭が ' = + - @ や空白にならない位置にずらす", () => {
  const c = setupClient();
  const text = "a".repeat(9) + "=-=+'@ \t\nxyz" + "b".repeat(30);
  const chunks = c.S.chunkString(text, 10);
  assert.equal(chunks.join(""), text, "文字列は変わらない");
  for (const ch of chunks.slice(1)) assert.ok(!/^['=+\-@ \t\n\r]/.test(ch), `先頭が危険な文字: ${JSON.stringify(ch.slice(0, 5))}`);
  for (const ch of chunks) assert.ok(ch.length <= 10 && ch.length > 0);
  // ふつうの内容では、これまでどおり上限ちょうどで切れる
  const plain = c.S.chunkString("a".repeat(100), 10);
  assert.deepEqual(Array.from(plain, (x) => x.length), Array(10).fill(10));
});

test("送信中に新しい保存があれば、未送信のまま残り、続けて送られる", async () => {
  const c = setupClient();
  c.S.init();
  const s = sampleState(c.env);
  c.env.Storage.save(s);
  let release;
  c.net.impl = () => new Promise((res) => (release = () => res(readable({ ok: true }))));
  const first = c.S.flush();
  await waitFor(() => c.fetches.length === 1);
  s.dailyRecords.push({ date: "2026-10-02", weight: 66.0, comment: "" });
  c.env.Storage.save(s); // 送信中の保存
  release();
  await first;
  assert.equal(c.S.status().pending, true, "送信中に保存された分は、まだ未送信");
  assert.ok(c.active().length >= 1, "続けて送る予約がある");
});

test("送信は text/plain・認証情報なし。接続キーは本文だけに入り、URLには入らない（読める方式・読めない方式のどちらも）", async () => {
  for (const mode of ["cors", "blind"]) {
    const c = setupClient({ mode });
    c.S.init();
    c.env.Storage.save(sampleState(c.env));
    await c.S.flush();
    assert.equal(c.fetches.length, mode === "cors" ? 1 : 2, "読めない環境は、読める方式 → 届くかの確認の順に送る");
    assert.deepEqual(c.fetches.map((f) => f.opts.mode), mode === "cors" ? ["cors"] : ["cors", "no-cors"]);
    for (const { url, opts } of c.fetches) {
      assert.equal(url, ENDPOINT);
      assert.ok(!url.includes(CONN_KEY));
      assert.equal(opts.method, "POST");
      assert.equal(opts.credentials, "omit");
      assert.equal(opts.referrerPolicy, "no-referrer");
      assert.match(opts.headers["Content-Type"], /^text\/plain/, "プリフライトが要らない形式");
      assert.equal(JSON.parse(opts.body).key, CONN_KEY);
    }
  }
});

// ---------- 確認できた送信と、試みただけの送信を分ける（修正A） ----------

test("サーバーが拒否したら、クライアントは「保存できた」と扱わない（確認日時を付けず、未確認のまま残す）", async () => {
  const c = setupClient();
  c.S.init();
  for (const error of ["unauthorized", "hash_mismatch", "busy", "internal", "stale_snapshot", "readback_mismatch"]) {
    c.net.impl = async () => readable({ ok: false, error });
    c.env.Storage.save(sampleState(c.env));
    const r = await c.S.flush({ force: true });
    assert.equal(r.ok, false, error);
    assert.equal(r.unconfirmed, true, error);
    assert.equal(r.serverError, error);
    const st = c.S.status();
    assert.equal(st.lastConfirmedAt, null, `${error}: 確認日時は付かない`);
    assert.equal(st.pending, true, `${error}: 未確認のまま`);
    assert.ok(st.lastAttemptAt, `${error}: 試行した日時は残る`);
    assert.match(st.lastError, new RegExp(error));
  }
  c.net.impl = async () => readable({ ok: false, error: "x" }, 500); // HTTPエラー・読めない応答も同じ
  assert.equal((await c.S.flush({ force: true })).unconfirmed, true);
  c.net.impl = async () => ({ ok: true, status: 200, text: async () => "<html>not json</html>" });
  const html = await c.S.flush({ force: true });
  assert.equal(html.unconfirmed, true);
  assert.equal(html.serverError, "bad_response");
  assert.equal(c.S.status().lastConfirmedAt, null);
});

test("サーバーが受け付けた応答を読めたときだけ、確認済み（確認日時・未確認フラグの解除・同じ内容の再送の抑止）になる", async () => {
  const c = setupClient();
  c.S.init();
  c.env.Storage.save(sampleState(c.env));
  const r = await c.S.flush();
  assert.equal(r.confirmed, true);
  const st = c.S.status();
  assert.ok(st.lastConfirmedAt);
  assert.ok(st.lastAttemptAt);
  assert.equal(st.pending, false);
  assert.equal(st.attemptCount, 0);
  assert.equal((await c.S.flush()).skipped, "unchanged", "確認できた内容は、同じなら再送しない");
});

test("応答を読めない環境（no-cors）: 試行日時は残すが、確認済みにはせず、未確認のまま保持する", async () => {
  const c = setupClient({ mode: null }); // まだ通信方式が分からない状態から始める
  c.S.init();
  // CORS では応答を読ませてもらえない（ブラウザが拒否）が、no-cors なら届く
  c.net.impl = async (_url, opts) => {
    if (opts.mode === "cors") throw new TypeError("Failed to fetch");
    return { type: "opaque" };
  };
  c.env.Storage.save(sampleState(c.env));
  const r = await c.S.flush();
  assert.equal(r.ok, false);
  assert.equal(r.unconfirmed, true);
  assert.equal(r.readable, false);
  assert.deepEqual(c.fetches.map((f) => f.opts.mode), ["cors", "no-cors"], "読める方式 → 届くかの確認の順で送る");
  const st = c.S.status();
  assert.equal(st.sendMode, "blind");
  assert.ok(st.lastAttemptAt, "試行日時は残る");
  assert.equal(st.lastConfirmedAt, null, "確認日時は付けない");
  assert.equal(st.pending, true, "未確認のまま保持する");
  assert.equal(c.env.ls.getItem(c.S.META.confirmedSha), null, "同じ内容の再送を抑止する根拠にもしない");
});

test("一度の失敗で「読めない環境」に固定しない。次の送信でまた読める方式を試し、読めれば確認済みになる", async () => {
  const c = setupClient({ mode: null });
  c.S.init();
  let corsWorks = false;
  c.net.impl = async (_url, opts) => {
    if (opts.mode === "cors") {
      if (!corsWorks) throw new TypeError("Failed to fetch"); // たまたま、その1回だけ失敗した
      return readable({ ok: true });
    }
    return { type: "opaque" };
  };
  c.env.Storage.save(sampleState(c.env));
  assert.equal((await c.S.flush()).unconfirmed, true);
  assert.equal(c.S.status().sendMode, "blind");

  corsWorks = true;
  c.clock.t += 2 * 60 * 1000;
  const again = await c.S.flush();
  assert.equal(again.confirmed, true, "あとから読めるようになれば、確認済みにできる");
  assert.equal(c.S.status().sendMode, "cors");
  assert.ok(c.S.status().lastConfirmedAt);
});

test("読める方式が時間切れになったときは、読めない環境とは判定せず、確かめの送信もしない", async () => {
  const c = setupClient({ mode: null });
  c.S.init();
  c.net.impl = async () => {
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  };
  c.env.Storage.save(sampleState(c.env));
  const r = await c.S.flush();
  assert.equal(r.ok, false);
  assert.ok(r.error);
  assert.equal(c.fetches.length, 1);
  assert.equal(c.S.status().sendMode, null);
  assert.equal(c.S.status().lastConfirmedAt, null);
});

test("応答の本文の読み取りが止まっても、時間制限で打ち切られ、送信が固まらない", async () => {
  const c = setupClient();
  c.S.init();
  c.net.impl = (_url, opts) => ({
    ok: true,
    status: 200,
    text: () =>
      new Promise((_res, rej) => opts.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))),
  });
  c.env.Storage.save(sampleState(c.env));
  const p = c.S.flush();
  await waitFor(() => c.fetches.length === 1);
  await waitFor(() => c.timers.some((t) => t.ms === c.S.FETCH_TIMEOUT_MS && !t.cleared)); // 本文を読んでいる間も、時間制限が生きている
  c.timers.find((t) => t.ms === c.S.FETCH_TIMEOUT_MS && !t.cleared).fn();
  const r = await p;
  assert.equal(r.ok, false);
  assert.ok(r.error);
  assert.equal(c.S.status().inFlight, false, "送信中のままにならない");
  assert.equal(c.S.status().lastConfirmedAt, null);
});

// ---------- 世代は「保存した時刻」で決め、再送しても変えない ----------

test("再送しても世代（snapshotCreatedAt）は変わらない（送った時刻ではなく、保存した時刻）", async () => {
  const c = setupClient({ mode: "blind" });
  c.S.init();
  c.env.Storage.save(sampleState(c.env));
  await c.S._stamping;
  const savedAt = c.env.ls.getItem(c.S.META.stateAt);
  assert.ok(savedAt);
  await c.S.flush();
  const gens = [];
  for (let i = 0; i < 3; i++) {
    c.clock.t += 24 * 60 * 60 * 1000;
    await c.S.flush();
  }
  for (const f of c.fetches) gens.push(JSON.parse(f.opts.body).snapshotCreatedAt);
  assert.ok(gens.length >= 4);
  assert.ok(gens.every((g) => g === savedAt), "何日あとに再送しても、同じ世代");
  // 「今すぐ送信」でも同じ（内容を保存し直していないので、世代は進めない）
  await c.S.sendNow();
  assert.equal(JSON.parse(c.fetches[c.fetches.length - 1].opts.body).snapshotCreatedAt, savedAt);
  // 保存すれば、新しい世代になる
  c.clock.t += 60 * 1000;
  const s = JSON.parse(c.env.ls.getItem(c.env.STORAGE_KEY));
  s.dailyRecords.push({ date: "2026-10-09", weight: 65, comment: "" });
  c.env.Storage.save(s);
  await c.S._stamping;
  assert.ok(c.env.ls.getItem(c.S.META.stateAt) > savedAt);
});

// 世代を進めてよいのは、「内容（ui を除く）が変わる保存」だけ。再送のきっかけでは進めない
async function generationAfter(c, trigger) {
  const before = c.env.ls.getItem(c.S.META.stateAt);
  await trigger();
  await c.S._stamping;
  return { before, after: c.env.ls.getItem(c.S.META.stateAt) };
}

test("再送のきっかけ（オンライン復帰・起動・有効化・再予約・今すぐ送信）では、世代を付け直さない", async () => {
  const c = setupClient({ mode: "blind" });
  c.S.init();
  c.env.Storage.save(sampleState(c.env));
  await c.S._stamping;
  await c.S.flush();
  const first = c.env.ls.getItem(c.S.META.stateAt);
  assert.ok(first);
  const triggers = {
    online: async () => {
      c.clock.t += 60 * 60 * 1000;
      c.listeners.online.forEach((fn) => fn());
      await c.S.flush();
    },
    startup: async () => {
      c.clock.t += 60 * 60 * 1000;
      await c.S._startupCheck();
      await c.S.flush();
    },
    enable: async () => {
      c.clock.t += 60 * 60 * 1000;
      c.S.setEnabled(false);
      c.S.setEnabled(true);
      await c.S.flush();
    },
    again: async () => {
      c.clock.t += 60 * 60 * 1000;
      c.S._again = true;
      c.S.schedule();
      await c.S.flush();
    },
    sendNow: async () => {
      c.clock.t += 60 * 60 * 1000;
      await c.S.sendNow();
    },
  };
  for (const [name, trigger] of Object.entries(triggers)) {
    const g = await generationAfter(c, trigger);
    assert.equal(g.after, first, `${name}: 世代は変わらない`);
  }
  assert.ok(c.fetches.length > 2, "（再送自体は行われている）");
  for (const f of c.fetches) assert.equal(JSON.parse(f.opts.body).snapshotCreatedAt, first, "送った世代は、すべて保存したときのもの");
});

test("画面を切り替えただけ（ui だけの保存）では、世代を進めない。記録が変わる保存では進む", async () => {
  const c = setupClient();
  c.S.init();
  const s = sampleState(c.env);
  s.ui.lastScreen = "home";
  c.env.Storage.save(s);
  await c.S._stamping;
  const first = c.env.ls.getItem(c.S.META.stateAt);
  for (const screen of ["settings", "records", "home"]) {
    c.clock.t += 60 * 1000;
    s.ui.lastScreen = screen;
    c.env.Storage.save(s);
    await c.S._stamping;
    assert.equal(c.env.ls.getItem(c.S.META.stateAt), first, `${screen}: 画面の切り替えでは進めない`);
  }
  c.clock.t += 60 * 1000;
  s.dailyRecords.push({ date: "2026-10-02", weight: 66.0, comment: "" });
  c.env.Storage.save(s);
  await c.S._stamping;
  assert.ok(c.env.ls.getItem(c.S.META.stateAt) > first, "記録が変わる保存では進む");
});

test("続けて保存しても、世代は保存の順番どおりに付く（最後の内容に、最後の保存の時刻）", async () => {
  const c = setupClient();
  c.S.init();
  const s = sampleState(c.env);
  const stamps = [];
  for (let i = 0; i < 4; i++) {
    c.clock.t += 1000;
    s.dailyRecords.push({ date: `2026-10-0${i + 2}`, weight: 66 - i / 10, comment: "" });
    c.env.Storage.save(s);
    stamps.push(c.clock.t);
  }
  await c.S._stamping;
  const at = Date.parse(c.env.ls.getItem(c.S.META.stateAt));
  assert.equal(at, stamps[3], "最後の保存の時刻");
  const last = await c.S.snapshotFromRaw(c.env.ls.getItem(c.env.STORAGE_KEY));
  assert.equal(c.env.ls.getItem(c.S.META.stateSha), last.contentSha256, "世代を付けた内容は、いま保存されている内容");
});

test("保存から時間があいてから送っても、世代は保存した時刻（送った時刻ではない）", async () => {
  const c = setupClient();
  c.S.init();
  c.net.impl = async () => {
    throw new TypeError("Failed to fetch");
  };
  c.env.Storage.save(sampleState(c.env));
  const savedMs = c.clock.t;
  c.clock.t += 3 * 60 * 60 * 1000; // 3時間あとに、送信の処理が動く
  await c.S.flush({ force: true });
  assert.equal(Date.parse(JSON.parse(c.fetches[0].opts.body).snapshotCreatedAt), savedMs);
});

test("保存の外で内容が変わった（復元など）ときは、世代をいまの時刻に付け直す。内容が同じなら付け直さない", async () => {
  const c = setupClient();
  c.S.init();
  const s = sampleState(c.env);
  c.env.Storage.save(s);
  await c.S._stamping;
  const first = c.env.ls.getItem(c.S.META.stateAt);
  await c.S.flush();

  // 復元のように、保存の外で内容だけが変わった
  c.clock.t += 2 * 60 * 60 * 1000;
  const restored = JSON.parse(c.env.ls.getItem(c.env.STORAGE_KEY));
  restored.dailyRecords = restored.dailyRecords.slice(0, 1);
  c.env.ls.map.set(c.env.STORAGE_KEY, JSON.stringify(restored));
  await c.S.flush();
  const second = c.env.ls.getItem(c.S.META.stateAt);
  assert.ok(second > first, "復元後の内容には、新しい世代が付く");
  assert.equal(Date.parse(JSON.parse(c.fetches[c.fetches.length - 1].opts.body).snapshotCreatedAt), c.clock.t, "気づいた時刻");

  // 同じ内容のまま、確認の記録だけが消えた場合は、世代を付け直さない
  c.clock.t += 2 * 60 * 60 * 1000;
  c.env.ls.map.delete(c.S.META.confirmedSha);
  await c.S.flush({ force: true });
  assert.equal(c.env.ls.getItem(c.S.META.stateAt), second);
});

test("起動時の確認は、内容が確認できた内容と違っていても、世代を付け直さない（送るときに決まる）", async () => {
  const c = setupClient();
  c.S.init();
  c.env.Storage.save(sampleState(c.env));
  await c.S._stamping;
  await c.S.flush();
  const first = c.env.ls.getItem(c.S.META.stateAt);
  assert.equal(c.S.status().pending, false);

  c.env.ls.map.set(c.S.META.confirmedSha, "0".repeat(64)); // 確認できた内容と違う、と見える状態
  c.clock.t += 60 * 60 * 1000;
  await c.S._startupCheck();
  assert.equal(c.env.ls.getItem(c.S.META.stateAt), first, "起動時の確認では、世代を進めない");
  await c.S.flush();
  assert.equal(c.env.ls.getItem(c.S.META.stateAt), first, "内容は保存した時と同じなので、送るときも進めない");
});

test("続けて保存したとき、世代付けが前後して古い内容に新しい世代（または逆）が付くことはない", async () => {
  const c = setupClient();
  c.S.init();
  // 1回目の内容のハッシュ計算を、わざと遅くする（2回目より後に終わる）
  const real = c.S.contentShaOf.bind(c.S);
  let calls = 0;
  c.S.contentShaOf = async (state) => {
    const n = (calls += 1);
    if (n === 1) await new Promise((r) => setTimeout(r, 40));
    return real(state);
  };
  const s = sampleState(c.env);
  c.clock.t += 1000;
  s.dailyRecords.push({ date: "2026-10-02", weight: 66.0, comment: "" });
  c.env.Storage.save(s); // 内容X（保存の時刻 t1）
  c.clock.t += 1000;
  const t2 = c.clock.t;
  s.dailyRecords.push({ date: "2026-10-03", weight: 65.9, comment: "" });
  c.env.Storage.save(s); // 内容Y（保存の時刻 t2）
  await c.S._stamping;
  await new Promise((r) => setTimeout(r, 120)); // 遅い1回目の計算が終わるのも待つ（順序が崩れていれば、ここで上書きされる）
  const finalSnap = await c.S.snapshotFromRaw(c.env.ls.getItem(c.env.STORAGE_KEY));
  assert.equal(c.env.ls.getItem(c.S.META.stateSha), finalSnap.contentSha256, "世代を付けた内容は、最後の保存の内容");
  assert.equal(Date.parse(c.env.ls.getItem(c.S.META.stateAt)), t2, "最後の内容には、最後の保存の時刻");
});

test("世代付けが終わる前に送信が始まっても、送信は世代付けを待ち、保存した時刻を使う", async () => {
  const c = setupClient();
  c.S.init();
  const real = c.S.contentShaOf.bind(c.S);
  let calls = 0;
  c.S.contentShaOf = async (state) => {
    if ((calls += 1) === 1) await new Promise((r) => setTimeout(r, 60)); // 保存直後の世代付け（1回目）だけを遅くする
    return real(state);
  };
  c.env.Storage.save(sampleState(c.env));
  const savedMs = c.clock.t;
  c.clock.t += 60 * 60 * 1000; // 世代付けが終わる前に、1時間たった体で送信が始まる
  await c.S.flush({ force: true });
  assert.equal(Date.parse(JSON.parse(c.fetches[0].opts.body).snapshotCreatedAt), savedMs, "送った時刻ではなく、保存した時刻");
});

test("送信の準備中（読み取り→計算の間）に別の保存が入っても、新しい内容に古い世代・古い内容に新しい世代が付かない", async () => {
  const c = setupClient();
  c.S.init();
  const s = sampleState(c.env);
  c.env.Storage.save(s); // 内容X
  await c.S._stamping;
  const real = c.S.contentShaOf.bind(c.S);
  let injected = false;
  let t2 = null;
  c.S.contentShaOf = async (state) => {
    const sha = await real(state);
    if (!injected) {
      injected = true; // 送信が内容Xを読んで、ハッシュを計算し終えたところへ、次の保存が入る
      c.clock.t += 5000;
      t2 = c.clock.t;
      s.dailyRecords.push({ date: "2026-10-02", weight: 66.0, comment: "" });
      c.env.Storage.save(s); // 内容Y（保存の時刻 t2）
    }
    return sha;
  };
  const r = await c.S.flush();
  assert.equal(r.ok, true);
  const sent = JSON.parse(c.fetches[c.fetches.length - 1].opts.body);
  const daily = JSON.parse(sent.rows.filter((x) => x.key === "dailyRecords").map((x) => x.json_chunk).join(""));
  assert.equal(daily.length, 4, "送られたのは、新しい内容Y");
  assert.equal(Date.parse(sent.snapshotCreatedAt), t2, "新しい内容には、その保存の時刻（t2）");
  await c.S._stamping;
  assert.equal(Date.parse(c.env.ls.getItem(c.S.META.stateAt)), t2);
});

test("保存の外で内容が変わっていた場合は、初めて送るときに、その時点の時刻を世代にする。使っていない間の保存も同じ", async () => {
  const c = setupClient({ configured: false, enabled: false });
  c.S.init();
  c.env.Storage.save(sampleState(c.env)); // 使っていない間の保存: 世代は付けない
  assert.equal(c.env.ls.getItem(c.S.META.stateAt), null);
  c.S.setConnection(ENDPOINT, CONN_KEY);
  c.clock.t += 60 * 60 * 1000;
  c.S.setEnabled(true);
  await c.S.flush();
  const g = JSON.parse(c.fetches[c.fetches.length - 1].opts.body).snapshotCreatedAt;
  assert.equal(Date.parse(g), c.clock.t, "初めて送るときに、いまの内容の世代が付く");
});

test("保存した時刻が、時計を直したあとに「いま」より大きく先になっていたら、新しい世代に付け直す", async () => {
  const c = setupClient();
  c.S.init();
  c.env.Storage.save(sampleState(c.env));
  c.env.ls.map.set(c.S.META.stateAt, new Date(c.clock.t + 3 * 24 * 60 * 60 * 1000).toISOString());
  await c.S.flush({ force: true });
  const sent = JSON.parse(c.fetches[0].opts.body).snapshotCreatedAt;
  assert.ok(Date.parse(sent) <= c.clock.t + 1000, "サーバーが拒否する未来の世代は使わない");
});

test("通信そのものができないとき（読める方式も届く確認も失敗）は、読めない環境とは判定しない", async () => {
  const c = setupClient({ mode: null });
  c.S.init();
  c.net.impl = async () => {
    throw new TypeError("Failed to fetch");
  };
  c.env.Storage.save(sampleState(c.env));
  const r = await c.S.flush();
  assert.equal(r.ok, false);
  assert.ok(r.error);
  assert.equal(c.S.status().sendMode, null);
  assert.equal(c.S.status().lastConfirmedAt, null);
  assert.equal(c.S.status().pending, true);
});

test("以前は応答を読めていた環境で通信に失敗しても、読めない環境へ切り替えず、二重に送らない", async () => {
  const c = setupClient({ mode: "cors" });
  c.S.init();
  c.net.impl = async () => {
    throw new TypeError("Failed to fetch");
  };
  c.env.Storage.save(sampleState(c.env));
  await c.S.flush();
  assert.equal(c.fetches.length, 1);
  assert.equal(c.S.status().sendMode, "cors");
});

// ---------- 同じ未確認の内容を、無限に送り直さない ----------

test("確認できない同じ内容の再送には、間隔と回数の上限がある（最大5回）", async () => {
  const c = setupClient({ mode: "blind" });
  c.S.init();
  c.env.Storage.save(sampleState(c.env));
  assert.equal((await c.S.flush()).unconfirmed, true); // 1回目
  assert.equal((await c.S.flush()).skipped, "retryWait", "すぐには送り直さない");
  assert.equal(c.noCors().length, 1);

  // 起動・オンライン復帰・保存のきっかけが何度来ても、時間が空かなければ送らない
  c.S.init();
  c.listeners.online.forEach((fn) => fn());
  await c.S.flush();
  assert.equal(c.noCors().length, 1);

  // 間隔が空けば、上限まで送り直す。以後は、何日たっても自動では送らない
  const waits = [];
  for (let i = 0; i < 40; i++) {
    c.clock.t += 24 * 60 * 60 * 1000;
    const r = await c.S.flush();
    waits.push(r.skipped || (r.unconfirmed ? "sent" : "?"));
  }
  assert.equal(c.noCors().length, 5, "合計5回で止まる");
  assert.equal(c.S.status().attemptCount, 5);
  assert.equal(c.S.status().retryStopped, true);
  assert.ok(waits.slice(4).every((w) => w === "retryLimit"));
  assert.equal(c.S.status().pending, true, "止めても、未確認の状態は保持する");
});

test("再送の待ち時間は、回数とともに延びる（1分 → 5分 → 30分 → 2時間）", async () => {
  const c = setupClient({ mode: "blind" });
  c.S.init();
  c.env.Storage.save(sampleState(c.env));
  const gaps = [60 * 1000, 5 * 60 * 1000, 30 * 60 * 1000, 2 * 60 * 60 * 1000];
  await c.S.flush();
  for (let n = 0; n < gaps.length; n++) {
    c.clock.t += gaps[n] - 1;
    assert.equal((await c.S.flush()).skipped, "retryWait", `${n + 1}回目のあと、待ち時間の途中では送らない`);
    c.clock.t += 1;
    assert.equal((await c.S.flush()).unconfirmed, true, `${n + 1}回目のあと、待ち時間が過ぎれば送る`);
  }
  assert.equal(c.noCors().length, 5);
});

test("上限に達したあとも、内容が変われば送る。「今すぐ送信」でも送る。接続設定を変えれば自動で送れる", async () => {
  const c = setupClient({ mode: "blind" });
  c.S.init();
  const s = sampleState(c.env);
  c.env.Storage.save(s);
  for (let i = 0; i < 8; i++) {
    c.clock.t += 24 * 60 * 60 * 1000;
    await c.S.flush();
  }
  assert.equal(c.noCors().length, 5);

  s.dailyRecords.push({ date: "2026-10-02", weight: 66.0, comment: "" });
  c.env.Storage.save(s);
  assert.equal((await c.S.flush()).unconfirmed, true, "内容が変われば、新しい送信として扱う");
  assert.equal(c.noCors().length, 6);
  assert.equal(c.S.status().attemptCount, 1);

  for (let i = 0; i < 8; i++) {
    c.clock.t += 24 * 60 * 60 * 1000;
    await c.S.flush();
  }
  assert.equal(c.noCors().length, 10, "新しい内容も、5回で止まる");
  assert.equal((await c.S.sendNow()).unconfirmed, true, "「今すぐ送信」は上限を超えても送る");
  assert.equal(c.noCors().length, 11);

  c.S.setConnection(ENDPOINT, CONN_KEY);
  c.env.ls.map.set(c.S.META.sendMode, "blind");
  assert.equal(c.S.status().retryStopped, false);
  assert.equal((await c.S.flush()).unconfirmed, true, "接続設定を変えたあとは、また自動で送れる");
  assert.equal(c.noCors().length, 12);
});

test("確認できないまま、保存のたびに送り続けることはない（タイマー・再帰で自動的に増えない）", async () => {
  const c = setupClient({ mode: "blind" });
  c.S.init();
  c.env.Storage.save(sampleState(c.env));
  await c.S.flush();
  // 保存の予約がなくても、時間が過ぎるだけでは、何も送られない（自動再送のタイマーを持たない）
  c.timers.length = 0;
  c.clock.t += 10 * 24 * 60 * 60 * 1000;
  assert.equal(c.active().length, 0);
  assert.equal(c.noCors().length, 1);
});

// ---------- スナップショットの世代（修正B・クライアント側） ----------

test("送るスナップショットには世代（snapshotCreatedAt）が付き、この端末では必ず増える（時計が戻っても戻らない）", async () => {
  const c = setupClient();
  c.S.init();
  const gens = [];
  const s = sampleState(c.env);
  for (let i = 0; i < 4; i++) {
    s.dailyRecords.push({ date: `2026-10-0${i + 2}`, weight: 66 - i / 10, comment: "" });
    c.env.Storage.save(s);
    if (i === 2) c.clock.t -= 60 * 1000; // 時計が1分戻った
    else if (i > 2) c.clock.t += 5;
    await c.S.flush();
    gens.push(JSON.parse(c.fetches[c.fetches.length - 1].opts.body).snapshotCreatedAt);
  }
  for (const g of gens) assert.match(g, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  for (let i = 1; i < gens.length; i++) assert.ok(gens[i] > gens[i - 1], `世代は増え続ける: ${gens[i - 1]} → ${gens[i]}`);
});

test("同じ時刻（同じミリ秒）に2回送っても、世代は同じにならない", () => {
  const c = setupClient();
  const a = c.S._nextSnapshotAt();
  const b = c.S._nextSnapshotAt();
  assert.ok(b > a);
});

test("前回の世代が「いま」より大きく先のとき（時計を直したあと）は、それに引きずられない", () => {
  const c = setupClient();
  c.env.ls.map.set(c.S.META.lastSnapshotMs, String(c.clock.t + 24 * 60 * 60 * 1000));
  const g = c.S._nextSnapshotAt();
  assert.equal(Date.parse(g), c.clock.t, "サーバーが拒否する未来の世代を、使い続けない");
});

// ---------- スナップショット ----------

test("stateの最上位キーが全件、スナップショットに入る（既知キー14件すべて）", () => {
  const c = setupClient();
  const s = sampleState(c.env);
  const rows = c.S.buildRows(s);
  const keys = [...new Set(rows.map((r) => r.key))];
  assert.deepEqual(keys.slice().sort(), Object.keys(s).sort());
  for (const k of c.env.Backup.KNOWN_TOP_KEYS) assert.ok(keys.includes(k), `${k} がスナップショットにある`);
  assert.equal(keys[0], "schemaVersion", "schemaVersion は先頭");
});

function bigState(c) {
  const s = sampleState(c.env);
  s.dailyRecords = Array.from({ length: 700 }, (_, i) => ({
    date: `2025-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}#${i}`,
    weight: 60 + (i % 50) / 10,
    comment: "日本語のメモ".repeat(4),
  }));
  return s;
}

test("35,000文字を超える項目はチャンクに分割され、どのチャンクも35,000文字以下", () => {
  const c = setupClient();
  const rows = c.S.buildRows(bigState(c));
  const daily = rows.filter((r) => r.key === "dailyRecords");
  assert.ok(daily.length > 1, "複数のチャンクになる");
  daily.forEach((r, i) => {
    assert.equal(r.chunk_index, i + 1);
    assert.equal(r.chunk_count, daily.length);
    assert.ok(r.json_chunk.length <= 35000);
  });
  for (const r of rows) assert.ok(r.json_chunk.length <= 35000);
});

test("チャンクを再結合すると、元のJSONと一致する", () => {
  const c = setupClient();
  const s = bigState(c);
  const rows = c.S.buildRows(s);
  const r = c.S.reconstruct(rows);
  assert.equal(r.ok, true);
  assert.equal(c.S.canonicalJSON(r.state), c.S.canonicalJSON(s));
  assert.deepEqual(clone(r.state), clone(s));
});

test("サロゲートペアの途中では分割しない（絵文字を含んでも壊れない）", () => {
  const c = setupClient();
  const text = "😀".repeat(30);
  const chunks = c.S.chunkString(text, 5);
  assert.equal(chunks.join(""), text);
  for (const ch of chunks) assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(ch), "孤立したサロゲートがない");
});

test("SHA-256: 同じcanonical JSONの値と一致し、再構成したstateからも同じ値になる", async () => {
  const c = setupClient();
  const s = bigState(c);
  const snap = await c.S.snapshotFromRaw(JSON.stringify(s));
  assert.equal(snap.sha256, sha256(c.S.canonicalJSON(s)));
  const back = c.S.reconstruct(snap.rows);
  assert.equal(sha256(c.S.canonicalJSON(back.state)), snap.sha256);
});

test("キーの並び順が違っても、canonical JSONとSHA-256は同じになる", async () => {
  const c = setupClient();
  const a = c.S.canonicalJSON({ b: 1, a: { y: [1, { d: 1, c: 2 }], x: null } });
  const b = c.S.canonicalJSON({ a: { x: null, y: [1, { c: 2, d: 1 }] }, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":{"x":null,"y":[1,{"c":2,"d":1}]},"b":1}');
});

test("再構成したstateは、既存の Backup.parse() の安全検証をそのまま通る", async () => {
  const c = setupClient();
  const s = sampleState(c.env);
  const snap = await c.S.snapshotFromRaw(JSON.stringify(s));
  const back = c.S.reconstruct(snap.rows);
  const parsed = c.env.Backup.parse(c.env.Backup.serialize(back.state), null);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.message || parsed));
  assert.deepEqual(clone(parsed.state.dailyRecords), clone(s.dailyRecords));
});

test("欠けたチャンク・番号の食い違い・不正なキー名は、再構成を拒否する", () => {
  const c = setupClient();
  const rows = c.S.buildRows(bigState(c));
  const daily = rows.filter((r) => r.key === "dailyRecords");
  assert.equal(c.S.reconstruct(rows.filter((r) => r !== daily[1])).ok, false, "欠け");
  assert.equal(c.S.reconstruct(rows.concat([clone(daily[0])])).ok, false, "重複");
  assert.equal(c.S.reconstruct([{ key: "__proto__", chunk_index: 1, chunk_count: 1, json_chunk: "{}" }]).ok, false, "不正なキー名");
  assert.equal(c.S.reconstruct([{ key: "a", chunk_index: 2, chunk_count: 1, json_chunk: "1" }]).ok, false, "番号");
  assert.equal(c.S.reconstruct([{ key: "a", chunk_index: 1, chunk_count: 1, json_chunk: "{" }]).ok, false, "壊れたJSON");
});

test("latestRecordDate: 予定の注射は含めず、実施済みはadministeredAtを使う（既存のBackup実装を再利用）", async () => {
  const c = setupClient();
  const s = sampleState(c.env);
  // sampleState: 体重・Protein・体調は 2026-10-01 まで、注射は 2026-10-08 の予定だけ
  let snap = await c.S.snapshotFromRaw(JSON.stringify(s));
  assert.equal(snap.latestRecordDate, "2026-10-01");
  assert.equal(snap.latestRecordDate, c.env.Backup.latestRecordDate(s));
  s.injections.push({ ...c.env.get("createEmptyInjection()"), id: 2, status: "administered", administeredAt: "2026-10-05", scheduledAt: "2099-12-31", regularDate: "2099-12-31" });
  snap = await c.S.snapshotFromRaw(JSON.stringify(s));
  assert.equal(snap.latestRecordDate, "2026-10-05");
});

// ---------- 設定・秘匿 ----------

test("endpoint・接続キー未設定のときは、通常の保存を妨げず、何も予約・送信しない", async () => {
  for (const opts of [{ configured: false, enabled: false }, { configured: false, enabled: true }, { configured: true, enabled: false }]) {
    const c = setupClient(opts);
    c.S.init();
    assert.equal(c.env.Storage.save(sampleState(c.env)), true);
    assert.ok(c.env.ls.getItem(c.env.STORAGE_KEY), "通常の保存は行われる");
    assert.equal(c.active().length, 0);
    assert.equal((await c.S.flush()).skipped, "inactive");
    assert.equal(c.fetches.length, 0);
    assert.equal(c.env.ls.getItem(c.S.META.pending), null);
  }
});

test("接続設定: script.google.com 以外・形式違い・短すぎるキーは保存しない", () => {
  const c = setupClient({ configured: false, enabled: false });
  for (const bad of [
    "https://evil.example.com/macros/s/AKfycb123/exec",
    "http://script.google.com/macros/s/AKfycb123/exec",
    "https://script.google.com.evil.example/macros/s/AKfycb123/exec",
    "https://script.google.com/macros/s/AKfycb123/exec?x=1",
    "https://script.google.com/macros/s//exec",
    "",
  ]) {
    assert.equal(c.S.setConnection(bad, CONN_KEY).ok, false, bad);
  }
  assert.equal(c.S.setConnection(ENDPOINT, "short").ok, false);
  assert.equal(c.S.isConfigured(), false);
  assert.equal(c.env.ls.getItem(c.S.META.endpoint), null);
  assert.equal(c.S.setConnection(`  ${ENDPOINT}  `, `  ${CONN_KEY}  `).ok, true, "前後の空白は取り除く");
  assert.equal(c.S.isConfigured(), true);
  assert.equal(c.env.ls.getItem(c.S.META.key), CONN_KEY);
});

test("接続キーは端末のlocalStorageにだけあり、state・バックアップJSON・スナップショットには入らない", async () => {
  const c = setupClient({ configured: false, enabled: false });
  c.S.setConnection(ENDPOINT, CONN_KEY);
  c.S.setEnabled(true);
  c.S.init();
  const s = sampleState(c.env);
  c.env.Storage.save(s);
  assert.ok(!c.env.ls.getItem(c.env.STORAGE_KEY).includes(CONN_KEY), "メインのstateに入らない");
  assert.ok(!c.env.Backup.serialize(s).includes(CONN_KEY), "書き出すJSONに入らない");
  const snap = await c.S.snapshotFromRaw(c.env.ls.getItem(c.env.STORAGE_KEY));
  assert.ok(!JSON.stringify(snap.rows).includes(CONN_KEY), "スナップショットの行に入らない");
  assert.ok(!JSON.stringify(snap.rows).includes("script.google.com"), "エンドポイントも入らない");
});

test("接続設定を消すと、送信は止まり、予約も取り消される", () => {
  const c = setupClient();
  c.S.init();
  c.env.Storage.save(sampleState(c.env));
  assert.equal(c.active().length, 1);
  c.S.clearConnection();
  assert.equal(c.active().length, 0);
  assert.equal(c.S.isConfigured(), false);
  assert.equal(c.S.getConfig().enabled, false);
});

test("接続キー・エンドポイント・スプレッドシートIDをソースコードに書いていない", () => {
  const files = ["js/sheets-sync.js", "js/ui-sheets-sync.js", "js/ui-backup.js", "js/app.js", "apps-script/Code.gs", "apps-script/appsscript.json", "index.html"];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    assert.ok(!/\/macros\/s\/[A-Za-z0-9_-]{10,}\/exec/.test(src), `${f}: デプロイURLを書いていない`);
    assert.ok(!/AKfycb[A-Za-z0-9_-]{10,}/.test(src), `${f}: デプロイIDを書いていない`);
    assert.ok(!/\b1[A-Za-z0-9_-]{43}\b/.test(src), `${f}: スプレッドシートIDの形の文字列がない`);
    for (const m of src.matchAll(/["'`]([A-Za-z0-9_-]{32,})["'`]/g)) {
      assert.ok(!(/[0-9]/.test(m[1]) && /[A-Za-z]/.test(m[1])), `${f}: 秘密らしい長い文字列「${m[1].slice(0, 8)}…」がある`);
    }
    assert.ok(!/(?:conn|sync|secret|api)[A-Za-z_]*key\s*[:=]\s*["'][^"']{8,}["']/i.test(src), `${f}: 接続キーの代入がない`);
  }
  const gs = fs.readFileSync(path.join(ROOT, "apps-script/Code.gs"), "utf8");
  assert.match(gs, /getProperty\("BG_SYNC_KEY"\)/, "接続キーはスクリプトプロパティから読む");
  assert.match(gs, /getProperty\("SPREADSHEET_ID"\)/, "スプレッドシートIDもスクリプトプロパティから読む");
});

// ---------- 設定画面 ----------

function setupUI(c) {
  vm.runInContext(
    `function escapeHtml(s){return String(s).replace(/[&<>"']/g,(ch)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));}`,
    c.env.ctx
  );
  vm.runInContext(fs.readFileSync(path.join(ROOT, "js", "ui-sheets-sync.js"), "utf8"), c.env.ctx, { filename: "ui-sheets-sync.js" });
  return c.env.get("SheetsSyncUI");
}

test("設定画面: ON/OFF・設定済み/未設定・最終確認日時・今すぐ送信がある。保存成功とは言わず、キーも表示しない", () => {
  const c = setupClient({ configured: false, enabled: false, mode: null });
  const ui = setupUI(c);
  let html = ui.html();
  assert.match(html, /自動バックアップを使う/);
  assert.match(html, /今すぐ送信/);
  assert.match(html, /接続設定：未設定/);
  assert.match(html, /まだ確認できていません/);
  assert.match(html, /id="sheets-enabled"[^>]*disabled/, "未設定のときはONにできない");
  assert.match(html, /<details/, "接続設定は折りたたまれている");

  c.S.setConnection(ENDPOINT, CONN_KEY);
  c.env.ls.map.set(c.S.META.lastConfirmedAt, "2026-11-15T01:02:03.000Z");
  html = ui.html();
  assert.match(html, /接続設定：設定済み/);
  assert.match(html, /最終確認日時：/);
  assert.ok(!html.includes(CONN_KEY), "接続キーを画面に出さない");
  assert.ok(!html.includes("AKfycb"), "エンドポイントを画面に出さない");
  assert.doesNotMatch(html, /保存(に)?成功しました|バックアップ完了|保存されました/, "成功を断定しない");
});

test("設定画面: 確認できていない送信は「最終送信試行日時」とし、「最終確認日時」とは出さない", () => {
  const c = setupClient({ mode: "blind" });
  const ui = setupUI(c);
  c.env.ls.map.set(c.S.META.lastAttemptAt, "2026-11-15T01:02:03.000Z");
  c.env.ls.map.set(c.S.META.pending, "1");
  const text = ui.statusText(c.S.status());
  assert.match(text, /最終送信試行日時：/);
  assert.doesNotMatch(text, /最終確認日時/, "確認できていないものを、確認済みの日時として出さない");
  assert.doesNotMatch(text, /最終送信日時/);
  assert.match(text, /まだ確認できていません/);
  assert.match(text, /未確認の変更があります/);
  assert.match(text, /応答を読めないため、保存の確認はできません/);

  // 確認できたときは、確認日時を出す
  c.env.ls.map.set(c.S.META.lastConfirmedAt, "2026-11-15T02:00:00.000Z");
  c.env.ls.map.set(c.S.META.sendMode, "cors");
  c.env.ls.map.delete(c.S.META.pending);
  const ok = ui.statusText(c.S.status());
  assert.match(ok, /最終確認日時：/);
  assert.doesNotMatch(ok, /まだ確認できていません/);
});

test("設定画面: 再送を止めているときは、そのことと再開のしかたを表示する", () => {
  const c = setupClient({ mode: "blind" });
  const ui = setupUI(c);
  c.env.ls.map.set(c.S.META.attemptCount, "5");
  assert.match(ui.statusText(c.S.status()), /自動の再送は止めています/);
});

test("設定画面: 直近の失敗は表示するが、保存への影響はないと伝える", () => {
  const c = setupClient();
  const ui = setupUI(c);
  c.env.ls.map.set(c.S.META.lastError, "サーバーが受け付けませんでした（unauthorized）");
  const text = ui.statusText(c.S.status());
  assert.match(text, /unauthorized/);
  assert.match(text, /記録の保存には影響していません/);
});
