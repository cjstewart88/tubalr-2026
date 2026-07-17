// Bootstrap: verify config, load the YouTube IFrame API, wire up the UI.
window.Tubalr = window.Tubalr || {};

(function (Tubalr) {
  "use strict";

  function keysMissing() {
    var c = window.TUBALR_CONFIG;
    if (!c) return true;
    var placeholders = ["", "YOUR_LASTFM_API_KEY", "YOUR_YOUTUBE_DATA_API_KEY"];
    return (
      placeholders.indexOf(c.lastfmKey) !== -1 ||
      placeholders.indexOf(c.youtubeKey) !== -1
    );
  }

  function showConfigBanner() {
    var banner = document.createElement("div");
    banner.className = "config-banner";
    banner.innerHTML =
      "No API keys found. Copy <code>js/config.example.js</code> to " +
      "<code>js/config.js</code> and add your Last.fm and YouTube Data API keys " +
      "(see the README). The app won’t play anything until then.";
    document.body.insertBefore(banner, document.body.firstChild);
  }

  function loadYouTubeApi() {
    // The IFrame API calls this global when it's ready.
    window.onYouTubeIframeAPIReady = function () {
      Tubalr.youtube.createPlayer("player");
    };
    var tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
  }

  // The app used to be a PWA and registered a service worker (sw.js). That file
  // is gone, but deleting it does NOT uninstall the copies already running in
  // returning visitors' browsers — an installed SW keeps serving its cached
  // shell indefinitely, so without this they'd be stuck on the old build. Tear
  // down any registration we find and bin the caches it made.
  //
  // This is transitional: it can be deleted once returning visitors have all
  // loaded the site at least once since the PWA was removed.
  function removeOldServiceWorker() {
    if (!navigator.serviceWorker || !navigator.serviceWorker.getRegistrations) return;
    navigator.serviceWorker
      .getRegistrations()
      .then(function (regs) {
        regs.forEach(function (reg) {
          reg.unregister();
        });
      })
      .catch(function () {
        /* non-fatal: nothing to clean up, or the browser said no */
      });

    if (!window.caches || !caches.keys) return;
    caches
      .keys()
      .then(function (keys) {
        keys.forEach(function (key) {
          // Only ours: "tubalr-v1" locally, "tubalr-<sha>" from a deploy.
          if (key.indexOf("tubalr-") === 0) caches.delete(key);
        });
      })
      .catch(function () {});
  }

  function init() {
    Tubalr.ui.init();
    if (keysMissing()) {
      showConfigBanner();
      Tubalr.ui.setStatus("Add your API keys in js/config.js to get started.", true);
    }
    loadYouTubeApi();
    removeOldServiceWorker();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})(window.Tubalr);
