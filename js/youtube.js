// YouTube layer: search.list to resolve "artist - track" -> videoId, cached in
// Supabase (site-wide, see supabase.js) to conserve the 100-searches/day quota, plus a
// thin wrapper over the IFrame Player API used by player.js.
window.Tubalr = window.Tubalr || {};

(function (Tubalr) {
  "use strict";

  var SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";

  function apiKey() {
    return (window.TUBALR_CONFIG && window.TUBALR_CONFIG.youtubeKey) || "";
  }

  // Custom error so callers can tell "quota exceeded" from "no results".
  function QuotaError(message) {
    this.name = "QuotaError";
    this.message = message || "YouTube API quota exceeded";
  }
  QuotaError.prototype = Object.create(Error.prototype);

  // Resolve a search query to a single embeddable videoId.
  // Supabase shared cache (site-wide) first, then YouTube search.list (last resort,
  // costs quota) on a miss.
  // Returns a Promise<string|null>; rejects with QuotaError on quota exhaustion.
  function searchVideoId(query) {
    return Tubalr.sharedCache.getCachedVideoId(query).then(function (shared) {
      if (shared) return shared;
      return fetchFromYouTube(query);
    });
  }

  function fetchFromYouTube(query) {
    var params = new URLSearchParams({
      part: "snippet",
      type: "video",
      videoEmbeddable: "true",
      maxResults: "1",
      q: query,
      key: apiKey(),
    });

    return fetch(SEARCH_URL + "?" + params.toString())
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) {
            var reason =
              data && data.error && data.error.errors && data.error.errors[0]
                ? data.error.errors[0].reason
                : "";
            if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
              throw new QuotaError();
            }
            var msg =
              (data && data.error && data.error.message) ||
              "YouTube search failed (" + res.status + ")";
            throw new Error(msg);
          }
          var item = data.items && data.items[0];
          var id = item && item.id && item.id.videoId;
          if (id) Tubalr.sharedCache.cacheVideoId(query, id);
          return id || null;
        });
      });
  }

  // ---- IFrame Player wrapper ----
  var player = null;
  var ready = false;
  var readyWaiters = [];
  var handlers = { onEnded: null, onError: null, onStateChange: null };

  // Called by the YouTube IFrame API script once it loads (see app.js).
  function createPlayer(elementId) {
    player = new YT.Player(elementId, {
      width: "100%",
      height: "100%",
      playerVars: {
        autoplay: 0,
        controls: 1,
        rel: 0,
        modestbranding: 1,
        playsinline: 1,
      },
      events: {
        onReady: function () {
          ready = true;
          readyWaiters.forEach(function (fn) {
            fn();
          });
          readyWaiters = [];
        },
        onStateChange: function (e) {
          if (handlers.onStateChange) handlers.onStateChange(e.data);
          if (e.data === YT.PlayerState.ENDED && handlers.onEnded) {
            handlers.onEnded();
          }
        },
        onError: function (e) {
          // 2 invalid id, 5 html5 error, 100 removed, 101/150 embedding disabled.
          if (handlers.onError) handlers.onError(e.data);
        },
      },
    });
  }

  function whenReady(fn) {
    if (ready) fn();
    else readyWaiters.push(fn);
  }

  function load(videoId) {
    whenReady(function () {
      player.loadVideoById(videoId);
    });
  }

  function play() {
    whenReady(function () {
      player.playVideo();
    });
  }

  // Restart the currently loaded video from the top. Used for repeat-one:
  // loadVideoById with the same id that just ENDED is unreliable, so seek instead.
  function replay() {
    whenReady(function () {
      player.seekTo(0, true);
      player.playVideo();
    });
  }

  function pause() {
    if (ready && player) player.pauseVideo();
  }

  function setHandlers(h) {
    handlers = Object.assign(handlers, h);
  }

  Tubalr.youtube = {
    searchVideoId: searchVideoId,
    QuotaError: QuotaError,
    createPlayer: createPlayer,
    load: load,
    play: play,
    replay: replay,
    pause: pause,
    setHandlers: setHandlers,
  };
})(window.Tubalr);
