// Body Garden — HOME「TODAY'S PROTEIN」カードの操作
// HOMEの主役は「今日の合計とプログレス」。商品管理フォームや長い履歴一覧は常設せず、
// 必要な操作だけをモーダルで開く軽量なUIにする。

const ProteinHomeUI = {
  // ---- ワンタップ登録の「誤連打」対策と「取り消す」 ----
  // ・登録した直後だけ、「押したボタン」を短時間（QUICK_LOCK_MS）無効にする。ほかのボタン（ホエイのあとにオイコス、など）は
  //   そのまま押せる。恒久的な重複禁止ではない（時間をあければ、同じものを同日に何度でも登録できる）。
  // ・登録直後に、確認の表示（トースト）を出し、「取り消す」で「その直前に追加した1件」だけを削除する。
  //   確認ダイアログは出さない（ワンタップ性を保つ）。
  QUICK_LOCK_MS: 1200,
  UNDO_VISIBLE_MS: 6000,
  _locks: {}, // ボタンごとの無効化の期限（"whey" / "food:<id>" → 時刻）
  _lockTimers: {},
  _toastTimer: null,
  _lastQuick: null, // { id, label, grams }。取り消せるのは、直前の1件だけ

  _now() {
    return Date.now();
  },
  _isLocked(key) {
    return this._now() < (this._locks[key] || 0);
  },

  // 食品サムネイル（仮配置）。未配置/読込失敗時は絵文字にフォールバックする
  _foodThumb(assetKey, fallbackEmoji) {
    const src = IMAGE_ASSETS[assetKey];
    const fallback = fallbackEmoji ? `this.outerHTML='${fallbackEmoji}'` : "this.remove()";
    return `<img class="protein-food-thumb" src="${src}" alt="" onerror="${fallback}" />`;
  },

  cardInnerHtml(state) {
    const total = Calc.proteinTotalForDate(todayISODate(), state.proteinEntries);
    const target = state.profile.proteinTarget;
    const pct = target > 0 ? Math.min(100, (total / target) * 100) : 0;
    const foods = ProteinLogic.activeFoods(state);
    const lockAttrFor = (key) => (this._isLocked(key) ? " disabled" : "");

    // 既定のホエイ商品があれば、その「いつもの量」で1タップ登録するボタン。商品が未登録のときは、従来どおり案内を開く
    const def = ProteinLogic.defaultProduct(state);
    let wheyChip;
    if (def) {
      const scoops = ProteinLogic.quickScoopsOf(def);
      const grams = Calc.round1((scoops / def.servingScoops) * def.proteinPerServing);
      wheyChip = `<button class="chip-btn chip-quick" data-protein-action="whey-quick"${lockAttrFor("whey")}>${this._foodThumb("foodWhey", "🥛")} <span class="chip-name">いつものプロテイン<span class="chip-sub">${scoops}スプーン・${fmt(grams, 1)}g</span></span> <span class="chip-plus">＋1杯</span></button>`;
    } else {
      wheyChip = `<button class="chip-btn" data-protein-action="whey">${this._foodThumb("foodWhey", "🥛")} <span class="chip-name">ホエイ</span> <span class="chip-plus">＋</span></button>`;
    }

    return `
      <p class="card-title">${UI.lineIcon("protein")}<span class="t-en">TODAY'S PROTEIN</span><span class="t-jp">今日のたんぱく質</span></p>
      <p class="protein-value">${fmt(total, 1)} / ${target} g</p>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="protein-chip-row">
        ${wheyChip}
        ${foods
          .map(
            (f) =>
              `<button class="chip-btn" data-protein-action="food-quick" data-food-id="${f.id}"${lockAttrFor("food:" + f.id)}>${
                f.id === "food-oikos" ? this._foodThumb("foodOikos", "") + " " : ""
              }<span class="chip-name">${escapeHtml(f.name)}</span> <span class="chip-plus">＋1</span></button>`
          )
          .join("")}
      </div>
      <div class="protein-link-row">
        <button class="btn-text protein-link-whey" data-protein-action="whey">スプーン数を指定して追加</button>
        <button class="btn-text protein-link-custom" data-protein-action="food-custom">数量を指定して追加</button>
        <button class="btn-text protein-link-meal" data-protein-action="add-meal">${this._foodThumb("foodMeal", "")}<span class="chip-name">食事を追加</span></button>
        <button class="btn-text protein-link-today" data-protein-action="view-today">今日の記録を見る</button>
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
    else if (action === "whey-quick") this._quickAddWhey(state);
    else if (action === "food-quick") this._quickAddFood(state, btn.dataset.foodId);
    else if (action === "food-custom") this._openFoodModal(state);
    else if (action === "add-meal") this._openMealModal(state);
    else if (action === "view-today") this._openTodayListModal(state);
  },

  // ホエイ: 既定商品を「いつもの量」で1タップ登録（既存の createWheyEntry → upsertProteinEntry の経路）
  _quickAddWhey(state) {
    if (this._isLocked("whey")) return; // 登録直後の誤連打
    const entry = ProteinLogic.createQuickWheyEntry(state, todayISODate());
    if (!entry) {
      this._openWheyModal(state); // 商品が未登録なら、案内を出す
      return;
    }
    this._commitQuick(state, "whey", entry, "いつものプロテイン");
  },

  // 登録食品: 1単位を1タップ登録（従来どおり）
  _quickAddFood(state, foodId) {
    const key = "food:" + foodId;
    if (this._isLocked(key)) return; // 登録直後の誤連打
    const entry = ProteinLogic.createFoodEntry(state, todayISODate(), foodId, 1);
    if (!entry) return;
    this._commitQuick(state, key, entry, entry.sourceName);
  },

  // 保存（既存の upsertProteinEntry → Storage.save。Google Sheets 自動バックアップも、この保存を起点に動く）
  // → 押したボタンの短時間の無効化 → 再描画 → 確認の表示（取り消し付き）
  _commitQuick(state, key, entry, label) {
    Storage.upsertProteinEntry(state, entry);
    // id は「最大値＋1」で採番され、削除された id は、あとの記録に再利用される。取り消しで別の記録を消さないよう、
    // id に加えて、作成時刻（createdAt）も控えて、両方が一致する記録だけを対象にする
    this._lastQuick = { id: entry.id, createdAt: entry.createdAt, label, grams: entry.proteinTotal };
    this._locks[key] = this._now() + this.QUICK_LOCK_MS;
    if (this._lockTimers[key] !== undefined) clearTimeout(this._lockTimers[key]);
    this._lockTimers[key] = setTimeout(() => this._unlock(key), this.QUICK_LOCK_MS);
    UI.renderHome(); // 無効化した状態のボタンで描画される（_isLocked）
    this._showUndoToast(state);
  },

  // 期限が来たボタンだけ、画面を作り直さずに有効へ戻す
  _unlock(key) {
    delete this._locks[key];
    delete this._lockTimers[key];
    document.querySelectorAll('[data-protein-action="whey-quick"], [data-protein-action="food-quick"]').forEach((b) => {
      const k = b.dataset.proteinAction === "whey-quick" ? "whey" : "food:" + b.dataset.foodId;
      if (k === key) b.disabled = false;
    });
  },

  _toastEl() {
    let el = document.getElementById("protein-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "protein-toast";
      el.className = "protein-toast";
      el.setAttribute("role", "status");
      document.body.appendChild(el);
    }
    return el;
  },

  _showUndoToast(state) {
    const last = this._lastQuick;
    if (!last) return;
    const el = this._toastEl();
    el.innerHTML = `<span class="protein-toast-msg">✓ ${escapeHtml(last.label)} ${fmt(last.grams, 1)}gを追加しました</span><button class="protein-toast-undo" data-protein-undo>取り消す</button>`;
    el.hidden = false;
    el.querySelector("[data-protein-undo]").addEventListener("click", () => this._undoLast(state));
    if (this._toastTimer !== null) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this._hideToast(), this.UNDO_VISIBLE_MS);
  },

  _hideToast() {
    if (this._toastTimer !== null) {
      clearTimeout(this._toastTimer);
      this._toastTimer = null;
    }
    const el = document.getElementById("protein-toast");
    if (el) el.hidden = true;
    this._lastQuick = null; // 表示が消えたら、取り消しもできない（記録の削除は「今日の記録を見る」から）
  },

  // 直前に1タップ登録した1件だけを削除する（他の記録には触れない）
  _undoLast(state) {
    const last = this._lastQuick;
    this._hideToast();
    if (!last) return;
    if (!state.proteinEntries.some((e) => e.id === last.id && e.createdAt === last.createdAt)) return;
    Storage.deleteProteinEntry(state, last.id);
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
      const range = ProteinLogic.wheyEditRange(); // 規定量が10を超える商品の記録も、編集できる範囲
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
