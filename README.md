# tubalr

**Live: https://cjstewart88.github.io/tubalr-2026/**

A tiny, client-side recreation of [Tubalr](https://news.ycombinator.com/item?id=3146182):
type an artist, and it plays a continuous YouTube session built from Last.fm data.

- **only** — the artist's top 20 tracks, back to back.
- **similar** — the top 10 similar artists, 2 tracks each (~20 total).

Controls: play/pause, shuffle, skip, and reverse. Plain HTML/CSS/JS — no framework,
no build step, no backend.

## How it works

- **[Last.fm API](https://www.last.fm/api)** supplies the music data
  (`artist.getTopTracks`, `artist.getSimilar`). It's CORS-enabled, so the browser
  calls it directly.
- **[YouTube Data API v3](https://developers.google.com/youtube/v3/docs/search/list)**
  (`search.list`) resolves each "artist – track" into a video ID. Video IDs are
  resolved **lazily** (only the track you're about to play, plus a prefetch of the
  next one) and cached in a **shared Supabase cache** (site-wide, so one visitor's
  lookup saves every later visitor's quota) — see `js/supabase.js`. There's no
  per-browser cache; every lookup, even a repeat, goes through the shared cache.
- **[YouTube IFrame Player API](https://developers.google.com/youtube/iframe_api_reference)**
  handles playback and auto-advances the queue when a video ends.

### ⚠️ YouTube quota

The free YouTube Data API quota is **10,000 units/day**, and each search costs **100
units** — about **100 track lookups per day**, shared across every visitor to the site.
Lazy resolution stretches this a long way (only the track about to play, plus a
one-track prefetch, are ever resolved), and the optional shared Supabase cache (see
below) stretches it further still: once *any* visitor resolves a track, every other
visitor — including that same visitor on a later visit — gets it for free. Without
Supabase configured there's no caching at all: every lookup, even a repeat, costs
quota. If you need more, request additional quota in the Google Cloud console. When the
quota is exhausted the app shows a message instead of
failing silently.

## Setup

1. **Get a Last.fm API key** — https://www.last.fm/api/account/create (instant, free).
2. **Get a YouTube Data API key** — in the
   [Google Cloud Console](https://console.cloud.google.com/apis/credentials), create a
   project, enable **YouTube Data API v3**, and create an API key. Recommended: restrict
   it by HTTP referrer to your own origin.
3. **Add your keys:**
   ```sh
   cp js/config.example.js js/config.js
   ```
   then edit `js/config.js` and paste in both keys. (`js/config.js` is git-ignored.)
4. **Optional but recommended: shared video cache.** Create a
   [Supabase](https://supabase.com) project, run
   [`supabase/schema.sql`](supabase/schema.sql) once in its SQL editor, then paste the
   project URL and anon/publishable key into `js/config.js`. Without this the app still
   works, but every video lookup — even a repeat — costs YouTube quota, since there's no
   fallback cache.

## Run

There's no build step. You can open `index.html` directly in a browser to load the
UI, but that won't be a fully working app: if you restrict the YouTube key by HTTP
referrer, playback from `file://` (origin `null`) is blocked. Serve the folder from
any static server so it has a real origin.

## Deploy to GitHub Pages

Deployment uses [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml), which
injects the keys from **repository secrets** at build time — so `js/config.js` never
gets committed, yet the deployed site still has working keys.

One-time setup on GitHub:

1. **Add the secrets** — repo **Settings → Secrets and variables → Actions →
   New repository secret**:
   - `LASTFM_KEY` = your Last.fm key
   - `YOUTUBE_KEY` = your YouTube Data API key
   - `SUPABASE_URL` / `SUPABASE_ANON_KEY` = optional, only if you set up the shared
     video cache (see Setup above)
2. **Enable Pages** — repo **Settings → Pages → Build and deployment → Source:
   GitHub Actions**.
3. **Restrict the YouTube key by HTTP referrer** (Google Cloud console) to your Pages
   origin, e.g. `https://<user>.github.io/*` (plus `http://localhost:8000/*` for local
   dev). A client-side app ships its keys to the browser, so referrer restriction — not
   secrecy — is what protects the key on a public site.

Every push to `main` then rebuilds and publishes automatically (or run it manually from
the **Actions** tab). The site lands at `https://<user>.github.io/<repo>/`.

## Structure

```
index.html             layout: header, player, playlist, transport
css/styles.css         styles
js/config.example.js   API-key template (copy to js/config.js)
js/lastfm.js           Last.fm data layer
js/supabase.js         shared video cache (optional, site-wide)
js/youtube.js          YouTube search (cached via shared Supabase cache) + IFrame player wrapper
js/playlist.js         builds the "only" / "similar" queues
js/player.js           transport + queue state machine (lazy resolve, auto-advance)
js/ui.js               DOM rendering + event wiring
js/app.js              bootstrap
supabase/schema.sql    reference SQL for the optional shared cache + playlist tables
```
