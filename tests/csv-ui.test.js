// 分析用CSV書き出し: 画面層（CsvUI）。iOS判定・共有/ダウンロードの分岐・フォールバック・非干渉。DOM/navigatorは最小のダミーで置き換える

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { loadEnv, sampleState } = require("./helpers");

function setupStateful({ isIOS = false, shareImpl = null, canShareImpl = null } = {}) {
  const env = loadEnv();
  const s = sampleState(env);
  vm.runInContext(
    `function escapeHtml(s){return String(s).replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c]));}
     const UI = { lineIcon(){ return ""; } };
     const __dom = { status: "", downloads: [] };
     const __elements = {};
     function __elFor(id){
       return {
         set innerHTML(v){ this._html = v; if (id === "csv-root") __dom.lastRootHtml = v; if (id === "csv-fallback") __dom.fallbackHtml = v; },
         get innerHTML(){ return this._html || ""; },
         set textContent(v){ __dom.status = v; },
         get textContent(){ return __dom.status; },
         hidden: id === "csv-fallback" ? true : false,
         disabled: false,
         querySelectorAll(){ return []; },
         querySelector(){ return null; },
         addEventListener(){},
       };
     }
     const document = {
       getElementById(id){
         if (!__elements[id]) __elements[id] = __elFor(id);
         return __elements[id];
       },
       querySelectorAll(){ return []; },
       createElement(){ return { set href(v){}, set download(v){ __dom.downloads.push(v); }, click(){}, remove(){}, style:{} }; },
       body: { appendChild(){} },
     };
     class File { constructor(parts, name, opts){ this.parts = parts; this.name = name; this.type = opts && opts.type; } }
     class Blob { constructor(parts, opts){ this.parts = parts; this.type = opts && opts.type; } }
     const URL = { createObjectURL(){ return "blob:x"; }, revokeObjectURL(){} };
     function setTimeout(fn){ fn(); return 0; }`,
    env.ctx
  );
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", "ui-csv.js"), "utf8"), env.ctx, { filename: "ui-csv.js" });
  const ui = env.get("CsvUI");

  const shareCalls = [];
  const navigator = {
    userAgent: isIOS ? "iPhone" : "DesktopBrowser",
    platform: isIOS ? "iPhone" : "Win32",
    maxTouchPoints: isIOS ? 5 : 0,
  };
  if (canShareImpl) navigator.canShare = canShareImpl;
  if (shareImpl)
    navigator.share = (opts) => {
      shareCalls.push(opts);
      return shareImpl(opts);
    };
  Object.defineProperty(env.ctx, "navigator", { value: navigator, configurable: true });

  const dom = env.get("__dom");
  const elements = () => env.get("__elements");
  return { env, ui, s, dom, shareCalls, elements };
}

// ---------- 基本の表示 ----------

test("設定タブに「すべて書き出す」と6シート分の個別ボタンが出る（export_infoは個別の対象外）。復元できない旨の注意書きが出る", () => {
  const { ui, s, dom } = setupStateful({});
  ui.render(s);
  const html = dom.lastRootHtml;
  assert.match(html, /すべて書き出す（7ファイル）/);
  for (const sheet of ["weight", "body_composition", "protein", "injections", "injection_schedule", "conditions"]) {
    assert.match(html, new RegExp(`data-csv-sheet="${sheet}"`));
  }
  assert.doesNotMatch(html, /data-csv-sheet="export_info"/);
  assert.match(html, /復元する機能はありません/);
});

test("シート名にHTMLが混ざっていてもエスケープされる", () => {
  const { ui, s, dom, env } = setupStateful({});
  const L = env.get("CsvLogic");
  L.SHEET_LABELS = { ...L.SHEET_LABELS, weight: "<script>x</script>" };
  ui.render(s);
  assert.doesNotMatch(dom.lastRootHtml, /<script>x/);
  assert.match(dom.lastRootHtml, /&lt;script&gt;x/);
});

// ---------- iOS以外: ダウンロード ----------

test("iOS以外で「すべて書き出す」を押すと、7件を続けてダウンロードし、完了表示を出す", () => {
  const { ui, s, dom } = setupStateful({ isIOS: false });
  ui.render(s);
  ui._exportAll();
  assert.equal(dom.downloads.length, 7);
  assert.ok(dom.downloads.every((n) => /^body-garden-.+\.csv$/.test(n)));
  assert.match(dom.status, /7ファイルのダウンロードを開始/);
});

test("iOS以外の個別シート書き出しは、1件だけダウンロードする", () => {
  const { ui, s, dom } = setupStateful({ isIOS: false });
  ui.render(s);
  ui._exportOne("conditions");
  assert.equal(dom.downloads.length, 1);
  assert.match(dom.downloads[0], /^body-garden-conditions-/);
  assert.match(dom.status, /書き出しました/);
});

// ---------- iOS: 複数ファイル共有に対応 ----------

test("iOSでcanShareが複数ファイルに対応していれば、クリックハンドラの中でcanShare→shareを同期的に呼び、1回のshareで7ファイル渡す（ダウンロードはしない）", async () => {
  const { ui, s, dom, shareCalls } = setupStateful({
    isIOS: true,
    canShareImpl: ({ files }) => files.length <= 10,
    shareImpl: async () => {},
  });
  ui.render(s);
  ui._exportAll();
  assert.equal(shareCalls.length, 1, "shareはクリックハンドラの中で同期的に1回だけ呼ばれる");
  assert.equal(shareCalls[0].files.length, 7);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(dom.downloads.length, 0, "共有できたときはダウンロードしない");
  assert.match(dom.status, /7ファイルを渡しました/);
});

test("iOSでshare中にキャンセル（AbortError）したら、個別フォールバックは出さずキャンセル表示にする", async () => {
  const abort = Object.assign(new Error("abort"), { name: "AbortError" });
  const { ui, s, dom, shareCalls, elements } = setupStateful({
    isIOS: true,
    canShareImpl: () => true,
    shareImpl: async () => {
      throw abort;
    },
  });
  ui.render(s);
  ui._exportAll();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(shareCalls.length, 1);
  assert.match(dom.status, /キャンセル/);
  assert.equal(elements()["csv-fallback"].hidden, true, "キャンセル時はフォールバック一覧を出さない");
});

test("iOSで複数ファイルのcanShareがfalseのときは、最初から1件ずつ渡す一覧になる（同じFileを使い回す）", () => {
  const { ui, s, dom, elements } = setupStateful({
    isIOS: true,
    canShareImpl: ({ files }) => files.length === 1, // 複数ファイルは非対応、単体は対応
  });
  ui.render(s);
  ui._exportAll();
  assert.equal(ui._fallback.length, 7, "個別フォールバックの一覧が保持される");
  assert.equal(elements()["csv-fallback"].hidden, false);
  assert.match(dom.fallbackHtml, /body-garden-weight-/);
  assert.match(dom.fallbackHtml, /body-garden-export_info-/, "exportInfoも個別一覧には含める（まとめての共有に使うため）");
});

test("iOSで複数ファイルの共有に失敗した（reject）ときも、同じ7ファイルで個別フォールバックに切り替わる", async () => {
  const fail = new Error("not allowed");
  const { ui, s, dom, shareCalls } = setupStateful({
    isIOS: true,
    canShareImpl: () => true,
    shareImpl: async (opts) => {
      if (opts.files.length > 1) throw fail;
    },
  });
  ui.render(s);
  ui._exportAll();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(shareCalls.length, 1);
  assert.equal(ui._fallback.length, 7);
  assert.match(dom.status, /1件ずつ書き出せる/);
});

test("個別フォールバックの1件だけを共有/ダウンロードできる（他の6件は渡さない）", async () => {
  const { ui, s, dom, shareCalls } = setupStateful({
    isIOS: true,
    canShareImpl: () => false, // 複数も単体も非対応 → ダウンロードへ
  });
  ui.render(s);
  ui._exportAll();
  assert.equal(ui._fallback.length, 7);
  const first = ui._fallback[0];
  dom.downloads.length = 0;
  ui._exportOne(first.sheet);
  assert.equal(dom.downloads.length, 1);
  assert.equal(shareCalls.length, 0);
});

// ---------- 非干渉・安全性 ----------

test("書き出しはstateを一切変更しない", () => {
  const { ui, s } = setupStateful({ isIOS: false });
  const before = JSON.stringify(s);
  ui.render(s);
  ui._exportAll();
  ui._exportOne("weight");
  assert.equal(JSON.stringify(s), before);
});

test("canShare/share が無い旧いiOS相当でも例外にならず、ダウンロードへ進む", () => {
  const { ui, s, dom } = setupStateful({ isIOS: true }); // canShareImpl/shareImpl を渡さない
  ui.render(s);
  assert.doesNotThrow(() => ui._exportAll());
  assert.equal(dom.downloads.length, 7);
});
