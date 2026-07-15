# CLAUDE.md

Base context for this repo. Read before making changes.

## What this is

A client-side recreation of **Tubalr**: type an artist, get a continuous YouTube
listening session. Two modes:

- **only** — the artist's top 20 tracks.
- **similar** — top 10 similar artists, 2 tracks each (~20 total).

Controls: play/pause, shuffle, skip, reverse.

**Hard constraints (do not break without asking):** vanilla HTML/CSS/JS only — no
framework, no build step, no bundler, no backend, no npm dependencies. It must run by
opening `index.html` directly or serving the folder statically.

## Architecture

Plain `<script>` tags loaded in dependency order in `index.html`. Every module attaches
to a single global namespace: `window.Tubalr = window.Tubalr || {}`. No ES modules
(so it works from `file://` too). Style is ES5-ish vanilla JS, no dependencies.

Load order and responsibilities:

1. `js/config.js` — defines `window.TUBALR_CONFIG` (`lastfmKey`, `youtubeKey`). Git-ignored.
2. `js/lastfm.js` — `Tubalr.lastfm`: `getTopTracks`, `getSimilarArtists`. Direct browser
   fetch (Last.fm sends `Access-Control-Allow-Origin: *`).
3. `js/youtube.js` — `Tubalr.youtube`: `searchVideoId` (Data API v3) + a thin IFrame
   Player wrapper (`createPlayer`, `load`, `play`, `pause`, `setHandlers`).
4. `js/playlist.js` — `Tubalr.playlist`: `buildOnly`/`buildSimilar` return a queue of
   `{ artist, title, query, videoId: null }`.
5. `js/player.js` — `Tubalr.player`: the transport/queue state machine (play order,
   lazy video resolution, auto-advance, shuffle, play/pause). Talks to `youtube` for
   playback, reports state to the UI via `init({ onChange, onStatus })`.
6. `js/ui.js` — `Tubalr.ui`: DOM rendering + event wiring.
7. `js/app.js` — bootstrap: config check + missing-key banner, loads the IFrame API.

Data flow: `ui` → `playlist` (Last.fm) → `player.start(queue)` → `player` lazily calls
`youtube.searchVideoId` per track → `youtube` IFrame plays; `ENDED`/error auto-advance.

## Non-obvious things to preserve

- **YouTube quota is the main constraint.** `search.list` costs 100 units; free quota is
  10,000/day (~100 searches). Quota **cannot be bought** — only extended via a free audit.
  So: resolve video IDs **lazily** (only the track about to play + a 1-track prefetch) and
  **cache** `query -> videoId` in `localStorage` (`yt:` prefix). Don't change this to
  resolve the whole playlist up front.
- **Keys are never committed.** `js/config.js` is git-ignored. Local dev: copy
  `js/config.example.js`. Deploy: `.github/workflows/deploy.yml` generates `config.js`
  from repo secrets `LASTFM_KEY` / `YOUTUBE_KEY` at build time. A client-side app exposes
  its keys in the browser regardless — the YouTube key is protected by an HTTP-referrer
  restriction, not by secrecy. Never hardcode keys into committed files.
- Last.fm returns HTTP 200 with an `error` field on failure, and track/artist lists are
  "sometimes array, sometimes single object, sometimes missing" — `lastfm.js` normalizes
  both; keep that.

## Deploy

Push to `main` → `.github/workflows/deploy.yml` publishes to GitHub Pages.
Live: https://cjstewart88.github.io/tubalr-2026/

## Verifying changes

The owner prefers to run/test the app themselves — hand off with clear instructions
rather than spinning up servers or browsers. `node --check js/*.js` for a quick syntax
pass is fine. Full playback needs real keys in `js/config.js`.
