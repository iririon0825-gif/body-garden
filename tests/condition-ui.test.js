// 体調・副作用: 画面層（HOMEのモード・下書き・保存手順・日付切替・エスケープ）。DOM は最小のダミーで置き換える

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { loadEnv, sampleState, clone } = require("./helpers");

const D = (day, h = 12, m = 0) => new Date(2026, 9, day, h, m, 0);

function setup(now = D(15)) {
  const env = loadEnv();
  const s = sampleState(env);
  s.conditionEntries = [];
  vm.runInContext(
    `function escapeHtml(s){return String(s).replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c]));}
     const __t = { cardHtml: null, renderHome: 0, detailHtml: null, modals: [], screens: [], hidden: 0, h: {} };
     const __card = { set innerHTML(v){ __t.cardHtml = v; }, get innerHTML(){ return __t.cardHtml; }, querySelectorAll(){ return []; }, querySelector(){ return null; } };
     const __home = { hidden: false, contains(){ return false; } };
     const setTimeout = () => 0;
     const UI = { state: null, lineIcon(){ return ""; }, showModal(h){ __t.modals.push(h); }, hideModal(){ __t.hidden++; }, switchScreen(n){ __t.screens.push(n); }, renderHome(){ __t.renderHome++; } };
     const document = {
       activeElement: null,
       querySelector(sel){ return sel.includes(".condition-card") ? __card : sel === '[data-screen="home"]' ? __home : null; },
       querySelectorAll(){ return []; },
       getElementById(id){ return id === "condition-root" ? { set innerHTML(v){ __t.detailHtml = v; } } : { addEventListener(ev, fn){ __t.h[id] = fn; }, scrollIntoView(){} }; },
       addEventListener(){}
     };`,
    env.ctx
  );
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", "ui-condition.js"), "utf8"), env.ctx, { filename: "ui-condition.js" });
  const ui = env.get("ConditionUI");
  const t = env.get("__t");
  const L = env.get("ConditionLogic");
  let clock = now;
  ui._now = () => new Date(clock.getTime());
  env.get("UI").state = s;
  const saves = { n: 0, ok: true };
  env.Storage.save = () => {
    saves.n++;
    return saves.ok;
  };
  return { env, ui, t, L, s, saves, setNow: (d) => (clock = d) };
}
const card = (ui, s) => ui.homeCardInnerHtml(s);

test("HOME: 記録が無いとき（add）は、顔を選んでもメモを入れても、記録するまで何も保存されない。レベル未選択では記録できない", () => {
  const { ui, s, saves } = setup();
  let html = card(ui, s);
  assert.match(html, /記録する/);
  assert.match(html, /id="cond-home-save" disabled/);
  ui._homeChoose("mild");
  ui._home.comment = "途中";
  assert.equal(saves.n, 0);
  assert.equal(s.conditionEntries.length, 0);
  html = card(ui, s);
  assert.doesNotMatch(html, /id="cond-home-save" disabled/);
  assert.match(html, /まだ保存していません/);
  assert.doesNotMatch(html, /cond-unsaved" hidden/);
});

test("HOME: 他のカードの再描画（renderHome）が走っても、選んだ段階とメモは下書きから描き直される", () => {
  const { ui, s } = setup();
  card(ui, s);
  ui._homeChoose("moderate");
  ui._home.comment = "胃が重い";
  const again = card(ui, s); // renderHome 相当
  assert.match(again, /value="胃が重い"/);
  assert.match(again, /data-cond-level="moderate"[^>]*>/);
  assert.match(again, /is-selected" data-cond-level="moderate" aria-pressed="true"/);
});

test("HOME: 記録するで1件保存し、記録済み（view）になる。保存の日付・時刻は保存の瞬間の now から作る", () => {
  const { ui, s, saves, setNow } = setup(D(15, 7, 30));
  card(ui, s);
  ui._homeChoose("mild");
  setNow(D(15, 7, 45));
  ui._homeSave();
  assert.equal(saves.n, 1);
  assert.equal(s.conditionEntries.length, 1);
  assert.equal(s.conditionEntries[0].date, "2026-10-15");
  assert.equal(s.conditionEntries[0].time, "07:45");
  assert.equal(s.conditionEntries[0].level, "mild");
  const html = card(ui, s);
  assert.match(html, /記録済み（07:45）/);
  assert.match(html, /この記録を直す/);
  assert.match(html, /もう1回記録する/);
});

test("HOME: 記録済み（view）で顔のボタンを押しても、保存も変更もされない（押せない見た目と aria）", () => {
  const { ui, s, L, saves } = setup();
  L.applyAdd(s, { date: "2026-10-15", time: "07:30", level: "mild", symptoms: [], comment: "朝" }, D(15, 7, 30));
  const html = card(ui, s);
  assert.match(html, /is-selected is-locked" data-cond-level="mild" aria-pressed="true" aria-disabled="true"/);
  const before = JSON.stringify(s);
  ui._homeChoose("none");
  ui._homeChoose("moderate");
  assert.equal(JSON.stringify(s), before);
  assert.equal(saves.n, 0);
  assert.equal(ui._home.mode, "view");
  assert.match(card(ui, s), /is-selected is-locked" data-cond-level="mild"/);
});

test("HOME: 朝「軽い」のあとに「もう1回記録する」で夜「なし」を追加すると、朝の記録は残り、表示は最新（夜）。今日 2件 と出る", () => {
  const { ui, s, L, setNow } = setup(D(15, 7, 30));
  L.applyAdd(s, { date: "2026-10-15", time: "07:30", level: "mild", symptoms: [], comment: "" }, D(15, 7, 30));
  card(ui, s);
  ui._homeAct("add");
  assert.equal(ui._home.mode, "add");
  assert.match(card(ui, s), /新しい記録を追加中/);
  ui._homeChoose("none");
  setNow(D(15, 21, 10));
  ui._homeSave();
  assert.deepEqual(clone(s.conditionEntries.map((e) => [e.level, e.time])), [["mild", "07:30"], ["none", "21:10"]]);
  const html = card(ui, s);
  assert.match(html, /今日 2件/);
  assert.match(html, /is-selected is-locked" data-cond-level="none"/);
});

test("HOME: 「この記録を直す」は最新の記録を同じ記録のまま更新する（件数は増えない）。やめる、で下書きを捨てる", () => {
  const { ui, s, L, setNow } = setup();
  const e = L.applyAdd(s, { date: "2026-10-15", time: "07:30", level: "mild", symptoms: ["nausea"], comment: "朝" }, D(15, 7, 30)).entry;
  card(ui, s);
  ui._homeAct("edit");
  assert.equal(ui._home.mode, "edit");
  ui._home.comment = "朝（少し楽）";
  ui._homeChoose("moderate");
  setNow(D(15, 12, 5));
  ui._homeSave();
  assert.equal(s.conditionEntries.length, 1);
  assert.equal(s.conditionEntries[0].id, e.id);
  assert.equal(s.conditionEntries[0].level, "moderate");
  assert.equal(s.conditionEntries[0].comment, "朝（少し楽）");
  assert.deepEqual(clone(s.conditionEntries[0].symptoms), ["nausea"], "HOMEでは症状を触らない");
  assert.equal(s.conditionEntries[0].createdAt, e.createdAt);
  ui._homeAct("edit");
  ui._homeChoose("none");
  ui._homeAct("cancel");
  assert.equal(ui._home.mode, "view");
});

test("HOME: severe の記録は「あり」と表示され、直して「あり」のまま更新しても保存値は severe のまま", () => {
  const { ui, s } = setup();
  s.conditionEntries = [{ id: 1, date: "2026-10-15", time: "08:00", level: "severe", symptoms: [], comment: "", createdAt: D(15, 8).toISOString() }];
  assert.match(card(ui, s), /is-selected is-locked" data-cond-level="moderate"/);
  ui._homeAct("edit");
  ui._home.comment = "追記";
  ui._homeChoose("moderate");
  ui._homeSave();
  assert.equal(s.conditionEntries[0].level, "severe");
  assert.equal(s.conditionEntries[0].comment, "追記");
});

test("HOME: メモに改行がある記録を直すときは、メモは変えず（入力欄を出さず）段階だけ更新する", () => {
  const { ui, s } = setup();
  s.conditionEntries = [{ id: 1, date: "2026-10-15", time: "08:00", level: "mild", symptoms: [], comment: "1行目\n2行目", createdAt: D(15, 8).toISOString() }];
  ui._homeAct("edit");
  const html = card(ui, s);
  assert.doesNotMatch(html, /id="cond-home-memo"/);
  assert.match(html, /詳しく記録」で編集できます/);
  ui._homeChoose("none");
  ui._homeSave();
  assert.equal(s.conditionEntries[0].level, "none");
  assert.equal(s.conditionEntries[0].comment, "1行目\n2行目");
});

test("HOME: 症状つきの記録を「なし」に変えようとすると保存せず、理由と「詳しく記録」への案内を出す", () => {
  const { ui, s } = setup();
  s.conditionEntries = [{ id: 1, date: "2026-10-15", time: "08:00", level: "mild", symptoms: ["nausea"], comment: "", createdAt: D(15, 8).toISOString() }];
  ui._homeAct("edit");
  ui._homeChoose("none");
  const before = JSON.stringify(s);
  ui._homeSave();
  assert.equal(JSON.stringify(s), before);
  assert.match(card(ui, s), /症状が選ばれているため/);
});

test("HOME: 保存に失敗したら配列を元に戻し、「何も変更していません」と出す。読み取り専用のときは書き込まない", () => {
  const { ui, s, saves } = setup();
  card(ui, s);
  ui._homeChoose("mild");
  saves.ok = false;
  ui._homeSave();
  assert.equal(s.conditionEntries.length, 0);
  assert.match(card(ui, s), /何も変更していません/);
  saves.ok = true;
  const before = saves.n;
  loadReadOnly(ui);
  ui._homeChoose("mild");
  ui._homeSave();
  assert.equal(saves.n, before, "読み取り専用では Storage.save を呼ばない");
  assert.equal(s.conditionEntries.length, 0);
  assert.match(card(ui, s), /いまは変更を保存できません/);
  assert.match(card(ui, s), /id="cond-home-save" disabled/);
});
function loadReadOnly(ui) {
  ui._writable = () => false;
}

test("日付: 昨日の下書きは、今日の記録として保存されない。日付をまたぐと、HOMEの「今日」は今日の記録だけを見る（昨日の記録を今日として表示しない）", () => {
  const { ui, s, L, setNow } = setup(D(14, 23, 50));
  L.applyAdd(s, { date: "2026-10-14", time: "23:00", level: "moderate", symptoms: [], comment: "昨夜" }, D(14, 23, 0));
  assert.match(card(ui, s), /記録済み（23:00）/);
  ui._homeAct("add");
  ui._homeChoose("none");
  ui._home.comment = "下書き";
  setNow(D(15, 0, 0));
  const html = card(ui, s); // 描画の時点で、下書きは今日のものに切り替わる
  assert.doesNotMatch(html, /記録済み/);
  assert.doesNotMatch(html, /昨夜/);
  assert.equal(ui._home.date, "2026-10-15");
  // 0時直前に作った下書きを、0時をまたいで保存しようとした場合
  setNow(D(14, 23, 59));
  ui._home = null;
  card(ui, s);
  ui._homeAct("add");
  ui._homeChoose("mild");
  setNow(D(15, 0, 0));
  const before = JSON.stringify(s);
  ui._homeSave();
  assert.equal(JSON.stringify(s), before, "日付が変わっていたら保存しない");
});

test("日付切替: 変わったことを検出したらHOMEを描き直し、下書きを捨てる。入力中は描き直さず、次の確認で更新する", () => {
  const { env, ui, t, s, setNow } = setup(D(14, 23, 50));
  ui._lastDate = "2026-10-14";
  assert.equal(ui.checkDateChange(), false, "同じ日なら何もしない");
  card(ui, s);
  ui._homeChoose("mild");
  setNow(D(15, 0, 1));
  // 入力中
  env.get("document").activeElement = { tagName: "INPUT" };
  env.get("__home").contains = () => true;
  assert.equal(ui.checkDateChange(), false);
  assert.equal(t.renderHome, 0);
  // 入力が終わった
  env.get("document").activeElement = null;
  assert.equal(ui.checkDateChange(), true);
  assert.equal(t.renderHome, 1);
  assert.equal(ui._home, null, "昨日の下書きは捨てる");
  assert.equal(ui._lastDate, "2026-10-15");
});

test("編集の下書き: 編集中の記録が削除されて同じidで別の記録ができても、古い下書きでは上書きしない（下書きは破棄される）", () => {
  const { ui, s, L, setNow } = setup(D(15, 8));
  const a = L.applyAdd(s, { date: "2026-10-15", time: "08:00", level: "mild", symptoms: [], comment: "朝" }, D(15, 8)).entry;
  card(ui, s);
  ui._homeAct("edit");
  ui._home.comment = "朝の直し";
  // 記録タブ相当の操作: 削除して、新しい記録を追加（id が再利用される）
  L.applyDelete(s, a.id, L.sourceOf(a));
  const b = L.applyAdd(s, { date: "2026-10-15", time: "21:00", level: "none", symptoms: [], comment: "夜" }, D(15, 21)).entry;
  assert.equal(b.id, a.id);
  setNow(D(15, 21, 5));
  ui._homeSave();
  assert.equal(s.conditionEntries[0].comment, "夜", "新しい記録は上書きされない");
  assert.equal(s.conditionEntries[0].level, "none");
});

test("エスケープ: メモ・症状・時刻・日付に入っていたタグは、HOME・履歴ともに文字として出る", () => {
  const { ui, s } = setup();
  const evil = '<img src=x onerror=alert(1)>"\'&';
  s.conditionEntries = [
    { id: 1, date: "2026-10-15", time: "08:00", level: "mild", symptoms: ["nausea", "<b>x</b>"], comment: evil, createdAt: D(15, 8).toISOString() },
    { id: 2, date: "2026-10-14", time: "<i>", level: "none", symptoms: [], comment: evil, createdAt: D(14, 8).toISOString() },
  ];
  const home = card(ui, s);
  ui.renderDetail(s);
  ui._view = "history";
  const dh = ui._detailHtml(s);
  ui._view = "edit";
  ui._edit = ui._detailFromEntry(s.conditionEntries[0]);
  const eh = ui._detailHtml(s);
  assert.match(eh, /&lt;img/, "編集フォームの値もエスケープされる");
  assert.doesNotMatch(eh, /<img/);
  for (const html of [home, dh]) {
    assert.doesNotMatch(html, /<img/);
    assert.doesNotMatch(html, /<b>x/);
    assert.doesNotMatch(html, /<i>/);
  }
  assert.match(home, /&lt;img/);
  assert.match(dh, /&lt;img/);
});

test("記録タブ: 追加で古い日付の記録を足すと、履歴に出る日数が広がり、履歴に戻る。編集の更新・削除（確認付き）も1件だけに作用する", () => {
  const { ui, s, saves } = setup();
  ui._historyDates = 1;
  const base = (date) => ({ date, time: "", level: "mild", symptoms: ["nausea"], comment: "x" });
  for (const d of ["2026-10-14", "2026-10-13"]) {
    ui._view = "new";
    ui._new = { mode: "add", source: null, ...base(d), timeAuto: false };
    ui._detailSave(s);
    assert.equal(ui._view, "history", "保存したら履歴に戻る");
    assert.equal(ui._new, null, "保存した下書きは破棄する");
  }
  assert.equal(s.conditionEntries.length, 2);
  assert.ok(ui._historyDates >= 2, "追加した日付が履歴に出る");
  // 編集は、履歴で「編集」を選んだときだけ始まる
  const e = s.conditionEntries[0];
  assert.equal(ui._edit, null);
  ui._startEdit(s, e.id);
  assert.equal(ui._view, "edit");
  ui._edit.level = "none";
  ui._edit.symptoms = [];
  ui._detailSave(s);
  assert.equal(s.conditionEntries.find((x) => x.id === e.id).level, "none");
  assert.equal(s.conditionEntries.length, 2);
  assert.equal(ui._view, "history");
  assert.equal(ui._edit, null);
  // 削除は確認モーダルを出し、OK で1件だけ消える
  const before = saves.n;
  ui._confirmDelete(s, e.id);
  assert.equal(saves.n, before, "確認を出しただけでは保存しない");
});

test("記録タブ: 「詳しく記録」は入口。HOMEの下書きにも既存の記録にも触れず、「新しく記録する」を開く（記録済みでも編集画面は開かない）", () => {
  const { ui, s, L, t } = setup();
  L.applyAdd(s, { date: "2026-10-15", time: "07:30", level: "mild", symptoms: [], comment: "朝" }, D(15, 7, 30));
  card(ui, s);
  ui._homeAct("more");
  assert.deepEqual(clone(t.screens), ["records"]);
  assert.equal(ui._view, "new");
  assert.equal(ui._edit, null, "既存の記録の編集は始まらない");
  assert.equal(s.conditionEntries.length, 1);
  assert.equal(s.conditionEntries[0].comment, "朝");
  // HOME で入力途中のとき: 下書きはHOMEに残る（消えない・二重にならない）
  ui._homeAct("add");
  ui._homeChoose("none");
  ui._home.comment = "夜";
  ui._homeAct("more");
  assert.equal(ui._home.level, "none");
  assert.equal(ui._home.comment, "夜");
  assert.equal(s.conditionEntries.length, 1, "移動だけでは保存しない");
  assert.equal(ui._new, null, "記録タブの下書きにHOMEの内容を持ち込まない");
});

test("記録タブ: 履歴を見る → 編集は明示操作。編集中に移動すると、変更があれば確認を出し、破棄を選ぶまで編集を続けられる", () => {
  const { ui, s, L, t } = setup();
  const e = L.applyAdd(s, { date: "2026-10-14", time: "08:00", level: "mild", symptoms: ["nausea"], comment: "a" }, D(14, 8)).entry;
  ui._view = "history";
  ui._startEdit(s, e.id);
  assert.equal(ui._view, "edit");
  // 変更なしで移動 → 確認なしで移動
  ui._setView(s, "new");
  assert.equal(ui._view, "new");
  assert.equal(ui._edit, null);
  // 変更ありで移動 → 確認を出し、まだ移動しない
  ui._startEdit(s, e.id);
  ui._edit.comment = "b";
  const n = t.modals.length;
  ui._setView(s, "history");
  assert.equal(t.modals.length, n + 1);
  assert.equal(ui._view, "edit", "確認の間は編集のまま");
  assert.ok(ui._edit);
  assert.equal(s.conditionEntries[0].comment, "a", "元の記録は変わらない");
});

test("記録タブ: 新しく記録する の下書きは、履歴を見に行って戻っても消えない", () => {
  const { ui, s } = setup();
  ui._view = "new";
  ui._detailDraft(s);
  ui._new.level = "mild";
  ui._new.comment = "書きかけ";
  ui._setView(s, "history");
  ui._setView(s, "new");
  assert.equal(ui._new.comment, "書きかけ");
  assert.equal(ui._new.level, "mild");
});

test("記録タブ: 編集中の記録が別の操作で変わった・消えたら、編集を終えて履歴に戻る（古い下書きで上書きしない）", () => {
  const { ui, s, L } = setup();
  const e = L.applyAdd(s, { date: "2026-10-14", time: "08:00", level: "mild", symptoms: [], comment: "a" }, D(14, 8)).entry;
  ui._startEdit(s, e.id);
  ui._edit.comment = "編集中";
  L.applyDelete(s, e.id, L.sourceOf(e));
  L.applyAdd(s, { date: "2026-10-14", time: "21:00", level: "none", symptoms: [], comment: "別の記録" }, D(14, 21)); // id が再利用される
  ui._detailSave(s);
  assert.equal(s.conditionEntries[0].comment, "別の記録");
  assert.equal(ui._view, "history");
  assert.equal(ui._edit, null);
});

test("顔アイコン: 画像が未設定の間は枠と文字ラベルだけ。パスを設定すると枠の中に img が入る（絵文字は使わない）", () => {
  const { env, ui, s } = setup();
  let html = card(ui, s);
  assert.match(html, /class="cond-face" data-face="none" aria-hidden="true"><\/span>/);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /[\u{1F300}-\u{1FAFF}☀-➿]/u, "絵文字を使わない");
  env.get("CONDITION_FACE_ASSETS").none = "assets/body-garden/face-none.png";
  html = card(ui, s);
  assert.match(html, /<span class="cond-face" data-face="none"[^>]*><img src="assets\/body-garden\/face-none.png" alt="" onerror="this.remove\(\)" \/><\/span>/);
});

test("医療判断を示唆する文言（診断・治療・受診・危険・注意）を、画面に出さない。注意書きは「医療の判断や診断ではありません」", () => {
  const { ui, s } = setup();
  const html = card(ui, s) + ui._detailHtml(s);
  assert.doesNotMatch(html, /受診|危険|警告|副作用の可能性|薬を|中止|相談してください/);
  assert.match(html, /医療の判断や診断ではありません/);
});

test("HOME保存: 日付が変わっていた／編集元が変わっていたときは、保存せず、それぞれの案内を出す（「どれかを選んでください」にならない）", () => {
  const { ui, s, L, setNow } = setup(D(14, 23, 58));
  card(ui, s);
  ui._homeChoose("mild");
  setNow(D(15, 0, 0));
  const before = JSON.stringify(s);
  ui._homeSave();
  assert.equal(JSON.stringify(s), before);
  assert.match(card(ui, s), /日付が変わりました/);
  assert.doesNotMatch(card(ui, s), /どれかを選んでください/);
  // 編集元が変わった
  const { ui: u2, s: s2, L: L2, setNow: set2 } = setup(D(15, 8));
  const a = L2.applyAdd(s2, { date: "2026-10-15", time: "08:00", level: "mild", symptoms: [], comment: "朝" }, D(15, 8)).entry;
  card(u2, s2);
  u2._homeAct("edit");
  u2._homeChoose("moderate");
  L2.applyDelete(s2, a.id, L2.sourceOf(a));
  L2.applyAdd(s2, { date: "2026-10-15", time: "21:00", level: "none", symptoms: [], comment: "夜" }, D(15, 21));
  set2(D(15, 21, 5));
  u2._homeSave();
  assert.equal(s2.conditionEntries[0].comment, "夜");
  assert.equal(s2.conditionEntries[0].level, "none");
  assert.match(card(u2, s2), /編集していた記録が変わったため/);
  void L;
});

test("日付をまたいだあと（描き直される前）のメモ入力・顔の選択は、古い編集の下書きを黙って「追加」に変えない。案内して捨てる", () => {
  const { ui, s, L, setNow } = setup(D(14, 23, 58));
  const e = L.applyAdd(s, { date: "2026-10-14", time: "20:00", level: "mild", symptoms: [], comment: "昨夜" }, D(14, 20)).entry;
  card(ui, s);
  ui._homeAct("edit");
  ui._home.comment = "昨夜の追記";
  setNow(D(15, 0, 1));
  ui._homeChoose("none"); // 0時を過ぎてから選ぶ
  assert.equal(ui._home.date, "2026-10-15", "古い下書きは捨てられ、今日の新しい下書きになる");
  assert.equal(ui._home.level, null);
  assert.equal(ui._home.comment, "");
  assert.match(ui._homeMsg, /日付が変わりました/);
  assert.equal(s.conditionEntries.length, 1);
  assert.equal(s.conditionEntries[0].id, e.id);
  const html = card(ui, s);
  assert.doesNotMatch(html, /昨夜の追記/, "昨日の編集内容が今日の下書きに持ち込まれない");
  assert.equal(ui._home.mode, "add");
});

test("HOME: 編集中の表示時刻は、編集している記録のもの。別の記録が追加されても食い違わない", () => {
  const { ui, s, L } = setup();
  L.applyAdd(s, { date: "2026-10-15", time: "07:30", level: "mild", symptoms: [], comment: "A" }, D(15, 7, 30));
  card(ui, s);
  ui._homeAct("edit");
  L.applyAdd(s, { date: "2026-10-15", time: "21:00", level: "none", symptoms: [], comment: "B" }, D(15, 21)); // 記録タブで追加
  const html = card(ui, s);
  assert.match(html, /記録を編集中（07:30）/);
  assert.doesNotMatch(html, /21:00/);
});

test("severe の記録: 別の段階を選んだあとに「あり」へ戻しても severe のまま。変更なしと判定され、未保存表示も出ない", () => {
  const { ui, s } = setup();
  s.conditionEntries = [{ id: 1, date: "2026-10-15", time: "08:00", level: "severe", symptoms: [], comment: "", createdAt: D(15, 8).toISOString() }];
  card(ui, s);
  ui._homeAct("edit");
  ui._homeChoose("mild");
  ui._homeChoose("moderate");
  assert.equal(ui._home.level, "severe");
  assert.doesNotMatch(card(ui, s), /id="cond-home-save" >|cond-unsaved" >/);
  assert.match(card(ui, s), /cond-unsaved" hidden/);
  assert.match(card(ui, s), /id="cond-home-save" disabled/);
  // 記録タブ
  ui._startEdit(s, 1);
  ui._edit.level = "mild";
  ui._edit.level = ui._edit.source.level === "severe" ? "severe" : "moderate"; // クリック処理と同じ規則
  assert.equal(ui._editDirty(s), false);
});

test("記録タブ（新しく記録する）: 日付・時刻は、開いたときではなく、描くとき・保存するときの now に合わせる。本人が触った日付は動かさない", () => {
  const { ui, s, setNow } = setup(D(14, 8, 0));
  ui._view = "new";
  ui._detailDraft(s);
  assert.equal(ui._new.date, "2026-10-14");
  assert.equal(ui._new.time, "08:00");
  setNow(D(15, 21, 0)); // 翌日の夜に、また記録タブを開いて保存する
  ui._new.level = "mild";
  ui._detailSave(s);
  assert.equal(s.conditionEntries.length, 1);
  assert.equal(s.conditionEntries[0].date, "2026-10-15");
  assert.equal(s.conditionEntries[0].time, "21:00");
  // 日付を本人が選んだとき（過去日）は、そのまま
  ui._view = "new";
  ui._detailDraft(s);
  ui._new.date = "2026-10-10";
  ui._new.dateAuto = false;
  ui._new.time = "";
  ui._new.timeAuto = false;
  ui._new.level = "none";
  setNow(D(16, 9, 0));
  ui._detailSave(s);
  assert.equal(s.conditionEntries[1].date, "2026-10-10");
  assert.equal(s.conditionEntries[1].time, null);
});

test("「詳しく記録」: 記録タブで編集の途中なら、その編集を続ける（未保存の編集を失わない）", () => {
  const { ui, s, L } = setup();
  const e = L.applyAdd(s, { date: "2026-10-14", time: "08:00", level: "mild", symptoms: [], comment: "a" }, D(14, 8)).entry;
  ui._startEdit(s, e.id);
  ui._edit.comment = "編集中の内容";
  ui._homeAct("more");
  assert.equal(ui._view, "edit");
  assert.equal(ui._edit.comment, "編集中の内容");
});

test("未知の症状が残る記録の編集フォームには、その症状のチェックボックスが出る（外せる）。値はエスケープされる", () => {
  const { ui, s } = setup();
  s.conditionEntries = [{ id: 1, date: "2026-10-14", time: null, level: "mild", symptoms: ["head<ache>"], comment: "", createdAt: D(14, 8).toISOString() }];
  ui._startEdit(s, 1);
  const html = ui._detailHtml(s);
  assert.match(html, /data-cond-symptom="head&lt;ache&gt;" checked/);
  assert.doesNotMatch(html, /head<ache>/);
});

test("削除の確定: OK で1件だけ消える。保存失敗は元に戻す。確認のあとで記録が変わっていたら消さない。読み取り専用では消さない", () => {
  const { ui, s, L, t, saves } = setup();
  const a = L.applyAdd(s, { date: "2026-10-14", time: "08:00", level: "mild", symptoms: [], comment: "a" }, D(14, 8)).entry;
  const b = L.applyAdd(s, { date: "2026-10-14", time: "21:00", level: "none", symptoms: [], comment: "b" }, D(14, 21)).entry;
  // 保存失敗 → 元に戻る
  saves.ok = false;
  ui._confirmDelete(s, b.id);
  t.h["cond-del-ok"]();
  assert.equal(s.conditionEntries.length, 2);
  assert.match(ui._detailMsg, /何も変更していません/);
  // 確認のあとで、その記録が別の操作で変わった → 消さない
  saves.ok = true;
  ui._confirmDelete(s, b.id);
  s.conditionEntries = s.conditionEntries.map((e) => (e.id === b.id ? { ...e, comment: "変更された" } : e));
  t.h["cond-del-ok"]();
  assert.equal(s.conditionEntries.length, 2);
  assert.match(ui._detailMsg, /変わりました/);
  // 読み取り専用 → 消さない
  ui._writable = () => false;
  ui._confirmDelete(s, a.id);
  const n = saves.n;
  t.h["cond-del-ok"]();
  assert.equal(s.conditionEntries.length, 2);
  assert.equal(saves.n, n);
  // 通常 → その1件だけ消える
  ui._writable = () => true;
  ui._confirmDelete(s, a.id);
  t.h["cond-del-ok"]();
  assert.deepEqual(clone(s.conditionEntries.map((e) => e.id)), [b.id]);
  assert.match(ui._detailMsg, /削除しました/);
});

test("記録タブの保存: 保存失敗は元に戻し「何も変更していません」。読み取り専用では保存しない。編集中の破棄確認で OK を押すと変更が破棄される", () => {
  const { ui, s, L, t, saves } = setup();
  ui._view = "new";
  ui._detailDraft(s);
  ui._new.level = "mild";
  saves.ok = false;
  ui._detailSave(s);
  assert.equal(s.conditionEntries.length, 0);
  assert.match(ui._detailMsg, /何も変更していません/);
  assert.equal(ui._view, "new", "失敗したときは入力画面のまま（入力は残る）");
  assert.equal(ui._new.level, "mild");
  saves.ok = true;
  ui._writable = () => false;
  const n = saves.n;
  ui._detailSave(s);
  assert.equal(saves.n, n);
  assert.equal(s.conditionEntries.length, 0);
  ui._writable = () => true;
  // 編集中の破棄確認
  const e = L.applyAdd(s, { date: "2026-10-14", time: "08:00", level: "mild", symptoms: [], comment: "a" }, D(14, 8)).entry;
  ui._startEdit(s, e.id);
  ui._edit.comment = "b";
  ui._setView(s, "history");
  t.h["cond-leave-ok"]();
  assert.equal(ui._view, "history");
  assert.equal(ui._edit, null);
  assert.equal(s.conditionEntries[0].comment, "a");
});

test("日付切替: HOMEが非表示のときは、描き直さずに今日へ切り替え、下書きを捨てる（他の画面は次に開いたときに描く）", () => {
  const { env, ui, t, s, setNow } = setup(D(14, 23, 50));
  ui._lastDate = "2026-10-14";
  card(ui, s);
  ui._homeChoose("mild");
  env.get("__home").hidden = true;
  setNow(D(15, 0, 1));
  assert.equal(ui.checkDateChange(), true);
  assert.equal(t.renderHome, 0);
  assert.equal(ui._home, null);
  assert.equal(ui._lastDate, "2026-10-15");
});

