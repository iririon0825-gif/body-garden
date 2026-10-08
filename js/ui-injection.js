// Body Garden — 注射タブ・HOME注射カード・各モーダル
// ロジックは injection-logic.js（純粋関数）。ここは画面と操作の流れだけを担当する。
//
// 方針（ユーザー確定）
//  - 添付文書の記載は「〜と記載されています」と案内するだけで、「打ってください／打たないでください」とは書かない。処方元の指示を優先する。
//  - 記録のない回を、本人の確認なしに見送りとして保存しない。
//  - 実際に投与した事実の記録は、72時間未満でも拒否しない（注意表示と確認を挟む）。
//  - 打ち忘れ・曜日変更・一時的な日程変更・予定の取消・履歴の削除は、それぞれ別の操作・別の画面。
// 表示する文字列は、日付・時刻・数値以外（メモ）は escapeHtml を通す。

const InjectionUI = {
  _historyLimit: 20,

  _now() {
    return new Date();
  },

  // ============ 小さな部品 ============

  _dl(ymd, today) {
    if (!InjectionLogic.isYmd(ymd)) return "日付不明"; // 以前のデータに日付のない記録がありうる
    return escapeHtml(InjectionLogic.formatShortDate(ymd, today));
  },
  // 保存できない状態（読み取り専用）では、操作を始めない。メモリ上だけ変わって保存されない状態を作らない
  _writable() {
    if (!Storage.readOnly) return true;
    this._info(
      "いまは変更を保存できません",
      "画面上部の案内のとおり、データを守るため、この画面では変更を保存しない状態です。再読み込みしてから操作してください（変更は行っていません）。"
    );
    return false;
  },
  _tl(t) {
    return t ? escapeHtml(t) : "時刻未設定";
  },
  _fmtTs(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  },
  _kindLabel(r, today) {
    if (r.kind === "makeup") return `臨時投与（${r.regularDate ? this._dl(r.regularDate, today) + "分" : "打ち忘れの回"}）`;
    if (r.kind === "oneOffChange") return `この回だけ変更（定例 ${r.regularDate ? this._dl(r.regularDate, today) : "—"}）`;
    if (r.kind === "regular") return "定例";
    if (r.kind === "legacy") return "以前の記録";
    return "手動";
  },
  _skipLabel(r) {
    return { missedUnder72h: "打ち忘れ・72時間未満", missedUnknown: "打ち忘れ・時刻不明", userChoice: "本人の確認で見送り" }[r.skipReason] || "見送り";
  },
  _doseSelect(id, selected) {
    const opts = INJECTION_DOSE_OPTIONS_MG.map((mg) => `<option value="${mg}" ${mg === selected ? "selected" : ""}>${mg}mg</option>`).join("");
    return `<select id="${id}"><option value="" ${selected === null || selected === undefined ? "selected" : ""}>選択してください</option>${opts}</select>`;
  },
  _field(label, inner, hint) {
    return `<label class="form-field"><span>${label}</span>${inner}${hint ? `<small class="inj-hint">${hint}</small>` : ""}</label>`;
  },
  _val(id) {
    const el = document.getElementById(id);
    return el ? el.value : "";
  },
  _numOrNull(v) {
    return v === "" || v === null || v === undefined ? null : Number(v);
  },
  _trial(state, fn) {
    // 画面上の事前確認用: 複製した state に対して apply を試し、本物の state は変えない
    return fn(JSON.parse(JSON.stringify(state)));
  },
  _commit(state) {
    Storage.sortInjections(state);
    return Storage.save(state);
  },
  _modal(html) {
    UI.showModal(html);
  },
  _close() {
    UI.hideModal();
  },
  _reRender() {
    this.render(UI.state);
  },
  _info(title, bodyHtml) {
    this._modal(`
      <p class="modal-title">${title}</p>
      <div class="modal-body">${bodyHtml}</div>
      <div class="modal-actions"><button class="btn-primary" id="inj-info-close">閉じる</button></div>`);
    document.getElementById("inj-info-close").addEventListener("click", () => this._close());
  },
  _confirm({ title, body, okLabel, onOk }) {
    this._modal(`
      <p class="modal-title">${title}</p>
      <div class="modal-body">${body}</div>
      <div class="modal-actions">
        <button class="btn-secondary" id="inj-confirm-cancel">キャンセル</button>
        <button class="btn-primary" id="inj-confirm-ok">${okLabel}</button>
      </div>`);
    document.getElementById("inj-confirm-cancel").addEventListener("click", () => this._close());
    document.getElementById("inj-confirm-ok").addEventListener("click", () => onOk());
  },

  // ============ HOME 注射カード ============
  // 次回予定日・予定時刻・投与済み／未投与・打ち忘れ時の注意を簡潔に表示する。
  // 本文幅は375pxで約139px（右に花瓶）。1行ずつ短く、通知は最大2行。

  homeCardInnerHtml(state) {
    try {
      return this._homeCardHtml(state);
    } catch (e) {
      // 注射のデータに問題があっても、HOME全体（体重・Protein）の表示を止めない
      console.error("[BodyGarden] 注射カードを表示できません", e);
      return `<div class="inj-home" data-inj-go><p class="inj-home-date muted">表示できません</p><p class="inj-home-sub">注射タブで確認</p></div>`;
    }
  },

  _homeCardHtml(state) {
    const now = this._now();
    const h = InjectionLogic.homeSummary(state, now);
    const parts = [];
    if (h.mode === "unset") {
      parts.push(`<p class="inj-home-date muted">未設定</p><p class="inj-home-sub">注射タブで登録</p>`);
    } else {
      parts.push(`<p class="inj-home-date">${this._dl(h.date, h.today)}</p>`);
      parts.push(
        `<p class="inj-home-sub">${h.mode === "missed" ? "予定日" : this._tl(h.time)}${h.chip ? ` <span class="inj-chip${h.mode === "missed" ? " inj-chip-warn" : ""}">${h.chip}</span>` : ""}</p>`
      );
    }
    // 重要な注意（打ち忘れ・長期中断）は、前回の投与日より優先して表示する（前回の行は出さない）
    const warned = h.notices.includes("missed") || h.notices.includes("longGap");
    if (h.notices.includes("missed")) parts.push(`<p class="inj-home-warn">記録のない回あり。注射タブで確認</p>`);
    if (h.notices.includes("longGap")) parts.push(`<p class="inj-home-warn">しばらく間があいています。処方元に確認を</p>`);
    if (!warned) parts.push(`<p class="inj-home-meta">前回：${h.lastAdministeredAt ? this._dl(h.lastAdministeredAt, h.today) : "まだなし"}</p>`);
    if (h.administeredToday) parts.push(`<p class="inj-home-note">今日投与済み</p>`);
    // 残本数: 在庫の確認が済むまでは「要確認」（24本から自動で差し引かない）
    const st = h.stock;
    parts.push(`<p class="inj-home-meta">残り：${st.needsReview ? "要確認" : st.over ? "0本（超過）" : `${st.remaining}本`}</p>`);
    return `<div class="inj-home" role="button" tabindex="0" aria-label="注射タブを開く" data-inj-go>${parts.join("")}</div>`;
  },

  bindHomeCard() {
    const el = document.querySelector("[data-inj-go]");
    if (!el) return;
    const go = () => UI.switchScreen("injection");
    el.addEventListener("click", go);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        go();
      }
    });
  },

  // ============ 注射タブ ============

  render(state) {
    const el = document.getElementById("injection-root");
    if (!el) return;
    try {
      this._renderInner(state, el);
    } catch (e) {
      console.error("[BodyGarden] 注射タブを表示できません", e);
      el.innerHTML = `<section class="card inj-card"><p class="card-title">${UI.lineIcon("injection")}注射スケジュール</p><p class="inj-warn">注射のデータを表示できませんでした。設定画面からバックアップを書き出してから、データの内容を確認してください。</p></section>`;
    }
  },

  // 予定日が過ぎた未投与の予定（定例が未設定のときは全ての未投与の予定）を、取消・投与の記録ができる一覧にする。
  // 行き止まり（取消の手段がない予定が残る）を作らない。
  _pendingListHtml(recs, today, noSchedule) {
    if (!recs.length) return "";
    const rows = recs
      .map(
        (r) => `<li class="inj-row">
          <div class="inj-row-main"><span class="inj-row-date">${this._dl(r.scheduledAt, today)} ${this._tl(r.scheduledTime)}</span><span class="inj-row-label">未投与の予定</span></div>
          <div class="inj-row-sub">${this._kindLabel(r, today)}</div>
          <div class="inj-row-actions"><button class="btn-text" data-inj-admin-id="${r.id}">この予定の投与を記録</button><button class="btn-text" data-inj-cancel-id="${r.id}">予定を取り消す</button></div>
        </li>`
      )
      .join("");
    return `<p class="inj-sub">${noSchedule ? "登録されている未投与の予定" : "予定日が過ぎた、未投与のままの予定"}</p><ul class="inj-list">${rows}</ul>`;
  },

  _renderInner(state, el) {
    const now = this._now();
    const L = InjectionLogic;
    const h = L.homeSummary(state, now);
    const today = h.today;
    const sch = L.schedule(state);
    const regular = sch.regular;

    const notices = [];
    if (h.notices.includes("longGap")) {
      notices.push(`<div class="inj-notice inj-notice-warn"><strong>前回の投与記録から${h.daysSinceLast}日あいています。</strong><br />再開の時期や用量について、アプリでは判断しません。処方元（医師・薬剤師）に確認してください。<br /><small>※28日はアプリ上の注意表示の目安です。再開できるかどうかの基準ではありません。</small></div>`);
    }
    if (h.mode === "missed") {
      notices.push(`<div class="inj-notice inj-notice-warn"><strong>記録のない回があります（${this._dl(h.date, today)}）。</strong><br />投与したかどうかはアプリでは分かりません。「打ち忘れた」から、内容を確認して記録してください。</div>`);
    }

    // 次回の予定
    let nextCard = "";
    if (!regular) {
      nextCard = `
        <p class="inj-big muted">定例スケジュールが未設定です</p>
        <p class="inj-sub">初回の予定日を登録すると、その曜日が定例の投与曜日になります。</p>
        <div class="inj-actions"><button class="btn-primary" id="inj-first-btn">初回の予定を登録</button></div>`;
    } else if (h.mode === "scheduled" || h.mode === "today") {
      const rec = state.injections.find((r) => String(r.id) === String(h.recordId));
      nextCard = `
        <p class="inj-big">${this._dl(h.date, today)}　${this._tl(h.time)}</p>
        <p class="inj-sub"><span class="inj-chip">未投与</span> ${rec ? this._kindLabel(rec, today) : ""}${h.mode === "today" ? "　今日の予定です" : ""}</p>
        ${h.timeUnknown ? `<p class="inj-sub">予定時刻が未設定です。72時間の判定のため、時刻を設定すると確認しやすくなります。</p>` : ""}
        <div class="inj-actions">
          <button class="btn-primary" id="inj-admin-sched-btn" data-id="${rec ? rec.id : ""}">投与を記録</button>
          <button class="btn-secondary" id="inj-oneoff-btn" data-id="${rec ? rec.id : ""}">この回だけ日程を変更</button>
          <button class="btn-text" id="inj-cancel-btn" data-id="${rec ? rec.id : ""}">予定を取り消す</button>
        </div>`;
    } else if (h.mode === "proposal") {
      nextCard = `
        <p class="inj-big">次回の提案　${this._dl(h.date, today)}　${this._tl(h.time)}</p>
        <p class="inj-sub"><span class="inj-chip">提案・未確定</span> 定例の曜日から計算した日付です。確定するまで保存されません。</p>
        <div class="inj-actions">
          <button class="btn-primary" id="inj-confirm-proposal-btn">この日で確定</button>
          <button class="btn-secondary" id="inj-change-proposal-btn">日付を変えて登録</button>
        </div>`;
    } else if (h.mode === "missed") {
      nextCard = `
        <p class="inj-big muted">次回の予定は未設定です</p>
        <p class="inj-sub">記録のない回の確認が先です。</p>
        <div class="inj-actions"><button class="btn-primary" id="inj-missed-btn-main">打ち忘れた</button></div>`;
    } else {
      nextCard = `
        <p class="inj-big muted">次回の予定は未設定です</p>
        <p class="inj-sub">新しい予定は、ご自身で登録してください。${h.eval && h.eval.longGap ? "" : ""}</p>
        <div class="inj-actions"><button class="btn-primary" id="inj-register-btn">予定を登録</button></div>`;
    }

    // 初回投与日：既存の投与済み記録のうち最も古いものから導出する（保存しない・設定項目なし）。
    // Body Garden開始日（HOMEの「開始から○日目」）とは別の概念
    const firstDate = L.firstAdministeredDate(state);
    const sinceFirst = L.daysSinceFirst(state, today);
    const firstLine = firstDate
      ? `<p class="inj-sub" id="inj-first-dose">初回投与：${escapeHtml(L.formatFullDate(firstDate))}${sinceFirst !== null ? `　投与開始から${sinceFirst + 1}日目` : ""}</p>`
      : "";

    // 定例スケジュール
    const wd = regular ? L.WEEKDAYS[regular.weekday] : null;
    const scheduleCard = `
      <section class="card inj-card">
        <p class="card-title">${UI.lineIcon("injection")}定例の投与スケジュール</p>
        ${firstLine}
        ${
          regular
            ? `<p class="inj-big">毎週${wd}曜日　${this._tl(regular.time)}</p>
               <p class="inj-sub">${this._dl(regular.effectiveFrom, today)} から。基準用量：${sch.baseDoseMg ? sch.baseDoseMg + "mg" : "未設定（直近の投与の用量を使います）"}</p>
               <div class="inj-actions">
                 <button class="btn-secondary" id="inj-weekday-btn">投与曜日を変更</button>
                 <button class="btn-text" id="inj-time-btn">予定時刻を設定</button>
                 <button class="btn-text" id="inj-basedose-btn">基準用量を設定</button>
               </div>
               ${this._scheduleHistoryHtml(sch, today)}`
            : `<p class="inj-sub">未設定です。</p>`
        }
      </section>`;

    // 在庫（残本数）。残りは保存せず、投与記録から毎回計算する
    const stock = L.stockSummary(state);
    const reviewRows = stock.reviewRecords
      .map(
        (r) => `<li class="inj-row">
          <div class="inj-row-main"><span class="inj-row-date">${this._dl(r.administeredAt, today)} ${r.administeredTime ? escapeHtml(r.administeredTime) : "<span class='muted'>時刻不明</span>"}</span><span class="inj-row-label">投与 ${typeof r.dose === "number" ? r.dose + "mg" : "—"}</span></div>
          <div class="inj-row-actions"><button class="btn-text" data-stock-review="${r.id}|counts">使用した分として数える</button><button class="btn-text" data-stock-review="${r.id}|excluded">数えない</button></div>
        </li>`
      )
      .join("");
    // 投与記録ごとの数え方。いつでも切り替えられる（確認の取り消しにも使う）。記録そのものは変わらない
    const adminList = L.administered(state).slice().reverse();
    const toggleRows = adminList
      .map((r) => {
        const counted = r.stockCount !== "review" && r.stockCount !== "excluded";
        const label = r.stockCount === "review" ? "確認待ち" : counted ? "数えている" : "数えていない";
        const target = counted ? "excluded" : "counts";
        return `<li class="inj-row">
          <div class="inj-row-main"><span class="inj-row-date">${this._dl(r.administeredAt, today)} ${r.administeredTime ? escapeHtml(r.administeredTime) : "<span class='muted'>時刻不明</span>"}</span><span class="inj-row-label">${label}</span></div>
          <div class="inj-row-actions"><button class="btn-text" data-stock-set="${r.id}|${target}">${counted ? "使用本数に数えない" : "使用本数に数える"}</button></div>
        </li>`;
      })
      .join("");
    const stockCard = `
      <section class="card inj-card">
        <p class="card-title">${UI.lineIcon("injection")}注射の在庫</p>
        <p class="inj-big">${stock.needsReview ? "残り：要確認" : `残り ${Math.max(0, stock.remaining)}本`}</p>
        <p class="inj-sub">初期在庫 ${stock.initial}本　使用済み ${stock.used}本${stock.over ? "（初期在庫より多く記録されています）" : ""}</p>
        <p class="inj-sub">残りは、投与を記録した回数（1回につき1本）から自動で計算します。予定の登録・打ち忘れ・見送り・曜日変更では減りません。履歴の修正・削除をすると、自動で計算し直されます。入庫・購入の管理はありません。</p>
        ${
          stock.needsReview
            ? `<div class="inj-notice inj-notice-warn"><strong>在庫の確認が必要です。</strong><br />在庫の設定より前から、投与の記録があります。実際に使った分か、テスト用などの記録かは、アプリでは判別できません。確認が済むまで、次の記録は使用本数に数えず、残りは「要確認」にしています（初期在庫から自動で差し引いていません）。<br />「数える／数えない」は残り本数への算入だけを変える操作です。投与の履歴、前回の投与日、72時間の判定、次回の予定には影響しません。</div>
               <ul class="inj-list">${reviewRows}</ul>
               <div class="inj-actions"><button class="btn-secondary" id="inj-stock-all-counts">すべて使用した分として数える</button><button class="btn-secondary" id="inj-stock-all-excluded">すべて数えない</button></div>`
            : ""
        }
        ${
          adminList.length
            ? `<details class="inj-details"><summary>投与記録ごとの数え方（${adminList.length}件）を確認・変更</summary>
                 <p class="inj-sub"><strong>「数える／数えない」は、残り本数への算入だけを変えます。</strong>投与の履歴、前回の投与日、72時間の判定、次回の予定は変わりません。記録は消えません。</p>
                 <ul class="inj-list">${toggleRows}</ul></details>`
            : ""
        }
      </section>`;

    // 履歴
    const closed = L.closed(state).slice().reverse();
    const shown = closed.slice(0, this._historyLimit);
    const rows = shown
      .map((r) => {
        if (r.status === "administered") {
          return `<li class="inj-row" data-id="${r.id}">
            <div class="inj-row-main">
              <span class="inj-row-date">${this._dl(r.administeredAt, today)} ${r.administeredTime ? escapeHtml(r.administeredTime) : "<span class='muted'>時刻不明</span>"}</span>
              <span class="inj-row-label">投与 ${typeof r.dose === "number" ? r.dose + "mg" : "—"}</span>
            </div>
            <div class="inj-row-sub">${this._kindLabel(r, today)}${r.scheduledAt && r.scheduledAt !== r.administeredAt ? `　予定 ${this._dl(r.scheduledAt, today)}` : ""}${r.comment ? `　${escapeHtml(r.comment)}` : ""}</div>
            <div class="inj-row-actions"><button class="btn-text" data-inj-edit="${r.id}">修正</button><button class="btn-text" data-inj-delete="${r.id}">削除</button></div>
          </li>`;
        }
        return `<li class="inj-row inj-row-skipped" data-id="${r.id}">
            <div class="inj-row-main">
              <span class="inj-row-date">${this._dl(r.regularDate || r.scheduledAt, today)}</span>
              <span class="inj-row-label">見送り</span>
            </div>
            <div class="inj-row-sub">${this._skipLabel(r)}${r.comment ? `　${escapeHtml(r.comment)}` : ""}</div>
            <div class="inj-row-actions"><button class="btn-text" data-inj-delete="${r.id}">削除</button></div>
          </li>`;
      })
      .join("");
    const historyCard = `
      <section class="card inj-card">
        <p class="card-title">${UI.lineIcon("records")}投与・見送りの履歴</p>
        ${closed.length === 0 ? `<div class="placeholder-box">まだ記録がありません</div>` : `<ul class="inj-list">${rows}</ul>`}
        ${closed.length > shown.length ? `<button class="btn-text" id="inj-more-btn">もっと見る（残り${closed.length - shown.length}件）</button>` : ""}
      </section>`;

    el.innerHTML = `
      <section class="card inj-card">
        <p class="card-title">${UI.lineIcon("injection")}注射スケジュール</p>
        <p class="inj-note">この画面は記録と予定の管理のためのものです。用量・間隔・再開の判断は、処方元の指示に従ってください。</p>
      </section>
      ${notices.join("")}
      <section class="card inj-card">
        <p class="card-title">次回の予定</p>
        ${nextCard}
        ${this._pendingListHtml(regular ? L.overdueScheduled(state, today) : L.scheduledRecords(state), today, !regular)}
      </section>
      <section class="card inj-card">
        <p class="card-title">操作</p>
        <div class="inj-actions inj-actions-grid">
          <button class="btn-primary" id="inj-admin-btn">投与を記録</button>
          <button class="btn-secondary" id="inj-missed-btn">打ち忘れた</button>
          <button class="btn-secondary" id="inj-weekday-btn2" ${regular ? "" : "disabled"}>投与曜日を変更</button>
        </div>
        <p class="inj-sub">「打ち忘れた」と「投与曜日を変更」は、判定の基準が異なる別の操作です。</p>
      </section>
      ${scheduleCard}
      ${stockCard}
      ${historyCard}`;

    this._bind(state);
  },

  _scheduleHistoryHtml(sch, today) {
    if (!sch.history.length) return "";
    const label = { set: "設定", weekdayChange: "曜日変更", timeChange: "時刻変更", clear: "解除" };
    const items = sch.history
      .slice()
      .reverse()
      .map((h) => {
        const to = h.to ? `${InjectionLogic.WEEKDAYS[h.to.weekday]}曜 ${this._tl(h.to.time)}（${this._dl(h.to.effectiveFrom, today)}から）` : "";
        const from = h.from ? `${InjectionLogic.WEEKDAYS[h.from.weekday]}曜 ${this._tl(h.from.time)} → ` : "";
        return `<li>${escapeHtml(label[h.type] || h.type)}：${from}${to}</li>`;
      })
      .join("");
    return `<details class="inj-details"><summary>定例の変更履歴（${sch.history.length}件）</summary><ul class="backup-list">${items}</ul></details>`;
  },

  _bind(state) {
    const on = (id, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("click", fn);
    };
    on("inj-first-btn", () => this._openFirstSchedule());
    on("inj-register-btn", () => this._openScheduleNext({}));
    on("inj-admin-btn", () => this._openAdminister({}));
    on("inj-admin-sched-btn", (e) => this._openAdminister({ recordId: e.currentTarget.dataset.id }));
    on("inj-oneoff-btn", (e) => this._openOneOff(e.currentTarget.dataset.id));
    on("inj-cancel-btn", (e) => this._confirmCancel(e.currentTarget.dataset.id));
    on("inj-missed-btn", () => this._openMissed());
    on("inj-missed-btn-main", () => this._openMissed());
    on("inj-weekday-btn", () => this._openWeekdayChange());
    on("inj-weekday-btn2", () => this._openWeekdayChange());
    on("inj-basedose-btn", () => this._openBaseDose());
    on("inj-time-btn", () => this._openRegularTime(false));
    on("inj-more-btn", () => {
      this._historyLimit += 20;
      this._reRender();
    });
    on("inj-confirm-proposal-btn", () => {
      const p = InjectionLogic.suggestNext(state, this._now());
      if (p) this._openScheduleNext({ date: p.date, time: p.time || "", regularDate: p.regularDate, fromProposal: true });
    });
    on("inj-change-proposal-btn", () => {
      const p = InjectionLogic.suggestNext(state, this._now());
      if (p) this._openScheduleNext({ date: p.date, time: p.time || "", regularDate: p.regularDate });
    });
    // 在庫の確認（本人の選択で、使用本数に数える／数えない）
    document.querySelectorAll("[data-stock-review]").forEach((b) =>
      b.addEventListener("click", () => {
        if (!this._writable()) return;
        const [id, decision] = b.dataset.stockReview.split("|");
        const r = InjectionLogic.applyStockReview(state, id, decision);
        if (!r.ok) return this._info("確認できません", escapeHtml(r.message));
        this._finish();
      })
    );
    // 数え方の切り替え（いつでも元に戻せる）
    document.querySelectorAll("[data-stock-set]").forEach((b) =>
      b.addEventListener("click", () => {
        if (!this._writable()) return;
        const [id, decision] = b.dataset.stockSet.split("|");
        const r = InjectionLogic.applyStockSet(state, id, decision);
        if (!r.ok) return this._info("変更できません", escapeHtml(r.message));
        this._finish();
      })
    );
    ["counts", "excluded"].forEach((d) => {
      const el = document.getElementById(`inj-stock-all-${d}`);
      if (!el) return;
      el.addEventListener("click", () => {
        if (!this._writable()) return;
        this._confirm({
          title: d === "counts" ? "すべて使用した分として数えます" : "すべて数えません",
          body: d === "counts" ? "確認待ちの投与記録を、すべて使用本数に数えます。残りが減ります。投与の履歴や72時間の判定は変わりません。" : "確認待ちの投与記録を、すべて使用本数に数えません（テスト用などの記録として扱います）。変わるのは残り本数への算入だけで、投与の履歴・前回の投与日・72時間の判定・次回の予定は変わりません。記録は消えません。",
          okLabel: "この内容で確認する",
          onOk: () => {
            if (!this._writable()) return;
            InjectionLogic.applyStockReviewAll(state, d);
            this._finish();
          },
        });
      });
    });
    document.querySelectorAll("[data-inj-admin-id]").forEach((b) => b.addEventListener("click", () => this._openAdminister({ recordId: b.dataset.injAdminId })));
    document.querySelectorAll("[data-inj-cancel-id]").forEach((b) => b.addEventListener("click", () => this._confirmCancel(b.dataset.injCancelId)));
    document.querySelectorAll("[data-inj-edit]").forEach((b) => b.addEventListener("click", () => this._openAdminister({ editId: b.dataset.injEdit })));
    document.querySelectorAll("[data-inj-delete]").forEach((b) => b.addEventListener("click", () => this._confirmDeleteHistory(b.dataset.injDelete)));
  },

  // ============ 初回の予定（定例スケジュールの設定） ============

  _openFirstSchedule() {
    const state = UI.state;
    const L = InjectionLogic;
    const now = this._now();
    const today = L.ymd(now);
    this._modal(`
      <p class="modal-title">初回の予定を登録</p>
      <div class="modal-body">
        初回の予定日を、ご自身で登録します。予定日の曜日が、定例の投与曜日になります。
      </div>
      <div class="form-grid">
        ${this._field("予定日", `<input type="date" id="inj-f-date" min="${today}" max="${L.addDays(today, INJECTION_SCHEDULE_MAX_DAYS_AHEAD)}" />`)}
        ${this._field("予定時刻（任意）", `<input type="time" id="inj-f-time" />`, "未入力でもかまいません（72時間の判定は、時刻が分かるほど正確になります）")}
        ${this._field("基準用量（任意）", this._doseSelect("inj-f-dose", null), "投与の記録で用量を選ぶときの初期選択になります")}
      </div>
      <p class="form-error" id="inj-f-err" hidden></p>
      <div class="modal-actions">
        <button class="btn-secondary" id="inj-f-cancel">キャンセル</button>
        <button class="btn-primary" id="inj-f-ok">登録</button>
      </div>`);
    document.getElementById("inj-f-cancel").addEventListener("click", () => this._close());
    document.getElementById("inj-f-ok").addEventListener("click", () => {
      if (!this._writable()) return;
      const input = { date: this._val("inj-f-date"), time: this._val("inj-f-time") || null, baseDoseMg: this._numOrNull(this._val("inj-f-dose")) };
      const r = L.applyFirstSchedule(state, input, this._now());
      if (!r.ok) return this._showErr("inj-f-err", r.message);
      this._finish();
    });
  },

  _showErr(id, message) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
  },
  // 変更を保存し、画面を更新する。extraHtml は、一部の操作が失敗したときなどの、追加のお知らせ
  _finish(extraHtml) {
    const saved = this._commit(UI.state);
    this._close();
    this._reRender();
    if (!saved) this._info("保存できませんでした", "画面には反映されましたが、保存に失敗しました。画面上部の案内を確認し、バックアップの書き出しもお試しください。");
    else if (extraHtml) this._info("一部を記録できませんでした", extraHtml);
  },

  // ============ 次回予定の登録・確定 ============
  // opts: { date, time, regularDate, fromProposal }。提案の確定も、見送り後の手動登録も、本人の操作でここを通る
  // 「次の定例まで72時間未満」の確認は、警告とチェックボックスを表示し続け、チェックが入ったときだけ確定できる。

  _scheduleModalLogic({ notesId, okId, state, apply, today, confirmedRef, onChange }) {
    const L = InjectionLogic;
    const refresh = () => {
      const probe = this._trial(state, (copy) => apply(copy, false));
      let html = "";
      let canSave = false;
      if (!probe.ok && probe.code === "CONFIRM_REQUIRED") {
        const g = probe.nextGap;
        const final = this._trial(state, (copy) => apply(copy, confirmedRef.value));
        html = `<p class="inj-warn">${escapeHtml(probe.message)}（次の定例 ${this._dl(g.nextDate, today)} まで ${escapeHtml(L.formatGap({ minMs: g.minMs, maxMs: g.maxMs }))}）</p>
          <label class="form-field-inline"><input type="checkbox" id="${notesId}-confirm" ${confirmedRef.value ? "checked" : ""} /> <span>内容を確認しました</span></label>`;
        canSave = final.ok;
        // 確認のほかに、保存できない別の理由（前回の実投与から72時間未満など）があれば、その理由も表示する
        if (!final.ok && final.code !== "CONFIRM_REQUIRED") html += `<p class="form-error">${escapeHtml(final.message)}</p>`;
      } else if (!probe.ok) {
        html = `<p class="form-error">${escapeHtml(probe.message)}</p>`;
      } else {
        canSave = true;
        html = onChange ? onChange() : "";
      }
      document.getElementById(notesId).innerHTML = html;
      document.getElementById(okId).disabled = !canSave;
      const chk = document.getElementById(`${notesId}-confirm`);
      if (chk) {
        chk.addEventListener("change", () => {
          confirmedRef.value = chk.checked;
          refresh();
        });
      }
      return canSave;
    };
    return refresh;
  },

  _openScheduleNext(opts) {
    const state = UI.state;
    const L = InjectionLogic;
    const now = this._now();
    const today = L.ymd(now);
    const regularDate = opts.regularDate || L.nextRegularFromState(state, now);
    const date0 = opts.date || regularDate || "";
    const time0 = opts.time !== undefined ? opts.time : (L.schedule(state).regular || {}).time || "";
    const confirmed = { value: false };
    this._modal(`
      <p class="modal-title">${opts.fromProposal ? "次回の予定を確定" : "次回の予定を登録"}</p>
      <div class="modal-body">
        ${regularDate ? `定例の系列の次回は ${this._dl(regularDate, today)} です。この日以外を選ぶと、<strong>この回だけの日程変更</strong>として登録されます（定例曜日は変わりません）。` : ""}
      </div>
      <div class="form-grid">
        ${this._field("予定日", `<input type="date" id="inj-n-date" value="${escapeHtml(date0)}" min="${today}" max="${L.addDays(today, INJECTION_SCHEDULE_MAX_DAYS_AHEAD)}" />`)}
        ${this._field("予定時刻（任意）", `<input type="time" id="inj-n-time" value="${escapeHtml(time0 || "")}" />`)}
      </div>
      <div id="inj-n-notes" class="inj-notes"></div>
      <div class="modal-actions">
        <button class="btn-secondary" id="inj-n-cancel">キャンセル</button>
        <button class="btn-primary" id="inj-n-ok" disabled>確定して登録</button>
      </div>`);
    const build = () => ({ date: this._val("inj-n-date"), time: this._val("inj-n-time") || null, regularDate });
    const apply = (copy, confirm) => L.applyScheduleNext(copy, { ...build(), confirmNextGap: confirm }, this._now());
    const refresh = this._scheduleModalLogic({
      notesId: "inj-n-notes",
      okId: "inj-n-ok",
      state,
      apply,
      today,
      confirmedRef: confirmed,
      onChange: () => (build().date !== regularDate ? `<p class="inj-sub">この回だけの日程変更として登録されます。</p>` : ""),
    });
    ["inj-n-date", "inj-n-time"].forEach((id) => {
      const el = document.getElementById(id);
      const h = () => {
        confirmed.value = false;
        refresh();
      };
      el.addEventListener("input", h);
      el.addEventListener("change", h);
    });
    document.getElementById("inj-n-cancel").addEventListener("click", () => this._close());
    document.getElementById("inj-n-ok").addEventListener("click", () => {
      if (!this._writable()) return;
      const r = apply(state, confirmed.value);
      if (!r.ok) return refresh();
      this._finish();
    });
    refresh();
  },

  // ============ この回だけ日程を変更（定例曜日は変わらない） ============

  _openOneOff(id) {
    const state = UI.state;
    const L = InjectionLogic;
    const rec = state.injections.find((r) => String(r.id) === String(id));
    if (!rec || rec.status !== "scheduled") return this._info("変更できません", "変更できる予定がありません。");
    const now = this._now();
    const today = L.ymd(now);
    const confirmed = { value: false };
    this._modal(`
      <p class="modal-title">この回だけ日程を変更</p>
      <div class="modal-body">
        現在の予定：${this._dl(rec.scheduledAt, today)} ${this._tl(rec.scheduledTime)}${rec.regularDate ? `（定例 ${this._dl(rec.regularDate, today)}）` : ""}<br />
        この1回だけを変更します。<strong>定例の投与曜日は変わりません。</strong>曜日そのものを変える場合は「投与曜日を変更」を使ってください。
      </div>
      <div class="form-grid">
        ${this._field("新しい予定日", `<input type="date" id="inj-o-date" value="${escapeHtml(rec.scheduledAt || "")}" min="${today}" max="${L.addDays(today, INJECTION_SCHEDULE_MAX_DAYS_AHEAD)}" />`)}
        ${this._field("予定時刻（任意）", `<input type="time" id="inj-o-time" value="${escapeHtml(rec.scheduledTime || "")}" />`)}
      </div>
      <div id="inj-o-notes" class="inj-notes"></div>
      <div class="modal-actions">
        <button class="btn-secondary" id="inj-o-cancel">キャンセル</button>
        <button class="btn-primary" id="inj-o-ok" disabled>変更する</button>
      </div>`);
    const build = () => ({ date: this._val("inj-o-date"), time: this._val("inj-o-time") || null });
    const apply = (copy, confirm) => L.applyOneOffChange(copy, id, { ...build(), confirmNextGap: confirm }, this._now());
    const refresh = this._scheduleModalLogic({ notesId: "inj-o-notes", okId: "inj-o-ok", state, apply, today, confirmedRef: confirmed });
    ["inj-o-date", "inj-o-time"].forEach((i) => {
      const el = document.getElementById(i);
      const h = () => {
        confirmed.value = false;
        refresh();
      };
      el.addEventListener("input", h);
      el.addEventListener("change", h);
    });
    document.getElementById("inj-o-cancel").addEventListener("click", () => this._close());
    document.getElementById("inj-o-ok").addEventListener("click", () => {
      if (!this._writable()) return;
      const r = apply(state, confirmed.value);
      if (!r.ok) return refresh();
      this._finish();
    });
    refresh();
  },

  // ============ 実際の投与の記録（新規・予定から・修正） ============
  // opts: { recordId, regularDate, olderSkips, editId, date, time }
  // 実投与は事実の記録。72時間未満・時刻不明・用量の確認は、注意表示と確認を挟んで記録できる。
  // 予定がある場合は、その予定の投与として結び付ける（結び付けないと、予定が未投与のまま残り、翌日に存在しない打ち忘れが出る）。

  _openAdminister(opts) {
    const state = UI.state;
    const L = InjectionLogic;
    const now = this._now();
    const today = L.ymd(now);
    const editing = opts.editId != null ? state.injections.find((r) => String(r.id) === String(opts.editId)) : null;
    if (opts.editId != null && (!editing || editing.status !== "administered")) return this._info("修正できません", "修正できる投与記録がありません。");
    const init = {
      date: editing ? editing.administeredAt || today : opts.date || today,
      time: editing ? editing.administeredTime || "" : opts.time || "",
      dose: editing ? editing.dose : L.defaultDose(state, now),
      comment: editing ? editing.comment || "" : "",
    };
    // 結び付ける予定の初期選択。指定された予定があればそれ、なければ「その実施日に結び付けてよい予定」だけを選ぶ
    // （離れた日付の過去分を入力するとき、今後の予定を「投与済み」にしてしまわないよう、範囲内の予定がなければ「結び付けない」）
    const scheduledList = editing ? [] : L.scheduledRecords(state);
    const linkOf = (date) => {
      if (editing || !scheduledList.length) return "";
      if (opts.recordId != null && opts.recordId !== "") return String(opts.recordId);
      const cands = L.linkCandidates(state, date);
      if (opts.regularDate) {
        const m = cands.find((r) => r.regularDate === opts.regularDate);
        return m ? String(m.id) : "";
      }
      return cands.length ? String(cands[0].id) : "";
    };
    let linkId = linkOf(init.date);
    let linkTouched = false;
    const longGap = L.isLongGap(state, today);
    const confirm = { dose: false, interval: false };
    const context = [];
    if (editing) context.push("実施日・時刻・用量・メモを修正します。予定日や定例日は変わりません。");
    else if (opts.regularDate) context.push(`打ち忘れの回（${this._dl(opts.regularDate, today)}）の臨時投与として記録します。定例の投与曜日は変わりません。`);
    if (longGap && !editing) context.push("前回の投与記録から28日以上あいているため、用量は自動では選びません。処方元の指示を確認してください。");
    const olderDates = (opts.olderSkips || []).map((o) => this._dl(o.regularDate, today));
    if (olderDates.length) context.push(`あわせて、選んだ古い回（${olderDates.join("、")}）を見送りとして記録します（この投与の保存後）。`);
    const linkOptions = scheduledList
      .map((r) => `<option value="${r.id}" ${String(r.id) === linkId ? "selected" : ""}>${this._dl(r.scheduledAt, today)} ${this._tl(r.scheduledTime)} の予定</option>`)
      .join("");
    this._modal(`
      <p class="modal-title">${editing ? "投与記録を修正" : "投与を記録"}</p>
      ${context.length ? `<div class="modal-body">${context.map((c) => escapeHtml(c)).join("<br />")}</div>` : ""}
      ${
        scheduledList.length
          ? this._field("結び付ける予定", `<select id="inj-a-link"><option value="" ${linkId === "" ? "selected" : ""}>結び付けない（予定とは別の記録）</option>${linkOptions}</select>`, "予定を選ぶと、その予定が「投与済み」になります。選ばないと、予定は未投与のまま残ります。")
          : ""
      }
      <div class="form-grid">
        ${this._field("実施日", `<input type="date" id="inj-a-date" value="${escapeHtml(init.date)}" max="${today}" />`)}
        ${this._field("実施時刻（任意）", `<input type="time" id="inj-a-time" value="${escapeHtml(init.time)}" />`, "分からなければ空欄のままで記録できます")}
        ${this._field("用量", this._doseSelect("inj-a-dose", init.dose), "製剤規格から選びます（アプリは増減を勧めません）")}
      </div>
      ${this._field("メモ（任意）", `<input type="text" id="inj-a-comment" maxlength="${INJECTION_COMMENT_MAX}" value="${escapeHtml(init.comment)}" />`)}
      <div id="inj-a-notes" class="inj-notes"></div>
      <div class="modal-actions">
        <button class="btn-secondary" id="inj-a-cancel">キャンセル</button>
        <button class="btn-primary" id="inj-a-ok" disabled>${editing ? "修正を保存" : "記録する"}</button>
      </div>`);
    const build = () => {
      const link = document.getElementById("inj-a-link");
      const linkValue = link ? link.value : "";
      return {
        date: this._val("inj-a-date"),
        time: this._val("inj-a-time") || null,
        dose: this._numOrNull(this._val("inj-a-dose")),
        comment: this._val("inj-a-comment"),
        editId: editing ? editing.id : undefined,
        recordId: linkValue || undefined,
        noLink: !editing && !linkValue,
        regularDate: opts.regularDate,
      };
    };
    let lastError = "";
    const refresh = () => {
      const a = L.assessAdministration(state, build(), this._now());
      let html = "";
      let canSave = a.errors.length === 0;
      if (a.errors.length) {
        html += `<p class="form-error">${escapeHtml(a.errors[0].message)}</p>`;
      } else {
        if (a.needs.dose) {
          const d = a.needs.dose;
          html += d.first
            ? `<p class="inj-warn">初めての記録です（比べる前回の用量がありません）。選んだ用量（${d.to}mg）が、処方された用量どおりかを確認してください。</p>`
            : `<p class="inj-warn">用量が前回の基準と異なります（${d.from}mg → ${d.to}mg）。処方された用量どおりかを確認してください。</p>`;
          html += `<label class="form-field-inline"><input type="checkbox" id="inj-a-cdose" ${confirm.dose ? "checked" : ""} /> <span>処方内容どおりであることを確認しました</span></label>`;
          if (!confirm.dose) canSave = false;
        }
        if (a.needs.interval) {
          for (const iv of a.needs.intervals || [a.needs.interval]) {
            const other = iv.with === "prev" ? "前回" : "次の";
            const when = `${this._dl(iv.other.date, today)} ${this._tl(iv.other.time)}`;
            const text =
              iv.result === "lt72"
                ? `${other}の投与（${when}）との間隔は ${escapeHtml(L.formatGap(iv))} で、72時間未満です。実際に投与した事実として記録はできますが、内容を確認してください。`
                : `時刻が不明のため、${other}の投与（${when}）との間隔が72時間以上かを厳密に判定できません（${escapeHtml(L.formatGap(iv))}）。時刻が分かれば入力してください。`;
            html += `<p class="inj-warn">${text}</p>`;
          }
          html += `<label class="form-field-inline"><input type="checkbox" id="inj-a-cint" ${confirm.interval ? "checked" : ""} /> <span>確認したうえで記録します</span></label>`;
          if (!confirm.interval) canSave = false;
        }
        if (lastError) html += `<p class="form-error">${escapeHtml(lastError)}</p>`;
      }
      document.getElementById("inj-a-notes").innerHTML = html;
      document.getElementById("inj-a-ok").disabled = !canSave;
      const cd = document.getElementById("inj-a-cdose");
      if (cd) cd.addEventListener("change", () => { confirm.dose = cd.checked; refresh(); });
      const ci = document.getElementById("inj-a-cint");
      if (ci) ci.addEventListener("change", () => { confirm.interval = ci.checked; refresh(); });
    };
    // 日付・時刻・用量・結び付ける予定が変わったときだけ、確認のチェックを外す（メモの入力では外さない）
    ["inj-a-date", "inj-a-time", "inj-a-dose", "inj-a-link"].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      const h = () => {
        const linkEl = document.getElementById("inj-a-link");
        if (id === "inj-a-link") linkTouched = true;
        // 実施日を変えたときは、本人が予定を選び直していない限り、新しい実施日に合う予定へ選び直す
        if (id === "inj-a-date" && linkEl && !linkTouched) linkEl.value = linkOf(this._val("inj-a-date"));
        confirm.dose = false;
        confirm.interval = false;
        lastError = "";
        refresh();
      };
      el.addEventListener("input", h);
      el.addEventListener("change", h);
    });
    document.getElementById("inj-a-comment").addEventListener("input", () => { lastError = ""; refresh(); });
    document.getElementById("inj-a-cancel").addEventListener("click", () => this._close());
    document.getElementById("inj-a-ok").addEventListener("click", () => {
      if (!this._writable()) return;
      const input = { ...build(), confirmDose: confirm.dose, confirmInterval: confirm.interval };
      const r = editing ? L.applyEditAdministration(state, editing.id, input, this._now()) : L.applyAdministration(state, input, this._now());
      if (!r.ok) {
        lastError = r.message || "保存できませんでした。";
        return refresh();
      }
      // 打ち忘れの画面で、本人が選んだ古い回は、投与の保存の後に見送りとして記録する。失敗した回は知らせる
      const failed = [];
      for (const s of opts.olderSkips || []) {
        const sr = L.applySkip(state, { regularDate: s.regularDate, recordId: s.recordId, reason: "userChoice" }, this._now());
        if (!sr.ok) failed.push(`${InjectionLogic.formatShortDate(s.regularDate, today)}：${sr.message}`);
      }
      this._finish(failed.length ? `投与は記録しましたが、次の回を見送りとして記録できませんでした。<br />${failed.map((f) => escapeHtml(f)).join("<br />")}` : "");
    });
    refresh();
  },

  // ============ 打ち忘れた（基準: 現在時刻 → 次の定例投与日時。電子添付文書 7.2） ============

  _openMissed(note) {
    const state = UI.state;
    const L = InjectionLogic;
    const now = this._now();
    const today = L.ymd(now);
    const ev = L.evaluateMissedDose(state, now);

    if (ev.status === "nothingMissed") {
      return this._info("打ち忘れの確認", `記録のない過去の定例回はありません。${ev.longGap ? "<br />前回の投与記録から28日以上あいています。処方元に確認してください。" : ""}<br /><small>実際に投与した場合は「投与を記録」から入力できます。</small>`);
    }
    if (ev.status === "noSchedule") {
      const list = ev.items.map((it) => `<li>${this._dl(it.date, today)}（予定）</li>`).join("");
      return this._info("打ち忘れの確認", `定例スケジュールが未設定のため、72時間の判定はできません。過去の予定があります：<ul class="backup-list">${list}</ul>投与した場合は「投与を記録」、不要な予定は注射タブの一覧から取り消してください。`);
    }

    const j = ev.judgment;
    const target = ev.target;
    const next = ev.next;
    const remain = L.formatGap(j);
    const text = {
      ge72: `添付文書（用法及び用量に関連する注意 7.2）には、次回投与までの期間が3日間（72時間）以上であれば、気づいた時点で直ちに投与し、その後はあらかじめ定めた曜日に投与する旨が記載されています。`,
      lt72: `添付文書（用法及び用量に関連する注意 7.2）には、次回投与までの期間が3日間（72時間）未満であれば投与せず、次のあらかじめ定めた曜日に投与する旨が記載されています。`,
      unknown: `予定時刻が未設定のため、残り時間が72時間以上あるかを厳密に判定できません（残り ${escapeHtml(remain)}）。時刻を確認してください。`,
    }[j.result];
    const resultLabel = { ge72: "72時間以上", lt72: "72時間未満", unknown: "判定できません" }[j.result];
    const older = ev.older
      .map(
        (o, i) => `<li><label class="form-field-inline"><input type="checkbox" class="inj-m-older" data-i="${i}" /> <span>${this._dl(o.date, today)} の回を見送りとして記録する</span></label></li>`
      )
      .join("");

    this._modal(`
      <p class="modal-title">打ち忘れた</p>
      ${note ? `<p class="inj-warn">${escapeHtml(note)}</p>` : ""}
      ${ev.longGap ? `<div class="inj-notice inj-notice-warn"><strong>前回の投与記録から${ev.daysSinceLast}日あいています。</strong><br />再開の時期や用量について、アプリでは判断しません。処方元（医師・薬剤師）に確認してください。<br /><small>※28日はアプリ上の注意表示の目安で、再開できるかどうかの基準ではありません。</small></div>` : ""}
      <div class="modal-body">
        <table class="inj-facts">
          <tr><th>対象の回</th><td>${this._dl(target.date, today)}（記録なし）</td></tr>
          <tr><th>次の定例投与</th><td>${this._dl(next.date, today)} ${this._tl(next.time)}${next.source === "scheduledRecord" ? "（登録済みの予定）" : ""}</td></tr>
          <tr><th>現在</th><td>${escapeHtml(this._fmtTs(now))}</td></tr>
          <tr><th>次の定例投与まで</th><td><strong>${escapeHtml(remain)}</strong>（${resultLabel}）</td></tr>
        </table>
        <p>${text}</p>
        <p class="inj-sub">処方元の指示がある場合は、そちらを優先してください。</p>
      </div>
      ${
        ev.older.length
          ? `<div class="modal-body"><p>さらに古い、記録のない回があります。<strong>記録がないことと、投与しなかったことは同じではありません。</strong>見送りとして記録するかどうかは、ご自身で選んでください（選ばなかった回は、記録なしのままです）。</p><ul class="inj-olderlist">${older}</ul></div>`
          : ""
      }
      <p class="inj-sub">見送りとして記録すると、履歴に残ります。定例スケジュールは変わりません。</p>
      <div class="modal-actions inj-missed-actions">
        ${j.result === "ge72" ? `<button class="btn-primary" id="inj-m-admin">投与を記録する</button>` : ""}
        ${j.result === "unknown" ? `<button class="btn-primary" id="inj-m-time">予定時刻を設定</button>` : ""}
        <button class="btn-secondary" id="inj-m-skip">見送りとして記録</button>
        <button class="btn-text" id="inj-m-close">閉じる</button>
      </div>
      ${j.result !== "ge72" ? `<p class="inj-sub">実際に投与した場合は、「投与を記録」から事実として記録できます。</p>` : ""}`);

    const selectedOlder = () => [...document.querySelectorAll(".inj-m-older")].filter((c) => c.checked).map((c) => ev.older[Number(c.dataset.i)]);
    // ダイアログを開いてから時間が経ち、判定が変わっていないか確認してから操作する
    const recheck = () => {
      const now2 = this._now();
      const ev2 = L.evaluateMissedDose(state, now2);
      if (ev2.status !== "judged" || ev2.judgment.result !== j.result || ev2.target.date !== target.date) {
        this._openMissed("時間が経過し、判定が変わりました。表示を更新しました。");
        return null;
      }
      return { now: now2, ev: ev2 };
    };
    document.getElementById("inj-m-close").addEventListener("click", () => this._close());
    const adminBtn = document.getElementById("inj-m-admin");
    if (adminBtn) {
      adminBtn.addEventListener("click", () => {
        const c = recheck();
        if (!c) return;
        this._openAdminister({ regularDate: target.regularDate, recordId: target.recordId, olderSkips: selectedOlder().map((o) => ({ regularDate: o.regularDate, recordId: o.recordId })) });
      });
    }
    const timeBtn = document.getElementById("inj-m-time");
    if (timeBtn) timeBtn.addEventListener("click", () => this._openRegularTime(true));
    document.getElementById("inj-m-skip").addEventListener("click", () => {
      if (!this._writable()) return;
      const c = recheck();
      if (!c) return;
      const reason = { ge72: "userChoice", lt72: "missedUnder72h", unknown: "missedUnknown" }[c.ev.judgment.result];
      // 保存する判定のスナップショットは、いま判定し直した値（画面を開いたときの値ではない）
      const check = {
        judgedAt: c.now.toISOString(),
        target: c.ev.target.date,
        next: { date: c.ev.next.date, time: c.ev.next.time || null },
        now: { date: L.ymd(c.now), time: this._fmtTs(c.now).slice(11) },
        result: c.ev.judgment.result,
        minMs: c.ev.judgment.minMs,
        maxMs: c.ev.judgment.maxMs,
      };
      const olders = selectedOlder();
      const r = L.applySkip(state, { regularDate: target.regularDate, recordId: target.recordId, reason, missedCheck: check }, c.now);
      if (!r.ok) return this._info("記録できませんでした", escapeHtml(r.message));
      const failed = [];
      for (const o of olders) {
        const sr = L.applySkip(state, { regularDate: o.regularDate, recordId: o.recordId, reason: "userChoice" }, c.now);
        if (!sr.ok) failed.push(`${L.formatShortDate(o.date, today)}：${sr.message}`);
      }
      this._finish(failed.length ? `対象の回は見送りとして記録しましたが、次の回を記録できませんでした。<br />${failed.map((f) => escapeHtml(f)).join("<br />")}` : "");
    });
  },

  // ============ 予定時刻の設定（定例の予定時刻だけ。曜日は変わらない） ============
  // 時刻不明で72時間を判定できないときに、時刻を入れて判定し直すための操作。曜日変更とは別の操作。

  _openRegularTime(returnToMissed) {
    const state = UI.state;
    const L = InjectionLogic;
    const reg = L.schedule(state).regular;
    if (!reg) return this._info("設定できません", "定例スケジュールが未設定です。");
    this._modal(`
      <p class="modal-title">予定時刻を設定</p>
      <div class="modal-body">定例の予定時刻だけを設定します。<strong>投与曜日は変わりません。</strong>過去の記録も変わりません。時刻を入れると、72時間の判定が正確になります。</div>
      ${this._field("予定時刻", `<input type="time" id="inj-t-time" value="${escapeHtml(reg.time || "")}" />`)}
      <p class="form-error" id="inj-t-err" hidden></p>
      <div class="modal-actions">
        <button class="btn-secondary" id="inj-t-cancel">キャンセル</button>
        <button class="btn-primary" id="inj-t-ok">設定する</button>
      </div>`);
    document.getElementById("inj-t-cancel").addEventListener("click", () => this._close());
    document.getElementById("inj-t-ok").addEventListener("click", () => {
      if (!this._writable()) return;
      const r = L.applyRegularTime(state, this._val("inj-t-time") || null, this._now());
      if (!r.ok) return this._showErr("inj-t-err", r.message);
      const saved = this._commit(state);
      this._close();
      this._reRender();
      if (!saved) return this._info("保存できませんでした", "画面には反映されましたが、保存に失敗しました。画面上部の案内を確認してください。");
      if (returnToMissed) this._openMissed();
    });
  },

  // ============ 投与曜日を変更（基準: 前回の実投与日時 → 変更後の最初の予定日時。電子添付文書 7.2） ============
  // 72時間未満・判定不能の候補は選べない（確定を保留し、時刻の確認を求める）。

  _openWeekdayChange(opts = {}) {
    const state = UI.state;
    const L = InjectionLogic;
    const now = this._now();
    const today = L.ymd(now);
    const can = L.canChangeSchedule(state, now);
    if (!can.ok) return this._info("投与曜日を変更できません", escapeHtml(can.message));
    const reg = L.schedule(state).regular;
    const fut = L.pendingFuture(state, today);
    let selected = null;
    const wdOptions = L.WEEKDAYS.map((w, i) => `<option value="${i}" ${i === reg.weekday ? "selected" : ""}>${w}曜日</option>`).join("");
    this._modal(`
      <p class="modal-title">投与曜日を変更</p>
      <div class="modal-body">
        現在の定例：毎週${L.WEEKDAYS[reg.weekday]}曜日 ${this._tl(reg.time)}<br />
        添付文書（用法及び用量に関連する注意 7.2）には、週1回投与の曜日を変更する場合は、前回投与から少なくとも3日間（72時間）以上間隔を空ける旨が記載されています。
        <br />予定時刻だけを設定する場合は、「予定時刻を設定」を使ってください（曜日は変わりません）。
      </div>
      <div class="form-grid">
        ${this._field("変更後の曜日", `<select id="inj-w-weekday">${wdOptions}</select>`)}
        ${this._field("予定時刻（任意）", `<input type="time" id="inj-w-time" value="${escapeHtml(reg.time || "")}" />`)}
      </div>
      <p class="modal-body">変更後の最初の予定日を選びます（72時間以上あいている日だけ選べます）：</p>
      <div id="inj-w-cands" class="inj-cands"></div>
      <div id="inj-w-notes" class="inj-notes"></div>
      <div class="modal-actions">
        <button class="btn-secondary" id="inj-w-cancel">キャンセル</button>
        <button class="btn-primary" id="inj-w-ok" disabled>変更を確定</button>
      </div>`);
    const refresh = () => {
      const weekday = Number(this._val("inj-w-weekday"));
      const time = this._val("inj-w-time") || null;
      const cands = L.weekdayChangeCandidates(state, { weekday, time }, this._now(), 3);
      const box = document.getElementById("inj-w-cands");
      if (!cands.some((c) => c.date === selected)) selected = null;
      box.innerHTML = cands
        .map((c) => {
          const jd = c.judgment;
          const status =
            jd.result === "ge72" || jd.result === "noHistory"
              ? `選べます${jd.minMs !== null ? `（前回の実投与から ${escapeHtml(L.formatGap(jd))}）` : "（投与履歴がありません）"}`
              : jd.result === "lt72"
              ? `前回の実投与から72時間未満のため選べません（${escapeHtml(L.formatGap(jd))}）`
              : `時刻が不明のため、72時間以上かを判定できません（${escapeHtml(L.formatGap(jd))}）`;
          const far = c.daysFromToday > 7 ? "<br /><small>1週間より先の日付です。それまでの間は、投与日が予定されません。</small>" : "";
          return `<label class="inj-cand ${jd.canConfirm ? "" : "inj-cand-off"}">
            <input type="radio" name="inj-w-cand" value="${c.date}" ${jd.canConfirm ? "" : "disabled"} ${selected === c.date ? "checked" : ""} />
            <span><strong>${this._dl(c.date, today)} ${this._tl(time)}</strong><br /><small>${status}</small>${far}</span>
          </label>`;
        })
        .join("");
      box.querySelectorAll('input[name="inj-w-cand"]').forEach((r) =>
        r.addEventListener("change", () => {
          selected = r.value;
          refresh();
        })
      );
      const unknownAny = cands.some((c) => c.judgment.result === "unknown");
      const notes = [];
      if (unknownAny) notes.push("前回の投与時刻が不明な場合は、履歴の「修正」から時刻を入力するか、変更後の予定時刻を入力してください。時刻が分かると判定できることがあります。");
      if (selected && fut && fut.scheduledAt !== selected) notes.push(`現在の予定 ${this._dl(fut.scheduledAt, today)} は、${this._dl(selected, today)} に置き換わります。`);
      if (weekday === reg.weekday && (time || null) === (reg.time || null)) notes.push("曜日・時刻とも現在と同じです。");
      document.getElementById("inj-w-notes").innerHTML = notes.map((n) => `<p class="inj-sub">${escapeHtml(n)}</p>`).join("");
      document.getElementById("inj-w-ok").disabled = !selected;
    };
    ["inj-w-weekday", "inj-w-time"].forEach((id) => {
      const el = document.getElementById(id);
      el.addEventListener("input", refresh);
      el.addEventListener("change", refresh);
    });
    document.getElementById("inj-w-cancel").addEventListener("click", () => this._close());
    document.getElementById("inj-w-ok").addEventListener("click", () => {
      if (!this._writable()) return;
      const input = { weekday: Number(this._val("inj-w-weekday")), time: this._val("inj-w-time") || null, firstDate: selected };
      const r = L.applyWeekdayChange(state, input, this._now());
      if (!r.ok) return this._info("変更できませんでした", escapeHtml(r.message));
      this._finish();
    });
    refresh();
  },

  // ============ 基準用量（投与の記録で選ぶときの初期選択。推奨用量ではない） ============

  _openBaseDose() {
    const state = UI.state;
    const L = InjectionLogic;
    this._modal(`
      <p class="modal-title">基準用量を設定</p>
      <div class="modal-body">投与を記録するときの、用量の初期選択になります。処方された用量を選んでください。アプリは用量の増減を勧めません。</div>
      ${this._field("基準用量", this._doseSelect("inj-b-dose", L.schedule(state).baseDoseMg))}
      <div class="modal-actions">
        <button class="btn-secondary" id="inj-b-cancel">キャンセル</button>
        <button class="btn-primary" id="inj-b-ok">保存</button>
      </div>`);
    document.getElementById("inj-b-cancel").addEventListener("click", () => this._close());
    document.getElementById("inj-b-ok").addEventListener("click", () => {
      if (!this._writable()) return;
      const r = L.applyBaseDose(state, this._numOrNull(this._val("inj-b-dose")));
      if (!r.ok) return this._info("保存できません", escapeHtml(r.message));
      this._finish();
    });
  },

  // ============ 予定の取消／履歴の削除（別々の操作・別々の確認） ============

  _confirmCancel(id) {
    const state = UI.state;
    const rec = state.injections.find((r) => String(r.id) === String(id));
    if (!rec || rec.status !== "scheduled") return this._info("取り消せません", "取り消せる予定がありません。");
    const today = InjectionLogic.ymd(this._now());
    this._confirm({
      title: "予定を取り消します",
      body: `${this._dl(rec.scheduledAt, today)} ${this._tl(rec.scheduledTime)} の予定を取り消します。<br />投与済み・見送りの履歴と、定例スケジュールには影響しません。`,
      okLabel: "予定を取り消す",
      onOk: () => {
        if (!this._writable()) return;
        const r = InjectionLogic.applyCancelScheduled(state, id);
        if (!r.ok) return this._info("取り消せません", escapeHtml(r.message));
        this._finish();
      },
    });
  },

  _confirmDeleteHistory(id) {
    const state = UI.state;
    const rec = state.injections.find((r) => String(r.id) === String(id));
    if (!rec || rec.status === "scheduled") return this._info("削除できません", "削除できる履歴がありません。");
    const today = InjectionLogic.ymd(this._now());
    const label = rec.status === "administered" ? `${this._dl(rec.administeredAt, today)} の投与記録（${typeof rec.dose === "number" ? rec.dose + "mg" : "用量なし"}）` : `${this._dl(rec.regularDate || rec.scheduledAt, today)} の見送りの記録`;
    this._confirm({
      title: "履歴を削除します",
      body: `${label}を削除します。<br /><strong>実際の投与の履歴が消えます。</strong>誤って入力した記録の訂正以外では、削除しないことをおすすめします（削除しても、書き出したバックアップからは復元できます）。<br />予定の取消とは別の操作です。`,
      okLabel: "履歴を削除する",
      onOk: () => {
        if (!this._writable()) return;
        const r = InjectionLogic.applyDeleteHistory(state, id);
        if (!r.ok) return this._info("削除できません", escapeHtml(r.message));
        this._finish();
      },
    });
  },
};
