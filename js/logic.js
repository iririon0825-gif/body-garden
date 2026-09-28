// Body Garden — Goal達成判定・BMIガードレール判定
// 体重保存のたびにafterWeightSave()を呼び、表示すべきモーダルのキューを受け取る。
// 判定に伴うstateの更新（achievedAt等）はここで行うが、永続化(Storage.save)は
// 呼び出し側の責務とする。

const Logic = {
  // 戻り値: [{ type: 'bmi21Alert' } | { type: 'bmi20Alert' }]
  // Goal達成はブロッキングモーダルにしない（HOME上のバナーで表示する方針のため）。
  // ここではachievedAt等のstate更新のみ行い、表示はrenderHome側がgoal.achievedAt &&
  // !goal.postAchievementChoiceを見て判断する。
  afterWeightSave(state, record) {
    const modals = [];
    if (record.weight == null) return modals;

    const { profile, goals, guardrails } = state;
    const currentWeight = record.weight;

    const goalKey = goals.activeGoal === 2 ? "goal2" : "goal1";
    const goal = goals[goalKey];
    if (goal && !goal.achievedAt && Calc.isGoalAchieved(currentWeight, goal, profile.heightCm)) {
      goal.achievedAt = record.date;
      goals.goalHistory.push({
        id: nextSequentialId(goals.goalHistory),
        timestamp: new Date().toISOString(),
        type: "achieved",
        goalKey,
        detail: { date: record.date, weight: currentWeight },
      });
    }

    const currentBmi = Calc.bmi(currentWeight, profile.heightCm);
    if (currentBmi == null) return modals;

    if (
      goals.mode === "reduction" &&
      currentBmi <= profile.bmiMaintenanceAlert &&
      guardrails.bmi21.acknowledgedForDate !== record.date
    ) {
      modals.push({ type: "bmi21Alert" });
    }

    if (currentBmi <= profile.bmiLowerLine && !guardrails.bmi20.acknowledgedAt) {
      modals.push({ type: "bmi20Alert" });
    }

    return modals;
  },

  // BMI21アラートを閉じる。choice: 'later' | 'viewPrep'
  resolveBmi21Alert(state, record, choice) {
    state.guardrails.bmi21.acknowledgedForDate = record.date;
    if (choice === "viewPrep") {
      this._enterMaintenancePrep(state, "bmi21");
    }
  },

  // BMI20アラートを閉じる。choice: 'viewPrep' | 'close'
  resolveBmi20Alert(state, choice) {
    state.guardrails.bmi20.acknowledgedAt = new Date().toISOString();
    if (choice === "viewPrep") {
      this._enterMaintenancePrep(state, "bmi20");
    }
  },

  // reduction中のみ維持準備へ遷移する（すでにprep/maintenanceならreasonは変更しない）
  _enterMaintenancePrep(state, reason) {
    if (state.goals.mode === "reduction") {
      state.goals.mode = "maintenancePrep";
      state.goals.maintenanceReason = reason;
    }
  },

  // 維持準備画面の［維持モードへ切り替える］
  confirmMaintenanceMode(state) {
    state.goals.mode = "maintenance";
  },

  // Goal達成後の選択。choice: 'nextGoal' | 'maintain'
  resolveGoalChoice(state, goalKey, choice) {
    const goal = state.goals[goalKey];
    if (!goal) return;
    goal.postAchievementChoice = choice;
    state.goals.goalHistory.push({
      id: nextSequentialId(state.goals.goalHistory),
      timestamp: new Date().toISOString(),
      type: "choiceMade",
      goalKey,
      detail: { choice },
    });

    if (choice === "nextGoal" && goalKey === "goal1" && state.goals.goal2) {
      state.goals.activeGoal = 2;
    } else if (choice === "maintain") {
      state.goals.mode = "maintenance";
      state.goals.maintenanceReason = "goalChoice";
    }
  },
};
