// Body Garden — Service Worker
// CACHE_VERSIONはTonight Gardenと同様に手動運用（このファイルを変えたときだけ上げる）。
//
// 事前キャッシュは「index.html が実際に読み込む URL（?t= 付きのまま）」を index.html から読み取って決める。
// 手で書いたURL一覧と、index.html の ?t= が食い違って、オフライン起動で一部のファイルが見つからなくなる
// （または旧版と新版のファイルが混ざる）ことを防ぐため。新しいJSを足すときは index.html に書くだけでよい。
// 画面に必要な読み込みは、キャッシュにある同じURL（完全一致）だけを使う。?t= を無視した照合はしない
// （旧版のファイルを新版の画面に混ぜてしまうため）。
// HTML（画面の遷移）は、実行時にはキャッシュを上書きしない。オンラインで新しい index.html だけを保存し、通信が途切れて
// 新しい js/css が揃っていない状態のまま、次のオフライン起動で「新しい HTML ＋ 旧い/欠けた JS」になるのを防ぐ。
// オフライン用の画面一式は、install のときに（HTML と js/css を同時に）入れ替わる。
// 公開のたびに、このファイルの CACHE_VERSION を上げること（上げないと install が走らず、オフライン用の一式が更新されない）。

const CACHE_VERSION = "body-garden-v22";

// index.html から取れないもの（HTML自身・マニフェスト・フォント・PWAアイコン・体調の顔アイコン）
const STATIC_URLS = [
  "./",
  "index.html",
  "manifest.json",
  "assets/fonts/KaiseiDecol-400.woff2",
  "assets/fonts/KaiseiDecol-500.woff2",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon-180.png",
  "assets/body-garden/condition-none.png",
  "assets/body-garden/condition-mild.png",
  "assets/body-garden/condition-moderate.png",
];

// 外部ライブラリ（オフラインでもグラフを描くため）。取得できなくてもインストールは失敗させない
const CDN_URLS = ["https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      // 常にネットワークから取得し直す（ブラウザのHTTPキャッシュの古い index.html を使わない）
      const res = await fetch("index.html", { cache: "reload" });
      if (!res.ok) throw new Error("index.html を取得できません");
      const html = await res.clone().text();
      // ローカルの js/ と css/ の読み込みURL（?t= 付き）
      const pageUrls = [...html.matchAll(/(?:src|href)="((?:js|css)\/[^"]+)"/g)].map((m) => m[1]);
      const urls = [...new Set([...STATIC_URLS, ...pageUrls])];
      // 1件でも取得できなければインストール全体を失敗にする（欠けた状態で新版にならない）
      await cache.addAll(urls.map((u) => new Request(u, { cache: "reload" })));
      // 「./」と「index.html」は、取得した同じ1つの応答から保存する（取得の合間に公開が入っても版がずれない）
      await cache.put("index.html", res.clone());
      await cache.put("./", res);
      // cache.add は不透明な応答（no-cors・status 0）を受け付けないため、取得して cache.put で保存する
      for (const u of CDN_URLS) {
        try {
          const req = new Request(u, { mode: "no-cors" });
          await cache.put(req, await fetch(req));
        } catch (_) {
          // CDNに届かなくても、通常の読み込み時にキャッシュされる
        }
      }
    })()
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

// network-first（オフライン時のみキャッシュにフォールバック）
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (event.request.mode !== "navigate" && response && (response.ok || response.type === "opaque")) {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request); // 完全一致のみ
        if (cached) return cached;
        // 画面の遷移（?r=… などのクエリ付きの開き方）は、保存済みの index.html を返す
        if (event.request.mode === "navigate") return caches.match("index.html");
        return Response.error();
      })
  );
});
