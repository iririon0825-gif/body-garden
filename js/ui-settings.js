// Body Garden — 設定画面（初期プロフィール・Goal1/Goal2）
// 身長・開始日・開始体重の変更は過去表示の再計算につながるため、保存時に確認を挟む。

const SettingsUI = {
  _draft: null,
  _error: null,

  render(state) {
    this._draft = this._draft || this._buildDraft(state);
    this._error = null;
    this._renderForm(state);
  },

  _buildDraft(state) {
    return {
      profile: { ...state.profile },
      goal1: { ...state.goals.goal1 },
      goal2Enabled: !!state.goals.goal2,
      goal2: state.goals.goal2 ? { ...state.goals.goal2 } : { type: "weight", value: state.goals.goal1.value },
    };
  },

  _renderForm(state) {
    const el = document.getElementById("settings-root");
    const d = this._draft;

    el.innerHTML = `
      <section class="card">
        <p class="card-title">初期プロフィール</p>
        <div class="form-grid">
          <label class="form-field">
            <span>身長 (cm)</span>
            <input type="number" step="0.1" id="f-heightCm" value="${d.profile.heightCm}" />
          </label>
          <label class="form-field">
            <span>開始日</span>
            <input type="date" id="f-startDate" value="${d.profile.startDate || ""}" max="${todayISODate()}" />
          </label>
          <label class="form-field">
            <span>開始体重 (kg)</span>
            <input type="number" step="0.01" id="f-startWeight" value="${d.profile.startWeight}" />
          </label>
          <label class="form-field">
            <span>BMI維持準備アラート値</span>
            <input type="number" step="0.1" id="f-bmiMaintenanceAlert" value="${d.profile.bmiMaintenanceAlert}" />
          </label>
          <label class="form-field">
            <span>BMI下限ライン</span>
            <input type="number" step="0.1" id="f-bmiLowerLine" value="${d.profile.bmiLowerLine}" />
          </label>
        </div>
      </section>

      <section class="card">
        <p class="card-title">${UI.lineIcon("goal")}Goal 1</p>
        ${this._goalFieldsHtml("goal1", d.goal1, d.profile)}
      </section>

      <section class="card">
        <label class="form-field-inline">
          ${UI.lineIcon("goal")}
          <input type="checkbox" id="f-goal2-enabled" ${d.goal2Enabled ? "checked" : ""} />
          <span>Goal 2 を設定する（任意）</span>
        </label>
        <div id="goal2-section" ${d.goal2Enabled ? "" : "hidden"}>
          ${this._goalFieldsHtml("goal2", d.goal2, d.profile)}
        </div>
      </section>

      ${this._error ? `<p class="form-error">${this._error}</p>` : ""}
      <button class="btn-primary" id="settings-save-btn">保存する</button>
    `;

    this._bindEvents(state);
    this._updateComputedDisplays(state);
    ProteinSettingsUI.render(state);
    BackupUI.render(state);
  },

  _goalFieldsHtml(key, goal, profile) {
    return `
      <div class="form-grid" data-goal-key="${key}">
        <label class="form-field-inline">
          <input type="radio" name="${key}-type" value="weight" ${goal.type === "weight" ? "checked" : ""} />
          <span>体重で設定</span>
        </label>
        <label class="form-field-inline">
          <input type="radio" name="${key}-type" value="bmi" ${goal.type === "bmi" ? "checked" : ""} />
          <span>BMIで設定</span>
        </label>
        <label class="form-field">
          <span>目標値</span>
          <input type="number" step="0.01" id="f-${key}-value" value="${goal.value}" />
        </label>
      </div>
      <p class="goal-computed" id="computed-${key}">計算中…</p>
    `;
  },

  _bindEvents(state) {
    const el = document.getElementById("settings-root");
    const d = this._draft;

    const bindNumber = (id, path) => {
      const input = document.getElementById(id);
      if (!input) return;
      input.addEventListener("input", () => {
        setPath(d, path, parseFloat(input.value));
        this._updateComputedDisplays(state);
      });
    };
    bindNumber("f-heightCm", "profile.heightCm");
    bindNumber("f-startWeight", "profile.startWeight");
    bindNumber("f-bmiMaintenanceAlert", "profile.bmiMaintenanceAlert");
    bindNumber("f-bmiLowerLine", "profile.bmiLowerLine");

    document.getElementById("f-startDate").addEventListener("input", (e) => {
      d.profile.startDate = e.target.value;
    });

    bindNumber("f-goal1-value", "goal1.value");
    bindNumber("f-goal2-value", "goal2.value");

    el.querySelectorAll('input[name="goal1-type"]').forEach((r) =>
      r.addEventListener("change", () => {
        d.goal1.type = r.value;
        this._updateComputedDisplays(state);
      })
    );
    el.querySelectorAll('input[name="goal2-type"]').forEach((r) =>
      r.addEventListener("change", () => {
        d.goal2.type = r.value;
        this._updateComputedDisplays(state);
      })
    );

    document.getElementById("f-goal2-enabled").addEventListener("change", (e) => {
      d.goal2Enabled = e.target.checked;
      document.getElementById("goal2-section").hidden = !d.goal2Enabled;
      this._updateComputedDisplays(state);
    });

    document.getElementById("settings-save-btn").addEventListener("click", () => this._handleSave(state));
  },

  _updateComputedDisplays(state) {
    const d = this._draft;
    this._renderGoalComputed("computed-goal1", d.goal1, d.profile);
    if (d.goal2Enabled) this._renderGoalComputed("computed-goal2", d.goal2, d.profile);
  },

  _renderGoalComputed(elId, goal, profile) {
    const el = document.getElementById(elId);
    if (!el) return;
    const goalWeight = Calc.goalToWeightKg(goal, profile.heightCm);
    const goalBmi = Calc.goalToBmi(goal, profile.heightCm);
    const decreaseKg = goalWeight != null ? profile.startWeight - goalWeight : null;
    const decreasePct = goalWeight != null && profile.startWeight ? (decreaseKg / profile.startWeight) * 100 : null;
    el.innerHTML = `目標体重 ${fmtN(goalWeight, 2)}kg ／ 目標BMI ${fmtN(goalBmi, 1)} ／ 開始から ${fmtN(
      decreaseKg,
      2
    )}kg（${fmtN(decreasePct, 1)}%）減`;
  },

  _handleSave(state) {
    const d = this._draft;
    const { heightCm } = VALIDATION_RANGES;

    if (!validateRange(d.profile.heightCm, VALIDATION_RANGES.heightCm)) {
      return this._fail(state, `身長は${VALIDATION_RANGES.heightCm.min}〜${VALIDATION_RANGES.heightCm.max}cmの範囲で入力してください。`);
    }
    if (!validateRange(d.profile.startWeight, VALIDATION_RANGES.weightKg)) {
      return this._fail(state, `開始体重は${VALIDATION_RANGES.weightKg.min}〜${VALIDATION_RANGES.weightKg.max}kgの範囲で入力してください。`);
    }
    if (!validateRange(d.profile.bmiMaintenanceAlert, VALIDATION_RANGES.bmi) || !validateRange(d.profile.bmiLowerLine, VALIDATION_RANGES.bmi)) {
      return this._fail(state, `BMIガードレール値は${VALIDATION_RANGES.bmi.min}〜${VALIDATION_RANGES.bmi.max}の範囲で入力してください。`);
    }
    if (!d.profile.startDate || Calc.isFutureDate(d.profile.startDate)) {
      return this._fail(state, "開始日は今日以前の日付を入力してください。");
    }
    const goal1Range = d.goal1.type === "bmi" ? VALIDATION_RANGES.bmi : VALIDATION_RANGES.weightKg;
    if (!validateRange(d.goal1.value, goal1Range)) {
      return this._fail(state, "Goal1の値が範囲外です。");
    }
    if (d.goal2Enabled) {
      const goal2Range = d.goal2.type === "bmi" ? VALIDATION_RANGES.bmi : VALIDATION_RANGES.weightKg;
      if (!validateRange(d.goal2.value, goal2Range)) {
        return this._fail(state, "Goal2の値が範囲外です。");
      }
      if (!Calc.isGoal2DirectionValid(d.goal1, d.goal2, d.profile.heightCm)) {
        return this._fail(state, "Goal2はGoal1よりさらに減らす方向の値にしてください。");
      }
    }

    const criticalChanged =
      d.profile.heightCm !== state.profile.heightCm ||
      d.profile.startDate !== state.profile.startDate ||
      d.profile.startWeight !== state.profile.startWeight;

    const apply = () => this._applyAndSave(state);
    if (criticalChanged) {
      UI.confirmProfileChange(apply);
    } else {
      apply();
    }
  },

  _fail(state, message) {
    this._error = message;
    this._renderForm(state);
  },

  _applyAndSave(state) {
    const d = this._draft;
    // proteinTargetはProteinSettingsUIが独立して保存するため、ここでは
    // このフォームが扱うフィールドだけを反映する（互いの保存で上書きしないため）
    state.profile.heightCm = d.profile.heightCm;
    state.profile.startDate = d.profile.startDate;
    state.profile.startWeight = d.profile.startWeight;
    state.profile.bmiMaintenanceAlert = d.profile.bmiMaintenanceAlert;
    state.profile.bmiLowerLine = d.profile.bmiLowerLine;
    state.goals.goal1 = { ...state.goals.goal1, type: d.goal1.type, value: d.goal1.value };
    if (d.goal2Enabled) {
      state.goals.goal2 = state.goals.goal2 || { achievedAt: null, postAchievementChoice: null };
      state.goals.goal2.type = d.goal2.type;
      state.goals.goal2.value = d.goal2.value;
    } else {
      state.goals.goal2 = null;
      if (state.goals.activeGoal === 2) state.goals.activeGoal = 1;
    }
    Storage.save(state);
    this._draft = null;
    this._error = null;
    this.render(state);
  },
};

function fmtN(value, digits) {
  return value == null || Number.isNaN(value) ? "—" : value.toFixed(digits);
}

function validateRange(value, range) {
  return typeof value === "number" && !Number.isNaN(value) && value >= range.min && value <= range.max;
}

function setPath(obj, path, value) {
  const keys = path.split(".");
  let target = obj;
  for (let i = 0; i < keys.length - 1; i++) target = target[keys[i]];
  target[keys[keys.length - 1]] = value;
}
