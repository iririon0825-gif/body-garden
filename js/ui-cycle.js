// Body Garden — 記録タブの「月経」カード（開始・終了・履歴・編集・削除）
// ロジックは cycle-logic.js（純粋関数）。ここは画面と操作の流れだけを担当する。
//
// 目的は「月経周期を予測すること」ではなく「体重変動を月経周期の文脈と一緒に見ること」。
// 症状・経血量の専用入力は持たない（体調タブと役割を分ける）。通常表示はシンプルに保つ：
// 「月経が始まった」「月経が終わった」は、その場で今日の日付を記録する一操作のボタン。
// 日付を直したいときは、履歴から編集する（開始日・終了日とも過去日に修正できる）。
//
// 保存は検証してから1回だけ。失敗したら配列を元に戻し、何も変更しない。

const CycleUI = {
  _view: "status", // "status" | "history" | "edit"
  _edit: null,
  _msg: "",
  _busy: false,

  _now() {
    return new Date();
  },
  _md(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
    return m ? `${m[1]}/${m[2]}/${m[3]}` : String(iso);
  },
  _writable() {
    return !Storage.readOnly;
  },

  render(state) {
    const el = document.getElementById("cycle-root");
    if (!el) return;
    try {
      el.innerHTML = this._html(state);
      this._bind(state);
    } catch (e) {
      console.error("[BodyGarden] 月経の記録を表示できません", e);
      el.innerHTML = `<section class="card"><p class="card-title">${UI.lineIcon("records")}月経</p><p class="form-error">月経の記録を表示できませんでした。設定画面からバックアップを書き出してから、データの内容を確認してください。</p></section>`;
    }
  },

  _html(state) {
    const msg = this._msg ? `<p class="cycle-msg" role="status">${escapeHtml(this._msg)}</p>` : "";
    if (this._view === "history") return this._statusCardHtml(state) + msg + this._historyHtml(state);
    if (this._view === "edit") return this._statusCardHtml(state) + msg + this._editHtml(state);
    return this._statusCardHtml(state) + msg;
  },

  _statusCardHtml(state) {
    const open = CycleLogic.openEntry(state);
    const writable = this._writable();
    return `
      <section class="card cycle-card">
        <p class="card-title">${UI.lineIcon("records")}月経</p>
        ${
          open
            ? `<p class="cycle-state">現在：<strong>月経中</strong></p>
               <p class="cycle-sub">開始：${escapeHtml(this._md(open.startDate))}</p>
               <div class="cycle-actions">
                 <button type="button" class="btn-primary" id="cycle-end-btn" ${writable ? "" : "disabled"}>月経が終わった</button>
               </div>`
            : `<p class="cycle-state">現在：月経外</p>
               <div class="cycle-actions">
                 <button type="button" class="btn-primary" id="cycle-start-btn" ${writable ? "" : "disabled"}>月経が始まった</button>
               </div>`
        }
        ${!writable ? `<p class="cycle-note">いまは変更を保存できません（画面上部の案内を確認してください）。</p>` : ""}
        <div class="cycle-actions">
          <button type="button" class="btn-text" id="cycle-history-btn">${this._view === "history" ? "閉じる" : "履歴を見る"}</button>
        </div>
      </section>`;
  },

  _historyHtml(state) {
    const rows = CycleLogic.sorted(state).slice().reverse();
    const list = rows
      .map((e) => {
        const days = e.endDate ? CycleLogic._diffDays(e.startDate, e.endDate) + 1 : null;
        return `<li class="cycle-row">
          <div class="cycle-row-main">
            <span class="cycle-row-range">${escapeHtml(this._md(e.startDate))} 〜 ${e.endDate ? escapeHtml(this._md(e.endDate)) : "（月経中）"}</span>
            ${days != null ? `<span class="cycle-chip">${days}日間</span>` : ""}
          </div>
          ${e.comment ? `<p class="cycle-row-memo">${escapeHtml(e.comment)}</p>` : ""}
          <div class="cycle-row-actions">
            <button type="button" class="btn-text" data-cycle-edit="${escapeHtml(e.id)}">編集</button>
            <button type="button" class="btn-text" data-cycle-del="${escapeHtml(e.id)}">削除</button>
          </div>
        </li>`;
      })
      .join("");
    return `
      <section class="card cycle-card">
        <p class="card-title">${UI.lineIcon("records")}月経の履歴</p>
        ${rows.length === 0 ? `<div class="placeholder-box">まだ月経の記録がありません</div>` : `<ul class="cycle-list">${list}</ul>`}
      </section>`;
  },

  _editHtml(state) {
    const d = this._edit;
    if (!d) return "";
    const today = CycleLogic._ymd(this._now());
    return `
      <section class="card cycle-card" id="cycle-edit-card">
        <p class="card-title">${UI.lineIcon("records")}月経の記録を編集</p>
        <div class="form-grid">
          <label class="form-field"><span>開始日</span><input type="date" id="cycle-edit-start" value="${escapeHtml(d.startDate)}" max="${today}" /></label>
          <label class="form-field"><span>終了日</span><input type="date" id="cycle-edit-end" value="${escapeHtml(d.endDate || "")}" max="${today}" ${d.endDate == null ? "disabled" : ""} /></label>
        </div>
        ${d.endDate == null ? `<p class="cycle-note">この記録は、まだ終了していません。終了日は「月経が終わった」から記録してください。</p>` : ""}
        <label class="form-field cycle-memo-field"><span>メモ（任意）</span><textarea id="cycle-edit-comment" class="cycle-textarea" maxlength="${CycleLogic.COMMENT_MAX}" rows="2">${escapeHtml(d.comment)}</textarea></label>
        <div class="cycle-actions">
          <button type="button" class="btn-primary" id="cycle-edit-save">更新する</button>
          <button type="button" class="btn-text" id="cycle-edit-cancel">やめる</button>
        </div>
      </section>`;
  },

  _bind(state) {
    const on = (id, ev, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener(ev, fn);
    };
    on("cycle-start-btn", "click", () => this._start(state));
    on("cycle-end-btn", "click", () => this._end(state));
    on("cycle-history-btn", "click", () => {
      this._view = this._view === "history" ? "status" : "history";
      this._msg = "";
      this.render(state);
    });
    document.querySelectorAll("[data-cycle-edit]").forEach((b) => b.addEventListener("click", () => this._startEdit(state, Number(b.dataset.cycleEdit))));
    document.querySelectorAll("[data-cycle-del]").forEach((b) => b.addEventListener("click", () => this._confirmDelete(state, Number(b.dataset.cycleDel))));
    if (this._view === "edit") {
      on("cycle-edit-start", "change", (e) => {
        this._edit.startDate = e.target.value;
      });
      on("cycle-edit-end", "change", (e) => {
        this._edit.endDate = e.target.value;
      });
      on("cycle-edit-comment", "input", (e) => {
        this._edit.comment = e.target.value;
      });
      on("cycle-edit-save", "click", () => this._saveEdit(state));
      on("cycle-edit-cancel", "click", () => {
        this._edit = null;
        this._view = "history";
        this._msg = "";
        this.render(state);
      });
    }
  },

  _afterWrite(state) {
    // グラフは状態が変わるたびに帯も変わる。HOMEが別タブで生きている場合に備え、再描画できれば再描画する
    if (typeof UI !== "undefined" && UI.state === state && document.getElementById("chart-weight-home") && typeof Charts !== "undefined") {
      Charts.renderWeightChart("chart-weight-home", state, UI.graphRange);
    }
  },

  _start(state) {
    if (this._busy) return;
    this._busy = true;
    try {
      if (!this._writable()) {
        this._msg = "いまは変更を保存できません。";
        return this.render(state);
      }
      const now = this._now();
      const r = CycleLogic.applyStart(state, { date: CycleLogic._ymd(now), comment: "" }, now);
      if (!r.ok) {
        this._msg = r.message;
        return this.render(state);
      }
      if (!Storage.save(state)) {
        CycleLogic.revert(state, r.snapshot);
        this._msg = "保存できませんでした。何も変更していません。";
        return this.render(state);
      }
      this._msg = `${this._md(r.entry.startDate)} に月経の開始を記録しました。`;
      this._afterWrite(state);
      this.render(state);
    } finally {
      this._busy = false;
    }
  },

  _end(state) {
    if (this._busy) return;
    this._busy = true;
    try {
      if (!this._writable()) {
        this._msg = "いまは変更を保存できません。";
        return this.render(state);
      }
      const open = CycleLogic.openEntry(state);
      if (!open) {
        this._msg = "現在、月経中の記録がありません。";
        return this.render(state);
      }
      const now = this._now();
      const r = CycleLogic.applyEnd(state, open.id, { date: CycleLogic._ymd(now) }, now);
      if (!r.ok) {
        this._msg = r.message;
        return this.render(state);
      }
      if (!Storage.save(state)) {
        CycleLogic.revert(state, r.snapshot);
        this._msg = "保存できませんでした。何も変更していません。";
        return this.render(state);
      }
      this._msg = `${this._md(r.entry.endDate)} に月経の終了を記録しました。`;
      this._afterWrite(state);
      this.render(state);
    } finally {
      this._busy = false;
    }
  },

  _startEdit(state, id) {
    const e = CycleLogic.findById(state, id);
    if (!e) return;
    this._edit = { source: CycleLogic.sourceOf(e), startDate: e.startDate, endDate: e.endDate, comment: e.comment || "" };
    this._view = "edit";
    this._msg = "";
    this.render(state);
  },

  _saveEdit(state) {
    if (this._busy) return;
    this._busy = true;
    try {
      if (!this._writable()) {
        this._msg = "いまは変更を保存できません。";
        return this.render(state);
      }
      const d = this._edit;
      const now = this._now();
      const patch = { startDate: d.startDate, comment: d.comment };
      if (d.endDate != null) patch.endDate = d.endDate;
      const r = CycleLogic.applyEdit(state, d.source.id, patch, d.source, now);
      if (!r.ok) {
        if (r.code === "STALE_SOURCE" || r.code === "NOT_FOUND") {
          this._edit = null;
          this._view = "history";
        }
        this._msg = r.message;
        return this.render(state);
      }
      if (!Storage.save(state)) {
        CycleLogic.revert(state, r.snapshot);
        this._msg = "保存できませんでした。何も変更していません。";
        return this.render(state);
      }
      this._msg = "記録を更新しました。";
      this._edit = null;
      this._view = "history";
      this._afterWrite(state);
      this.render(state);
    } finally {
      this._busy = false;
    }
  },

  _confirmDelete(state, id) {
    const e = CycleLogic.findById(state, id);
    if (!e) return;
    const source = CycleLogic.sourceOf(e);
    UI.showModal(`
      <p class="modal-title">この月経の記録を削除します</p>
      <p class="modal-body">${escapeHtml(this._md(e.startDate))} 〜 ${e.endDate ? escapeHtml(this._md(e.endDate)) : "（月経中）"} の記録を削除します。<br />この記録だけが消えます。体重・体調・注射などは消えません。</p>
      <div class="modal-actions">
        <button class="btn-secondary" id="cycle-del-cancel">キャンセル</button>
        <button class="btn-primary" id="cycle-del-ok">削除する</button>
      </div>`);
    document.getElementById("cycle-del-cancel").addEventListener("click", () => UI.hideModal());
    document.getElementById("cycle-del-ok").addEventListener("click", () => {
      UI.hideModal();
      if (!this._writable()) {
        this._msg = "いまは変更を保存できません。";
        return this.render(state);
      }
      const r = CycleLogic.applyDelete(state, id, source);
      if (!r.ok) {
        this._msg = r.message;
        return this.render(state);
      }
      if (!Storage.save(state)) {
        CycleLogic.revert(state, r.snapshot);
        this._msg = "保存できませんでした。何も変更していません。";
        return this.render(state);
      }
      this._msg = "記録を削除しました。";
      this._afterWrite(state);
      this.render(state);
    });
  },
};
