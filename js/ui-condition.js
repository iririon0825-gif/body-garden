// Body Garden — 今日の体調・副作用（HOMEカード＋記録タブの詳細）
// ロジックは condition-logic.js（純粋関数）。ここは画面と操作の流れだけを担当する。
//
// 体調・副作用は、本人による日々の状態の記録。医療の判断・診断・助言は行わない（注意喚起・警告色も出さない）。
//
// HOMEの操作（モード）:
//   view … 今日の記録がある。最新の記録を表示するだけ。顔のボタン・メモは押しても保存・変更されない。
//          [この記録を直す]（最新の記録を編集）と [もう1回記録する]（新しい記録を追加）を分けて選ぶ。
//   add  … 新しい記録を追加する（今日の記録がまだ無いときの既定）。[記録する]で初めて保存される。
//   edit … 当日の最新の記録を編集する。[更新する]で初めて保存される。
//   下書き（選んだ段階・メモ）はメモリ上だけ。他のカードの再描画（Proteinの操作など）で消えないよう、
//   カードは常に下書きから描く。日付が変わったら下書きは捨てる。
// 保存は、検証→変更→Storage.save→失敗したら元に戻す。保存の日付・時刻は、保存の瞬間の now から1回だけ作る。
// 表示する文字列はすべて escapeHtml を通す。

const ConditionUI = {
  _home: null,
  _homeMsg: "",
  _view: "new", // 記録タブ: new（新しく記録する）| history（履歴を見る）| edit（既存の記録を編集する）
  _new: null,
  _edit: null,
  _detailMsg: "",
  _historyDates: 30,
  _busy: false,
  _lastDate: null,

  _now() {
    return new Date();
  },
  _today() {
    return ConditionLogic._ymd(this._now());
  },
  _state() {
    return UI.state;
  },
  _writable() {
    return !Storage.readOnly;
  },
  _md(date) {
    const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(date || "");
    return m ? `${Number(m[1])}/${Number(m[2])}` : String(date);
  },

  // ============ 小さな部品 ============

  // 顔アイコン枠。画像は CONDITION_FACE_ASSETS で後から差し替える。未設定・読み込み失敗のときは枠と文字ラベルだけ
  _faceHtml(level) {
    const src = typeof CONDITION_FACE_ASSETS !== "undefined" ? CONDITION_FACE_ASSETS[level] : null;
    return `<span class="cond-face" data-face="${escapeHtml(level)}" aria-hidden="true">${src ? `<img src="${escapeHtml(src)}" alt="" onerror="this.remove()" />` : ""}</span>`;
  },
  _levelButtons({ selected, locked, attr }) {
    return ConditionLogic.SELECTABLE.map((lv) => {
      const on = selected === lv;
      return `<button type="button" class="cond-face-btn${on ? " is-selected" : ""}${locked ? " is-locked" : ""}" ${attr}="${lv}" aria-pressed="${on}" ${locked ? 'aria-disabled="true" tabindex="-1"' : ""}>${this._faceHtml(lv)}<span class="cond-face-label">${escapeHtml(ConditionLogic.levelLabel(lv))}</span></button>`;
    }).join("");
  },

  // ============ HOME：下書きと状態 ============

  _newHome(state, date) {
    const latest = ConditionLogic.latestForDate(state, date);
    return { date, mode: latest ? "view" : "add", explicitAdd: false, source: null, level: null, comment: "" };
  },

  _HOME_DATE_MSG: "日付が変わりました。入力していた内容は保存していません。今日の記録として、もう一度入力してください。",
  _HOME_EDIT_MSG: "編集していた記録が変わったため、編集を終了しました。",

  _homeDirty(d) {
    if (!d) return false;
    if (d.mode === "add") return d.level !== null || d.comment !== "";
    if (d.mode === "edit") return d.level !== d.source.level || (ConditionLogic.memoEditableOnHome(d.source) && d.comment !== d.source.comment);
    return false;
  },
  // 下書きが古くなっていないか（日付が変わった／編集元が消えた・変わった）。古ければ案内の文を返す。state は変えない
  _homeStale(state, today = this._today()) {
    const d = this._home;
    if (!d) return null;
    if (d.date !== today) return this._HOME_DATE_MSG;
    if (d.mode === "edit") {
      const cur = d.source ? ConditionLogic.findById(state, d.source.id) : null;
      if (!cur || cur.date !== today || !ConditionLogic._sourceMatches(cur, d.source)) return this._HOME_EDIT_MSG;
    }
    return null;
  },
  // 古い下書きを捨てて、案内つきで描き直す（入力は受け付けない）
  _homeReset(msg) {
    this._home = null;
    this._homeMsg = msg;
    this._refreshHomeCard();
  },

  // 下書きを、今日・いまの記録の状態に合わせて整える。描画の経路で古い下書きを見つけたときは、
  // 入力があった下書きに限り、捨てたことを案内する
  _homeDraft(state) {
    const today = this._today();
    let d = this._home;
    if (!d || d.date !== today) {
      if (d && this._homeDirty(d)) this._homeMsg = this._HOME_DATE_MSG;
      d = this._home = this._newHome(state, today);
    }
    const entries = ConditionLogic.entriesForDate(state, today);
    if (d.mode === "edit") {
      const cur = d.source ? ConditionLogic.findById(state, d.source.id) : null;
      if (!cur || cur.date !== today || !ConditionLogic._sourceMatches(cur, d.source)) {
        this._home = d = this._newHome(state, today);
        this._homeMsg = this._HOME_EDIT_MSG;
      }
    }
    if (d.mode === "view" && entries.length === 0) d.mode = "add";
    if (d.mode === "add" && entries.length > 0 && !d.explicitAdd && d.level === null && d.comment === "") d.mode = "view";
    return d;
  },
  _homeInfo(state) {
    const d = this._homeDraft(state);
    const today = d.date;
    const entries = ConditionLogic.entriesForDate(state, today);
    const latest = entries.length ? entries[entries.length - 1] : null;
    let dirty = false;
    let canSave = false;
    if (d.mode === "add") {
      dirty = d.level !== null || d.comment !== "";
      canSave = ConditionLogic.SELECTABLE.includes(d.level);
    } else if (d.mode === "edit") {
      const memoEditable = ConditionLogic.memoEditableOnHome(d.source);
      dirty = d.level !== d.source.level || (memoEditable && d.comment !== d.source.comment);
      canSave = dirty;
    }
    return { d, today, entries, latest, dirty, canSave: canSave && this._writable() };
  },

  // ============ HOME：描画 ============

  homeCardInnerHtml(state) {
    try {
      return this._homeHtml(state);
    } catch (e) {
      console.error("[BodyGarden] 体調カードを表示できません", e);
      return `<p class="card-title">${UI.lineIcon("condition")}今日の体調・副作用</p><p class="cond-note">体調の表示でエラーが起きました。設定画面からバックアップを書き出して確認してください。</p>`;
    }
  },

  _homeHtml(state) {
    const { d, entries, latest, dirty, canSave } = this._homeInfo(state);
    const view = d.mode === "view";
    const editing = d.mode === "edit";
    const memoEditable = !editing || ConditionLogic.memoEditableOnHome(d.source);
    const selected = view && latest ? ConditionLogic.displayLevel(latest.level) : ConditionLogic.displayLevel(d.level);
    const msg = this._homeMsg ? `<p class="cond-msg" role="status">${escapeHtml(this._homeMsg)}</p>` : "";
    const roReason = !this._writable() ? `<p class="cond-note">いまは変更を保存できません（画面上部の案内を確認してください）。</p>` : "";

    let status = "";
    if (view && latest) {
      status = `<p class="cond-status">記録済み${latest.time ? `（${escapeHtml(latest.time)}）` : ""}${entries.length > 1 ? `　今日 ${entries.length}件` : ""}</p>`;
    } else if (editing) {
      const target = ConditionLogic.findById(state, d.source.id);
      status = `<p class="cond-status">記録を編集中${target && target.time ? `（${escapeHtml(target.time)}）` : ""}</p>`;
    } else if (entries.length > 0) {
      status = `<p class="cond-status">新しい記録を追加中（今日 ${entries.length}件 記録済み）</p>`;
    }

    let memo;
    if (view) {
      const c = latest && latest.comment ? latest.comment : "";
      memo = `<p class="cond-memo-view${c ? "" : " is-empty"}">${c ? escapeHtml(c) : "メモなし"}</p>`;
    } else if (!memoEditable) {
      memo = `<p class="cond-memo-view">${escapeHtml(d.source.comment)}</p><p class="cond-note">メモは「詳しく記録」で編集できます（ここでは段階だけ更新します）。</p>`;
    } else {
      memo = `<input type="text" class="cond-memo" id="cond-home-memo" maxlength="${ConditionLogic.COMMENT_MAX}" placeholder="メモを入力..." value="${escapeHtml(d.comment)}" aria-label="メモ" />`;
    }

    let actions;
    if (view) {
      actions = `<button type="button" class="btn-secondary cond-btn" data-cond-act="edit">この記録を直す</button>
                 <button type="button" class="btn-secondary cond-btn" data-cond-act="add">もう1回記録する</button>`;
    } else {
      const label = editing ? "更新する" : "記録する";
      actions = `<button type="button" class="btn-primary cond-btn" id="cond-home-save" ${canSave ? "" : "disabled"}>${label}</button>
                 ${editing || entries.length > 0 ? `<button type="button" class="btn-text cond-btn" data-cond-act="cancel">やめる</button>` : ""}`;
    }

    return `
      <div class="cond-head">
        <p class="card-title">${UI.lineIcon("condition")}今日の体調・副作用</p>
        <button type="button" class="cond-more" data-cond-act="more">詳しく記録 <span aria-hidden="true">›</span></button>
      </div>
      <div class="cond-home">
        ${status}
        <div class="cond-faces" role="group" aria-label="今日の体調">${this._levelButtons({ selected, locked: view, attr: "data-cond-level" })}</div>
        <div class="cond-body">
          ${memo}
          <p class="cond-unsaved" ${dirty ? "" : "hidden"}>まだ保存していません。</p>
          ${msg}${roReason}
          <div class="cond-actions">${actions}</div>
        </div>
      </div>`;
  },

  // HOMEの体調カードだけを描き直す（他のカード・グラフには触れない）
  _refreshHomeCard() {
    const el = document.querySelector('[data-screen="home"] .condition-card');
    if (!el) return;
    el.innerHTML = this.homeCardInnerHtml(this._state());
    this.bindHomeCard();
  },

  // 入力中は描き直さず、保存ボタンと「まだ保存していません」だけを更新する（入力欄のフォーカスを保つ）
  _syncHomeButtons() {
    const info = this._homeInfo(this._state());
    const save = document.getElementById("cond-home-save");
    if (save) save.disabled = !info.canSave;
    const un = document.querySelector(".cond-unsaved");
    if (un) un.hidden = !info.dirty;
  },

  bindHomeCard() {
    const root = document.querySelector('[data-screen="home"] .condition-card');
    if (!root) return;
    const state = this._state();
    root.querySelectorAll("[data-cond-level]").forEach((b) => b.addEventListener("click", () => this._homeChoose(b.dataset.condLevel)));
    const memo = root.querySelector("#cond-home-memo");
    if (memo) {
      memo.addEventListener("input", () => {
        const stale = this._homeStale(state);
        if (stale) return this._homeReset(stale);
        this._homeDraft(state).comment = memo.value;
        this._syncHomeButtons();
      });
    }
    root.querySelectorAll("[data-cond-act]").forEach((b) => b.addEventListener("click", () => this._homeAct(b.dataset.condAct)));
    const save = root.querySelector("#cond-home-save");
    if (save) save.addEventListener("click", () => this._homeSave());
  },

  // 顔のボタン。選ぶのは下書きだけで、保存はしない。表示モード（記録済み）では何も起きない
  _homeChoose(lv) {
    const state = this._state();
    const stale = this._homeStale(state);
    if (stale) return this._homeReset(stale);
    const d = this._homeDraft(state);
    if (d.mode === "view") return;
    if (!ConditionLogic.SELECTABLE.includes(lv)) return;
    // severe の記録で「あり」を押したときは、保存値の severe のまま（別の段階から戻したときも同じ）
    d.level = d.mode === "edit" && d.source.level === "severe" && lv === "moderate" ? "severe" : lv;
    this._homeMsg = "";
    this._refreshHomeCard();
  },

  _homeAct(act) {
    const state = this._state();
    const info = this._homeInfo(state);
    this._homeMsg = "";
    if (act === "edit" && info.latest) {
      this._home = { date: info.today, mode: "edit", explicitAdd: false, source: ConditionLogic.sourceOf(info.latest), level: info.latest.level === undefined ? null : info.latest.level, comment: info.latest.comment || "" };
    } else if (act === "add") {
      this._home = { date: info.today, mode: "add", explicitAdd: true, source: null, level: null, comment: "" };
    } else if (act === "cancel") {
      this._home = this._newHome(state, info.today);
    } else if (act === "more") {
      return this._openDetailFromHome();
    }
    this._refreshHomeCard();
  },

  // HOMEの保存。日付・時刻は now から1回だけ作る。保存に失敗したら元に戻す
  _homeSave() {
    if (this._busy) return;
    this._busy = true;
    try {
      const state = this._state();
      if (!this._writable()) {
        this._homeMsg = "いまは変更を保存できません。";
        return this._refreshHomeCard();
      }
      const now = this._now();
      const today = ConditionLogic._ymd(now);
      const stale = this._homeStale(state, today);
      if (stale) return this._homeReset(stale); // 昨日の下書き・編集元が変わった下書きは、保存しない
      const d = this._home || this._homeDraft(state);
      let r;
      if (d.mode === "edit") {
        const patch = { level: d.level };
        if (ConditionLogic.memoEditableOnHome(d.source)) patch.comment = d.comment;
        r = ConditionLogic.applyEdit(state, d.source.id, patch, d.source, now);
      } else {
        r = ConditionLogic.applyAdd(state, { date: today, time: ConditionLogic._hm(now), level: d.level, symptoms: [], comment: d.comment }, now);
      }
      if (!r.ok) {
        if (r.code === "STALE_SOURCE" || r.code === "NOT_FOUND") this._home = null;
        this._homeMsg = r.code === "NONE_WITH_SYMPTOMS" ? `${r.message}（症状は「詳しく記録」で外せます）` : r.message;
        return this._refreshHomeCard();
      }
      if (!Storage.save(state)) {
        ConditionLogic.revert(state, r.snapshot);
        this._homeMsg = "保存できませんでした。何も変更していません。";
        return this._refreshHomeCard();
      }
      this._homeMsg = d.mode === "edit" ? "更新しました。" : "記録しました。";
      this._home = this._newHome(state, today);
      this._refreshHomeCard();
    } finally {
      this._busy = false;
    }
  },

  // 「詳しく記録」: 記録タブの体調記録セクションへ移動する入口。HOMEの下書きにも、既存の記録にも触れない。
  // 記録タブでは「新しく記録する」を開く（既存の記録の編集は、履歴で本人が「編集」を選んだときだけ始まる）
  _openDetailFromHome() {
    if (!(this._view === "edit" && this._edit)) this._view = "new"; // 編集の途中なら、その編集を続ける（未保存の編集を失わない）
    this._detailMsg = "";
    UI.switchScreen("records");
    setTimeout(() => {
      const el = document.getElementById("cond-section");
      if (el && el.scrollIntoView) el.scrollIntoView({ block: "start" });
    }, 0);
  },

  // ============ 記録タブ：体調・副作用（新しく記録する／履歴を見る／既存の記録を編集する） ============
  // 3つの操作を分ける:
  //   new     … 新しく記録する（日付・時刻・段階・症状・メモ）。下書きはメモリに残り、画面を切り替えても消えない。
  //   history … 履歴を見る（日付別・入力順）。各記録の [編集] [削除] は、ここで本人が選ぶ。
  //   edit    … 既存の記録を編集する。[編集]を押したときだけ始まる。保存・やめる で履歴に戻る。

  _detailNew(now) {
    return { mode: "add", source: null, date: ConditionLogic._ymd(now), time: ConditionLogic._hm(now), dateAuto: true, timeAuto: true, level: null, symptoms: [], comment: "" };
  },
  // 本人が触っていない日付・時刻は、描くとき・保存するときの now に合わせる（開いたときの時刻で固まらない）
  _refreshAuto(d, now) {
    if (d.mode !== "add") return;
    if (d.dateAuto) d.date = ConditionLogic._ymd(now);
    if (d.timeAuto) d.time = d.date === ConditionLogic._ymd(now) ? ConditionLogic._hm(now) : "";
  },
  _detailFromEntry(e) {
    return {
      mode: "edit",
      source: ConditionLogic.sourceOf(e),
      date: e.date,
      time: e.time || "",
      timeAuto: false,
      level: e.level === undefined ? null : e.level,
      symptoms: Array.isArray(e.symptoms) ? [...e.symptoms] : [],
      comment: e.comment || "",
    };
  },
  // 編集の下書きが、いまも同じ記録を指しているか。違えば編集を終えて履歴に戻る
  _checkEdit(state) {
    const d = this._edit;
    if (!d) return null;
    const cur = ConditionLogic.findById(state, d.source.id);
    if (!cur || !ConditionLogic._sourceMatches(cur, d.source)) {
      this._edit = null;
      if (this._view === "edit") this._view = "history";
      this._detailMsg = "編集していた記録が変わったため、編集を終了しました。";
      return null;
    }
    return d;
  },
  // いま表示している画面の下書き（履歴を見るときは null）
  _detailDraft(state) {
    if (this._view === "history") return null;
    if (this._view === "edit") {
      const d = this._checkEdit(state);
      if (d) return d;
      return null; // 履歴に戻った
    }
    if (!this._new) this._new = this._detailNew(this._now());
    this._refreshAuto(this._new, this._now());
    return this._new;
  },
  _editDirty(state) {
    const d = this._edit;
    const cur = d ? ConditionLogic.findById(state, d.source.id) : null;
    if (!cur) return false;
    const sym = Array.isArray(cur.symptoms) ? cur.symptoms : [];
    return d.date !== cur.date || (d.time || "") !== (cur.time || "") || d.level !== (cur.level === undefined ? null : cur.level) || d.comment !== (cur.comment || "") || d.symptoms.length !== sym.length || d.symptoms.some((x, k) => x !== sym[k]);
  },
  _setView(state, view) {
    if (view === this._view) return;
    if (this._view === "edit" && this._edit && this._editDirty(state)) {
      UI.showModal(`
        <p class="modal-title">編集を中止します</p>
        <p class="modal-body">編集中の内容は、まだ保存していません。移動すると、変更は破棄されます。</p>
        <div class="modal-actions">
          <button class="btn-secondary" id="cond-leave-cancel">編集を続ける</button>
          <button class="btn-primary" id="cond-leave-ok">破棄して移動</button>
        </div>`);
      document.getElementById("cond-leave-cancel").addEventListener("click", () => UI.hideModal());
      document.getElementById("cond-leave-ok").addEventListener("click", () => {
        UI.hideModal();
        this._edit = null;
        this._view = view;
        this._detailMsg = "";
        this.renderDetail(state);
      });
      return;
    }
    if (this._view === "edit") this._edit = null;
    this._view = view;
    this._detailMsg = "";
    this.renderDetail(state);
  },

  renderDetail(state) {
    const el = document.getElementById("condition-root");
    if (!el) return;
    try {
      el.innerHTML = this._detailHtml(state);
      this._bindDetail(state);
    } catch (e) {
      console.error("[BodyGarden] 体調の記録画面を表示できません", e);
      el.innerHTML = `<section class="card"><p class="card-title">${UI.lineIcon("condition")}体調・副作用の記録</p><p class="form-error">体調の記録を表示できませんでした。設定画面からバックアップを書き出してから、データの内容を確認してください。</p></section>`;
    }
  },

  _detailHtml(state) {
    const d = this._detailDraft(state); // 履歴を見る間は null
    const view = this._view;
    const msg = this._detailMsg ? `<p class="cond-msg" role="status">${escapeHtml(this._detailMsg)}</p>` : "";
    const tabs = `
      <div class="cond-tabs" role="group" aria-label="体調の記録の操作">
        <button type="button" class="cond-tab${view === "new" ? " is-active" : ""}" data-cond-view="new" aria-pressed="${view === "new"}">新しく記録する</button>
        <button type="button" class="cond-tab${view === "history" || view === "edit" ? " is-active" : ""}" data-cond-view="history" aria-pressed="${view === "history" || view === "edit"}">履歴を見る</button>
      </div>`;
    const head = `
      <section class="card cond-card" id="cond-section">
        <p class="card-title">${UI.lineIcon("condition")}体調・副作用</p>
        <p class="cond-note">日々の状態を、自分で記録するものです。医療の判断や診断ではありません。</p>
        ${tabs}
        ${msg}
      </section>`;
    if (d) return head + this._formHtml(state, d);
    return head + this._historyHtml(state);
  },

  _formHtml(state, d) {
    const today = this._today();
    const editing = d.mode === "edit";
    const writable = this._writable();
    const selected = ConditionLogic.displayLevel(d.level);
    const symptoms = CONDITION_SYMPTOMS.map(
      (s) => `<label class="cond-symptom"><input type="checkbox" data-cond-symptom="${escapeHtml(s.id)}" ${d.symptoms.includes(s.id) ? "checked" : ""} /> <span>${escapeHtml(s.label)}</span></label>`
    ).join("");
    const unknownKept = d.symptoms.filter((x) => !ConditionLogic.symptomIds().includes(x));
    const unknownBoxes = unknownKept
      .map((x) => `<label class="cond-symptom"><input type="checkbox" data-cond-symptom="${escapeHtml(x)}" checked /> <span>${escapeHtml(x)}</span></label>`)
      .join("");
    return `
      <section class="card cond-card" id="cond-form-card">
        <p class="card-title">${UI.lineIcon("condition")}${editing ? "既存の記録を編集" : "新しく記録する"}</p>
        ${editing ? `<p class="cond-status">${escapeHtml(this._md((ConditionLogic.findById(state, d.source.id) || {}).date || d.date))} の記録を編集中です。保存するまで、元の記録は変わりません。</p>` : ""}
        <div class="form-grid">
          <label class="form-field"><span>日付</span><input type="date" id="cond-date" value="${escapeHtml(d.date)}" max="${escapeHtml(today)}" /></label>
          <label class="form-field"><span>時刻（任意）</span><input type="time" id="cond-time" value="${escapeHtml(d.time)}" /></label>
        </div>
        <div class="cond-faces cond-faces-detail" role="group" aria-label="体調">${this._levelButtons({ selected, locked: false, attr: "data-cond-dlevel" })}</div>
        <p class="cond-sub">症状（当てはまるものを選べます）</p>
        <div class="cond-symptoms">${symptoms}${unknownBoxes}${unknownKept.length ? `<p class="cond-note">この版にない症状の記録が残っています（チェックを外すと消えます）。</p>` : ""}</div>
        <label class="form-field cond-memo-field"><span>メモ</span><textarea id="cond-comment" class="cond-textarea" maxlength="${ConditionLogic.COMMENT_MAX}" rows="3" placeholder="メモを入力...">${escapeHtml(d.comment)}</textarea></label>
        ${!writable ? `<p class="cond-note">いまは変更を保存できません（画面上部の案内を確認してください）。</p>` : ""}
        <div class="cond-actions">
          <button type="button" class="btn-primary" id="cond-save-btn" ${writable ? "" : "disabled"}>${editing ? "更新する" : "追加する"}</button>
          ${editing ? `<button type="button" class="btn-text" id="cond-cancel-btn">やめる</button>` : ""}
        </div>
      </section>`;
  },

  _historyHtml(state) {
    const hist = ConditionLogic.historyGroups(state, this._historyDates);
    const groups = hist.groups
      .map((g) => {
        const rows = g.entries
          .map((e) => {
            const lv = ConditionLogic.displayLevel(e.level);
            const chips = (Array.isArray(e.symptoms) ? e.symptoms : []).map((x) => `<span class="cond-chip cond-chip-sym">${escapeHtml(ConditionLogic.symptomLabel(x))}</span>`).join("");
            return `<li class="cond-row">
              <div class="cond-row-main">
                <span class="cond-row-time">${e.time ? escapeHtml(e.time) : "—"}</span>
                <span class="cond-chip cond-chip-${escapeHtml(lv || "unset")}">${escapeHtml(ConditionLogic.levelLabel(e.level))}</span>${chips}
              </div>
              ${e.comment ? `<p class="cond-row-memo">${escapeHtml(e.comment)}</p>` : ""}
              <div class="cond-row-actions">
                <button type="button" class="btn-text" data-cond-edit="${escapeHtml(e.id)}">編集</button>
                <button type="button" class="btn-text" data-cond-del="${escapeHtml(e.id)}">削除</button>
              </div>
            </li>`;
          })
          .join("");
        return `<div class="cond-day"><p class="cond-day-head">${escapeHtml(g.date)}${g.entries.length > 1 ? `<span class="cond-day-count">${g.entries.length}件</span>` : ""}</p><ul class="cond-list">${rows}</ul></div>`;
      })
      .join("");
    return `
      <section class="card cond-card" id="cond-history-card">
        <p class="card-title">${UI.lineIcon("records")}体調・副作用の履歴</p>
        <p class="cond-note">日付ごとに、同じ日の中は入力した順に並びます。記録を直すときは、その記録の「編集」を押してください。</p>
        ${hist.groups.length === 0 ? `<div class="placeholder-box">まだ体調の記録がありません</div>` : groups}
        ${hist.hasMore ? `<div class="cond-actions"><button type="button" class="btn-secondary" id="cond-more-btn">もっと見る</button></div>` : ""}
      </section>`;
  },

  _bindDetail(state) {
    const d = this._detailDraft(state);
    const on = (id, ev, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener(ev, fn);
    };
    document.querySelectorAll("[data-cond-view]").forEach((b) => b.addEventListener("click", () => this._setView(state, b.dataset.condView)));
    if (d) {
      on("cond-date", "change", (e) => {
        d.date = e.target.value;
        d.dateAuto = false;
        // 自動で入れた現在時刻は、今日以外の日付では外す（過去日に今の時刻を付けない）
        if (d.timeAuto) d.time = d.date === this._today() ? ConditionLogic._hm(this._now()) : "";
        this._detailMsg = "";
        this.renderDetail(state);
      });
      on("cond-time", "input", (e) => {
        d.time = e.target.value;
        d.timeAuto = false;
      });
      on("cond-comment", "input", (e) => {
        d.comment = e.target.value;
      });
      document.querySelectorAll("[data-cond-dlevel]").forEach((b) =>
        b.addEventListener("click", () => {
          const lv = b.dataset.condDlevel;
          d.level = d.mode === "edit" && d.source.level === "severe" && lv === "moderate" ? "severe" : lv;
          this._detailMsg = "";
          this.renderDetail(state);
        })
      );
      document.querySelectorAll("[data-cond-symptom]").forEach((c) =>
        c.addEventListener("change", () => {
          const id = c.dataset.condSymptom;
          d.symptoms = c.checked ? [...d.symptoms.filter((x) => x !== id), id] : d.symptoms.filter((x) => x !== id);
          // CONDITION_SYMPTOMS の並びにそろえる
          const order = ConditionLogic.symptomIds();
          const ix = (x) => (order.indexOf(x) < 0 ? 999 : order.indexOf(x));
          d.symptoms.sort((a, b) => ix(a) - ix(b));
          this._detailMsg = "";
        })
      );
      on("cond-save-btn", "click", () => this._detailSave(state));
      on("cond-cancel-btn", "click", () => this._setView(state, "history"));
    }
    on("cond-more-btn", "click", () => {
      this._historyDates += 30;
      this.renderDetail(state);
    });
    document.querySelectorAll("[data-cond-edit]").forEach((b) => b.addEventListener("click", () => this._startEdit(state, Number(b.dataset.condEdit))));
    document.querySelectorAll("[data-cond-del]").forEach((b) => b.addEventListener("click", () => this._confirmDelete(state, Number(b.dataset.condDel))));
  },

  // 履歴の「編集」。本人がこれを選んだときだけ、既存の記録の編集が始まる
  _startEdit(state, id) {
    const e = ConditionLogic.findById(state, id);
    if (!e) return;
    this._edit = this._detailFromEntry(e);
    this._view = "edit";
    this._detailMsg = "";
    this.renderDetail(state);
    const f = document.getElementById("cond-form-card");
    if (f && f.scrollIntoView) f.scrollIntoView({ block: "start" });
  },

  _detailSave(state) {
    if (this._busy) return;
    this._busy = true;
    try {
      if (!this._writable()) {
        this._detailMsg = "いまは変更を保存できません。";
        return this.renderDetail(state);
      }
      const d = this._detailDraft(state);
      if (!d) return this.renderDetail(state); // 編集元が変わって履歴に戻っていた
      const now = this._now();
      this._refreshAuto(d, now); // 日付・時刻は、保存の瞬間の now から作る
      const fields = { date: d.date, time: d.time, level: d.level, symptoms: d.symptoms, comment: d.comment };
      const r = d.mode === "edit" ? ConditionLogic.applyEdit(state, d.source.id, fields, d.source, now) : ConditionLogic.applyAdd(state, fields, now);
      if (!r.ok) {
        if (r.code === "STALE_SOURCE" || r.code === "NOT_FOUND") {
          this._edit = null;
          this._view = "history";
        }
        this._detailMsg = r.message;
        return this.renderDetail(state);
      }
      if (!Storage.save(state)) {
        ConditionLogic.revert(state, r.snapshot);
        this._detailMsg = "保存できませんでした。何も変更していません。";
        return this.renderDetail(state);
      }
      // 古い日付の記録を足したときも、履歴に出るよう表示する日数を広げる
      const idx = ConditionLogic.historyGroups(state, 1).indexOfDate(r.entry.date);
      if (idx >= this._historyDates) this._historyDates = idx + 1;
      this._detailMsg = d.mode === "edit" ? `${this._md(r.entry.date)} の記録を更新しました。` : `${this._md(r.entry.date)} に記録を追加しました。`;
      if (d.mode === "edit") this._edit = null;
      else this._new = null;
      this._view = "history";
      this.renderDetail(state);
    } finally {
      this._busy = false;
    }
  },

  _confirmDelete(state, id) {
    const e = ConditionLogic.findById(state, id);
    if (!e) return;
    const source = ConditionLogic.sourceOf(e);
    UI.showModal(`
      <p class="modal-title">この体調の記録を削除します</p>
      <p class="modal-body">${escapeHtml(e.date)}${e.time ? ` ${escapeHtml(e.time)}` : ""}「${escapeHtml(ConditionLogic.levelLabel(e.level))}」の記録を削除します。<br />この記録だけが消えます。体重・Protein・注射・体組成などは消えません。</p>
      <div class="modal-actions">
        <button class="btn-secondary" id="cond-del-cancel">キャンセル</button>
        <button class="btn-primary" id="cond-del-ok">削除する</button>
      </div>`);
    document.getElementById("cond-del-cancel").addEventListener("click", () => UI.hideModal());
    document.getElementById("cond-del-ok").addEventListener("click", () => {
      UI.hideModal();
      if (!this._writable()) {
        this._detailMsg = "いまは変更を保存できません。";
        return this.renderDetail(state);
      }
      const r = ConditionLogic.applyDelete(state, id, source);
      if (!r.ok) {
        this._detailMsg = r.message;
        return this.renderDetail(state);
      }
      if (!Storage.save(state)) {
        ConditionLogic.revert(state, r.snapshot);
        this._detailMsg = "保存できませんでした。何も変更していません。";
        return this.renderDetail(state);
      }
      this._detailMsg = `${this._md(e.date)} の記録を削除しました。`;
      this.renderDetail(state);
    });
  },

  // ============ 日付をまたいだとき ============
  // 復帰（visibility/pageshow/focus）と1分ごとに今日を確かめ、変わっていたらHOMEの「今日」を更新する。
  // 入力中（HOMEの入力欄にフォーカスがある）は描き直さず、次の確認で更新する。保存の直前にも日付を確かめるので、昨日の下書きが今日の記録になることはない。

  watchDate() {
    this._lastDate = this._today();
    const check = () => this.checkDateChange();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") check();
    });
    window.addEventListener("pageshow", check);
    window.addEventListener("focus", check);
    setInterval(check, 60000);
  },

  checkDateChange() {
    const today = this._today();
    if (today === this._lastDate) return false;
    const home = document.querySelector('[data-screen="home"]');
    const homeVisible = !!home && !home.hidden;
    if (homeVisible) {
      const a = document.activeElement;
      if (a && home.contains(a) && /^(INPUT|TEXTAREA)$/.test(a.tagName)) return false; // 入力中。次の確認で更新する
      this._lastDate = today;
      this._home = null;
      this._homeMsg = "";
      UI.renderHome();
    } else {
      this._lastDate = today;
      this._home = null; // 他の画面は、次に開いたときに描かれる
      this._homeMsg = "";
    }
    return true;
  },
};
