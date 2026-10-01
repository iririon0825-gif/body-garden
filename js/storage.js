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

  // v2: goals.maintenanceMode(boolean)のみで「何がきっかけで維持に入ったか」を
  //     区別できなかった。
  // v3: mode('reduction'|'maintenancePrep'|'maintenance') + maintenanceReason
  //     に置き換え、BMIガードレールの表示制御用にguardrailsを新設。
  2: (state) => {
    if (state.goals) {
      if ("maintenanceMode" in state.goals) {
        state.goals.mode = state.goals.maintenanceMode ? "maintenance" : "reduction";
        state.goals.maintenanceReason = state.goals.maintenanceMode ? "bmi21" : null;
        delete state.goals.maintenanceMode;
      } else {
        state.goals.mode = state.goals.mode || "reduction";
        state.goals.maintenanceReason = state.goals.maintenanceReason || null;
      }
    }
    state.guardrails = state.guardrails || createDefaultGuardrails();
    state.schemaVersion = 3;
    return state;
  },

  // v3: proteinProductsに status/isDefault がなく、proteinEntriesは
  //     商品/食品IDを都度参照する方式だった（マスター編集で過去合計が変わりうる構造）。
  // v4: 商品にstatus('active'|'archived')/isDefaultを追加。proteinEntriesは
  //     記録時点のsnapshot（sourceName/unitProtein/servingScoops/proteinTotal）を
  //     持つ方式に変更し、マスター変更の影響を受けないようにする。
  3: (state) => {
    state.proteinProducts = (state.proteinProducts || []).map((p, i) => ({
      ...p,
      status: p.status || "active",
      isDefault: p.isDefault != null ? p.isDefault : i === 0,
    }));
    state.registeredFoods = (state.registeredFoods || []).map((f) => ({
      ...f,
      status: f.status || "active",
    }));

    state.proteinEntries = (state.proteinEntries || []).map((e) => {
      if (e.sourceType) return e; // 既にv4形式
      const createdAt = e.createdAt || `${e.date}T00:00:00.000Z`;
      if (e.source === "whey") {
        const product = state.proteinProducts.find((p) => p.id === e.wheyProductId);
        const servingScoops = product ? product.servingScoops : null;
        const unitProtein = product ? product.proteinPerServing : null;
        const proteinTotal =
          product && e.scoops != null ? Math.round((e.scoops / servingScoops) * unitProtein * 10) / 10 : 0;
        return {
          id: e.id,
          date: e.date,
          time: e.time || null,
          sourceType: "whey",
          sourceId: e.wheyProductId,
          sourceName: product ? product.name : "(削除済みの商品)",
          quantity: e.scoops,
          unitProtein,
          servingScoops,
          proteinTotal,
          memo: null,
          createdAt,
        };
      }
      if (e.source === "food") {
        const food = state.registeredFoods.find((f) => f.id === e.foodId);
        const unitProtein = food ? food.proteinPerUnit : null;
        const proteinTotal = food && e.qty != null ? Math.round(unitProtein * e.qty * 10) / 10 : 0;
        return {
          id: e.id,
          date: e.date,
          time: e.time || null,
          sourceType: "food",
          sourceId: e.foodId,
          sourceName: food ? food.name : "(削除済みの食品)",
          quantity: e.qty,
          unitProtein,
          servingScoops: null,
          proteinTotal,
          memo: null,
          createdAt,
        };
      }
      // meal
      return {
        id: e.id,
        date: e.date,
        time: e.time || null,
        sourceType: "meal",
        sourceId: null,
        sourceName: e.name,
        quantity: null,
        unitProtein: null,
        servingScoops: null,
        proteinTotal: e.proteinG || 0,
        memo: e.memo || null,
        createdAt,
      };
    });

    state.schemaVersion = 4;
    return state;
  },

  // v4: injections は {scheduledAt, administeredAt, dose, status, comment} のみ。定例スケジュールの概念なし。
  // v5: 注射管理（Phase4）。injections に kind / regularDate / 時刻 / 見送り理由などを追加し、
  //     定例スケジュール injectionSchedule を新設する。既存の記録は値を変えずに引き継ぐ（冪等）。
  //     定例曜日は既存データから推測しない（画面で本人が設定する）。
  4: (state) => {
    const defaults = createEmptyInjection();
    const list = Array.isArray(state.injections) ? state.injections : [];
    const migrated = list.map((i) => {
      const rec = { ...defaults, ...i };
      // status は元のデータの値で判定する（既定値の "scheduled" が先に入るため rec.status は使わない）
      if (!["scheduled", "administered", "skipped"].includes(i.status)) {
        rec.status = rec.administeredAt ? "administered" : "scheduled";
      }
      if (rec.kind === "manual" && i.kind === undefined) rec.kind = "legacy";
      if (rec.scheduledAt === undefined) rec.scheduledAt = null;
      if (rec.administeredAt === undefined) rec.administeredAt = null;
      if (rec.dose === undefined) rec.dose = null;
      if (typeof rec.comment !== "string") rec.comment = "";
      return rec;
    });
    // idが無い記録には連番を振る（数値idだけを数える）
    for (const rec of migrated) {
      if (rec.id === null || rec.id === undefined) rec.id = nextSequentialId(migrated);
    }
    state.injections = migrated;
    state.injectionSchedule = state.injectionSchedule || createDefaultInjectionSchedule();
    // 在庫（残本数）の初期化。既存の投与済みの記録は削除せず、本人の確認が済むまで使用本数に数えない
    applyStockBaseline(state);
    state.ui = state.ui || { lastScreen: "home" };
    state.schemaVersion = 5;
    return state;
  },
};

const Storage = {
  // true の間は save() が何も書き込まない（データを守るための読み取り専用モード）。
  //   "newerSchema": 保存データがこのアプリより新しい版で作られている
  //   "preMigrationBackupFailed": 移行前の退避に失敗したため、移行結果を保存しない
  readOnly: false,
  readOnlyReason: null,
  // 起動後に保存できなくなった（容量不足・他タブが新しい版を保存など）ときに、画面側へ知らせるための連絡先。
  // 引数は "saveFailed" | "newerSchema"。ui-backup.js が帯の表示を結びつける。
  onProblem: null,

  _notify(kind) {
    if (typeof this.onProblem === "function") {
      try {
        this.onProblem(kind);
      } catch (_) {
        // 通知の失敗で保存処理を妨げない
      }
    }
  },

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
      if (state === null || typeof state !== "object" || Array.isArray(state)) {
        throw new Error("stateがオブジェクトではありません");
      }
    } catch (e) {
      console.error("[BodyGarden] state破損。バックアップを退避し初期状態にフォールバック", e);
      let kept = false;
      try {
        localStorage.setItem(`${STORAGE_KEY}.corrupted.${Date.now()}`, raw);
        kept = true;
      } catch (_) {
        // 退避できない
      }
      if (!kept) {
        // 退避できないまま初期状態で上書きすると、元のデータを失う。メモリ上の初期状態で起動し、保存しない。
        this.readOnly = true;
        this.readOnlyReason = "corruptBackupFailed";
        const fresh = createDefaultState();
        fresh.profile.startDate = todayISODate();
        return fresh;
      }
      return this._seedFreshState();
    }

    const storedVersion = state.schemaVersion || 1;

    // このアプリより新しい版のデータは、変換も保存もしない（古いアプリが新しいデータを壊さないため）
    if (storedVersion > SCHEMA_VERSION) {
      console.warn(`[BodyGarden] 保存データ(v${storedVersion})がアプリ(v${SCHEMA_VERSION})より新しいため、読み取り専用で起動します`);
      this.readOnly = true;
      this.readOnlyReason = "newerSchema";
      return state;
    }

    if (storedVersion < SCHEMA_VERSION) {
      // 移行の前に生データを一度だけ退避する（既にあれば上書きしない）。
      // 退避できなければ、移行結果はメモリ上だけで使い、保存しない。
      const backupKey = `${STORAGE_KEY}.preMigration.v${storedVersion}`;
      let backedUp = false;
      try {
        if (localStorage.getItem(backupKey) === null) localStorage.setItem(backupKey, raw);
        backedUp = true;
      } catch (e) {
        console.error("[BodyGarden] 移行前の退避に失敗。移行結果は保存しません", e);
      }
      state = this.migrate(state);
      if (backedUp) {
        this.save(state); // マイグレーション結果を保存し、次回読み込みで同じ変換を繰り返さないようにする
      } else {
        this.readOnly = true;
        this.readOnlyReason = "preMigrationBackupFailed";
      }
      return state;
    }

    // 同じ版のデータは変換不要なので、読み込みだけでは書き込まない。
    // ただし在庫の設定が無い（開発中のv5データ）ときだけ、初期値を入れて保存する（既存の記録は変更しない）
    if (!state.injectionStock || !state.injectionSchedule) {
      if (!state.injectionSchedule) state.injectionSchedule = createDefaultInjectionSchedule();
      applyStockBaseline(state);
      this.save(state);
    }
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

  // strict=true（バックアップ読み込み時）は、移行関数が無い・版が進まない場合に例外を投げる。
  // strict=false（通常起動時）は従来どおり、移行できるところまで進めて止まる。
  migrate(state, { strict = false } = {}) {
    let version = state.schemaVersion || 1;
    while (version < SCHEMA_VERSION) {
      const migrateFn = MIGRATIONS[version];
      if (!migrateFn) {
        if (strict) throw new Error(`v${version} からの移行関数がありません`);
        break;
      }
      state = migrateFn(state);
      if (strict && !(state.schemaVersion > version)) {
        throw new Error(`v${version} の移行で版が進みませんでした`);
      }
      version = state.schemaVersion;
    }
    return state;
  },

  // 書き込めたら true。読み取り専用モード、または保存済みデータの方が新しい版のときは書かない
  save(state) {
    if (this.readOnly) return false;
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const m = /"schemaVersion"\s*:\s*(\d+)/.exec(stored);
        if (m && Number(m[1]) > SCHEMA_VERSION) {
          console.warn("[BodyGarden] 保存済みデータの方が新しい版のため、上書きしません");
          this.readOnly = true;
          this.readOnlyReason = "newerSchema";
          this._notify("newerSchema");
          return false;
        }
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      console.error("[BodyGarden] localStorage書き込み失敗", e);
      this._notify("saveFailed");
      return false;
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
    this.sortInjections(state);
    this.save(state);
    return state;
  },

  // 実効日（実施日、なければ予定日、なければ定例日）→ 時刻 → id の順。null（予定なしの投与など）でも順序が壊れない
  sortInjections(state) {
    const key = (i) => [i.administeredAt || i.scheduledAt || i.regularDate || "", i.administeredTime || i.scheduledTime || "", typeof i.id === "number" ? i.id : 0];
    state.injections.sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      for (let n = 0; n < 3; n++) {
        if (ka[n] < kb[n]) return -1;
        if (ka[n] > kb[n]) return 1;
      }
      return 0;
    });
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

  deleteProteinEntry(state, entryId) {
    state.proteinEntries = state.proteinEntries.filter((e) => e.id !== entryId);
    this.save(state);
    return state;
  },

  // ホエイ商品のupsert。新規追加時、これが最初のactive商品ならisDefaultにする
  upsertProteinProduct(state, product) {
    const isNew = product.id == null;
    this._upsertById(state.proteinProducts, product);
    if (isNew && ProteinLogic.activeProducts(state).length === 1) {
      product.isDefault = true;
    }
    this.save(state);
    return state;
  },

  // 指定商品をデフォルトにし、他のisDefaultを解除する
  setDefaultProteinProduct(state, productId) {
    state.proteinProducts.forEach((p) => {
      p.isDefault = String(p.id) === String(productId);
    });
    this.save(state);
    return state;
  },

  archiveProteinProduct(state, productId) {
    const product = findById(state.proteinProducts, productId);
    if (!product) return state;
    product.status = "archived";
    product.isDefault = false;
    // デフォルトが不在になった場合、残っているactive商品の先頭を新たなデフォルトにする
    const stillActive = ProteinLogic.activeProducts(state);
    if (stillActive.length > 0 && !stillActive.some((p) => p.isDefault)) {
      stillActive[0].isDefault = true;
    }
    this.save(state);
    return state;
  },

  restoreProteinProduct(state, productId) {
    const product = findById(state.proteinProducts, productId);
    if (!product) return state;
    product.status = "active";
    if (ProteinLogic.activeProducts(state).length === 1) product.isDefault = true;
    this.save(state);
    return state;
  },

  // 未使用の商品のみ完全削除できる（呼び出し側でProteinLogic.isProductUsed()を確認すること）
  deleteProteinProduct(state, productId) {
    state.proteinProducts = state.proteinProducts.filter((p) => String(p.id) !== String(productId));
    this.save(state);
    return state;
  },

  upsertRegisteredFood(state, food) {
    this._upsertById(state.registeredFoods, food);
    this.save(state);
    return state;
  },

  archiveRegisteredFood(state, foodId) {
    const food = findById(state.registeredFoods, foodId);
    if (!food) return state;
    food.status = "archived";
    this.save(state);
    return state;
  },

  restoreRegisteredFood(state, foodId) {
    const food = findById(state.registeredFoods, foodId);
    if (!food) return state;
    food.status = "active";
    this.save(state);
    return state;
  },

  // 未使用の食品のみ完全削除できる（呼び出し側でProteinLogic.isFoodUsed()を確認すること）
  deleteRegisteredFood(state, foodId) {
    state.registeredFoods = state.registeredFoods.filter((f) => String(f.id) !== String(foodId));
    this.save(state);
    return state;
  },

  // id採番付きのupsert共通処理（配列を直接書き換える）
  // id採番は数値idのみを対象にする。proteinProducts/registeredFoodsの初期シードは
  // "whey-default"のような文字列idを使うため、Math.maxに文字列が混ざるとNaN化して
  // 新規追加のidがnullになってしまう不具合があった（nextSequentialIdも同様に修正済み）。
  _upsertById(list, item) {
    if (item.id == null) {
      item.id = nextSequentialId(list);
      list.push(item);
    } else {
      const idx = list.findIndex((i) => i.id === item.id);
      if (idx >= 0) list[idx] = item;
      else list.push(item);
    }
  },
};
