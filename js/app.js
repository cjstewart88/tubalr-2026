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

  // Register the service worker so the app is installable and the shell loads
  // offline. Gated to secure contexts: service workers require http/https, so
  // this is a no-op when the page is opened directly via file://.
  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    if (location.protocol !== "http:" && location.protocol !== "https:") return;
    // Relative path -> scopes to the app's directory (works under a subpath).
    navigator.serviceWorker.register("sw.js").catch(function () {
      /* non-fatal: the app still works without offline/install support */
    });
  }

  function init() {
    Tubalr.ui.init();
    if (keysMissing()) {
      showConfigBanner();
      Tubalr.ui.setStatus("Add your API keys in js/config.js to get started.", true);
    }
    loadYouTubeApi();
    registerServiceWorker();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})(window.Tubalr);
