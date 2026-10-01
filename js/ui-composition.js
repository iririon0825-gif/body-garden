// Body Garden — 体組成タブ（一括貼り付け登録・プレビュー・履歴）
// ロジックは body-composition-logic.js（純粋関数）。ここは画面と操作の流れだけを担当する。
//
// 流れ: 登録用テキストを貼り付け → 内容を確認（解析・プレビュー）→ 測定日を確認 → 保存へ進む → 確認画面 → 保存
//  - アプリ内OCRは無い。画像の読み取りと登録用テキストの作成はオルグレイ（ChatGPT）が担当する。
//  - 保存は検証してから1回だけ。保存に失敗したら、記録と goals を元に戻し、何も変更しない。
//  - 同じ測定日に既存の値があるときは、既定で既存を残す。上書きは本人が項目ごとに選ぶ。
// 表示する文字列は escapeHtml を通す（貼り付けのテキストは外部の入力）。

const CompositionUI = {
  // 下書きはメモリ上にだけ置く（localStorage には保存しない）
  _draft: null,
  _status: "",

  _now() {
    return new Date();
  },
  _fresh() {
    return { text: "", parsed: null, date: "", time: "", overwrite: {}, weight: "keep", ack: false, basis: null };
  },
  _d() {
    if (!this._draft) this._draft = this._fresh();
    return this._draft;
  },

  // ============ 小さな部品 ============

  STATUS_LABEL: {
    ok: ["読取済", "ok"],
    suspect: ["要確認", "warn"],
    missing: ["未読取", "muted"],
    absent: ["記載なし", "muted"],
    invalidValue: ["値が不正", "bad"],
    unitMissing: ["単位なし", "bad"],
    unitMismatch: ["単位不一致", "bad"],
    outOfRange: ["範囲外", "bad"],
    duplicate: ["重複", "bad"],
  },

  _fmt(field, v) {
    if (v === null || v === undefined) return "—";
    if (field.type === "string") return escapeHtml(v);
    return `${escapeHtml(String(v))}${field.unit ? escapeHtml(field.unit) : ""}`;
  },
  _field(key) {
    return COMPOSITION_FIELDS.find((f) => f.key === key);
  },
  _writable() {
    if (!Storage.readOnly) return true;
    this._info("いまは変更を保存できません", "画面上部の案内のとおり、データを守るため、この画面では変更を保存しない状態です。再読み込みしてから操作してください（変更は行っていません）。");
    return false;
  },
  _info(title, bodyHtml) {
    UI.showModal(`
      <p class="modal-title">${escapeHtml(title)}</p>
      <div class="modal-body">${bodyHtml}</div>
      <div class="modal-actions"><button class="btn-primary" id="comp-info-close">閉じる</button></div>`);
    document.getElementById("comp-info-close").addEventListener("click", () => UI.hideModal());
  },
  _confirm({ title, body, okLabel, onOk }) {
    UI.showModal(`
      <p class="modal-title">${escapeHtml(title)}</p>
      <div class="modal-body">${body}</div>
      <div class="modal-actions">
        <button class="btn-secondary" id="comp-confirm-cancel">キャンセル</button>
        <button class="btn-primary" id="comp-confirm-ok">${escapeHtml(okLabel)}</button>
      </div>`);
    document.getElementById("comp-confirm-cancel").addEventListener("click", () => UI.hideModal());
    document.getElementById("comp-confirm-ok").addEventListener("click", () => onOk());
  },

  // 解析結果と測定日から、確認用の評価を作る（state は変えない）
  _assess(state) {
    const d = this._d();
    if (!d.parsed || !d.parsed.ok) return null;
    return BodyCompositionLogic.assess(state, d.parsed, d.date, this._now());
  },

  // 測定日を決めたときの既定の選択（既存の値は残す。体重は、その日の体重が無いときだけ登録をオンにする）
  _resetChoices(state) {
    const d = this._d();
    d.overwrite = {};
    d.ack = false;
    const a = this._assess(state);
    d.weight = a && a.weight.kind === "add" ? "set" : "keep";
    d.basis = a ? a.basis : null; // プレビューを出した時点の、その日の既存の状態。保存の直前に食い違えば保存しない
  },

  // ============ 画面 ============

  render(state) {
    const el = document.getElementById("composition-root");
    if (!el) return;
    try {
      el.innerHTML = this._pageHtml(state);
      this._bind(state);
    } catch (e) {
      console.error("[BodyGarden] 体組成タブを表示できません", e);
      el.innerHTML = `<section class="card"><p class="card-title">体組成</p><p class="form-error">体組成の画面を表示できませんでした。設定画面からバックアップを書き出してから、データの内容を確認してください。</p></section>`;
    }
  },

  _pageHtml(state) {
    const d = this._d();
    const status = this._status ? `<p class="comp-status" role="status">${escapeHtml(this._status)}</p>` : "";
    const err = d.parsed && !d.parsed.ok ? `<div class="comp-errors">${d.parsed.errors.map((e) => `<p class="form-error">${escapeHtml(e.message)}</p>`).join("")}</div>` : "";
    return `
      <section class="card">
        <p class="card-title">${UI.lineIcon("composition")}体組成を貼り付けて登録</p>
        <p class="comp-note">体組成計のスクリーンショットから、オルグレイが作った「登録用テキスト」を、そのまま貼り付けてください。項目ごとの入力は要りません。保存の前に、内容と測定日を確認します。</p>
        ${status}
        <textarea class="backup-textarea comp-textarea" id="comp-text" maxlength="${COMPOSITION_TEXT_MAX_CHARS}" placeholder="【Body Garden 体組成 v1】&#10;測定日: 2026-10-01&#10;体重: 66.80 kg&#10;…&#10;【ここまで】">${escapeHtml(d.text)}</textarea>
        ${err}
        <div class="comp-actions">
          <button class="btn-primary" id="comp-parse-btn">内容を確認</button>
          <button class="btn-text" id="comp-clear-btn">クリア</button>
          <button class="btn-text" id="comp-spec-btn">オルグレイ向けの仕様を見る・コピー</button>
        </div>
      </section>
      ${d.parsed && d.parsed.ok ? this._previewCard(state) : ""}
      ${this._historyCard(state)}`;
  },

  // プレビュー（16項目の確認）
  _previewCard(state) {
    const d = this._d();
    const p = d.parsed;
    const a = this._assess(state);
    const B = BodyCompositionLogic;
    const today = B._ymd(this._now());
    for (const k of Object.keys(d.overwrite)) if (!a.rows.some((r) => r.key === k && r.kind === "conflict")) delete d.overwrite[k];
    const hasExisting = !!(a && a.existing && (Object.values(a.existing.bodyComposition || {}).some((v) => v !== null) || a.existing.weight != null));
    const rows = a.rows
      .map((r) => {
        const f = this._field(r.key);
        const [label, cls] = this.STATUS_LABEL[r.status] || [r.status, "muted"];
        const incoming = r.incoming === null ? "—" : this._fmt(f, r.incoming);
        const existingCell = hasExisting ? `<td class="comp-num">${this._fmt(f, r.existing)}</td>` : "";
        let action = `<span class="comp-chip comp-chip-${cls}">${escapeHtml(label)}</span>`;
        if (r.kind === "conflict") {
          action += ` <label class="comp-ow"><input type="checkbox" data-comp-ow="${escapeHtml(r.key)}" ${d.overwrite[r.key] ? "checked" : ""} /> 上書き</label>`;
        } else if (r.kind === "same") action += ` <span class="comp-same">同じ</span>`;
        else if (r.kind === "keep") action += ` <span class="comp-same">既存を残す</span>`;
        const msg = r.message && r.status !== "ok" && r.status !== "missing" && r.status !== "absent" ? `<tr class="comp-msg"><td colspan="${hasExisting ? 4 : 3}">${escapeHtml(r.message)}</td></tr>` : "";
        return `<tr class="comp-row comp-row-${escapeHtml(r.kind)}"><th scope="row">${escapeHtml(r.label)}</th>${existingCell}<td class="comp-num">${incoming}</td><td>${action}</td></tr>${msg}`;
      })
      .join("");

    const w = a.weight;
    const weightBlock =
      w.kind === "none"
        ? ""
        : `<div class="comp-weight">
             <p class="comp-sub"><strong>この日の体重（記録タブの体重）</strong>：${w.existing === null ? "まだ記録がありません" : `既存 ${escapeHtml(String(w.existing))}kg`}／体組成計の体重 ${escapeHtml(String(w.measured))}kg${w.diff !== null && w.diff !== 0 ? `（差 ${w.diff > 0 ? "+" : ""}${escapeHtml(String(w.diff))}kg）` : ""}</p>
             ${
               w.kind === "same"
                 ? `<p class="comp-sub">既存の体重と同じです（変更なし）。</p>`
                 : `<label class="form-field-inline"><input type="radio" name="comp-weight" value="set" ${d.weight === "set" ? "checked" : ""} /> <span>${w.kind === "add" ? "この日の体重として登録する" : "体組成計の値に更新する"}</span></label>
                    <label class="form-field-inline"><input type="radio" name="comp-weight" value="keep" ${d.weight !== "set" ? "checked" : ""} /> <span>${w.kind === "add" ? "体重は登録しない（体組成の値だけ保存）" : "既存の体重のまま残す"}</span></label>
                    <p class="comp-sub">体重を登録・更新すると、記録タブの体重と同じ扱い（HOME・グラフ・Goal・BMIの判定）になります。判定には、体組成計のBMIではなく、アプリが体重と身長から計算するBMIを使います。</p>`
             }
           </div>`;

    const warnList = a.warnings.map((x) => `<li>${escapeHtml(x.message)}</li>`).join("");
    const unrec = p.unrecognizedLines
      .slice(0, 20)
      .map((u) => `<li>${u.lineNo}行目「${escapeHtml(u.text)}」${u.hint ? `<br /><small>${escapeHtml(u.hint)}</small>` : ""}</li>`)
      .join("");
    const notes = p.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("");
    const blocking = a.blocking.map((b) => `<p class="form-error">${escapeHtml(b.message)}</p>`).join("");
    const canSave = a.blocking.length === 0 && (!a.needsAck || d.ack);
    const c = p.counts;
    const dateHint = p.dateStatus === "ok" ? "画像から読み取った日付です。間違いがないか確認してください。" : "測定日を読み取れませんでした。日付を入力してください（今日の日付を自動では入れません）。";

    return `
      <section class="card" id="comp-preview">
        <p class="card-title">${UI.lineIcon("composition")}内容の確認（まだ保存されていません）</p>
        <p class="comp-sub">読み取り ${c.ok + c.suspect}／16項目${c.suspect ? `（うち要確認 ${c.suspect}）` : ""}　未読取・記載なし ${c.missing + c.absent}　保存しない ${c.problem}${p.unrecognizedLines.length ? `　未認識の行 ${p.unrecognizedLines.length}` : ""}</p>
        <div class="form-grid">
          <label class="form-field"><span>測定日（必ず確認）</span><input type="date" id="comp-date" value="${escapeHtml(d.date)}" max="${today}" /></label>
          <label class="form-field"><span>測定時刻（任意）</span><input type="time" id="comp-time" value="${escapeHtml(d.time)}" /></label>
        </div>
        <p class="comp-sub">${escapeHtml(dateHint)} <button class="btn-text" id="comp-today-btn" type="button">今日の日付を入れる</button></p>
        ${blocking}
        ${hasExisting ? `<p class="comp-sub comp-existing">この測定日には、すでに記録があります。<strong>既存の値は、既定では上書きしません。</strong>違う値は「上書き」を選んだ項目だけ、新しい値になります。</p>` : ""}
        <div class="comp-table-wrap">
          <table class="comp-table">
            <thead><tr><th>項目</th>${hasExisting ? "<th>既存</th>" : ""}<th>今回</th><th>状態</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        ${weightBlock}
        ${warnList ? `<p class="comp-sub"><strong>確認してください</strong></p><ul class="backup-list">${warnList}</ul>` : ""}
        ${unrec ? `<p class="comp-sub"><strong>未認識の行（保存されません）</strong></p><ul class="backup-list">${unrec}${p.unrecognizedLines.length > 20 ? `<li>ほか ${p.unrecognizedLines.length - 20} 行</li>` : ""}</ul>` : ""}
        ${notes ? `<p class="comp-sub"><strong>備考（表示のみ。保存されません）</strong></p><ul class="backup-list">${notes}</ul>` : ""}
        ${
          a.needsAck
            ? `<label class="form-field-inline comp-ack"><input type="checkbox" id="comp-ack" ${d.ack ? "checked" : ""} /> <span>保存されない項目・未認識の行・警告があることを確認しました</span></label>`
            : ""
        }
        <div class="comp-actions">
          <button class="btn-primary" id="comp-save-btn" ${canSave ? "" : "disabled"}>保存へ進む</button>
          <button class="btn-text" id="comp-reset-btn">やり直す</button>
        </div>
      </section>`;
  },

  // 履歴（体組成のある日。新しい順）
  _historyCard(state) {
    const rows = BodyCompositionLogic.historyRows(state, 20);
    const today = BodyCompositionLogic._ymd(this._now());
    const f = (r, k) => (r.bodyComposition[k] === null || r.bodyComposition[k] === undefined ? "—" : this._fmt(this._field(k), r.bodyComposition[k]));
    const list = rows
      .map(
        (r) => `<li class="comp-hrow">
          <div class="comp-hmain"><span class="comp-hdate">${escapeHtml(r.date)}${r.compositionMeta && r.compositionMeta.measuredTime ? ` ${escapeHtml(r.compositionMeta.measuredTime)}` : ""}</span><span class="comp-hval">${f(r, "measuredWeight")}</span></div>
          <div class="comp-hsub">体脂肪率 ${f(r, "bodyFatPct")}　筋肉量 ${f(r, "muscleMass")}${r.compositionMeta && r.compositionMeta.mixed ? `　<span class="comp-chip comp-chip-warn">2回分が混在</span>` : ""}</div>
          <div class="comp-hactions"><button class="btn-text" data-comp-detail="${escapeHtml(r.date)}">詳細</button></div>
        </li>`
      )
      .join("");
    void today;
    return `
      <section class="card">
        <p class="card-title">${UI.lineIcon("records")}体組成の記録（直近${Math.min(rows.length, 20)}件）</p>
        ${rows.length === 0 ? `<div class="placeholder-box">まだ体組成の記録がありません</div>` : `<ul class="comp-hlist">${list}</ul>`}
      </section>`;
  },

  // ============ 操作 ============

  _bind(state) {
    const d = this._d();
    const on = (id, ev, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener(ev, fn);
    };
    on("comp-text", "input", (e) => {
      d.text = e.target.value;
      // 確認したあとで本文を直したら、プレビューは古くなる。取り下げて、もう一度「内容を確認」してもらう
      if (d.parsed) {
        d.parsed = null;
        d.basis = null;
        const pv = document.getElementById("comp-preview");
        if (pv) pv.remove();
        this._status = "";
        const st = document.querySelector(".comp-status");
        if (st) st.remove();
        const er = document.querySelector(".comp-errors");
        if (er) er.remove();
        if (!document.getElementById("comp-stale-note")) e.target.insertAdjacentHTML("afterend", `<p class="comp-sub" id="comp-stale-note" role="status">本文を変更したため、確認の内容を取り下げました。「内容を確認」を押してください。</p>`);
      }
    });
    on("comp-parse-btn", "click", () => this._parse(state));
    on("comp-clear-btn", "click", () => {
      this._draft = this._fresh();
      this._status = "";
      this.render(state);
    });
    on("comp-reset-btn", "click", () => {
      d.parsed = null;
      d.date = "";
      d.time = "";
      d.overwrite = {};
      d.ack = false;
      this.render(state);
    });
    on("comp-spec-btn", "click", () => this._showSpec());
    on("comp-date", "change", (e) => {
      d.date = e.target.value;
      this._resetChoices(state);
      this.render(state);
    });
    on("comp-time", "input", (e) => {
      d.time = e.target.value;
    });
    on("comp-today-btn", "click", () => {
      d.date = BodyCompositionLogic._ymd(this._now());
      this._resetChoices(state);
      this.render(state);
    });
    on("comp-ack", "change", (e) => {
      d.ack = e.target.checked;
      this.render(state);
    });
    document.querySelectorAll("[data-comp-ow]").forEach((c) =>
      c.addEventListener("change", () => {
        d.overwrite[c.dataset.compOw] = c.checked;
        this.render(state);
      })
    );
    document.querySelectorAll('input[name="comp-weight"]').forEach((r) =>
      r.addEventListener("change", () => {
        d.weight = r.value;
        this.render(state);
      })
    );
    on("comp-save-btn", "click", () => this._confirmSave(state));
    document.querySelectorAll("[data-comp-detail]").forEach((b) => b.addEventListener("click", () => this._showDetail(state, b.dataset.compDetail)));
  },

  _parse(state) {
    const d = this._d();
    const ta = document.getElementById("comp-text");
    if (ta) d.text = ta.value;
    this._status = "";
    d.parsed = BodyCompositionLogic.parse(d.text, this._now());
    if (d.parsed.ok) {
      d.date = d.parsed.date || ""; // 読めなかったときは空欄（今日の日付を自動では入れない）
      d.time = d.parsed.time || "";
      this._resetChoices(state);
    }
    this.render(state);
  },

  // オルグレイに渡す仕様文（項目の定義から自動で作るので、解析とずれない）
  _showSpec() {
    const text = BodyCompositionLogic.specText();
    UI.showModal(`
      <p class="modal-title">オルグレイ向け 登録用テキストの仕様</p>
      <p class="modal-body">コピーして、オルグレイ（ChatGPT）に渡してください。体組成計のスクリーンショットと一緒に渡すと、この形式のテキストを作ってもらえます。</p>
      <textarea class="backup-textarea comp-spec" id="comp-spec-text" readonly>${escapeHtml(text)}</textarea>
      <p class="comp-sub" id="comp-copy-status" role="status"></p>
      <div class="modal-actions">
        <button class="btn-secondary" id="comp-spec-close">閉じる</button>
        <button class="btn-primary" id="comp-spec-copy">コピー</button>
      </div>`);
    document.getElementById("comp-spec-close").addEventListener("click", () => UI.hideModal());
    document.getElementById("comp-spec-copy").addEventListener("click", async () => {
      const status = document.getElementById("comp-copy-status");
      try {
        await navigator.clipboard.writeText(text);
        status.textContent = "コピーしました。";
      } catch (_) {
        // クリップボードが使えないときは、全選択して手動でコピーできるようにする
        const ta = document.getElementById("comp-spec-text");
        ta.focus();
        ta.select();
        status.textContent = "自動でコピーできませんでした。選択した内容を、手動でコピーしてください。";
      }
    });
  },

  _confirmSave(state) {
    const d = this._d();
    const a = this._assess(state);
    if (!a || a.blocking.length) return;
    const writes = a.rows.filter((r) => r.kind === "add" || (r.kind === "conflict" && d.overwrite[r.key]));
    const kept = a.rows.filter((r) => r.kind === "conflict" && !d.overwrite[r.key]);
    const overwrites = a.rows.filter((r) => r.kind === "conflict" && d.overwrite[r.key]);
    const weightLine = d.weight === "set" && a.weight.kind !== "none" && a.weight.kind !== "same" ? `<br />体重：${a.weight.existing === null ? "新しく登録" : `${a.weight.existing}kg → ${a.weight.measured}kg に更新`}（${escapeHtml(String(a.weight.measured))}kg）` : "";
    this._confirm({
      title: `${d.date} の体組成を保存します`,
      body: `追加 ${writes.length - overwrites.length} 項目${overwrites.length ? `／上書き ${overwrites.length} 項目` : ""}${kept.length ? `／既存のまま残す ${kept.length} 項目` : ""}${weightLine}<br /><small>保存した体組成は、体組成タブの履歴から削除できます。</small>`,
      okLabel: "保存する",
      onOk: () => this._save(state),
    });
  },

  // 保存: 検証 → 変更 →（体重が変わったときだけ afterWeightSave）→ 保存1回。保存に失敗したら記録と goals を元に戻す
  _save(state) {
    if (!this._writable()) return;
    const d = this._d();
    const B = BodyCompositionLogic;
    const now = this._now();
    const a = this._assess(state);
    UI.hideModal();
    if (!a) return;
    const decisions = { date: d.date, time: d.time || null, overwrite: { ...d.overwrite }, weight: d.weight, acknowledged: d.ack, basis: d.basis };
    const goalsBefore = JSON.parse(JSON.stringify(state.goals));
    const r = B.applyImport(state, d.parsed, decisions, now);
    if (!r.ok) {
      if (r.code === "STALE_PREVIEW") {
        // その日の記録が確認のあとで変わった。最新の内容で並べ直す（何も保存していない）
        this._resetChoices(state);
        this.render(state);
      }
      this._info("保存できませんでした", escapeHtml(r.message));
      return;
    }
    let modals = [];
    if (r.weightChanged) modals = Logic.afterWeightSave(state, r.record);
    const saved = Storage.save(state);
    if (!saved) {
      B.revertImport(state, { date: d.date, prevRecord: r.prevRecord, goals: goalsBefore });
      this._info("保存できませんでした", "保存に失敗したため、何も変更していません。画面上部の案内を確認し、バックアップの書き出しもお試しください。");
      this.render(state);
      return;
    }
    const parts = [`追加${r.written.length}項目`];
    if (r.overwritten.length) parts.push(`上書き${r.overwritten.length}項目`);
    if (r.kept.length) parts.push(`既存を残した${r.kept.length}項目`);
    if (r.weightChanged) parts.push("体重を更新");
    this._status = `${d.date} の体組成を保存しました（${parts.join("・")}）`;
    this._draft = this._fresh();
    this.render(state);
    if (modals.length > 0) UI.enqueueGuardrailModals(modals, r.record);
  },

  _showDetail(state, date) {
    const rec = state.dailyRecords.find((r) => r.date === date);
    if (!rec) return;
    const meta = rec.compositionMeta;
    const rows = COMPOSITION_FIELDS.map((f) => `<tr><th scope="row">${escapeHtml(f.label)}</th><td class="comp-num">${this._fmt(f, (rec.bodyComposition || {})[f.key] === undefined ? null : rec.bodyComposition[f.key])}</td></tr>`).join("");
    UI.showModal(`
      <p class="modal-title">${escapeHtml(date)} の体組成</p>
      <table class="comp-table comp-detail"><tbody>${rows}</tbody></table>
      <p class="comp-sub">${rec.weight != null ? `この日の体重（記録タブ）：${escapeHtml(String(rec.weight))}kg` : "この日の体重の記録はありません"}</p>
      ${meta ? `<p class="comp-sub">取り込み：${escapeHtml(meta.importedAt)}${meta.updatedAt !== meta.importedAt ? `／更新：${escapeHtml(meta.updatedAt)}` : ""}${meta.measuredTime ? `／測定 ${escapeHtml(meta.measuredTime)}` : ""}${meta.mixed ? "<br />2回以上の測定の値が混ざっています。" : ""}</p>` : ""}
      <div class="modal-actions">
        <button class="btn-secondary" id="comp-detail-close">閉じる</button>
        <button class="btn-text" id="comp-detail-delete">この日の体組成を削除</button>
      </div>`);
    document.getElementById("comp-detail-close").addEventListener("click", () => UI.hideModal());
    document.getElementById("comp-detail-delete").addEventListener("click", () => {
      this._confirm({
        title: "この日の体組成を削除します",
        body: `${escapeHtml(date)} の体組成（16項目）を削除します。<br /><strong>体重の記録・メモ・注射・Protein・体調は消えません。</strong>削除しても、書き出したバックアップからは復元できます。`,
        okLabel: "削除する",
        onOk: () => this._delete(state, date),
      });
    });
  },

  _delete(state, date) {
    if (!this._writable()) return;
    const prev = state.dailyRecords.find((r) => r.date === date);
    const prevRecord = prev ? JSON.parse(JSON.stringify(prev)) : null;
    const r = BodyCompositionLogic.applyDeleteComposition(state, date);
    UI.hideModal();
    if (!r.ok) return this._info("削除できませんでした", escapeHtml(r.message));
    if (!Storage.save(state)) {
      BodyCompositionLogic.revertImport(state, { date, prevRecord, goals: null });
      this._info("保存できませんでした", "保存に失敗したため、何も変更していません。");
      this.render(state);
      return;
    }
    this._status = `${date} の体組成を削除しました`;
    this.render(state);
  },
};
