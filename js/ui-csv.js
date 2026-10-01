// Body Garden — 設定画面の「分析用CSVを書き出す」カード
// 中身の作成は csv-logic.js。ここは画面と、ファイルの受け渡し（共有／ダウンロード）だけを担当する。
// 状態は一切変更しない（読み取り専用の書き出し）。JSONバックアップ（BackupUI）とは別のカード。
//
// 複数ファイルの受け渡し方針:
//  - iOS/iPadOS（Web Share API Level 2）で複数ファイルの共有に対応していれば、1回の共有操作で全ファイルを渡す。
//  - 対応していない・共有が失敗した場合は、1ファイルずつ渡す一覧に切り替える（1回のタップ＝1回の共有/ダウンロード操作を保つ）。
//  - navigator.share() はユーザー操作の直後にしか呼べないため、クリックハンドラの中で同期的に呼ぶ（間にawaitを挟まない）。

const CsvUI = {
  _busy: false,
  _fallback: null, // 一括共有が使えなかったときの、残り（個別に渡す）ファイル一覧

  _isIOS() {
    const ua = navigator.userAgent || "";
    return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  },

  render(state) {
    const el = document.getElementById("csv-root");
    if (!el) return;
    this._state = state;
    el.innerHTML = `
      <section class="card csv-card">
        <p class="card-title">${UI.lineIcon("records")}分析用CSVを書き出す</p>
        <p class="csv-note">
          Excel・スプレッドシートで集計・グラフ化するための書き出しです。<strong>この内容からアプリへ復元する機能はありません。</strong>
          データの復元には、上の「データのバックアップ」をお使いください。
        </p>
        <div class="csv-actions">
          <button class="btn-primary" id="csv-all-btn">すべて書き出す（7ファイル）</button>
        </div>
        <ul class="csv-list">
          ${Object.entries(CsvLogic.SHEET_LABELS)
            .filter(([k]) => k !== "export_info")
            .map(([k, label]) => `<li><button class="btn-text" data-csv-sheet="${escapeHtml(k)}">${escapeHtml(label)}（${escapeHtml(k)}.csv）</button></li>`)
            .join("")}
        </ul>
        <p class="csv-status" id="csv-status" role="status"></p>
        <div class="csv-fallback" id="csv-fallback" hidden></div>
      </section>`;
    document.getElementById("csv-all-btn").addEventListener("click", () => this._exportAll());
    document.querySelectorAll("[data-csv-sheet]").forEach((b) => b.addEventListener("click", () => this._exportOne(b.dataset.csvSheet)));
  },

  _status(msg) {
    const el = document.getElementById("csv-status");
    if (el) el.textContent = msg;
  },
  _clearFallback() {
    this._fallback = null;
    const el = document.getElementById("csv-fallback");
    if (el) {
      el.hidden = true;
      el.innerHTML = "";
    }
  },

  // 1件だけ、共有できる形（File）とダウンロード用のBlob URLの両方を作れるようにしておく
  _toFile(def) {
    return new File([def.text], def.fileName, { type: "text/csv" });
  },
  _download(def) {
    const blob = new Blob([def.text], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = def.fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  },

  // 単一シートの書き出し（個別ボタン）。iOSは共有、それ以外はダウンロード
  _exportOne(sheet) {
    if (this._busy) return;
    const def = CsvLogic.toFile(this._buildOne(sheet), new Date());
    this._clearFallback();
    if (this._isIOS() && navigator.canShare && navigator.share) {
      const file = this._toFile(def);
      if (navigator.canShare({ files: [file] })) {
        navigator
          .share({ files: [file] })
          .then(() => this._status(`${def.fileName} を渡しました。`))
          .catch((e) => {
            if (e && e.name === "AbortError") return this._status("キャンセルしました。");
            this._download(def);
            this._status(`共有できなかったため、${def.fileName} をダウンロードしました。`);
          });
        return;
      }
    }
    this._download(def);
    this._status(`${def.fileName} を書き出しました。`);
  },

  _buildOne(sheet) {
    const fn = { weight: "buildWeight", body_composition: "buildBodyComposition", protein: "buildProtein", injections: "buildInjections", injection_schedule: "buildInjectionSchedule", conditions: "buildConditions" }[sheet];
    return { sheet, ...CsvLogic[fn](this._state) };
  },

  // 「すべて書き出す」。クリックハンドラの中で、組み立て→canShare→share を同期的に行う（間にawaitを挟まない）
  _exportAll() {
    if (this._busy) return;
    this._clearFallback();
    const now = new Date();
    const defs = CsvLogic.buildAll(this._state, now).map((d) => CsvLogic.toFile(d, now));

    if (this._isIOS() && navigator.canShare && navigator.share) {
      const files = defs.map((d) => this._toFile(d));
      if (navigator.canShare({ files })) {
        this._busy = true;
        this._status("共有シートを開いています…");
        navigator
          .share({ files })
          .then(() => this._status("7ファイルを渡しました。"))
          .catch((e) => {
            if (e && e.name === "AbortError") return this._status("キャンセルしました。");
            // 複数ファイルの共有に失敗した環境: 1件ずつ渡す一覧に切り替える（新しく作り直さず、同じFileを使う）
            this._status("まとめての共有ができなかったため、1件ずつ書き出せるようにしました。");
            this._showFallback(defs);
          })
          .finally(() => {
            this._busy = false;
          });
        return;
      }
      // canShare が複数ファイルに対応していない: 最初から1件ずつの一覧にする
      this._status("この端末ではまとめて共有できないため、1件ずつ書き出せるようにしました。");
      this._showFallback(defs);
      return;
    }

    // iOS以外: 続けてダウンロード。ブラウザ側で一部だけ止められることがあるため、個別の一覧も残す
    defs.forEach((d, i) => setTimeout(() => this._download(d), i * 150));
    this._status("7ファイルのダウンロードを開始しました。途中で止まった場合は、下の一覧から個別に書き出してください。");
    this._showFallback(defs, { downloadedAlready: true });
  },

  // 1ファイルずつ、本人のタップごとに渡す一覧
  _showFallback(defs, { downloadedAlready = false } = {}) {
    this._fallback = defs;
    const el = document.getElementById("csv-fallback");
    if (!el) return;
    el.hidden = false;
    el.innerHTML = `
      <p class="csv-sub">${downloadedAlready ? "念のための個別書き出し：" : "1件ずつ書き出す："}</p>
      <ul class="csv-list">
        ${defs.map((d, i) => `<li><button class="btn-text" data-csv-fb="${i}">${escapeHtml(d.fileName)}</button></li>`).join("")}
      </ul>`;
    el.querySelectorAll("[data-csv-fb]").forEach((b) =>
      b.addEventListener("click", () => {
        const d = this._fallback[Number(b.dataset.csvFb)];
        if (this._isIOS() && navigator.canShare && navigator.share) {
          const file = this._toFile(d);
          if (navigator.canShare({ files: [file] })) {
            navigator
              .share({ files: [file] })
              .then(() => this._status(`${d.fileName} を渡しました。`))
              .catch((e) => {
                if (e && e.name === "AbortError") return this._status("キャンセルしました。");
                this._download(d);
                this._status(`共有できなかったため、${d.fileName} をダウンロードしました。`);
              });
            return;
          }
        }
        this._download(d);
        this._status(`${d.fileName} を書き出しました。`);
      })
    );
  },
};
