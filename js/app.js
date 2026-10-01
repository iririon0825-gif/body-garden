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
    if (typeof ConditionUI !== "undefined") ConditionUI.watchDate();
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker
      .register("service-worker.js")
      .then((reg) => {
        // 新しいバージョンがインストールされたら知らせる（作業中に自動で再読み込みはしない）。
        // 登録の前に始まった更新（すでに待機中・インストール中）も見逃さない
        if (reg.waiting && navigator.serviceWorker.controller) BackupUI.showBanner("updateReady", { onlyIfEmpty: true });
        reg.addEventListener("updatefound", () => {
          const worker = reg.installing;
          if (!worker) return;
          worker.addEventListener("statechange", () => {
            if (worker.state === "installed" && navigator.serviceWorker.controller) BackupUI.showBanner("updateReady", { onlyIfEmpty: true });
          });
        });
      })
      .catch((e) => {
        console.error("[BodyGarden] service worker登録失敗", e);
      });
  }
});
