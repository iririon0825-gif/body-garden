// Body Garden — 設定画面の「データのバックアップ」カード（書き出し・復元・復元前に戻す）
// 検証・保存は backup.js。ここは画面と操作の流れだけを担当する。
// 取り込んだデータが画面に出る前に backup.js で形式を検証済みだが、表示する文字列は必ず escapeHtml を通す。

const BackupUI = {
  COUNT_LABELS: {
    dailyRecords: "体重の記録",
    proteinEntries: "Proteinの記録",
    conditionEntries: "体調の記録",
    injections: "注射",
    proteinProducts: "ホエイ商品",
    registeredFoods: "登録食品",
  },

  render(state) {
    const el = document.getElementById("backup-root");
    if (!el) return;
    const last = Backup.getLastBackupAt();
    const pre = Backup.preRestoreInfo();

    el.innerHTML = `
      <section class="card backup-card">
        <p class="card-title">${UI.lineIcon("settings")}データのバックアップ</p>
        <p class="backup-note">
          記録はこの端末のブラウザ内だけに保存されています。機種変更やブラウザのデータ削除に備えて、
          ときどきファイルへ書き出してください。<strong>外部ファイルへの書き出しが基本の保護です。</strong>
        </p>
        <div class="backup-actions">
          <button class="btn-primary" id="backup-export-btn">バックアップを書き出す</button>
          <button class="btn-secondary" id="backup-import-btn">バックアップから復元</button>
        </div>
        <input type="file" id="backup-file-input" accept=".json,application/json,text/plain" hidden />
        <p class="backup-meta" id="backup-status" role="status">${
          last ? `最後に書き出し操作をした日時：${escapeHtml(this._fmtTs(last))}` : "まだ書き出していません。"
        }</p>
        <div class="backup-subactions">
          <button class="btn-text" id="backup-copy-btn">テキストでコピー</button>
          <button class="btn-text" id="backup-paste-btn">テキストを貼り付けて復元</button>
        </div>
        ${
          pre
            ? `<div class="backup-pre">
                 <p class="backup-meta">直前の復元の前のデータを、補助としてこのブラウザ内に1件だけ残しています${
                   pre.savedAt ? `（${escapeHtml(this._fmtTs(pre.savedAt))}）` : ""
                 }。ブラウザのデータを消すと、これも消えます。</p>
                 <button class="btn-text" id="backup-rollback-btn">復元前のデータに戻す</button>
               </div>`
            : ""
        }
      </section>
    `;

    document.getElementById("backup-export-btn").addEventListener("click", () => this._export());
    document.getElementById("backup-copy-btn").addEventListener("click", () => this._copyText());
    document.getElementById("backup-import-btn").addEventListener("click", () => {
      document.getElementById("backup-file-input").click();
    });
    document.getElementById("backup-file-input").addEventListener("change", (e) => this._onFileChosen(e.target));
    document.getElementById("backup-paste-btn").addEventListener("click", () => this._showPasteModal());
    const rb = document.getElementById("backup-rollback-btn");
    if (rb) rb.addEventListener("click", () => this._confirmRollback());
  },

  // 保存データが新しい版のとき、通常画面の代わりに出す案内。保存データには一切触れない。
  // 「保存データをそのまま書き出す」で、生のJSONを退避できる（他の端末・新しい版のアプリで使うため）。
  showNewerSchemaScreen() {
    document.querySelectorAll("main, nav.bottom-nav").forEach((el) => (el.hidden = true));
    const box = document.createElement("div");
    box.className = "newer-schema-screen";
    box.innerHTML = `
      <section class="card">
        <p class="card-title">${UI.lineIcon("settings")}アプリの更新が必要です</p>
        <p class="backup-note">
          この端末の記録は、より新しいバージョンのBody Gardenで作成されています。
          データを守るため、このバージョンでは画面を開かず、何も書き込みません。
          アプリを最新版に更新してから開いてください。
        </p>
        <div class="backup-actions">
          <button class="btn-secondary" id="newer-raw-export-btn">保存データをそのまま書き出す</button>
        </div>
        <p class="backup-meta" id="newer-raw-status" role="status"></p>
      </section>`;
    document.body.insertBefore(box, document.getElementById("modal-root"));
    document.getElementById("newer-raw-export-btn").addEventListener("click", () => {
      const status = document.getElementById("newer-raw-status");
      try {
        // 中身は検証せず、新しい版のアプリが読み込める包み（envelope）に入れて書き出す
        const raw = Backup.wrapRaw(localStorage.getItem(STORAGE_KEY) || "");
        const p = (n) => String(n).padStart(2, "0");
        const d = new Date();
        const name = `body-garden-raw-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
        const url = URL.createObjectURL(new Blob([raw], { type: "application/json" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        status.textContent = `書き出しました（${name}）。`;
      } catch (_) {
        status.textContent = "書き出せませんでした。";
      }
    });
  },

  BANNER_MESSAGES: {
    newerSchema: "このデータは、より新しいバージョンのアプリで作成されています。データを守るため、このアプリでは変更を保存しません。アプリを更新してください。",
    preMigrationBackupFailed: "データ形式の更新前の退避に失敗したため、変更を保存しません。バックアップを書き出してから、再読み込みしてください。",
    corruptBackupFailed: "保存データを読み込めず、その退避もできなかったため、変更を保存しません（元のデータは消していません）。ブラウザの保存領域に空きを作ってから、再読み込みしてください。",
    staleTab: "他のタブでデータが更新されました。上書きを防ぐため、このタブでは変更を保存しません。再読み込みしてください。",
    saveFailed: "保存できませんでした（保存領域の不足など）。直近の変更が残っていない可能性があります。バックアップを書き出してください。",
    updateReady: "新しいバージョンが用意できました。作業を終えたら再読み込みすると、更新されます。",
  },

  // 保存しない状態（読み取り専用）や、保存に失敗したこと、更新があることを知らせる帯。
  // onlyIfEmpty: すでに別の帯（より重要な案内）が出ているときは、上書きしない
  showBanner(kind, { onlyIfEmpty = false } = {}) {
    let banner = document.getElementById("readonly-banner");
    if (banner && onlyIfEmpty) return;
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "readonly-banner";
      banner.className = "readonly-banner";
      banner.setAttribute("role", "status");
      document.body.insertBefore(banner, document.body.firstChild);
    }
    banner.textContent = this.BANNER_MESSAGES[kind] || "データを守るため、変更を保存しません。";
    // 更新のお知らせは、データを守るための警告とは色を分ける
    banner.classList.toggle("is-info", kind === "updateReady");
  },

  showReadOnlyBannerIfNeeded() {
    if (Storage.readOnly) this.showBanner(Storage.readOnlyReason);
  },

  // 起動時に一度だけ呼ぶ: 保存の失敗・他タブの更新を検知して帯を出す
  watchStorage() {
    Storage.onProblem = (kind) => this.showBanner(kind);
    window.addEventListener("storage", (e) => {
      // 他のタブがこのデータを書き換えた（key=null は clear）。古い画面のまま保存して巻き戻さない
      if (e.storageArea === localStorage && (e.key === null || e.key === STORAGE_KEY) && !Storage.readOnly) {
        Storage.readOnly = true;
        Storage.readOnlyReason = "staleTab";
        this.showBanner("staleTab");
      }
    });
  },

  // ---------- 書き出し ----------

  // 書き出した内容が、復元のときの検証を通らない場合の警告（書き出せても、復元できないデータを見逃さない）
  _selfCheckNote(check) {
    if (!check || check.ok) return "";
    const detail = (check.details || []).slice(0, 2).join(" ／ ");
    return ` ⚠ 注意：このデータは復元時の検証を通りません（${check.message}${detail ? " " + detail : ""}）。復元できない可能性があるため、内容を確認してください。`;
  },

  async _export() {
    if (this._exporting) return; // 共有シート表示中の二重タップを防ぐ
    this._exporting = true;
    const btn = document.getElementById("backup-export-btn");
    if (btn) btn.disabled = true;
    const status = document.getElementById("backup-status");
    try {
      const r = await Backup.exportFile(UI.state);
      if (r.cancelled) {
        status.textContent = "書き出しをキャンセルしました。";
      } else {
        const how = r.method === "share" ? "共有シートからファイルに保存してください" : "ダウンロードしました";
        status.textContent = `書き出しました（${r.fileName}）。${how}。最後に書き出し操作をした日時：${this._fmtTs(Backup.getLastBackupAt())}${this._selfCheckNote(r.selfCheck)}`;
      }
    } catch (e) {
      console.error("[BodyGarden] 書き出し失敗", e);
      status.textContent = "書き出しに失敗しました。「テキストでコピー」もお試しください。";
    } finally {
      this._exporting = false;
      if (btn) btn.disabled = false;
    }
  },

  async _copyText() {
    const status = document.getElementById("backup-status");
    const text = Backup.serialize(UI.state);
    const note = this._selfCheckNote(Backup.selfCheck(text));
    try {
      await navigator.clipboard.writeText(text);
      Backup.setLastBackupAt(new Date().toISOString());
      status.textContent = `バックアップをクリップボードへコピーしました。メモ等に貼り付けて保管してください。${note}`;
    } catch (_) {
      // クリップボードが使えない環境では、全選択済みの欄に出す
      this._showTextModal(text);
    }
  },

  _showTextModal(text) {
    UI.showModal(`
      <p class="modal-title">バックアップ（テキスト）</p>
      <p class="modal-body">下の欄をすべて選択してコピーし、メモ等に貼り付けて保管してください。</p>
      <textarea class="backup-textarea" id="backup-text-out" readonly>${escapeHtml(text)}</textarea>
      <div class="modal-actions">
        <button class="btn-primary" id="backup-text-close">閉じる</button>
      </div>`);
    const ta = document.getElementById("backup-text-out");
    ta.focus();
    ta.select();
    Backup.setLastBackupAt(new Date().toISOString());
    document.getElementById("backup-text-close").addEventListener("click", () => {
      UI.hideModal();
      this.render(UI.state);
    });
  },

  // ---------- 読み込み ----------

  async _onFileChosen(input) {
    const file = input.files && input.files[0];
    input.value = ""; // 同じファイルをもう一度選べるようにする
    if (!file) return;
    if (file.size > Backup.MAX_BYTES) {
      return this._showError({ message: "ファイルが大きすぎます（上限5MB）。Body Gardenのバックアップではない可能性があります。", details: [] });
    }
    let text;
    try {
      text = await file.text();
    } catch (_) {
      return this._showError({ message: "ファイルを読み込めませんでした。", details: [] });
    }
    this._handleText(text);
  },

  _showPasteModal() {
    UI.showModal(`
      <p class="modal-title">テキストを貼り付けて復元</p>
      <p class="modal-body">書き出したバックアップの内容をすべて貼り付けてください。内容を確認してから、置き換えるかどうかをお聞きします。</p>
      <textarea class="backup-textarea" id="backup-text-in" placeholder="ここに貼り付け"></textarea>
      <div class="modal-actions">
        <button class="btn-secondary" id="backup-paste-cancel">キャンセル</button>
        <button class="btn-primary" id="backup-paste-check">内容を確認する</button>
      </div>`);
    document.getElementById("backup-paste-cancel").addEventListener("click", () => UI.hideModal());
    document.getElementById("backup-paste-check").addEventListener("click", () => {
      const text = document.getElementById("backup-text-in").value;
      this._handleText(text);
    });
  },

  _handleText(text) {
    let result;
    try {
      result = Backup.parse(text, UI.state); // ここまで localStorage は一切変更しない
    } catch (e) {
      console.error("[BodyGarden] バックアップの検証中にエラー", e);
      result = { ok: false, message: "読み込み中に予期しないエラーが起きました。", details: [] };
    }
    if (!result.ok) return this._showError(result);
    this._showConfirm(result);
  },

  // reassure=false は「何も変えていない」と言い切れない場合（ロールバック失敗など）
  _showError(result, reassure = true) {
    const details = (result.details || []).map((d) => `<li>${escapeHtml(d)}</li>`).join("");
    UI.showModal(`
      <p class="modal-title">${reassure ? "読み込めませんでした" : "処理できませんでした"}</p>
      <p class="modal-body">${escapeHtml(result.message)}</p>
      ${details ? `<ul class="backup-list">${details}</ul>` : ""}
      ${reassure ? `<p class="modal-body backup-reassure">現在のデータは変更していません。</p>` : ""}
      <div class="modal-actions">
        <button class="btn-primary" id="backup-error-close">閉じる</button>
      </div>`);
    document.getElementById("backup-error-close").addEventListener("click", () => UI.hideModal());
  },

  _showConfirm(result) {
    const s = result.summary;
    const rows = Backup.COUNT_KEYS.map(
      (k) =>
        `<tr><th scope="row">${this.COUNT_LABELS[k]}</th><td>${s.current ? s.current[k] : "—"} 件</td><td>${s.incoming[k]} 件</td></tr>`
    ).join("");
    const warnings = result.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("");
    const exported = result.envelope.exportedAt ? this._fmtTs(result.envelope.exportedAt) : "不明";
    UI.showModal(`
      <p class="modal-title">現在のデータを置き換えます</p>
      <p class="modal-body">
        書き出し日時：${escapeHtml(exported)}<br />
        データ形式：v${s.fileVersion}${s.migrated ? `（現在の v${s.currentVersion} へ変換して取り込みます）` : ""}<br />
        ${s.range ? `体重の記録期間：${escapeHtml(s.range.from)} 〜 ${escapeHtml(s.range.to)}` : "体重の記録：なし"}
      </p>
      <table class="backup-compare">
        <thead><tr><th></th><th>現在</th><th>バックアップ</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${warnings ? `<p class="modal-body">確認事項：</p><ul class="backup-list">${warnings}</ul>` : ""}
      <p class="modal-body">現在のデータは消え、このファイルの内容に置き換わります。<strong>元に戻すには、先に現在のデータを書き出しておくのが確実です。</strong>${
        Backup.hasPreRestore() ? "<br />このブラウザ内に残している、直前の復元前のデータは、今回の復元前のデータに置き換わります。" : ""
      }</p>
      <div class="modal-actions backup-confirm-actions">
        <button class="btn-text" id="backup-confirm-export">先に現在のデータを書き出す</button>
        <button class="btn-secondary" id="backup-confirm-cancel">キャンセル</button>
        <button class="btn-primary" id="backup-confirm-ok">置き換えて復元</button>
      </div>`);
    document.getElementById("backup-confirm-cancel").addEventListener("click", () => UI.hideModal());
    document.getElementById("backup-confirm-export").addEventListener("click", async () => {
      const btn = document.getElementById("backup-confirm-export");
      btn.disabled = true;
      try {
        const r = await Backup.exportFile(UI.state);
        btn.textContent = r.ok ? "書き出しました" : "キャンセルしました";
      } catch (_) {
        btn.textContent = "書き出しに失敗しました";
      }
      btn.disabled = false;
    });
    document.getElementById("backup-confirm-ok").addEventListener("click", () => {
      const ok = document.getElementById("backup-confirm-ok");
      ok.disabled = true;
      this._applyRestore(result.state);
    });
  },

  _applyRestore(newState) {
    const r = Backup.applyRestore(newState);
    if (r.ok) return this._showReloadModal("復元しました", "バックアップの内容に置き換えました。画面を再読み込みします。");
    UI.showModal(`
      <p class="modal-title">復元できませんでした</p>
      <p class="modal-body">${escapeHtml(r.message)}</p>
      <div class="modal-actions"><button class="btn-primary" id="backup-restore-fail-close">閉じる</button></div>`);
    document.getElementById("backup-restore-fail-close").addEventListener("click", () => {
      UI.hideModal();
      this.render(UI.state);
    });
  },

  _showReloadModal(title, body) {
    UI.showModal(`
      <p class="modal-title">${escapeHtml(title)}</p>
      <p class="modal-body">${escapeHtml(body)}</p>
      <div class="modal-actions"><button class="btn-primary" id="backup-reload-btn">再読み込み</button></div>`);
    document.getElementById("backup-reload-btn").addEventListener("click", () => location.reload());
  },

  // ---------- 復元前に戻す ----------

  _confirmRollback() {
    UI.showModal(`
      <p class="modal-title">復元前のデータに戻します</p>
      <p class="modal-body">いまのデータと、直前の復元の前のデータを入れ替えます。もう一度押せば、元の状態に戻せます。</p>
      <div class="modal-actions">
        <button class="btn-secondary" id="backup-rollback-cancel">キャンセル</button>
        <button class="btn-primary" id="backup-rollback-ok">戻す</button>
      </div>`);
    document.getElementById("backup-rollback-cancel").addEventListener("click", () => UI.hideModal());
    document.getElementById("backup-rollback-ok").addEventListener("click", () => {
      const r = Backup.rollbackToPreRestore();
      if (r.ok) return this._showReloadModal("戻しました", "復元前のデータに戻しました。画面を再読み込みします。");
      this._showError({ message: r.message, details: [] }, false); // 状態は各メッセージが説明する
    });
  },

  _fmtTs(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  },
};
