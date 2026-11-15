// Body Garden — 設定 → バックアップ欄の「Google Sheets 自動バックアップ」
// 通常は「使う／使わない」「最終送信日時」「今すぐ送信」だけが目に入る。接続設定は折りたたんでおく。
// 「確認」は、Google側が受け付けたと応答で確認できたときだけ。送ってみた（試行）だけでは、保存できたとは扱わない。

const SheetsSyncUI = {
  _fmt(iso) {
    if (!iso) return "";
    if (typeof BackupUI !== "undefined" && typeof BackupUI._fmtTs === "function") return BackupUI._fmtTs(iso);
    return String(iso);
  },

  // 「確認」は、サーバーが受け付けたと応答で確認できたときだけ。送ってみた時刻（試行）とは分けて表示する。
  statusText(st) {
    const parts = [`接続設定：${st.configured ? "設定済み" : "未設定"}`];
    parts.push(st.lastConfirmedAt ? `最終確認日時：${this._fmt(st.lastConfirmedAt)}` : "Google側が受け付けたことは、まだ確認できていません");
    if (st.lastAttemptAt) parts.push(`最終送信試行日時：${this._fmt(st.lastAttemptAt)}`);
    if (st.enabled && st.pending) parts.push("未確認の変更があります");
    if (st.sendMode === "blind") parts.push("この環境ではGoogleからの応答を読めないため、保存の確認はできません");
    if (st.retryStopped) parts.push("自動の再送は止めています（内容が変わるか、「今すぐ送信」で再開します）");
    if (st.lastError) parts.push(`直近の送信は確認できませんでした：${st.lastError}（記録の保存には影響していません）`);
    return parts.join(" ／ ");
  },

  html() {
    const st = SheetsSync.status();
    return `
        <div class="backup-pre sheets-sync" id="sheets-sync-box">
          <p class="backup-note">
            <strong>Google Sheets 自動バックアップ</strong><br />
            記録を保存したあと、自動でGoogle Sheetsにも控えを送ります。「最終確認日時」は、Google側が受け付けたと
            応答で確認できたときだけ表示します。確認できない環境では「最終送信試行日時」だけを表示し、保存できたとは扱いません。
            手動のJSON書き出しも、あわせて続けてください。
          </p>
          <label class="form-field-inline">
            <input type="checkbox" id="sheets-enabled" ${st.enabled ? "checked" : ""} ${st.configured ? "" : "disabled"} />
            自動バックアップを使う
          </label>
          <p class="backup-meta" id="sheets-status" role="status">${escapeHtml(this.statusText(st))}</p>
          <div class="backup-actions">
            <button class="btn-secondary" id="sheets-send-now" ${st.configured ? "" : "disabled"}>今すぐ送信</button>
          </div>
          <details class="sheets-conn">
            <summary class="backup-meta">接続設定</summary>
            <div class="form-field">
              <label for="sheets-endpoint">エンドポイントURL</label>
              <input id="sheets-endpoint" type="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://script.google.com/macros/s/…/exec" />
            </div>
            <div class="form-field">
              <label for="sheets-key">接続キー</label>
              <input id="sheets-key" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" />
            </div>
            <p class="form-error" id="sheets-conn-error" role="alert" hidden></p>
            <p class="backup-meta">エンドポイントと接続キーは、この端末の中にだけ保存します（書き出すJSONには含まれません）。入力した値は、保存後は画面に表示しません。</p>
            <div class="backup-subactions">
              <button class="btn-text" id="sheets-conn-save">接続設定を保存</button>
              <button class="btn-text" id="sheets-conn-clear">接続設定を消す</button>
            </div>
          </details>
        </div>`;
  },

  _setStatus(text) {
    const el = document.getElementById("sheets-status");
    if (el) el.textContent = text;
  },

  _rerender() {
    if (typeof BackupUI !== "undefined" && typeof UI !== "undefined") BackupUI.render(UI.state);
  },

  bind() {
    const enabled = document.getElementById("sheets-enabled");
    if (enabled) {
      enabled.addEventListener("change", () => {
        SheetsSync.setEnabled(enabled.checked);
        this._setStatus(this.statusText(SheetsSync.status()));
      });
    }

    const sendBtn = document.getElementById("sheets-send-now");
    if (sendBtn) {
      sendBtn.addEventListener("click", async () => {
        sendBtn.disabled = true;
        this._setStatus("送信しています…");
        let r;
        try {
          r = await SheetsSync.sendNow();
        } catch (_) {
          r = { ok: false };
        }
        const st = SheetsSync.status();
        let head;
        if (r && r.confirmed) head = "Google側が受け付けたことを確認しました。";
        else if (r && r.unconfirmed) {
          head = `送信を試みました。Google側が保存したかは、確認できていません${r.serverError ? `（サーバーの応答: ${r.serverError}）` : ""}。`;
        } else if (r && (r.skipped === "retryWait" || r.skipped === "retryLimit")) head = "同じ内容の再送を控えています。";
        else if (r && r.skipped === "offline") head = "オフラインのため、まだ送信していません。通信できるようになったら、自動で送ります。";
        else if (r && r.skipped === "readOnly") head = "この画面では変更を保存しない状態のため、送信していません。";
        else if (r && r.skipped === "inFlight") head = "送信中です。しばらくしてから、状態をご確認ください。";
        else if (r && r.skipped === "inactive") head = "自動バックアップが有効になっていないため、送信していません。";
        else head = "送信が完了しませんでした。記録の保存には影響していません。あとで、もう一度お試しください。";
        this._setStatus(`${head} ${this.statusText(st)}`);
        sendBtn.disabled = !st.configured;
      });
    }

    const save = document.getElementById("sheets-conn-save");
    if (save) {
      save.addEventListener("click", () => {
        const err = document.getElementById("sheets-conn-error");
        const r = SheetsSync.setConnection(
          document.getElementById("sheets-endpoint").value,
          document.getElementById("sheets-key").value
        );
        if (!r.ok) {
          err.textContent = r.message;
          err.hidden = false;
          return;
        }
        this._rerender(); // 入力欄を空に戻し、状態表示を更新する
      });
    }

    const clear = document.getElementById("sheets-conn-clear");
    if (clear) {
      clear.addEventListener("click", () => {
        SheetsSync.clearConnection();
        this._rerender();
      });
    }
  },
};
