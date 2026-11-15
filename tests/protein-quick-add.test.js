// Protein ワンタップ登録: いつもの量（quickScoops）・確認表示と取り消し・誤連打の抑止・集計/保存形式の不変・自動バックアップの起点

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { sampleState, clone } = require("./helpers");
const { setupClient, ROOT } = require("./sheets-helpers");

// ---- 偽のDOM（トーストとモーダルと、ボタンの有効/無効だけを再現する） ----
function makeDom() {
  const els = new Map();
  const quickButtons = []; // querySelectorAll で返す（無効化の解除を確かめる）
  let modalHtml = "";
  const stub = (id) => ({
    id,
    value: "",
    hidden: /error$/.test(id || ""), // 実際のモーダルでも、エラー表示欄は最初は非表示
    disabled: false,
    className: "",
    attrs: {},
    listeners: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    get innerHTML() { return this._html || ""; },
    set innerHTML(v) { this._html = v; this._undo = null; },
    querySelector(sel) {
      if (sel === "[data-protein-undo]" && (this._html || "").includes("data-protein-undo")) {
        this._undo = this._undo || { listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } };
        return this._undo;
      }
      return null;
    },
  });
  els.set("modal-root", { id: "modal-root", querySelectorAll() { return []; } }); // 「今日の記録」一覧の再表示で使う
  const document = {
    getElementById(id) {
      if (els.has(id)) return els.get(id);
      if (modalHtml.includes(`id="${id}"`)) {
        els.set(id, stub(id));
        return els.get(id);
      }
      return null;
    },
    createElement() { return stub(null); },
    body: { appendChild(el) { els.set(el.id, el); } },
    querySelectorAll() { return quickButtons; },
  };
  return { document, els, quickButtons, setModal(html) { modalHtml = html; els.forEach((_, k) => { if (/^(whey|food|meal|edit)-/.test(k)) els.delete(k); }); }, getModal: () => modalHtml };
}

// 保存・計算・Sheets 同期は本物。画面側は ProteinHomeUI / ProteinSettingsUI と偽のDOM
function setup(opts = {}) {
  const c = setupClient(opts);
  const dom = makeDom();
  const ui = { renders: 0, hidden: 0 };
  c.env.ctx.document = dom.document;
  c.env.ctx.UI = {
    lineIcon: () => "",
    renderHome() { ui.renders += 1; },
    showModal(html) { dom.setModal(html); },
    hideModal() { ui.hidden += 1; },
  };
  // ui.js の fmt / ui-settings.js の validateRange と同じ定義（それぞれ画面全体を読み込まずに使う）
  vm.runInContext(
    `function fmt(value, digits){ if (value == null || Number.isNaN(value)) return "—"; return value.toFixed(digits); }
     function validateRange(value, range){ return typeof value === "number" && !Number.isNaN(value) && value >= range.min && value <= range.max; }`,
    c.env.ctx
  );
  for (const f of ["ui-protein-home.js", "ui-protein-settings.js"]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, "js", f), "utf8"), c.env.ctx, { filename: f });
  }
  const Home = c.env.get("ProteinHomeUI");
  const Settings = c.env.get("ProteinSettingsUI");
  Home._now = () => c.clock.t;
  Home._locks = {};
  Home._lockTimers = {};
  Home._lastQuick = null;
  Home._toastTimer = null;
  return { ...c, dom, ui, Home, Settings, Logic: c.env.get("ProteinLogic"), Calc: c.env.get("Calc") };
}

// WINZONE のように、規定量（栄養表示）といつもの量が違う商品
function winzone(over = {}) {
  return { id: "p-win", name: "WINZONE", servingScoops: 2, proteinPerServing: 14, status: "active", isDefault: true, ...over };
}
function stateWith(t, products, entries = []) {
  const s = sampleState(t.env);
  s.proteinProducts = products;
  s.proteinEntries = entries;
  return s;
}
const today = (t) => t.env.get("todayISODate()");
const tap = (t, state, action, extra = {}) => t.Home._handleAction(state, { dataset: { proteinAction: action, ...extra } });

// ---------- いつもの量（quickScoops） ----------

test("既定商品＋quickScoopsで、1タップでホエイが登録される（規定量とは別の量・proteinTotalは商品設定から計算）", () => {
  const t = setup();
  const s = stateWith(t, [winzone({ quickScoops: 3 })]);
  tap(t, s, "whey-quick");
  assert.equal(s.proteinEntries.length, 1);
  const e = s.proteinEntries[0];
  assert.equal(e.sourceType, "whey");
  assert.equal(e.sourceId, "p-win");
  assert.equal(e.sourceName, "WINZONE");
  assert.equal(e.quantity, 3, "いつもの量");
  assert.equal(e.servingScoops, 2, "記録時の規定量のsnapshot");
  assert.equal(e.unitProtein, 14);
  assert.equal(e.proteinTotal, 21, "3 ÷ 2 × 14 = 21.0g");
  assert.equal(e.date, today(t));
  assert.ok(e.id != null, "保存時に採番される");
  assert.ok(t.env.ls.getItem(t.env.STORAGE_KEY).includes('"proteinTotal":21'), "localStorageへ保存されている");
});

test("quickScoopsが未設定・不正な値のときは、規定スプーン数にフォールバックする", () => {
  for (const bad of [undefined, null, "3", "abc", NaN, 0, -1, 0.05, 11, Infinity]) {
    const t = setup();
    const p = winzone();
    if (bad !== undefined) p.quickScoops = bad;
    const s = stateWith(t, [p]);
    tap(t, s, "whey-quick");
    assert.equal(s.proteinEntries[0].quantity, 2, `quickScoops=${String(bad)} → 規定量 2`);
    assert.equal(s.proteinEntries[0].proteinTotal, 14);
  }
  const t = setup();
  assert.equal(t.Logic.quickScoopsOf(null), null);
});

test("既存データを書き換えない: 商品に quickScoops が増えるのは、設定画面で保存したときだけ", () => {
  const t = setup();
  const s = stateWith(t, [winzone()]);
  const before = JSON.stringify(s.proteinProducts);
  tap(t, s, "whey-quick");
  assert.equal(JSON.stringify(s.proteinProducts), before, "ワンタップ登録は商品マスターに触れない");
  assert.ok(!("quickScoops" in s.proteinProducts[0]));
});

test("既定商品を変えると、その商品のquickScoopsで登録される", () => {
  const t = setup();
  const a = winzone({ id: "pA", name: "A", servingScoops: 3, proteinPerServing: 21, quickScoops: 3, isDefault: true });
  const b = winzone({ id: "pB", name: "B", servingScoops: 2, proteinPerServing: 20, quickScoops: 1.5, isDefault: false });
  const s = stateWith(t, [a, b]);
  tap(t, s, "whey-quick");
  assert.equal(s.proteinEntries[0].sourceId, "pA");
  assert.equal(s.proteinEntries[0].quantity, 3);
  t.env.Storage.setDefaultProteinProduct(s, "pB");
  t.clock.t += 5000;
  tap(t, s, "whey-quick");
  const e = s.proteinEntries[1];
  assert.equal(e.sourceId, "pB");
  assert.equal(e.quantity, 1.5);
  assert.equal(e.proteinTotal, 15, "1.5 ÷ 2 × 20");
});

test("商品が1件もないときは、ワンタップで登録せず、案内を出す（記録は増えない）", () => {
  const t = setup();
  const s = stateWith(t, []);
  tap(t, s, "whey-quick");
  assert.equal(s.proteinEntries.length, 0);
  assert.match(t.dom.getModal(), /ホエイ商品が未登録です/);
});

test("HOMEの表示: いつもの量のワンタップ登録と、スプーン数を指定して追加の両方がある", () => {
  const t = setup();
  const s = stateWith(t, [winzone({ quickScoops: 3 })]);
  const html = t.Home.cardInnerHtml(s);
  assert.match(html, /data-protein-action="whey-quick"/);
  assert.match(html, /いつものプロテイン/);
  assert.match(html, /＋1杯/);
  assert.match(html, /3スプーン・21\.0g/, "量とgが分かる");
  assert.match(html, /data-protein-action="whey">スプーン数を指定して追加/);
  assert.match(html, /data-protein-action="food-custom">数量を指定して追加/, "従来の入力口も残る");
  assert.match(html, /data-protein-action="add-meal"/);
  // 商品が無いときは、従来のボタン
  const none = t.Home.cardInnerHtml(stateWith(t, []));
  assert.doesNotMatch(none, /whey-quick/);
  assert.match(none, /data-protein-action="whey"[^>]*>[\s\S]*ホエイ/);
});

// ---------- 詳細入力（既存のモーダル）はそのまま ----------

test("スプーン数を指定して追加: 既存のモーダルで、従来どおり登録できる", () => {
  const t = setup();
  const s = stateWith(t, [winzone({ quickScoops: 3 })]);
  tap(t, s, "whey");
  assert.match(t.dom.getModal(), /whey-scoops-input/);
  t.dom.document.getElementById("whey-scoops-input").value = "1.5";
  t.dom.document.getElementById("whey-confirm-btn").listeners.click();
  assert.equal(s.proteinEntries.length, 1);
  assert.equal(s.proteinEntries[0].quantity, 1.5, "いつもの量ではなく、指定した量");
  assert.equal(s.proteinEntries[0].proteinTotal, 10.5);
  assert.ok(ui_hidden(t) >= 1);
  // 範囲外はエラーのまま、登録されない
  tap(t, s, "whey");
  t.dom.document.getElementById("whey-scoops-input").value = "50";
  t.dom.document.getElementById("whey-confirm-btn").listeners.click();
  assert.equal(s.proteinEntries.length, 1);
  assert.equal(t.dom.document.getElementById("whey-modal-error").hidden, false);
});
const ui_hidden = (t) => t.ui.hidden;

test("ワンタップのエントリと詳細入力のエントリは、同じ保存形式（キー・型）", () => {
  const t = setup();
  const s = stateWith(t, [winzone({ quickScoops: 3 })]);
  tap(t, s, "whey-quick");
  const detail = t.Logic.createWheyEntry(s, today(t), "p-win", 3);
  assert.deepEqual(Object.keys(s.proteinEntries[0]).sort(), Object.keys(detail).sort(), "proteinEntriesの保存形式は変えない");
  assert.ok(!("quickScoops" in s.proteinEntries[0]));
});

// ---------- 確認表示と取り消し ----------

test("登録後に確認表示（追加した内容・g・取り消す）が出る。確認ダイアログは出さない", () => {
  const t = setup();
  const s = stateWith(t, [winzone({ quickScoops: 3 })]);
  tap(t, s, "whey-quick");
  const toast = t.dom.els.get("protein-toast");
  assert.ok(toast, "確認表示がある");
  assert.equal(toast.hidden, false);
  assert.match(toast.innerHTML, /✓ いつものプロテイン 21\.0gを追加しました/);
  assert.match(toast.innerHTML, /取り消す/);
  assert.equal(t.dom.getModal(), "", "ダイアログ（モーダル）は出さない");
  assert.equal(t.ui.renders, 1, "HOMEは再描画される");
});

test("取り消す: 直前に追加した1件だけを削除し、ほかの記録・合計はそのまま", () => {
  const t = setup();
  const s = stateWith(t, [winzone({ quickScoops: 3 })]);
  const before = t.Logic.createMealEntry(today(t), "サラダチキン", 24, "");
  t.env.Storage.upsertProteinEntry(s, before);
  tap(t, s, "whey-quick"); // 21.0g
  t.clock.t += 5000;
  tap(t, s, "whey-quick"); // もう1杯（直前の1件だけが取り消し対象）
  assert.equal(s.proteinEntries.length, 3);
  const keep = clone(s.proteinEntries.slice(0, 2));
  const lastId = s.proteinEntries[2].id;
  t.dom.els.get("protein-toast").querySelector("[data-protein-undo]").listeners.click();
  assert.equal(s.proteinEntries.length, 2);
  assert.ok(!s.proteinEntries.some((e) => e.id === lastId));
  assert.deepEqual(clone(s.proteinEntries), keep, "ほかの記録は変わらない");
  assert.equal(t.Calc.proteinTotalForDate(today(t), s.proteinEntries), 45, "24 + 21");
  assert.equal(t.dom.els.get("protein-toast").hidden, true, "確認表示は消える");
  assert.equal(JSON.parse(t.env.ls.getItem(t.env.STORAGE_KEY)).proteinEntries.length, 2, "保存済みのデータからも消えている");
});

test("取り消しは1回だけ。確認表示が消えたあとは、取り消せない（記録も消えない）", () => {
  const t = setup();
  const s = stateWith(t, [winzone({ quickScoops: 3 })]);
  tap(t, s, "whey-quick");
  const undo = t.dom.els.get("protein-toast").querySelector("[data-protein-undo]").listeners.click;
  undo();
  assert.equal(s.proteinEntries.length, 0);
  t.clock.t += 5000;
  tap(t, s, "whey-quick");
  const timerFn = t.timers.find((x) => x.ms === t.Home.UNDO_VISIBLE_MS && !x.cleared);
  assert.ok(timerFn, "一定時間で確認表示が消える");
  timerFn.fn();
  assert.equal(t.dom.els.get("protein-toast").hidden, true);
  undo(); // 古いボタンが押されても、新しく追加した記録は消さない
  assert.equal(s.proteinEntries.length, 1);
  t.Home._undoLast(s); // 消えたあとの取り消しも何もしない
  assert.equal(s.proteinEntries.length, 1);
});

test("別の画面などで、すでに削除された記録は、取り消しても何も起きない", () => {
  const t = setup();
  const s = stateWith(t, [winzone({ quickScoops: 3 })]);
  tap(t, s, "whey-quick");
  const id = s.proteinEntries[0].id;
  t.env.Storage.deleteProteinEntry(s, id); // 「今日の記録を見る」から削除した、など
  const other = t.Logic.createMealEntry(today(t), "別の記録", 10, "");
  other.createdAt = new Date(Date.now() + 3000).toISOString(); // 数秒あとに追加された（人の操作は、同じミリ秒にはならない）
  t.env.Storage.upsertProteinEntry(s, other);
  assert.equal(other.id, id, "削除された id は、次の記録に再利用される（このテストの前提）");
  t.dom.els.get("protein-toast").querySelector("[data-protein-undo]").listeners.click();
  assert.equal(s.proteinEntries.length, 1, "id が同じでも、別の記録は消さない（作成時刻も照合する）");
  assert.equal(s.proteinEntries[0].sourceName, "別の記録");
});

// ---------- 二重登録の抑止（短時間だけ。恒久的な禁止ではない） ----------

test("連打: 登録直後の同じボタンは、短時間無効になり、誤った二重登録を防ぐ", () => {
  const t = setup();
  const s = stateWith(t, [winzone({ quickScoops: 3 })]);
  tap(t, s, "whey-quick");
  tap(t, s, "whey-quick"); // 連打
  tap(t, s, "whey-quick");
  assert.equal(s.proteinEntries.length, 1);
  assert.match(t.Home.cardInnerHtml(s), /data-protein-action="whey-quick" disabled/, "描画されるボタンは無効");
  t.clock.t += t.Home.QUICK_LOCK_MS - 1;
  tap(t, s, "whey-quick");
  assert.equal(s.proteinEntries.length, 1, "まだ短時間のうち");
});

test("時間をあければ、同じものを同日に何度でも登録できる（恒久的な重複禁止ではない）", () => {
  const t = setup();
  const s = stateWith(t, [winzone({ quickScoops: 3 })]);
  tap(t, s, "whey-quick");
  t.clock.t += t.Home.QUICK_LOCK_MS;
  assert.doesNotMatch(t.Home.cardInnerHtml(s), /whey-quick" disabled/, "期限が来れば、有効に戻る");
  tap(t, s, "whey-quick");
  t.clock.t += 60 * 60 * 1000;
  tap(t, s, "whey-quick");
  assert.equal(s.proteinEntries.length, 3);
  assert.equal(t.Calc.proteinTotalForDate(today(t), s.proteinEntries), 63, "21 × 3");
});

test("無効化の解除: 期限が来ると、表示中のボタンが有効に戻る（画面を作り直さずに）", () => {
  const t = setup();
  const s = stateWith(t, [winzone({ quickScoops: 3 })]);
  const btn = { disabled: true, dataset: { proteinAction: "whey-quick" } };
  const other = { disabled: true, dataset: { proteinAction: "food-quick", foodId: "food-oikos" } };
  t.dom.quickButtons.push(btn, other);
  tap(t, s, "whey-quick");
  const lockTimer = t.timers.find((x) => x.ms === t.Home.QUICK_LOCK_MS && !x.cleared);
  assert.ok(lockTimer);
  lockTimer.fn();
  assert.equal(btn.disabled, false, "ホエイのボタンは戻る");
  assert.equal(other.disabled, true, "ほかのボタンの無効化は、そのボタンの期限まで保つ");
});

test("押したボタンだけが無効になる: ホエイのあとに、続けて食品（オイコス）も登録できる", () => {
  const t = setup();
  const s = stateWith(t, [winzone({ quickScoops: 3 })]);
  s.registeredFoods = [{ id: "food-oikos", name: "オイコス（プレーン）", unit: "個", proteinPerUnit: 10, status: "active" }];
  tap(t, s, "whey-quick");
  tap(t, s, "food-quick", { foodId: "food-oikos" });
  assert.equal(s.proteinEntries.length, 2);
  tap(t, s, "food-quick", { foodId: "food-oikos" }); // 食品の連打は抑止
  assert.equal(s.proteinEntries.length, 2);
  const html = t.Home.cardInnerHtml(s);
  assert.match(html, /whey-quick" disabled/);
  assert.match(html, /food-quick" data-food-id="food-oikos" disabled/);
});

// ---------- 登録食品の＋1（従来どおり） ----------

test("登録食品の＋1は従来どおり1タップで登録され、確認表示と取り消しも使える", () => {
  const t = setup();
  const s = stateWith(t, [winzone()]);
  s.registeredFoods = [{ id: "food-egg", name: "ゆで卵", unit: "個", proteinPerUnit: 6.5, status: "active" }];
  tap(t, s, "food-quick", { foodId: "food-egg" });
  const e = s.proteinEntries[0];
  assert.equal(e.sourceType, "food");
  assert.equal(e.sourceId, "food-egg");
  assert.equal(e.quantity, 1);
  assert.equal(e.unitProtein, 6.5);
  assert.equal(e.proteinTotal, 6.5);
  assert.match(t.dom.els.get("protein-toast").innerHTML, /ゆで卵 6\.5gを追加しました/);
  t.dom.els.get("protein-toast").querySelector("[data-protein-undo]").listeners.click();
  assert.equal(s.proteinEntries.length, 0);
  // 存在しない食品は何もしない
  tap(t, s, "food-quick", { foodId: "nope" });
  assert.equal(s.proteinEntries.length, 0);
});

test("食品の名前に記号が入っていても、確認表示は安全（エスケープされる）", () => {
  const t = setup();
  const s = stateWith(t, [winzone()]);
  s.registeredFoods = [{ id: "f1", name: '<img src=x onerror="alert(1)">', unit: "個", proteinPerUnit: 5, status: "active" }];
  tap(t, s, "food-quick", { foodId: "f1" });
  const html = t.dom.els.get("protein-toast").innerHTML;
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

// ---------- 集計・目標・過去記録・保存形式は変わらない ----------

test("75g目標・合計・過去記録は変わらない。商品マスターを変えても過去の記録は動かない", () => {
  const t = setup();
  const s = stateWith(t, [winzone({ quickScoops: 3 })]);
  assert.equal(s.profile.proteinTarget, 75);
  const yesterday = t.Logic.createWheyEntry(s, "2026-11-01", "p-win", 3); // 21.0g
  t.env.Storage.upsertProteinEntry(s, yesterday);
  tap(t, s, "whey-quick");
  assert.equal(t.Calc.proteinTotalForDate(today(t), s.proteinEntries), 21);
  assert.equal(t.Calc.proteinTotalForDate("2026-11-01", s.proteinEntries), 21);
  assert.equal(t.Calc.proteinTotalForDate("2026-11-02", s.proteinEntries), 0, "記録が無い日を、記録として補わない");
  // 商品を編集（規定量・いつもの量を変更）しても、過去の記録は変わらない
  const p = s.proteinProducts[0];
  p.servingScoops = 5;
  p.proteinPerServing = 99;
  p.quickScoops = 1;
  t.env.Storage.upsertProteinProduct(s, p);
  assert.equal(s.proteinEntries.find((e) => e.id === yesterday.id).proteinTotal, 21);
  assert.equal(s.proteinEntries.find((e) => e.id === yesterday.id).servingScoops, 2);
  assert.equal(t.Calc.proteinTotalForDate("2026-11-01", s.proteinEntries), 21);
  assert.equal(s.profile.proteinTarget, 75);
});

test("トレンドの集計は、ワンタップの記録も同じように数える（未記録日はnullのまま）", () => {
  const t = setup();
  const s = stateWith(t, [winzone({ quickScoops: 3 })]);
  tap(t, s, "whey-quick");
  const series = t.Logic.trendSeries(s, "7", new Date(t.clock.t));
  assert.ok(series.points.length === 1);
  assert.equal(series.points[0].value, 21);
  assert.ok(series.data.filter((v) => v === null).length === series.days.length - 1, "記録の無い日は 0 ではなく null");
});

test("schemaVersion 7・Backup形式1のまま。quickScoopsありでも無しでも、バックアップの書き出し→読み込みを通る", () => {
  const t = setup();
  assert.equal(t.env.get("SCHEMA_VERSION"), 7);
  assert.equal(t.env.Backup.FORMAT_VERSION, 1);
  const s = stateWith(t, [winzone({ quickScoops: 3 }), winzone({ id: "p2", isDefault: false })]);
  tap(t, s, "whey-quick");
  assert.equal(JSON.parse(t.env.ls.getItem(t.env.STORAGE_KEY)).schemaVersion, 7);
  const parsed = t.env.Backup.parse(t.env.Backup.serialize(s), null);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.message || parsed));
  assert.equal(parsed.state.proteinProducts[0].quickScoops, 3, "いつもの量は、バックアップで保たれる");
  assert.equal(parsed.state.proteinProducts[1].quickScoops, undefined, "未設定は未設定のまま");
});

// ---------- 規定量が10スプーンを超える商品の記録も、あとから編集できる ----------

// 規定量が大きい（15スプーン=60g）が、商品として有効（規定スプーン数は最大20まで登録できる）
function bigProduct(over = {}) {
  return { id: "p-big", name: "大容量", servingScoops: 15, proteinPerServing: 60, status: "active", isDefault: true, ...over };
}
function editWhey(t, state, entry, value) {
  t.Home._openEditWheyModal(state, entry);
  t.dom.document.getElementById("edit-scoops-input").value = String(value);
  t.dom.document.getElementById("edit-confirm-btn").listeners.click();
  const err = t.dom.document.getElementById("edit-modal-error");
  return err && !err.hidden ? err.textContent : null; // エラー表示があれば、その文言
}

test("規定量が10を超える有効な商品でも、ワンタップ登録で記録を作れる", () => {
  const t = setup();
  const s = stateWith(t, [bigProduct()]); // いつもの量は未設定 → 規定量（15）で登録される
  tap(t, s, "whey-quick");
  const e = s.proteinEntries[0];
  assert.equal(e.quantity, 15, "規定スプーン数へフォールバック（10を超える）");
  assert.equal(e.servingScoops, 15);
  assert.equal(e.proteinTotal, 60);
  assert.deepEqual(clone(t.Logic.wheyEditRange()), { min: 0.1, max: 20 });
});

test("その記録を、編集画面でそのまま保存でき、スプーン数を変えても保存できる（編集不能にならない）", () => {
  const t = setup();
  const s = stateWith(t, [bigProduct()]);
  tap(t, s, "whey-quick");
  const e = s.proteinEntries[0];
  assert.equal(editWhey(t, s, e, 15), null, "変更せずに保存できる");
  assert.equal(e.quantity, 15);
  assert.equal(e.proteinTotal, 60);
  assert.equal(editWhey(t, s, e, 12), null, "10を超える値へ変更できる");
  assert.equal(e.quantity, 12);
  assert.equal(e.proteinTotal, 48, "12 ÷ 15 × 60");
  assert.equal(editWhey(t, s, e, 20), null, "上限（20）まで");
  assert.equal(e.proteinTotal, 80);
  assert.equal(JSON.parse(t.env.ls.getItem(t.env.STORAGE_KEY)).proteinEntries[0].proteinTotal, 80, "保存されている");
});

test("編集の範囲外（20超・0.1未満・0・負・数値でない）は、従来どおり保存されず、エラーを出す", () => {
  const t = setup();
  const s = stateWith(t, [bigProduct()]);
  tap(t, s, "whey-quick");
  const e = s.proteinEntries[0];
  for (const bad of [20.1, 25, 0.05, 0, -1, "abc", ""]) {
    const msg = editWhey(t, s, e, bad);
    assert.match(msg || "", /スプーン数は0\.1〜20の範囲で入力してください/, `${bad}`);
    assert.equal(e.quantity, 15, `${bad}: 値は変わらない`);
  }
});

test("通常の0.1〜10杯の編集は、これまでと同じ（再計算も従来どおり）", () => {
  const t = setup();
  const s = stateWith(t, [winzone({ quickScoops: 3 })]); // 規定量2・14g
  tap(t, s, "whey-quick");
  const e = s.proteinEntries[0];
  const cases = [
    [0.1, 0.7], // 0.1 ÷ 2 × 14
    [1, 7],
    [3, 21],
    [4.5, 31.5],
    [10, 70],
  ];
  for (const [scoops, grams] of cases) {
    assert.equal(editWhey(t, s, e, scoops), null, `${scoops}`);
    assert.equal(e.quantity, scoops);
    assert.equal(e.proteinTotal, grams, `${scoops}スプーン → ${grams}g`);
  }
  assert.equal(editWhey(t, s, e, 0.09) !== null, true, "0.1未満は不可（従来どおり）");
});

test("編集時の再計算は、記録時のsnapshotを使う（商品マスターを変えていても、記録時のレート）", () => {
  const t = setup();
  const s = stateWith(t, [bigProduct()]);
  tap(t, s, "whey-quick"); // snapshot: 15スプーン=60g
  const p = s.proteinProducts[0];
  p.servingScoops = 3; // 商品マスターは、あとから変えられた
  p.proteinPerServing = 99;
  t.env.Storage.upsertProteinProduct(s, p);
  const e = s.proteinEntries[0];
  assert.equal(editWhey(t, s, e, 12), null);
  assert.equal(e.proteinTotal, 48, "12 ÷ 15 × 60（マスターの 3 / 99 ではない）");
  assert.equal(e.servingScoops, 15);
  assert.equal(e.unitProtein, 60);
});

test("新規の詳細入力（スプーン数を指定して追加）と、いつもの量の設定は、これまでどおり0.1〜10まで", () => {
  const t = setup();
  const s = stateWith(t, [bigProduct()]);
  tap(t, s, "whey");
  t.dom.document.getElementById("whey-scoops-input").value = "12";
  t.dom.document.getElementById("whey-confirm-btn").listeners.click();
  assert.equal(s.proteinEntries.length, 0, "10を超える新規の詳細入力は、従来どおり受け付けない");
  assert.match(t.dom.document.getElementById("whey-modal-error").textContent, /0\.1〜10/);
  // いつもの量の設定も 0.1〜10 のまま
  t.Settings.render = () => {};
  t.Settings._productForm = { ...s.proteinProducts[0] };
  fillProductForm(t, { name: "大容量", serving: "15", per: "60", quick: "12" });
  t.Settings._saveProduct(s);
  assert.ok(!("quickScoops" in s.proteinProducts[0]));
  assert.match(t.Settings._error, /いつもの量は0\.1〜10/);
});

test("規定量が10を超える商品の記録を編集して保存した内容も、通常のsave経路で自動バックアップの対象になる", async () => {
  const t = setup();
  t.S.init();
  const s = stateWith(t, [bigProduct()]);
  tap(t, s, "whey-quick");
  await t.S.flush();
  t.clock.t += 10 * 1000;
  assert.equal(editWhey(t, s, s.proteinEntries[0], 12), null);
  assert.equal(t.timers.filter((x) => x.ms === t.S.DEBOUNCE_MS && !x.cleared).length, 1, "編集の保存でも、同期が予約される");
  assert.equal((await t.S.flush()).confirmed, true);
  const sent = JSON.parse(t.fetches[t.fetches.length - 1].opts.body);
  const entries = JSON.parse(sent.rows.filter((r) => r.key === "proteinEntries").map((r) => r.json_chunk).join(""));
  assert.equal(entries[0].proteinTotal, 48);
});

// ---------- 設定画面（いつもの量の保存） ----------

function fillProductForm(t, { name = "WINZONE", serving = "2", per = "14", quick = "" } = {}) {
  const inputs = { "pf-name": name, "pf-servingScoops": serving, "pf-proteinPerServing": per, "pf-quickScoops": quick };
  t.dom.els.clear();
  for (const [id, value] of Object.entries(inputs)) t.dom.els.set(id, { id, value });
}

test("設定: いつもの量（任意）を保存できる。空欄ならキーを持たない。範囲外は保存しない", () => {
  const t = setup();
  const s = stateWith(t, [winzone()]);
  t.Settings.render = () => {};
  t.Settings._productForm = { ...s.proteinProducts[0] };

  fillProductForm(t, { quick: "3" });
  t.Settings._saveProduct(s);
  assert.equal(s.proteinProducts[0].quickScoops, 3);
  assert.equal(s.proteinProducts.length, 1, "同じ商品を更新する");
  assert.equal(s.proteinProducts[0].isDefault, true);

  for (const bad of ["0", "11", "-1", "abc"]) {
    t.Settings._productForm = { ...s.proteinProducts[0] };
    fillProductForm(t, { quick: bad });
    t.Settings._saveProduct(s);
    assert.equal(s.proteinProducts[0].quickScoops, 3, `${bad}: 範囲外・不正は保存しない`);
    assert.match(t.Settings._error, /いつもの量/);
  }

  t.Settings._productForm = { ...s.proteinProducts[0] };
  fillProductForm(t, { quick: "" });
  t.Settings._saveProduct(s);
  assert.ok(!("quickScoops" in s.proteinProducts[0]), "空欄で未設定に戻せる");
  tap(t, s, "whey-quick");
  assert.equal(s.proteinEntries[0].quantity, 2, "未設定なら、規定量");
});

test("設定の表示: いつもの量が設定されている商品は、一覧に量が出る", () => {
  const t = setup();
  const s = stateWith(t, [winzone({ quickScoops: 3 })]);
  const row = t.Settings._productRowHtml(s.proteinProducts[0], s);
  assert.match(row, /2杯 = 14g／いつもの量 3スプーン/);
  const none = t.Settings._productRowHtml(winzone(), s);
  assert.doesNotMatch(none, /いつもの量/);
  assert.match(t.Settings._productFormHtml.call({ _productForm: { quickScoops: 3 } }), /id="pf-quickScoops" value="3"/);
});

// ---------- Google Sheets 自動バックアップ（既存の保存フックをそのまま使う） ----------

test("ワンタップ登録・取り消し・いつもの量の保存は、通常のsave経路を通り、自動バックアップの対象になる", async () => {
  const t = setup();
  t.S.init();
  const s = stateWith(t, [winzone({ quickScoops: 3 })]);
  const sheetTimers = () => t.timers.filter((x) => x.ms === t.S.DEBOUNCE_MS && !x.cleared);

  tap(t, s, "whey-quick");
  assert.equal(sheetTimers().length, 1, "ワンタップ登録で、同期が予約される（Storage.save → onSaved）");
  assert.equal(t.fetches.length, 0, "保存の時点では通信しない");
  assert.equal((await t.S.flush()).confirmed, true);
  const sent1 = JSON.parse(t.fetches[0].opts.body);
  const entries = JSON.parse(sent1.rows.filter((r) => r.key === "proteinEntries").map((r) => r.json_chunk).join(""));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].proteinTotal, 21, "登録した記録が、送られる内容に入っている");

  t.clock.t += 10 * 1000;
  t.dom.els.get("protein-toast").querySelector("[data-protein-undo]").listeners.click();
  assert.equal(sheetTimers().length, 1, "取り消し（削除）でも、同期が予約される");
  assert.equal((await t.S.flush()).confirmed, true);
  const sent2 = JSON.parse(t.fetches[1].opts.body);
  assert.equal(JSON.parse(sent2.rows.filter((r) => r.key === "proteinEntries").map((r) => r.json_chunk).join("")).length, 0);

  t.clock.t += 10 * 1000;
  t.Settings.render = () => {};
  t.Settings._productForm = { ...s.proteinProducts[0] };
  fillProductForm(t, { quick: "2.5" });
  t.Settings._saveProduct(s);
  assert.equal(sheetTimers().length, 1, "いつもの量の設定の保存でも、同期が予約される");
  assert.equal((await t.S.flush()).confirmed, true);
  const products = JSON.parse(JSON.parse(t.fetches[2].opts.body).rows.filter((r) => r.key === "proteinProducts").map((r) => r.json_chunk).join(""));
  assert.equal(products[0].quickScoops, 2.5, "いつもの量も、バックアップの内容に入る");
});

test("同期が失敗しても、ワンタップ登録・取り消しは通常どおり動く（記録の保存を止めない）", async () => {
  const t = setup();
  t.S.init();
  t.net.impl = async () => {
    throw new TypeError("Failed to fetch");
  };
  const s = stateWith(t, [winzone({ quickScoops: 3 })]);
  tap(t, s, "whey-quick");
  assert.equal((await t.S.flush()).ok, false);
  assert.equal(s.proteinEntries.length, 1);
  assert.equal(t.env.Storage.readOnly, false);
  t.clock.t += 5000;
  tap(t, s, "whey-quick");
  assert.equal(s.proteinEntries.length, 2, "同期の失敗のあとも、記録できる");
  assert.equal(JSON.parse(t.env.ls.getItem(t.env.STORAGE_KEY)).proteinEntries.length, 2);
});

test("自動バックアップを使っていなくても（未設定）、ワンタップ登録は通常どおり保存される", () => {
  const t = setup({ configured: false, enabled: false });
  t.S.init();
  const s = stateWith(t, [winzone({ quickScoops: 3 })]);
  tap(t, s, "whey-quick");
  assert.equal(s.proteinEntries.length, 1);
  assert.equal(t.timers.filter((x) => x.ms === t.S.DEBOUNCE_MS).length, 0);
  assert.equal(t.fetches.length, 0);
});
