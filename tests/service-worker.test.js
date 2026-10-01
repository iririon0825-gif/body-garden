// Service Worker とキャッシュ対象の整合（index.html の読み込みURLと事前キャッシュのずれ・旧版と新版の混在を防ぐ）

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const sw = fs.readFileSync(path.join(ROOT, "service-worker.js"), "utf8");

// service-worker.js が index.html から読み取るのと同じ正規表現
const PAGE_URL_RE = /(?:src|href)="((?:js|css)\/[^"]+)"/g;
const pageUrls = [...html.matchAll(PAGE_URL_RE)].map((m) => m[1]);

test("index.html の js/css 読み込みは、すべて実在するファイルで、?t= が付いている", () => {
  assert.ok(pageUrls.length >= 15, `読み込みURLを取り出せている（${pageUrls.length}件）`);
  for (const u of pageUrls) {
    const file = u.split("?")[0];
    assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} が存在する`);
    assert.match(u, /\?t=\d+$/, `${u} にキャッシュ更新用の ?t= がある`);
  }
});

test("js/ にあるスクリプトは、すべて index.html から読み込まれている（読み込み漏れ・キャッシュ漏れがない）", () => {
  const loaded = new Set(pageUrls.map((u) => u.split("?")[0]));
  const onDisk = fs.readdirSync(path.join(ROOT, "js")).filter((f) => f.endsWith(".js")).map((f) => `js/${f}`);
  for (const f of onDisk) assert.ok(loaded.has(f), `${f} が index.html から読み込まれている`);
});

test("読み込みURLは重複しない（同じファイルを別の ?t= で2回読まない＝新旧の混在がない）", () => {
  const files = pageUrls.map((u) => u.split("?")[0]);
  assert.equal(new Set(files).size, files.length);
});

test("Service Worker は事前キャッシュのURLを index.html から取り出す（手書きのJS一覧を持たない）", () => {
  assert.match(sw, /\(\?:src\|href\)="\(\(\?:js\|css\)\\\/\[\^"\]\+\)"/, "index.html の js/css 読み込みを正規表現で取り出している");
  for (const u of pageUrls) {
    const file = u.split("?")[0];
    assert.ok(!sw.includes(`"${file}"`), `${file} を service-worker.js に手書きしていない`);
  }
});

test("Service Worker の固定URLはすべて実在する（1件でも欠けると install が失敗する）", () => {
  const block = sw.slice(sw.indexOf("const STATIC_URLS"), sw.indexOf("];", sw.indexOf("const STATIC_URLS")));
  const urls = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((u) => u !== "./");
  assert.ok(urls.length >= 3);
  for (const u of urls) assert.ok(fs.existsSync(path.join(ROOT, u)), `${u} が存在する`);
});

test("オフライン時の照合は完全一致のみ（?t= を無視した照合で旧版ファイルを返さない）", () => {
  assert.ok(!/ignoreSearch/.test(sw.replace(/\/\/.*$/gm, "")), "コード中で ignoreSearch を使っていない");
  assert.match(sw, /caches\.match\(event\.request\)/);
  assert.match(sw, /mode === "navigate"/, "クエリ付きの画面遷移は index.html を返す");
});

test("CACHE_VERSION は文字列で、activate 時に古いキャッシュを削除する", () => {
  assert.match(sw, /const CACHE_VERSION = "body-garden-v\d+";/);
  assert.match(sw, /key !== CACHE_VERSION/);
  assert.match(sw, /caches\.delete\(key\)/);
});
