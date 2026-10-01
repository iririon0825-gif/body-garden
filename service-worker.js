// Body Garden — Service Worker
// CACHE_VERSIONはTonight Gardenと同様に手動運用（更新時にこの文字列を上げる）
const CACHE_VERSION = "body-garden-v4";

const PRECACHE_URLS = [
  "./",
  "index.html",
  "manifest.json",
  "css/style.css",
  "assets/fonts/KaiseiDecol-400.woff2",
  "assets/fonts/KaiseiDecol-500.woff2",
  "js/icons.js",
  "js/data.js",
  "js/calc.js",
  "js/storage.js",
  "js/logic.js",
  "js/charts.js",
  "js/ocr.js",
  "js/ui.js",
  "js/protein-logic.js",
  "js/ui-settings.js",
  "js/ui-protein-settings.js",
  "js/ui-protein-home.js",
  "js/ui-records.js",
  "js/backup.js",
  "js/ui-backup.js",
  "js/app.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(PRECACHE_URLS))
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
        const clone = response.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
