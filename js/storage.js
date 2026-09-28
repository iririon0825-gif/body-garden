// Body Garden — 永続化（localStorage + スキーマバージョン管理）
// Tonight Garden の storage.js パターン（単一キー・JSON・MIGRATIONS）を踏襲。

const STORAGE_KEY = "bodyGarden.state";

// MIGRATIONS[N] は「schemaVersion=N のstate」を受け取り、
// schemaVersion=N+1 に変換して返す関数。将来のスキーマ変更はここに追記する。
const MIGRATIONS = {
  // v1: dailyRecords内にprotein/conditionを埋め込んでいた。
  // v2: 1日複数回ありうるProtein/体調をproteinEntries/conditionEntriesへ分離、
  //     injectionのフィールド名をscheduledAt/administeredAt/statusへ統一。
  1: (state) => {
    state.proteinEntries = state.proteinEntries || [];
    state.conditionEntries = state.conditionEntries || [];
    let nextId = 1;

    for (const record of state.dailyRecords || []) {
      if (record.protein) {
        const createdAt = `${record.date}T00:00:00.000Z`;
        if (record.protein.wheyScoops) {
          state.proteinEntries.push({
            id: nextId++,
            date: record.date,
            time: null,
            source: "whey",
            wheyProductId: record.protein.wheyProductId,
            scoops: record.protein.wheyScoops,
            foodId: null,
            qty: null,
            name: null,
            proteinG: null,
            memo: null,
            createdAt,
          });
        }
        for (const entry of record.protein.registeredFoodEntries || []) {
          state.proteinEntries.push({
            id: nextId++,
            date: record.date,
            time: null,
            source: "food",
            wheyProductId: null,
            scoops: null,
            foodId: entry.foodId,
            qty: entry.qty,
            name: null,
            proteinG: null,
            memo: null,
            createdAt,
          });
        }
        for (const meal of record.protein.mealEntries || []) {
          state.proteinEntries.push({
            id: nextId++,
            date: record.date,
            time: null,
            source: "meal",
            wheyProductId: null,
            scoops: null,
            foodId: null,
            qty: null,
            name: meal.name,
            proteinG: meal.proteinG,
            memo: meal.memo || null,
            createdAt,
          });
        }
        delete record.protein;
      }

      if (record.condition) {
        if (record.condition.level != null) {
          state.conditionEntries.push({
            id: nextId++,
            date: record.date,
            time: null,
            level: record.condition.level,
            symptoms: record.condition.symptoms || [],
            comment: record.condition.comment || "",
            createdAt: `${record.date}T00:00:00.000Z`,
          });
        }
        delete record.condition;
      }
    }

    for (const inj of state.injections || []) {
      if ("scheduledDate" in inj) {
        inj.scheduledAt = inj.scheduledDate;
        delete inj.scheduledDate;
      }
      if ("actualDate" in inj) {
        inj.administeredAt = inj.actualDate;
        delete inj.actualDate;
      }
      if ("completed" in inj) {
        inj.status = inj.completed ? "administered" : "scheduled";
        delete inj.completed;
      }
    }

    if (state.goals) {
      for (const key of ["goal1", "goal2"]) {
        if (state.goals[key] && !("postAchievementChoice" in state.goals[key])) {
          state.goals[key].postAchievementChoice = null;
        }
      }
      if (!state.goals.goalHistory) state.goals.goalHistory = [];
    }

    state.schemaVersion = 2;
    return state;
  },
};

const Storage = {
  load() {
    let raw;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      console.error("[BodyGarden] localStorage読み込み失敗", e);
      return this._seedFreshState();
    }

    if (!raw) {
      return this._seedFreshState();
    }

    let state;
    try {
      state = JSON.parse(raw);
    } catch (e) {
      console.error("[BodyGarden] state破損。バックアップを退避し初期状態にフォールバック", e);
      try {
        localStorage.setItem(`${STORAGE_KEY}.corrupted.${Date.now()}`, raw);
      } catch (_) {
        // バックアップ自体が失敗しても初期状態へのフォールバックは継続する
      }
      return this._seedFreshState();
    }

    state = this.migrate(state);
    this.save(state); // マイグレーション結果を即保存し、次回読み込みで同じ変換を繰り返さないようにする
    return state;
  },

  // 初回起動時・復旧時の共通処理。startDateを今日にセットして保存する
  // （saveは内部でtry/catchしているため、保存自体が失敗しても例外は投げない）
  _seedFreshState() {
    const fresh = createDefaultState();
    fresh.profile.startDate = todayISODate();
    this.save(fresh);
    return fresh;
  },

  migrate(state) {
    let version = state.schemaVersion || 1;
    while (version < SCHEMA_VERSION) {
      const migrateFn = MIGRATIONS[version];
      if (!migrateFn) break;
      state = migrateFn(state);
      version = state.schemaVersion;
    }
    return state;
  },

  save(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.error("[BodyGarden] localStorage書き込み失敗", e);
    }
  },

  // date(YYYY-MM-DD)の記録を取得。なければ空レコードを返す（stateには追加しない）
  getRecordForDate(state, date) {
    return state.dailyRecords.find((r) => r.date === date) || createEmptyDailyRecord(date);
  },

  // 指定日の記録をupsertして保存
  upsertRecord(state, record) {
    const idx = state.dailyRecords.findIndex((r) => r.date === record.date);
    if (idx >= 0) {
      state.dailyRecords[idx] = record;
    } else {
      state.dailyRecords.push(record);
    }
    state.dailyRecords.sort((a, b) => (a.date < b.date ? -1 : 1));
    this.save(state);
    return state;
  },

  upsertInjection(state, injection) {
    this._upsertById(state.injections, injection);
    state.injections.sort((a, b) => (a.scheduledAt < b.scheduledAt ? -1 : 1));
    this.save(state);
    return state;
  },

  upsertProteinEntry(state, entry) {
    this._upsertById(state.proteinEntries, entry);
    this.save(state);
    return state;
  },

  upsertConditionEntry(state, entry) {
    this._upsertById(state.conditionEntries, entry);
    this.save(state);
    return state;
  },

  // id採番付きのupsert共通処理（配列を直接書き換える）
  _upsertById(list, item) {
    if (item.id == null) {
      const maxId = list.reduce((max, i) => Math.max(max, i.id || 0), 0);
      item.id = maxId + 1;
      list.push(item);
    } else {
      const idx = list.findIndex((i) => i.id === item.id);
      if (idx >= 0) list[idx] = item;
      else list.push(item);
    }
  },
};
