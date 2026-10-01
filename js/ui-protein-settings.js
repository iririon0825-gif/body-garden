// Body Garden — 設定タブ内「Protein設定」（ホエイ商品／登録食品／1日の目標）
// 商品マスターの追加・編集・archiveはここでのみ行う。HOME/記録は「摂取する場所」であり
// マスター管理はしない。

const ProteinSettingsUI = {
  _productForm: null, // null=非表示, {}=新規, {...product}=編集中
  _foodForm: null,
  _showArchivedProducts: false,
  _showArchivedFoods: false,
  _error: null,

  render(state) {
    const el = document.getElementById("protein-settings-root");
    const activeProducts = state.proteinProducts.filter((p) => p.status === "active");
    const archivedProducts = state.proteinProducts.filter((p) => p.status === "archived");
    const activeFoods = state.registeredFoods.filter((f) => f.status === "active");
    const archivedFoods = state.registeredFoods.filter((f) => f.status === "archived");

    el.innerHTML = `
      <section class="card">
        <p class="card-title">${UI.lineIcon("protein")}Protein設定</p>

        <p class="subsection-title">ホエイ商品</p>
        <ul class="master-list">
          ${activeProducts.map((p) => this._productRowHtml(p, state)).join("") || `<li class="master-empty">未登録</li>`}
        </ul>
        ${
          archivedProducts.length > 0
            ? `<button class="btn-text" id="toggle-archived-products">${
                this._showArchivedProducts ? "アーカイブ済みを隠す" : `アーカイブ済みを表示（${archivedProducts.length}）`
              }</button>
              ${
                this._showArchivedProducts
                  ? `<ul class="master-list is-archived">${archivedProducts.map((p) => this._productRowHtml(p, state)).join("")}</ul>`
                  : ""
              }`
            : ""
        }
        ${this._productForm ? this._productFormHtml() : `<button class="btn-text" id="add-product-btn">＋ホエイ商品を追加</button>`}

        <p class="subsection-title">登録食品</p>
        <ul class="master-list">
          ${activeFoods.map((f) => this._foodRowHtml(f, state)).join("") || `<li class="master-empty">未登録</li>`}
        </ul>
        ${
          archivedFoods.length > 0
            ? `<button class="btn-text" id="toggle-archived-foods">${
                this._showArchivedFoods ? "アーカイブ済みを隠す" : `アーカイブ済みを表示（${archivedFoods.length}）`
              }</button>
              ${
                this._showArchivedFoods
                  ? `<ul class="master-list is-archived">${archivedFoods.map((f) => this._foodRowHtml(f, state)).join("")}</ul>`
                  : ""
              }`
            : ""
        }
        ${this._foodForm ? this._foodFormHtml() : `<button class="btn-text" id="add-food-btn">＋登録食品を追加</button>`}

        <p class="subsection-title">1日のProtein目標</p>
        <label class="form-field">
          <span>目標量 (g)</span>
          <input type="number" step="1" id="f-protein-target" value="${state.profile.proteinTarget}" />
        </label>

        ${this._error ? `<p class="form-error">${this._error}</p>` : ""}
      </section>
    `;

    this._bindEvents(state);
  },

  _productRowHtml(p, state) {
    const used = ProteinLogic.isProductUsed(state, p.id);
    return `
      <li class="master-row" data-product-id="${p.id}">
        <span class="master-row-main">
          ${escapeHtml(p.name)}${p.isDefault ? ' <span class="default-tag">既定</span>' : ""}
          <span class="master-row-sub">${p.servingScoops}杯 = ${p.proteinPerServing}g</span>
        </span>
        <span class="master-row-actions">
          ${
            p.status === "active"
              ? `${!p.isDefault ? `<button class="btn-text" data-product-default="${p.id}">既定にする</button>` : ""}
                 <button class="btn-text" data-product-edit="${p.id}">編集</button>
                 <button class="btn-text" data-product-archive="${p.id}">アーカイブ</button>`
              : `<button class="btn-text" data-product-restore="${p.id}">復元</button>
                 ${!used ? `<button class="btn-text" data-product-delete="${p.id}">完全削除</button>` : ""}`
          }
        </span>
      </li>`;
  },

  _foodRowHtml(f, state) {
    const used = ProteinLogic.isFoodUsed(state, f.id);
    return `
      <li class="master-row" data-food-id="${f.id}">
        <span class="master-row-main">
          ${escapeHtml(f.name)}
          <span class="master-row-sub">${escapeHtml(f.unit)}あたり${f.proteinPerUnit}g</span>
        </span>
        <span class="master-row-actions">
          ${
            f.status === "active"
              ? `<button class="btn-text" data-food-edit="${f.id}">編集</button>
                 <button class="btn-text" data-food-archive="${f.id}">アーカイブ</button>`
              : `<button class="btn-text" data-food-restore="${f.id}">復元</button>
                 ${!used ? `<button class="btn-text" data-food-delete="${f.id}">完全削除</button>` : ""}`
          }
        </span>
      </li>`;
  },

  _productFormHtml() {
    const p = this._productForm;
    return `
      <div class="form-grid inline-form">
        <label class="form-field">
          <span>商品名</span>
          <input type="text" id="pf-name" value="${escapeHtml(p.name || "")}" placeholder="例: ホエイプロテイン" />
        </label>
        <label class="form-field">
          <span>規定スプーン数</span>
          <input type="number" step="0.1" id="pf-servingScoops" value="${p.servingScoops ?? ""}" />
        </label>
        <label class="form-field">
          <span>規定量あたりProtein (g)</span>
          <input type="number" step="0.1" id="pf-proteinPerServing" value="${p.proteinPerServing ?? ""}" />
        </label>
      </div>
      <div class="modal-actions">
        <button class="btn-text" id="pf-cancel">キャンセル</button>
        <button class="btn-primary" id="pf-save">保存</button>
      </div>`;
  },

  _foodFormHtml() {
    const f = this._foodForm;
    return `
      <div class="form-grid inline-form">
        <label class="form-field">
          <span>食品名</span>
          <input type="text" id="ff-name" value="${escapeHtml(f.name || "")}" placeholder="例: オイコス（プレーン）" />
        </label>
        <label class="form-field">
          <span>単位</span>
          <input type="text" id="ff-unit" value="${escapeHtml(f.unit || "")}" placeholder="例: 個" />
        </label>
        <label class="form-field">
          <span>1単位あたりProtein (g)</span>
          <input type="number" step="0.1" id="ff-proteinPerUnit" value="${f.proteinPerUnit ?? ""}" />
        </label>
      </div>
      <div class="modal-actions">
        <button class="btn-text" id="ff-cancel">キャンセル</button>
        <button class="btn-primary" id="ff-save">保存</button>
      </div>`;
  },

  _bindEvents(state) {
    const el = document.getElementById("protein-settings-root");

    const addProductBtn = document.getElementById("add-product-btn");
    if (addProductBtn) addProductBtn.addEventListener("click", () => { this._productForm = {}; this.render(state); });

    const addFoodBtn = document.getElementById("add-food-btn");
    if (addFoodBtn) addFoodBtn.addEventListener("click", () => { this._foodForm = {}; this.render(state); });

    const toggleArchivedProducts = document.getElementById("toggle-archived-products");
    if (toggleArchivedProducts) toggleArchivedProducts.addEventListener("click", () => { this._showArchivedProducts = !this._showArchivedProducts; this.render(state); });

    const toggleArchivedFoods = document.getElementById("toggle-archived-foods");
    if (toggleArchivedFoods) toggleArchivedFoods.addEventListener("click", () => { this._showArchivedFoods = !this._showArchivedFoods; this.render(state); });

    el.querySelectorAll("[data-product-default]").forEach((btn) =>
      btn.addEventListener("click", () => { Storage.setDefaultProteinProduct(state, btn.dataset.productDefault); this.render(state); })
    );
    el.querySelectorAll("[data-product-edit]").forEach((btn) =>
      btn.addEventListener("click", () => {
        this._productForm = { ...findById(state.proteinProducts, btn.dataset.productEdit) };
        this.render(state);
      })
    );
    el.querySelectorAll("[data-product-archive]").forEach((btn) =>
      btn.addEventListener("click", () => { Storage.archiveProteinProduct(state, btn.dataset.productArchive); UI.renderHome(); this.render(state); })
    );
    el.querySelectorAll("[data-product-restore]").forEach((btn) =>
      btn.addEventListener("click", () => { Storage.restoreProteinProduct(state, btn.dataset.productRestore); this.render(state); })
    );
    el.querySelectorAll("[data-product-delete]").forEach((btn) =>
      btn.addEventListener("click", () => { Storage.deleteProteinProduct(state, btn.dataset.productDelete); this.render(state); })
    );

    el.querySelectorAll("[data-food-edit]").forEach((btn) =>
      btn.addEventListener("click", () => {
        this._foodForm = { ...findById(state.registeredFoods, btn.dataset.foodEdit) };
        this.render(state);
      })
    );
    el.querySelectorAll("[data-food-archive]").forEach((btn) =>
      btn.addEventListener("click", () => { Storage.archiveRegisteredFood(state, btn.dataset.foodArchive); UI.renderHome(); this.render(state); })
    );
    el.querySelectorAll("[data-food-restore]").forEach((btn) =>
      btn.addEventListener("click", () => { Storage.restoreRegisteredFood(state, btn.dataset.foodRestore); this.render(state); })
    );
    el.querySelectorAll("[data-food-delete]").forEach((btn) =>
      btn.addEventListener("click", () => { Storage.deleteRegisteredFood(state, btn.dataset.foodDelete); this.render(state); })
    );

    const pfCancel = document.getElementById("pf-cancel");
    if (pfCancel) pfCancel.addEventListener("click", () => { this._productForm = null; this._error = null; this.render(state); });
    const pfSave = document.getElementById("pf-save");
    if (pfSave) pfSave.addEventListener("click", () => this._saveProduct(state));

    const ffCancel = document.getElementById("ff-cancel");
    if (ffCancel) ffCancel.addEventListener("click", () => { this._foodForm = null; this._error = null; this.render(state); });
    const ffSave = document.getElementById("ff-save");
    if (ffSave) ffSave.addEventListener("click", () => this._saveFood(state));

    const targetInput = document.getElementById("f-protein-target");
    if (targetInput) {
      targetInput.addEventListener("change", () => {
        const value = parseFloat(targetInput.value);
        if (!validateRange(value, VALIDATION_RANGES.proteinTarget)) {
          this._error = `タンパク質目標は${VALIDATION_RANGES.proteinTarget.min}〜${VALIDATION_RANGES.proteinTarget.max}gの範囲で入力してください。`;
          this.render(state);
          return;
        }
        state.profile.proteinTarget = value;
        Storage.save(state);
        this._error = null;
        UI.renderHome();
        this.render(state);
      });
    }
  },

  _saveProduct(state) {
    const name = document.getElementById("pf-name").value.trim();
    const servingScoops = parseFloat(document.getElementById("pf-servingScoops").value);
    const proteinPerServing = parseFloat(document.getElementById("pf-proteinPerServing").value);

    if (!name) return this._fail(state, "商品名を入力してください。");
    if (!validateRange(servingScoops, VALIDATION_RANGES.productServingScoops)) {
      return this._fail(state, `規定スプーン数は${VALIDATION_RANGES.productServingScoops.min}〜${VALIDATION_RANGES.productServingScoops.max}の範囲で入力してください。`);
    }
    if (!validateRange(proteinPerServing, VALIDATION_RANGES.productProteinPerServing)) {
      return this._fail(state, `規定量あたりProteinは${VALIDATION_RANGES.productProteinPerServing.min}〜${VALIDATION_RANGES.productProteinPerServing.max}gの範囲で入力してください。`);
    }

    const product = {
      id: this._productForm.id ?? null,
      name,
      servingScoops,
      proteinPerServing,
      status: this._productForm.status || "active",
      isDefault: this._productForm.isDefault || false,
    };
    Storage.upsertProteinProduct(state, product);
    this._productForm = null;
    this._error = null;
    this.render(state);
  },

  _saveFood(state) {
    const name = document.getElementById("ff-name").value.trim();
    const unit = document.getElementById("ff-unit").value.trim();
    const proteinPerUnit = parseFloat(document.getElementById("ff-proteinPerUnit").value);

    if (!name) return this._fail(state, "食品名を入力してください。");
    if (!unit) return this._fail(state, "単位を入力してください。");
    if (!validateRange(proteinPerUnit, VALIDATION_RANGES.foodProteinPerUnit)) {
      return this._fail(state, `1単位あたりProteinは${VALIDATION_RANGES.foodProteinPerUnit.min}〜${VALIDATION_RANGES.foodProteinPerUnit.max}gの範囲で入力してください。`);
    }

    const food = {
      id: this._foodForm.id ?? null,
      name,
      unit,
      proteinPerUnit,
      status: this._foodForm.status || "active",
    };
    Storage.upsertRegisteredFood(state, food);
    this._foodForm = null;
    this._error = null;
    this.render(state);
  },

  _fail(state, message) {
    this._error = message;
    this.render(state);
  },
};
