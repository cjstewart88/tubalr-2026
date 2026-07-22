// One-time migration: pushes this browser's localStorage video-ID cache (from
// before the shared Supabase cache existed) into the video_cache table, so other
// visitors benefit from lookups already paid for.
//
// Not loaded by the app. Usage: open the running app (the same origin whose
// localStorage you want to migrate — localhost and the deployed site are separate
// origins), open devtools console, paste this whole file, press enter. Makes zero
// YouTube API calls, so it doesn't touch quota. Safe to re-run: cache_video()'s
// "on conflict do nothing" makes it idempotent.
(async function migrateLocalCacheToSupabase() {
  var CONFIG = window.TUBALR_CONFIG;
  if (!CONFIG || !CONFIG.supabaseUrl || !CONFIG.supabaseAnonKey) {
    console.error("Missing supabaseUrl/supabaseAnonKey in TUBALR_CONFIG.");
    return;
  }
  if (!window.supabase) {
    console.error("Supabase client library not loaded.");
    return;
  }
  var sb = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey);

  var PREFIX = "yt:";
  var entries = [];
  for (var i = 0; i < localStorage.length; i++) {
    var key = localStorage.key(i);
    if (key && key.indexOf(PREFIX) === 0) {
      var query = key.slice(PREFIX.length);
      var videoId = localStorage.getItem(key);
      if (query && videoId) entries.push({ query: query, videoId: videoId });
    }
  }

  console.log("Found " + entries.length + " cached lookups to migrate.");

  var ok = 0, failed = 0;
  for (var j = 0; j < entries.length; j++) {
    var e = entries[j];
    var res = await sb.rpc("cache_video", { p_query: e.query, p_video_id: e.videoId });
    if (res.error) {
      failed++;
      console.warn("Failed:", e.query, res.error.message);
    } else {
      ok++;
    }
  }

  console.log("Done. " + ok + " migrated, " + failed + " failed, out of " + entries.length + ".");
})();
