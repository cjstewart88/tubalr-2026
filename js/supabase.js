// Shared cache layer: reads/writes the site-wide query -> videoId cache in Supabase,
// so one visitor's YouTube search.list lookup benefits every later visitor. Optional —
// if supabaseUrl/supabaseAnonKey aren't configured, every call is a silent no-op and
// youtube.js falls back to calling YouTube search directly every time.
window.Tubalr = window.Tubalr || {};

(function (Tubalr) {
  "use strict";

  var client = null;

  function getClient() {
    if (client) return client;
    var c = window.TUBALR_CONFIG;
    if (!c || !c.supabaseUrl || !c.supabaseAnonKey) return null;
    if (!window.supabase) return null;
    client = window.supabase.createClient(c.supabaseUrl, c.supabaseAnonKey);
    return client;
  }

  // -> Promise<string|null>. Never rejects: a miss and an unreachable/unconfigured
  // Supabase look identical to the caller, so a Supabase outage never blocks playback.
  function getCachedVideoId(query) {
    var sb = getClient();
    if (!sb) return Promise.resolve(null);
    return sb
      .from("video_cache")
      .select("video_id")
      .eq("query", query)
      .maybeSingle()
      .then(function (res) {
        return (res.data && res.data.video_id) || null;
      })
      .catch(function () {
        return null;
      });
  }

  // Fire-and-forget write-through. Errors are swallowed — a failed shared-cache write
  // just means the next visitor pays the API cost too; this visitor's playback already
  // succeeded by the time this is called.
  function cacheVideoId(query, videoId) {
    var sb = getClient();
    if (!sb) return;
    // rpc() returns a thenable builder, not a full Promise — it has .then() but no
    // .catch(), so swallow errors via then's second argument instead.
    sb.rpc("cache_video", { p_query: query, p_video_id: videoId }).then(function () {}, function () {});
  }

  Tubalr.sharedCache = {
    getCachedVideoId: getCachedVideoId,
    cacheVideoId: cacheVideoId,
  };
})(window.Tubalr);
