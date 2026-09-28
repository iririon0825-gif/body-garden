// Body Garden — エントリーポイント
document.addEventListener("DOMContentLoaded", () => {
  const state = Storage.load();
  UI.init(state);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js").catch((e) => {
      console.error("[BodyGarden] service worker登録失敗", e);
    });
  }
});
