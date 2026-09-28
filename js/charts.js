// Body Garden — 体重グラフ（Chart.js）
// 実測体重・Goal1/Goal2ライン・BMI21/BMI20相当体重ラインを重ねて描画する。
// Phase2では全期間表示のみ（期間切替はPhase3以降、記録量が増えてから追加）。

const Charts = {
  _instances: {},

  // canvasIdの要素に既存グラフがあれば破棄してから再描画する
  // （HOME/記録画面のinnerHTML差し替えで毎回canvas要素が作り直されるため）
  renderWeightChart(canvasId, state) {
    const canvas = document.getElementById(canvasId);
    const emptyMsg = document.getElementById(`${canvasId}-empty`);
    if (!canvas) return;

    if (this._instances[canvasId]) {
      this._instances[canvasId].destroy();
      delete this._instances[canvasId];
    }

    const { profile, goals, dailyRecords } = state;
    const points = (dailyRecords || [])
      .filter((r) => r.weight != null)
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    if (points.length === 0) {
      canvas.hidden = true;
      if (emptyMsg) emptyMsg.hidden = false;
      return;
    }
    canvas.hidden = false;
    if (emptyMsg) emptyMsg.hidden = true;

    const labels = points.map((p) => p.date);
    const weightData = points.map((p) => p.weight);

    const datasets = [
      {
        label: "体重",
        data: weightData,
        borderColor: "#6fa89c",
        backgroundColor: "rgba(111,168,156,0.15)",
        pointRadius: 3,
        tension: 0.25,
        fill: true,
      },
    ];

    const goal1Weight = Calc.goalToWeightKg(goals.goal1, profile.heightCm);
    if (goal1Weight != null) {
      datasets.push(flatLine("Goal1", goal1Weight, labels.length, "#d9a9ac"));
    }
    if (goals.goal2) {
      const goal2Weight = Calc.goalToWeightKg(goals.goal2, profile.heightCm);
      if (goal2Weight != null) {
        datasets.push(flatLine("Goal2", goal2Weight, labels.length, "#b7a9d6"));
      }
    }

    const bmi21Weight = Calc.weightForBmi(profile.bmiMaintenanceAlert, profile.heightCm);
    if (bmi21Weight != null) {
      datasets.push(flatLine(`BMI${profile.bmiMaintenanceAlert}`, bmi21Weight, labels.length, "#e0c68a", true));
    }
    const bmi20Weight = Calc.weightForBmi(profile.bmiLowerLine, profile.heightCm);
    if (bmi20Weight != null) {
      datasets.push(flatLine(`BMI${profile.bmiLowerLine} LOWER LINE`, bmi20Weight, labels.length, "#c08a8a", true));
    }

    this._instances[canvasId] = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 10 } } },
        },
        scales: {
          y: { ticks: { callback: (v) => `${v}kg` } },
          x: { ticks: { maxTicksLimit: 6 } },
        },
      },
    });
  },
};

function flatLine(label, value, length, color, dashed) {
  return {
    label,
    data: new Array(length).fill(value),
    borderColor: color,
    borderWidth: 1.5,
    borderDash: dashed ? [4, 4] : undefined,
    pointRadius: 0,
    fill: false,
  };
}
