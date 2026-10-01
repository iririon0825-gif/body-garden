// Body Garden — エントリーポイント
document.addEventListener("DOMContentLoaded", () => {
  const state = Storage.load();

  if (Storage.readOnly && Storage.readOnlyReason === "newerSchema") {
    // 新しい版で作られたデータは、この版の画面で扱うと壊す・誤表示するおそれがあるため、通常画面を起動しない
    BackupUI.showNewerSchemaScreen();
  } else {
    UI.init(state);
    BackupUI.showReadOnlyBannerIfNeeded();
    BackupUI.watchStorage();
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js").catch((e) => {
      console.error("[BodyGarden] service worker登録失敗", e);
    });
  }
});
