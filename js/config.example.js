// Copy this file to js/config.js and fill in your own keys.
// js/config.js is git-ignored so your keys never get committed.
//
//   Last.fm API key:  https://www.last.fm/api/account/create
//   YouTube Data API v3 key (Google Cloud Console, enable "YouTube Data API v3"):
//                     https://console.cloud.google.com/apis/credentials
//   Supabase project URL + anon key (optional — enables a shared, site-wide video
//   cache; the app works without it, just without that quota saving):
//                     https://supabase.com/dashboard -> Project Settings -> API
//
// Tip: restrict the YouTube key by HTTP referrer so it can only be used from
// your own origin.

window.TUBALR_CONFIG = {
  lastfmKey: "YOUR_LASTFM_API_KEY",
  youtubeKey: "YOUR_YOUTUBE_DATA_API_KEY",
  supabaseUrl: "YOUR_SUPABASE_PROJECT_URL",
  supabaseAnonKey: "YOUR_SUPABASE_ANON_KEY",
};
