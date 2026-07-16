// Tubalr service worker — makes the app installable and lets the shell load
// offline. Deliberately minimal: it precaches the static app shell and never
// touches the API/playback traffic (YouTube, Last.fm, Google Fonts), so nothing
// stale is ever served for quota-limited or freshness-sensitive requests.
//
// Bump CACHE (v1 -> v2 -> ...) whenever a shell file changes to invalidate.

var CACHE = "tubalr-v1";

// Relative to the SW's own scope, so this resolves correctly under the GitHub
// Pages subpath (/tubalr-2026/). config.js is intentionally omitted — it's
// regenerated per deploy with the injected keys and should always come fresh
// from the network.
var SHELL = [
  "./",
  "index.html",
  "css/styles.css",
  "js/lastfm.js",
  "js/youtube.js",
  "js/playlist.js",
  "js/player.js",
  "js/ui.js",
  "js/app.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(function (cache) {
        return cache.addAll(SHELL);
      })
      .then(function () {
        return self.skipWaiting();
      })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys.map(function (key) {
            if (key !== CACHE) return caches.delete(key);
          })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

self.addEventListener("fetch", function (event) {
  var req = event.request;

  // Only handle same-origin GETs. Everything else (YouTube API/iframe,
  // googleapis.com, Google Fonts, ws.audioscrobbler.com) passes straight
  // through to the network and is never cached.
  if (req.method !== "GET") return;
  if (new URL(req.url).origin !== self.location.origin) return;

  // Navigations: try network first so a fresh shell is preferred, but fall back
  // to the cached shell when offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(function () {
        return caches.match(req).then(function (hit) {
          return hit || caches.match("index.html") || caches.match("./");
        });
      })
    );
    return;
  }

  // Same-origin assets: cache-first (the cache is versioned by CACHE).
  event.respondWith(
    caches.match(req).then(function (hit) {
      return hit || fetch(req);
    })
  );
});
