// Body Garden — HOME「TODAY'S PROTEIN」カードの操作
// HOMEの主役は「今日の合計とプログレス」。商品管理フォームや長い履歴一覧は常設せず、
// 必要な操作だけをモーダルで開く軽量なUIにする。

const ProteinHomeUI = {
  cardInnerHtml(state) {
    const total = Calc.proteinTotalForDate(todayISODate(), state.proteinEntries);
    const target = state.profile.proteinTarget;
    const pct = target > 0 ? Math.min(100, (total / target) * 100) : 0;
    const foods = ProteinLogic.activeFoods(state);

    return `
      <p class="card-title">${UI.titleIcon("iconProtein", "🥤")}TODAY'S PROTEIN</p>
      <p class="protein-value">${fmt(total, 1)} / ${target} g</p>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="protein-chip-row">
        <button class="chip-btn" data-protein-action="whey">🥛 ホエイ ＋</button>
        ${foods
          .map(
            (f) =>
              `<button class="chip-btn" data-protein-action="food-quick" data-food-id="${f.id}">${escapeHtml(f.name)} ＋1</button>`
          )
          .join("")}
      </div>
      <div class="protein-link-row">
        <button class="btn-text" data-protein-action="food-custom">数量を指定して追加</button>
        <button class="btn-text" data-protein-action="add-meal">食事を追加</button>
        <button class="btn-text" data-protein-action="view-today">今日の記録を見る</button>
      </div>
    `;
  },

  bindCard(state) {
    const card = document.querySelector(".protein-card");
    if (!card) return;
    card.querySelectorAll("[data-protein-action]").forEach((btn) => {
      btn.addEventListener("click", () => this._handleAction(state, btn));
    });
  },

  _handleAction(state, btn) {
    const action = btn.dataset.proteinAction;
    if (action === "whey") this._openWheyModal(state);
    else if (action === "food-quick") this._quickAddFood(state, btn.dataset.foodId);
    else if (action === "food-custom") this._openFoodModal(state);
    else if (action === "add-meal") this._openMealModal(state);
    else if (action === "view-today") this._openTodayListModal(state);
  },

  _quickAddFood(state, foodId) {
    const entry = ProteinLogic.createFoodEntry(state, todayISODate(), foodId, 1);
    if (!entry) return;
    Storage.upsertProteinEntry(state, entry);
    UI.renderHome();
  },

  _noProductModalHtml() {
    return `
      <p class="modal-title">ホエイ商品が未登録です</p>
      <p class="modal-body">ホエイを記録する前に、設定画面でホエイ商品を登録してください。</p>
      <div class="modal-actions">
        <button class="btn-secondary" data-modal-action="close-generic">閉じる</button>
        <button class="btn-primary" data-modal-action="goto-protein-settings">商品を登録する</button>
      </div>`;
  },

  _noFoodModalHtml() {
    return `
      <p class="modal-title">登録食品がありません</p>
      <p class="modal-body">設定画面で登録食品を追加してください。</p>
      <div class="modal-actions">
        <button class="btn-secondary" data-modal-action="close-generic">閉じる</button>
        <button class="btn-primary" data-modal-action="goto-protein-settings">登録する</button>
      </div>`;
  },

  _openWheyModal(state) {
    const active = ProteinLogic.activeProducts(state);
    if (active.length === 0) {
      UI.showModal(this._noProductModalHtml());
      return;
    }
    const def = ProteinLogic.defaultProduct(state);
    const needsSelect = active.length > 1;
    UI.showModal(`
      <p class="modal-title">🥛 ホエイを記録</p>
      ${
        needsSelect
          ? `<label class="form-field">
              <span>商品</span>
              <select id="whey-product-select">
                ${active
                  .map((p) => `<option value="${p.id}" ${p.id === def.id ? "selected" : ""}>${escapeHtml(p.name)}</option>`)
                  .join("")}
              </select>
            </label>`
          : `<p class="modal-body">${escapeHtml(def.name)}</p>`
      }
      <label class="form-field">
        <span>スプーン数</span>
        <input type="number" id="whey-scoops-input" step="0.1" placeholder="例: 3" />
      </label>
      <p class="form-error" id="whey-modal-error" hidden></p>
      <div class="modal-actions">
        <button class="btn-secondary" data-modal-action="close-generic">キャンセル</button>
        <button class="btn-primary" id="whey-confirm-btn">追加</button>
      </div>`);

    document.getElementById("whey-confirm-btn").addEventListener("click", () => {
      const productId = needsSelect ? document.getElementById("whey-product-select").value : def.id;
      const scoops = parseFloat(document.getElementById("whey-scoops-input").value);
      const range = VALIDATION_RANGES.wheyScoops;
      const err = document.getElementById("whey-modal-error");
      if (Number.isNaN(scoops) || scoops < range.min || scoops > range.max) {
        err.textContent = `スプーン数は${range.min}〜${range.max}の範囲で入力してください。`;
        err.hidden = false;
        return;
      }
      const entry = ProteinLogic.createWheyEntry(state, todayISODate(), productId, scoops);
      Storage.upsertProteinEntry(state, entry);
      UI.hideModal();
      UI.renderHome();
    });
  },

  _openFoodModal(state) {
    const active = ProteinLogic.activeFoods(state);
    if (active.length === 0) {
      UI.showModal(this._noFoodModalHtml());
      return;
    }
    UI.showModal(`
      <p class="modal-title">登録食品を追加</p>
      <label class="form-field">
        <span>食品</span>
        <select id="food-select">
          ${active
            .map((f) => `<option value="${f.id}">${escapeHtml(f.name)}（${escapeHtml(f.unit)}あたり${f.proteinPerUnit}g）</option>`)
            .join("")}
        </select>
      </label>
      <label class="form-field">
        <span>数量</span>
        <input type="number" id="food-qty-input" step="0.25" value="1" />
      </label>
      <p class="form-error" id="food-modal-error" hidden></p>
      <div class="modal-actions">
        <button class="btn-secondary" data-modal-action="close-generic">キャンセル</button>
        <button class="btn-primary" id="food-confirm-btn">追加</button>
      </div>`);

    document.getElementById("food-confirm-btn").addEventListener("click", () => {
      const foodId = document.getElementById("food-select").value;
      const qty = parseFloat(document.getElementById("food-qty-input").value);
      const range = VALIDATION_RANGES.foodQty;
      const err = document.getElementById("food-modal-error");
      if (Number.isNaN(qty) || qty < range.min || qty > range.max) {
        err.textContent = `数量は${range.min}〜${range.max}の範囲で入力してください。`;
        err.hidden = false;
        return;
      }
      const entry = ProteinLogic.createFoodEntry(state, todayISODate(), foodId, qty);
      Storage.upsertProteinEntry(state, entry);
      UI.hideModal();
      UI.renderHome();
    });
  },

  _openMealModal(state) {
    UI.showModal(`
      <p class="modal-title">食事を追加</p>
      <label class="form-field">
        <span>食事／食品名</span>
        <input type="text" id="meal-name-input" placeholder="例: 鶏むね肉のサラダ" />
      </label>
      <label class="form-field">
        <span>Protein (g)</span>
        <input type="number" id="meal-protein-input" step="0.1" placeholder="例: 25" />
      </label>
      <label class="form-field">
        <span>メモ（任意）</span>
        <input type="text" id="meal-memo-input" />
      </label>
      <p class="form-error" id="meal-modal-error" hidden></p>
      <div class="modal-actions">
        <button class="btn-secondary" data-modal-action="close-generic">キャンセル</button>
        <button class="btn-primary" id="meal-confirm-btn">追加</button>
      </div>`);

    document.getElementById("meal-confirm-btn").addEventListener("click", () => {
      const name = document.getElementById("meal-name-input").value.trim();
      const proteinG = parseFloat(document.getElementById("meal-protein-input").value);
      const memo = document.getElementById("meal-memo-input").value.trim();
      const range = VALIDATION_RANGES.mealProteinG;
      const err = document.getElementById("meal-modal-error");
      if (!name) {
        err.textContent = "食事／食品名を入力してください。";
        err.hidden = false;
        return;
      }
      if (Number.isNaN(proteinG) || proteinG < range.min || proteinG > range.max) {
        err.textContent = `Proteinは${range.min}〜${range.max}gの範囲で入力してください。`;
        err.hidden = false;
        return;
      }
      const entry = ProteinLogic.createMealEntry(todayISODate(), name, proteinG, memo);
      Storage.upsertProteinEntry(state, entry);
      UI.hideModal();
      UI.renderHome();
    });
  },

  _openTodayListModal(state) {
    const entries = state.proteinEntries
      .filter((e) => e.date === todayISODate())
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    UI.showModal(this._todayListHtml(entries));
    this._bindTodayListButtons(state);
  },

  _todayListHtml(entries) {
    return `
      <p class="modal-title">今日の記録</p>
      ${
        entries.length === 0
          ? `<p class="modal-body">まだ記録がありません。</p>`
          : `<ul class="protein-entry-list">
              ${entries
                .map(
                  (e) => `
                <li class="protein-entry-row" data-entry-id="${e.id}">
                  <span class="protein-entry-name">${this._entryLabel(e)}</span>
                  <span class="protein-entry-amount">${fmt(e.proteinTotal, 1)}g</span>
                  <button class="btn-text" data-entry-edit="${e.id}">修正</button>
                  <button class="btn-text" data-entry-delete="${e.id}">削除</button>
                </li>`
                )
                .join("")}
            </ul>`
      }
      <div class="modal-actions">
        <button class="btn-secondary" data-modal-action="close-generic">閉じる</button>
      </div>`;
  },

  _entryLabel(e) {
    if (e.sourceType === "whey") return `🥛 ${escapeHtml(e.sourceName)}（${e.quantity}杯）`;
    if (e.sourceType === "food") return `${escapeHtml(e.sourceName)} ×${e.quantity}`;
    return `🍽 ${escapeHtml(e.sourceName)}`;
  },

  _bindTodayListButtons(state) {
    const root = document.getElementById("modal-root");
    root.querySelectorAll("[data-entry-edit]").forEach((btn) => {
      btn.addEventListener("click", () => this._openEditModal(state, parseInt(btn.dataset.entryEdit, 10)));
    });
    root.querySelectorAll("[data-entry-delete]").forEach((btn) => {
      btn.addEventListener("click", () => {
        Storage.deleteProteinEntry(state, parseInt(btn.dataset.entryDelete, 10));
        UI.renderHome();
        this._openTodayListModal(state);
      });
    });
  },

  _openEditModal(state, entryId) {
    const entry = state.proteinEntries.find((e) => e.id === entryId);
    if (!entry) return;
    if (entry.sourceType === "whey") this._openEditWheyModal(state, entry);
    else if (entry.sourceType === "food") this._openEditFoodModal(state, entry);
    else this._openEditMealModal(state, entry);
  },

  _openEditWheyModal(state, entry) {
    UI.showModal(`
      <p class="modal-title">ホエイの記録を修正</p>
      <p class="modal-body">${escapeHtml(entry.sourceName)}（記録時点の商品名）</p>
      <label class="form-field">
        <span>スプーン数</span>
        <input type="number" id="edit-scoops-input" step="0.1" value="${entry.quantity}" />
      </label>
      <p class="form-error" id="edit-modal-error" hidden></p>
      <div class="modal-actions">
        <button class="btn-secondary" data-modal-action="close-generic">キャンセル</button>
        <button class="btn-primary" id="edit-confirm-btn">保存</button>
      </div>`);
    document.getElementById("edit-confirm-btn").addEventListener("click", () => {
      const scoops = parseFloat(document.getElementById("edit-scoops-input").value);
      const range = VALIDATION_RANGES.wheyScoops;
      const err = document.getElementById("edit-modal-error");
      if (Number.isNaN(scoops) || scoops < range.min || scoops > range.max) {
        err.textContent = `スプーン数は${range.min}〜${range.max}の範囲で入力してください。`;
        err.hidden = false;
        return;
      }
      entry.quantity = scoops;
      entry.proteinTotal = ProteinLogic.recalcEntryTotal(entry);
      Storage.upsertProteinEntry(state, entry);
      UI.renderHome();
      this._openTodayListModal(state);
    });
  },

  _openEditFoodModal(state, entry) {
    UI.showModal(`
      <p class="modal-title">登録食品の記録を修正</p>
      <p class="modal-body">${escapeHtml(entry.sourceName)}（記録時点の食品名）</p>
      <label class="form-field">
        <span>数量</span>
        <input type="number" id="edit-qty-input" step="0.25" value="${entry.quantity}" />
      </label>
      <p class="form-error" id="edit-modal-error" hidden></p>
      <div class="modal-actions">
        <button class="btn-secondary" data-modal-action="close-generic">キャンセル</button>
        <button class="btn-primary" id="edit-confirm-btn">保存</button>
      </div>`);
    document.getElementById("edit-confirm-btn").addEventListener("click", () => {
      const qty = parseFloat(document.getElementById("edit-qty-input").value);
      const range = VALIDATION_RANGES.foodQty;
      const err = document.getElementById("edit-modal-error");
      if (Number.isNaN(qty) || qty < range.min || qty > range.max) {
        err.textContent = `数量は${range.min}〜${range.max}の範囲で入力してください。`;
        err.hidden = false;
        return;
      }
      entry.quantity = qty;
      entry.proteinTotal = ProteinLogic.recalcEntryTotal(entry);
      Storage.upsertProteinEntry(state, entry);
      UI.renderHome();
      this._openTodayListModal(state);
    });
  },

  _openEditMealModal(state, entry) {
    UI.showModal(`
      <p class="modal-title">食事の記録を修正</p>
      <label class="form-field">
        <span>食事／食品名</span>
        <input type="text" id="edit-meal-name" value="${escapeHtml(entry.sourceName || "")}" />
      </label>
      <label class="form-field">
        <span>Protein (g)</span>
        <input type="number" id="edit-meal-protein" step="0.1" value="${entry.proteinTotal}" />
      </label>
      <label class="form-field">
        <span>メモ（任意）</span>
        <input type="text" id="edit-meal-memo" value="${escapeHtml(entry.memo || "")}" />
      </label>
      <p class="form-error" id="edit-modal-error" hidden></p>
      <div class="modal-actions">
        <button class="btn-secondary" data-modal-action="close-generic">キャンセル</button>
        <button class="btn-primary" id="edit-confirm-btn">保存</button>
      </div>`);
    document.getElementById("edit-confirm-btn").addEventListener("click", () => {
      const name = document.getElementById("edit-meal-name").value.trim();
      const proteinG = parseFloat(document.getElementById("edit-meal-protein").value);
      const memo = document.getElementById("edit-meal-memo").value.trim();
      const range = VALIDATION_RANGES.mealProteinG;
      const err = document.getElementById("edit-modal-error");
      if (!name) {
        err.textContent = "食事／食品名を入力してください。";
        err.hidden = false;
        return;
      }
      if (Number.isNaN(proteinG) || proteinG < range.min || proteinG > range.max) {
        err.textContent = `Proteinは${range.min}〜${range.max}gの範囲で入力してください。`;
        err.hidden = false;
        return;
      }
      entry.sourceName = name;
      entry.memo = memo;
      entry.proteinTotal = Calc.round1(proteinG);
      Storage.upsertProteinEntry(state, entry);
      UI.renderHome();
      this._openTodayListModal(state);
    });
  },
};

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
