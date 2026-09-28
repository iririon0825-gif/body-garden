// Body Garden — 記録画面（体重入力・過去日付の新規/修正・履歴一覧）
// Phase2では体重のみ。体組成の詳細入力・画像読み取りはPhase5で追加する。

const RecordsUI = {
  _editingDate: null,
  _error: null,

  render(state) {
    const el = document.getElementById("records-root");
    const today = todayISODate();
    const editDate = this._editingDate || today;
    const existing = state.dailyRecords.find((r) => r.date === editDate);
    const weightValue = existing && existing.weight != null ? existing.weight : "";

    const history = [...state.dailyRecords]
      .filter((r) => r.weight != null)
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .slice(0, 30);

    el.innerHTML = `
      <section class="card">
        <p class="card-title">体重を記録</p>
        <form id="weight-form" class="form-grid">
          <label class="form-field">
            <span>日付</span>
            <input type="date" id="weight-date" value="${editDate}" max="${today}" />
          </label>
          <label class="form-field">
            <span>体重 (kg)</span>
            <input type="number" id="weight-value" step="0.01" value="${weightValue}" placeholder="例: 66.80" />
          </label>
        </form>
        ${this._error ? `<p class="form-error">${this._error}</p>` : ""}
        <div class="modal-actions">
          <button class="btn-primary" id="weight-save-btn">保存</button>
          ${this._editingDate ? `<button class="btn-text" id="weight-cancel-btn">新規入力に戻る</button>` : ""}
        </div>
      </section>

      <section class="card">
        <p class="card-title">記録一覧（直近30件）</p>
        ${
          history.length === 0
            ? `<div class="placeholder-box">まだ記録がありません</div>`
            : `<ul class="record-history-list">
                ${history
                  .map(
                    (r) => `
                  <li class="record-history-row" data-date="${r.date}">
                    <span class="record-history-date">${r.date}</span>
                    <span class="record-history-weight">${fmt2(r.weight)} kg</span>
                    <button class="btn-text" data-edit-date="${r.date}">修正</button>
                  </li>`
                  )
                  .join("")}
              </ul>`
        }
      </section>
    `;

    document.getElementById("weight-save-btn").addEventListener("click", (e) => {
      e.preventDefault();
      this._handleSave(state);
    });

    const cancelBtn = document.getElementById("weight-cancel-btn");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", () => {
        this._editingDate = null;
        this._error = null;
        this.render(state);
      });
    }

    el.querySelectorAll("[data-edit-date]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._editingDate = btn.dataset.editDate;
        this._error = null;
        this.render(state);
      });
    });
  },

  _handleSave(state) {
    const date = document.getElementById("weight-date").value;
    const weightRaw = document.getElementById("weight-value").value;
    const weight = weightRaw === "" ? null : parseFloat(weightRaw);

    if (!date) {
      this._error = "日付を入力してください。";
      this.render(state);
      return;
    }
    if (Calc.isFutureDate(date)) {
      this._error = "未来の日付には記録できません。";
      this.render(state);
      return;
    }
    if (weight == null || Number.isNaN(weight)) {
      this._error = "体重を入力してください。";
      this.render(state);
      return;
    }
    const { min, max } = VALIDATION_RANGES.weightKg;
    if (weight < min || weight > max) {
      this._error = `体重は${min}〜${max}kgの範囲で入力してください。`;
      this.render(state);
      return;
    }

    this._error = null;
    const record = Storage.getRecordForDate(state, date);
    record.weight = weight;
    Storage.upsertRecord(state, record);

    const modals = Logic.afterWeightSave(state, record);
    Storage.save(state);

    this._editingDate = null;
    this.render(state);

    if (modals.length > 0) {
      UI.enqueueGuardrailModals(modals, record);
    }
  },
};

function fmt2(value) {
  return value == null ? "—" : value.toFixed(2);
}
