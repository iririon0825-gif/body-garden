// Body Garden — Google Sheets 自動バックアップ（送信側）
//
// 方針
// - localStorage への保存（Storage.save）が成功したあとに、別系統で Google Apps Script Web App へ送る。
//   送信の成否は、保存の結果・画面操作・読み取り専用の状態に一切影響させない。
// - 「送信を試みた」と「サーバーが受け付けたと確認できた」を分けて持つ。
//     lastAttemptAt   … 最後に送信を試みた日時
//     lastConfirmedAt … サーバーの応答を読めて、受け付けたと確認できた日時（確認できたときだけ）
//   まず CORS で送り、応答（{ok:true}）を読めれば「確認済み」にする。読めなかったときは、届くかだけを no-cors で
//   確かめる。その場合は届いたかどうかを確認できないので、「未確認」のまま残し、確認できたとは扱わない。
// - 確認できていない同じ内容を無限に送り直さないよう、回数（MAX_ATTEMPTS）と間隔（RETRY_WAIT_MS）に上限を置く。
// - 送るスナップショットには、内容を保存した時刻から作る世代（snapshotCreatedAt。端末内で単調に増え、再送しても同じ）を付ける。
//   サーバーは、いま保存されている世代より古いものでは latest_snapshot を上書きしない。
// - 接続キー・エンドポイントはこの端末の localStorage にだけ置く（ソース・バックアップJSONには含めない。URLにも入れない）。
//   メインの state（bodyGarden.state）には何も足さない。
// - スナップショットは、最上位キーごとに canonical JSON（キー順を固定）へ直して 35,000 文字以下に分割する。
//   全体の SHA-256 も同じ canonical JSON から作る。復元に使うときは reconstruct() → Backup.parse() を通す。

const SheetsSync = {
  SOURCE: "body-garden-pwa",
  PAYLOAD_VERSION: 1,
  CHUNK_SIZE: 35000, // Sheets の 1セル 50,000文字に余裕を持たせる
  DEBOUNCE_MS: 2000,
  FETCH_TIMEOUT_MS: 20000,
  KEY_MIN_LENGTH: 16,
  // 確認できていない同じ内容の再送: 最大5回まで。n回目の試行のあと、次の試行までこれだけ待つ（最後の値を上限とする）。
  // 上限に達したら、内容が変わる・「今すぐ送信」・接続設定の変更があるまで、自動では送らない。
  MAX_ATTEMPTS: 5,
  RETRY_WAIT_MS: [60 * 1000, 5 * 60 * 1000, 30 * 60 * 1000, 2 * 60 * 60 * 1000],
  CLOCK_TOLERANCE_MS: 5 * 60 * 1000,
  // 個人の記録を送るので、送信先は Apps Script の公開URLだけに限る（貼り間違い・書き換えで別のホストへ送らない）
  ENDPOINT_PATTERN: /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/,
  TOP_KEY_PATTERN: /^[A-Za-z][A-Za-z0-9_]{0,63}$/,

  META: {
    enabled: "bodyGarden.meta.sheets.enabled",
    endpoint: "bodyGarden.meta.sheets.endpoint",
    key: "bodyGarden.meta.sheets.key",
    pending: "bodyGarden.meta.sheets.pending", // 未確認の変更がある（"1"）
    lastAttemptAt: "bodyGarden.meta.sheets.lastAttemptAt",
    attemptSha: "bodyGarden.meta.sheets.attemptSha", // 最後に試みた内容（ui を除いた SHA-256）
    attemptCount: "bodyGarden.meta.sheets.attemptCount", // 同じ内容を、確認できないまま試みた回数
    lastConfirmedAt: "bodyGarden.meta.sheets.lastConfirmedAt",
    confirmedSha: "bodyGarden.meta.sheets.confirmedSha", // サーバーが受け付けたと確認できた内容（ui を除いた SHA-256）
    lastError: "bodyGarden.meta.sheets.lastError",
    sendMode: "bodyGarden.meta.sheets.sendMode", // "cors"（応答を読める）／"blind"（読めない）／未設定（まだ分からない）
    lastSnapshotMs: "bodyGarden.meta.sheets.lastSnapshotMs", // 世代を作るときの前回の値（この端末で単調増加）
    stateAt: "bodyGarden.meta.sheets.stateAt", // いまの内容の世代＝その内容を保存した時刻。再送しても、画面を切り替えても変わらない
    stateSha: "bodyGarden.meta.sheets.stateSha", // stateAt を付けたときの内容（ui を除いた SHA-256）。内容が変わったときだけ世代を進める根拠
  },

  _timer: null,
  _seq: 0, // 保存のたびに増える。送信中に新しい保存があったかを見分ける
  _inFlight: false,
  _again: false,
  _stamping: null, // 保存直後の世代付け（非同期）。送信の前に、これが済むのを待つ

  _now() {
    return Date.now();
  },

  // ---------- 端末内の設定（メインの state とは別のキー） ----------

  _get(k) {
    try {
      return localStorage.getItem(k);
    } catch (_) {
      return null;
    }
  },
  _set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch (_) {
      // 設定・状態を書けなくても、記録の保存・操作には影響させない
    }
  },
  _del(k) {
    try {
      localStorage.removeItem(k);
    } catch (_) {
      // 同上
    }
  },

  getConfig() {
    return {
      enabled: this._get(this.META.enabled) === "1",
      endpoint: this._get(this.META.endpoint) || "",
      key: this._get(this.META.key) || "",
    };
  },

  isConfigured() {
    const c = this.getConfig();
    return this.ENDPOINT_PATTERN.test(c.endpoint) && c.key.length >= this.KEY_MIN_LENGTH;
  },

  _active() {
    return this.getConfig().enabled && this.isConfigured();
  },

  // 送信の記録（試行・確認・回数・通信方式）を捨てる。送信先・キーが変わったとき用
  _resetSendState() {
    for (const k of ["lastAttemptAt", "attemptSha", "attemptCount", "lastConfirmedAt", "confirmedSha", "lastError", "sendMode"]) {
      this._del(this.META[k]);
    }
  },

  // 接続設定を保存する。形式が正しくなければ保存しない。
  setConnection(endpoint, key) {
    const ep = String(endpoint || "").trim();
    const k = String(key || "").trim();
    if (!this.ENDPOINT_PATTERN.test(ep)) {
      return { ok: false, message: "エンドポイントURLは「https://script.google.com/macros/s/…/exec」の形で入力してください。" };
    }
    if (k.length < this.KEY_MIN_LENGTH) {
      return { ok: false, message: `接続キーは${this.KEY_MIN_LENGTH}文字以上にしてください。` };
    }
    this._set(this.META.endpoint, ep);
    this._set(this.META.key, k);
    // 送信先・キーが変わったら、これまでの試行・確認の記録を捨てる（キーを直したあと、同じ内容でも送り直せるように）
    this._resetSendState();
    return { ok: true };
  },

  clearConnection() {
    this._del(this.META.endpoint);
    this._del(this.META.key);
    this._resetSendState();
    this._set(this.META.enabled, "0");
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  },

  setEnabled(on) {
    this._set(this.META.enabled, on ? "1" : "0");
    if (on && this.isConfigured()) this.schedule(); // 有効にしたら、いまの内容を一度送る
    if (!on && this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  },

  status() {
    const c = this.getConfig();
    const attemptCount = Number(this._get(this.META.attemptCount) || 0);
    return {
      enabled: c.enabled,
      configured: this.isConfigured(),
      pending: this._get(this.META.pending) === "1",
      lastAttemptAt: this._get(this.META.lastAttemptAt),
      lastConfirmedAt: this._get(this.META.lastConfirmedAt),
      lastError: this._get(this.META.lastError),
      sendMode: this._get(this.META.sendMode),
      attemptCount,
      retryStopped: attemptCount >= this.MAX_ATTEMPTS,
      inFlight: this._inFlight,
    };
  },

  // ---------- スナップショット（canonical JSON・分割・SHA-256） ----------

  // キー順を固定した JSON。クライアントとサーバー（Apps Script）で同じ文字列になるようにする。
  canonicalJSON(value) {
    if (value === null || typeof value !== "object") {
      const s = JSON.stringify(value);
      return s === undefined ? "null" : s;
    }
    if (Array.isArray(value)) {
      return "[" + value.map((v) => (v === undefined || typeof v === "function" ? "null" : this.canonicalJSON(v))).join(",") + "]";
    }
    const parts = [];
    for (const k of Object.keys(value).sort()) {
      const v = value[k];
      if (v === undefined || typeof v === "function") continue;
      parts.push(JSON.stringify(k) + ":" + this.canonicalJSON(v));
    }
    return "{" + parts.join(",") + "}";
  },

  // 切る位置の工夫（どちらも、元の文字列は変えず、切る位置を数文字ずらすだけ）
  // ・UTF-16 のサロゲートペアの途中では切らない（途中で切ると、送信時に文字が壊れる）
  // ・次のチャンクの先頭が、' = + - @ や空白にならないようにする（表計算がセルの先頭の文字を特別に扱う可能性があるため）
  chunkString(str, size = this.CHUNK_SIZE) {
    const out = [];
    const risky = (ch) => ch === "'" || ch === "=" || ch === "+" || ch === "-" || ch === "@" || ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
    let i = 0;
    while (i < str.length) {
      let end = Math.min(i + size, str.length);
      if (end < str.length) {
        const c = str.charCodeAt(end - 1);
        if (c >= 0xd800 && c <= 0xdbff && end - 1 > i) end -= 1;
        let back = 0;
        while (end - 1 > i && back < 64 && risky(str.charAt(end))) {
          end -= 1;
          back += 1;
        }
        if (end - 1 > i) {
          const c2 = str.charCodeAt(end - 1);
          if (c2 >= 0xd800 && c2 <= 0xdbff) end -= 1;
        }
      }
      out.push(str.slice(i, end));
      i = end;
    }
    return out;
  },

  // state の最上位キーを1つずつ canonical JSON にして、チャンク行へ分ける。schemaVersion は先頭に置く。
  buildRows(state, size = this.CHUNK_SIZE) {
    const keys = Object.keys(state);
    const ordered = keys.includes("schemaVersion") ? ["schemaVersion", ...keys.filter((k) => k !== "schemaVersion")] : keys;
    const rows = [];
    for (const key of ordered) {
      if (state[key] === undefined) continue;
      const chunks = this.chunkString(this.canonicalJSON(state[key]), size);
      chunks.forEach((json_chunk, i) => rows.push({ key, chunk_index: i + 1, chunk_count: chunks.length, json_chunk }));
    }
    return rows;
  },

  // 行（latest_snapshot の内容）から state を組み立てる。形式が崩れていれば ok:false。
  // 組み立てた結果は、そのまま Backup.parse() の入力（Backup.serialize）に使える。
  reconstruct(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return { ok: false, message: "行がありません。" };
    const groups = new Map();
    for (const r of rows) {
      if (!r || typeof r.key !== "string" || !this.TOP_KEY_PATTERN.test(r.key)) return { ok: false, message: "キー名が正しくありません。" };
      const idx = Number(r.chunk_index);
      const cnt = Number(r.chunk_count);
      if (!Number.isInteger(idx) || !Number.isInteger(cnt) || idx < 1 || cnt < 1 || idx > cnt) return { ok: false, message: "チャンク番号が正しくありません。" };
      if (typeof r.json_chunk !== "string") return { ok: false, message: "チャンクの内容が文字列ではありません。" };
      let g = groups.get(r.key);
      if (!g) {
        g = { count: cnt, parts: new Map() };
        groups.set(r.key, g);
      }
      if (g.count !== cnt || g.parts.has(idx)) return { ok: false, message: "チャンクの数・番号が一致しません。" };
      g.parts.set(idx, r.json_chunk);
    }
    const state = {};
    for (const [key, g] of groups) {
      if (g.parts.size !== g.count) return { ok: false, message: `「${key}」のチャンクが欠けています。` };
      let json = "";
      for (let i = 1; i <= g.count; i++) json += g.parts.get(i);
      try {
        state[key] = JSON.parse(json);
      } catch (_) {
        return { ok: false, message: `「${key}」を読み取れません。` };
      }
    }
    return { ok: true, state };
  },

  async sha256Hex(str) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
  },

  // 画面の状態（ui）を除いた内容の SHA-256（「内容が変わったか」の判定に使う）
  contentShaOf(state) {
    const { ui: _ui, ...withoutUi } = state;
    return this.sha256Hex(this.canonicalJSON(withoutUi));
  },

  // 保存済みの生データ（localStorage の文字列）から、送るもの一式を作る
  async snapshotFromRaw(raw) {
    const state = JSON.parse(raw);
    if (!state || typeof state !== "object" || Array.isArray(state) || !Number.isInteger(state.schemaVersion)) {
      throw new Error("保存データの形式が正しくありません");
    }
    if (state.schemaVersion > SCHEMA_VERSION) throw new Error("保存データの方が新しい版です");
    const sha256 = await this.sha256Hex(this.canonicalJSON(state));
    // 「前回と同じ内容か」の判定には、画面の状態（ui: 最後に開いた画面など）を含めない。
    // タブを切り替えるだけで保存が走るので、含めると、記録を変えていないのに全データを再送し、ログが増え続ける。
    // 送るデータ（rows・sha256）には ui も含める（state 全体を保存する）。
    const contentSha256 = await this.contentShaOf(state);
    return {
      schemaVersion: state.schemaVersion,
      latestRecordDate: Backup.latestRecordDate(state) || "", // 既存のバックアップ実装と同じ定義（予定の注射は含めない）
      sha256,
      contentSha256,
      rows: this.buildRows(state),
    };
  },

  // スナップショットの世代。この端末では必ず増える（時計が戻っても戻らない）。
  // 世代は「内容を保存した時刻」で決め、再送しても変えない。付けるのは、保存のとき（_onSaved）と、内容が保存の外で
  // 変わっていたとき（flush が気づいた分）だけ。再送・オンライン復帰・起動・画面の切り替え（ui だけの保存）では進めない。
  // 「送った時刻」にすると、オフラインのあいだに古くなった内容を、あとから送り直したとき、別の端末が書いた
  // 新しい内容を巻き戻してしまうため。
  // サーバーは、いま保存されている世代より古いものを受け付けない（遅れて届いた古い送信で、最新が巻き戻らないように）。
  // 前回の値が「いま」より大きく先なら（時計を直したなど）、それは無視する（サーバーが未来の世代を拒否するため）。
  _nextSnapshotAt() {
    const now = this._now();
    let last = Number(this._get(this.META.lastSnapshotMs));
    if (!Number.isFinite(last) || last > now + this.CLOCK_TOLERANCE_MS) last = 0;
    const ms = Math.max(now, last + 1);
    this._set(this.META.lastSnapshotMs, String(ms));
    return new Date(ms).toISOString();
  },

  // 送る内容の世代。保存したときに付けた値を使う（再送しても同じ）。まだ無い場合（保存の外で変わった・初回の
  // 「今すぐ送信」など）と、前回の値が「いま」より大きく先のとき（時計を直した）は、新しく付ける。
  _generation() {
    const saved = this._get(this.META.stateAt);
    const ms = Date.parse(saved || "");
    if (Number.isFinite(ms) && ms <= this._now() + this.CLOCK_TOLERANCE_MS) return saved;
    const fresh = this._nextSnapshotAt();
    this._set(this.META.stateAt, fresh);
    return fresh;
  },

  // 保存が成功した直後（Storage.onSaved）。世代の候補（この保存の時刻）を、その場で確保する。
  // 内容（ui を除く）が前回の世代を付けたときと違う場合だけ、その時刻を世代にする（順番を守るため1本につなぐ）。
  _onSaved() {
    if (!this._active()) return; // 使っていないときは、何もしない（通常の保存に、手間を足さない）
    let raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (_) {
      raw = null;
    }
    const at = this._nextSnapshotAt();
    if (raw !== null) {
      this._stamping = (this._stamping || Promise.resolve())
        .then(async () => {
          const sha = await this.contentShaOf(JSON.parse(raw));
          if (sha !== this._get(this.META.stateSha)) {
            this._set(this.META.stateAt, at);
            this._set(this.META.stateSha, sha);
          }
        })
        .catch(() => {});
    }
    this.schedule();
  },

  buildPayload(snap, key, snapshotCreatedAt) {
    return {
      v: this.PAYLOAD_VERSION,
      key,
      source: this.SOURCE,
      snapshotCreatedAt,
      schemaVersion: snap.schemaVersion,
      latestRecordDate: snap.latestRecordDate,
      sha256: snap.sha256,
      rows: snap.rows,
    };
  },

  // ---------- 送信の予約・実行 ----------

  // Storage.save が成功した直後に呼ばれる。ここでは通信しない（予約するだけ）。
  schedule() {
    if (!this._active()) return;
    this._seq += 1;
    this._set(this.META.pending, "1");
    if (this._timer !== null) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush().catch(() => {});
    }, this.DEBOUNCE_MS);
  },

  // 確認できていない同じ内容を、続けて送り直してよいか。だめなら理由を返す。
  _retryGate(contentSha) {
    if (this._get(this.META.attemptSha) !== contentSha) return null; // 内容が変わっていれば、新しい送信として扱う
    const n = Number(this._get(this.META.attemptCount) || 0);
    if (n >= this.MAX_ATTEMPTS) return "retryLimit";
    const last = Date.parse(this._get(this.META.lastAttemptAt) || "");
    if (Number.isFinite(last) && n >= 1) {
      const wait = this.RETRY_WAIT_MS[Math.min(n, this.RETRY_WAIT_MS.length) - 1];
      if (this._now() - last < wait) return "retryWait";
    }
    return null;
  },

  _recordAttempt(contentSha) {
    const same = this._get(this.META.attemptSha) === contentSha;
    const n = same ? Number(this._get(this.META.attemptCount) || 0) : 0;
    this._set(this.META.attemptSha, contentSha);
    this._set(this.META.attemptCount, String(n + 1));
    this._set(this.META.lastAttemptAt, new Date(this._now()).toISOString());
  },

  _readState() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (_) {
      return null;
    }
  },

  // 実際の送信。失敗しても例外は外へ出さない（保存・画面操作を止めない）。
  // force: 前回と同じ内容でも、再送の上限を超えていても送る（「今すぐ送信」）
  // 戻り値: confirmed=サーバーが受け付けたと確認できた ／ unconfirmed=送ったが確認できない ／ error=通信できなかった
  async flush({ force = false } = {}) {
    if (!this._active()) return { ok: false, skipped: "inactive" };
    if (Storage.readOnly) return { ok: false, skipped: "readOnly" };
    if (typeof navigator !== "undefined" && navigator.onLine === false) return { ok: false, skipped: "offline" };
    if (this._inFlight) {
      this._again = true;
      return { ok: false, skipped: "inFlight" };
    }
    this._inFlight = true;
    const seqAtStart = this._seq;
    try {
      // 読み取り → 計算の間に、別の保存が入ることがある（その保存の世代付けは、別に進んでいる）。
      // 古い内容にその世代を、新しい内容に古い世代を付けてしまわないよう、世代付けが済み、かつ読んでから内容が
      // 変わっていないことを確かめてから先へ進む。変わっていたら読み直す（数回で収まらなければ、その保存が
      // 予約した次の送信に任せる）。
      let raw = null;
      let snap = null;
      for (let tries = 0; tries < 3 && snap === null; tries++) {
        if (this._stamping) await this._stamping;
        raw = this._readState();
        if (raw === null) return { ok: false, skipped: "noData" };
        const candidate = await this.snapshotFromRaw(raw);
        if (this._stamping) await this._stamping;
        if (this._readState() === raw) snap = candidate;
      }
      if (snap === null) return { ok: false, skipped: "changing" };
      // ↓ここから送信の準備が済むまで await を挟まない（途中に別の保存が割り込まない）
      // 保存の外で内容が変わっていた場合（復元・使っていない間の保存・初回）は、いま気づいた時刻を世代にする
      if (snap.contentSha256 !== this._get(this.META.stateSha)) {
        this._set(this.META.stateAt, this._nextSnapshotAt());
        this._set(this.META.stateSha, snap.contentSha256);
      }
      // 「同じ内容」を省くのは、サーバーが受け付けたと確認できた内容だけ（確認できていない内容は省かない）
      if (!force && snap.contentSha256 === this._get(this.META.confirmedSha)) {
        if (seqAtStart === this._seq) this._del(this.META.pending);
        return { ok: true, confirmed: true, skipped: "unchanged" };
      }
      if (!force) {
        const gate = this._retryGate(snap.contentSha256);
        if (gate) return { ok: false, skipped: gate };
      }
      this._recordAttempt(snap.contentSha256);
      const res = await this._post(this.buildPayload(snap, this.getConfig().key, this._generation()));
      if (res.confirmed) {
        this._set(this.META.lastConfirmedAt, new Date(this._now()).toISOString());
        this._set(this.META.confirmedSha, snap.contentSha256);
        this._del(this.META.lastError);
        this._del(this.META.attemptCount);
        this._del(this.META.attemptSha);
        if (seqAtStart === this._seq) this._del(this.META.pending); // 送信中に新しい保存があれば、未確認のまま残す
        return { ok: true, confirmed: true, duplicate: !!res.duplicate };
      }
      // 送ったが、サーバーが受け付けたと確認できない。未確認のまま残す（未送信フラグも消さない）
      if (res.serverError) this._set(this.META.lastError, `サーバーが受け付けませんでした（${res.serverError}）`);
      else this._del(this.META.lastError);
      return { ok: false, unconfirmed: true, readable: !!res.readable, serverError: res.serverError || null };
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 200);
      this._set(this.META.lastError, msg);
      console.warn("[BodyGarden] Google Sheets への送信に失敗（記録の保存には影響しません）", msg);
      return { ok: false, error: msg };
    } finally {
      this._inFlight = false;
      if (this._again) {
        this._again = false;
        this.schedule();
      }
    }
  },

  // POST（text/plain なのでプリフライトなし。接続キーは本文だけに入れ、URLには入れない）
  // 応答の本文まで読み終わるまでを、同じ時間制限（FETCH_TIMEOUT_MS）で区切る（読み取りが止まって送信が固まらないように）。
  // readBody=false（no-cors）のときは、応答は不透明で読めないので、本文は読まない。
  async _fetch(payload, mode, readBody) {
    const { endpoint } = this.getConfig();
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const t = ctrl ? setTimeout(() => ctrl.abort(), this.FETCH_TIMEOUT_MS) : null;
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        mode,
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        redirect: "follow",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload),
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (!readBody) return { res, text: null };
      let text = null;
      try {
        text = await res.text();
      } catch (e) {
        if (e && e.name === "AbortError") throw e; // 時間切れは、通信の失敗として扱う
        text = null; // 読めなかった（応答が壊れている）
      }
      return { res, text };
    } finally {
      if (t !== null) clearTimeout(t);
    }
  },

  // まず応答を読める CORS で送る。読める環境なら、サーバーの答え（{ok:true}）で「確認済み」にできる。
  // CORS で失敗したときは、通信できないのか、応答を読めないだけなのか、区別できない。
  // 以前に読めたことがなければ、no-cors で一度だけ送り直して確かめる（同じ内容は、サーバーが重複として受け付ける）。
  //   no-cors が通れば「いまは応答を読めない（blind）」。この回は確認できない。
  //   no-cors も通らなければ、通信できていないので例外にする。
  // 「読めない環境」を、一度の失敗で固定しない（毎回、まず CORS を試す）。時間切れ（AbortError）は、読めない
  // こととは別の通信の問題なので、確かめの送信もしない。
  async _post(payload) {
    const mode = this._get(this.META.sendMode);
    let got;
    try {
      got = await this._fetch(payload, "cors", true);
    } catch (e) {
      if (mode === "cors" || (e && e.name === "AbortError")) throw e; // 以前は読めていた／時間切れ → 通信の失敗
      await this._fetch(payload, "no-cors", false);
      this._set(this.META.sendMode, "blind");
      return { confirmed: false, readable: false };
    }
    this._set(this.META.sendMode, "cors");
    return this._readResponse(got);
  },

  _readResponse({ res, text }) {
    let body = null;
    try {
      if (typeof text !== "string") throw new Error("no body");
      body = JSON.parse(text);
    } catch (_) {
      return { confirmed: false, readable: true, serverError: "bad_response" };
    }
    if (res.ok && body && body.ok === true) return { confirmed: true, readable: true, duplicate: body.duplicate === true };
    const code = body && typeof body.error === "string" ? body.error.replace(/[^A-Za-z0-9_]/g, "").slice(0, 40) : "";
    return { confirmed: false, readable: true, serverError: code || `http_${res.status}` };
  },

  sendNow() {
    return this.flush({ force: true });
  },

  // 起動時に一度だけ呼ぶ。保存後のフック・オンライン復帰・起動時の再送を結びつける。
  init() {
    Storage.onSaved = () => this._onSaved();
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("online", () => {
        if (this._get(this.META.pending) === "1") this.schedule();
      });
    }
    this._startupCheck().catch(() => {});
  },

  // 起動時: 未確認が残っている、または確認できた内容と違う（復元など、保存の外で変わった場合も含む）なら再送を予約。
  // 実際に送るかどうかは、flush の再送の上限が決める（起動のたびに無限に送り直さない）。
  async _startupCheck() {
    if (!this._active()) return;
    if (this._get(this.META.pending) === "1") return this.schedule();
    let raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (_) {
      return;
    }
    if (raw === null) return;
    const snap = await this.snapshotFromRaw(raw);
    if (snap.contentSha256 !== this._get(this.META.confirmedSha)) this.schedule();
  },
};
