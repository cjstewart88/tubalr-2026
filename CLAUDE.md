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
6. `js/ui.js` — `Tubalr.ui`: DOM rendering + event wiring; also drives the error toast
   (the only status surface, on every viewport — transient loading messages are dropped)
   and the Media Session (lock-screen) metadata + action handlers.
7. `js/app.js` — bootstrap: config check + missing-key banner, loads the IFrame API,
   tears down the old service worker (see below).

Non-script static files: `icons/` (favicon-32 = tab icon, icon-192 = mobile header logo,
icon-512 = Media Session artwork) and `tools/icon-generator.html` (a standalone icon
exporter, never loaded by the app).

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
- **The PWA was removed** (manifest, service worker, install/home-screen metadata). Don't
  reintroduce one without asking. `js/app.js` still carries `removeOldServiceWorker()`:
  deleting `sw.js` does **not** uninstall the copies already registered in returning
  visitors' browsers — an installed SW serves its cached shell forever — so the bootstrap
  unregisters any it finds and deletes the `tubalr-*` caches. It's transitional and can go
  once returning visitors have all loaded the site since the removal.
- **Every URL stays relative** because Pages serves from the `/tubalr-2026/` subpath —
  never use root-absolute paths.
- Regenerate the icon PNGs with `tools/icon-generator.html` and commit them (the app itself
  stays dependency-free).
- **Desktop and mobile share one DOM.** The phone layout — an app-like shell (full-bleed
  player, scrolling playlist, transport pinned at the playlist bottom, a permanent
  icon + search header) — is driven entirely by a `@media (max-width: 600px)` block plus
  `:has()`-based visibility. Don't fork the markup; desktop must stay unchanged.
- **The app is permanently dark** — there is no light theme and no
  `prefers-color-scheme` branch; `:root` just declares `color-scheme: dark` so UA chrome
  (scrollbars, caret) follows. Surfaces stack lightest-on-top: `--bg` (page) → `--surface`
  (raised bars) → `--field-bg` (inputs/buttons). Use those variables rather than inlining
  new greys — the surfaces are violet-tinted, not neutral. The accent (`--accent`, galaxy
  purple) and logo ink (`--ink`, now near-white) are derived from the app icon; keep the
  CSS palette and the icon in sync if either changes. Translucent accents use
  `rgba(var(--accent-rgb), …)`, so `--accent` and `--accent-rgb` must stay the same colour.
  The icon's glow lives in `tools/icon-generator.html` (`GLOW`/`CORE`); changing the accent
  means re-exporting the PNGs from that tool and committing them.
- **The chrome is a Winamp homage.** Controls are square (2px radius) and chiselled via the
  `--bevel-out` / `--bevel-in` box-shadow pairs: things you press stand proud and invert to
  sunken on `:active`; fields are sunken to begin with. Reuse those variables rather than
  hand-rolling shadows. The playlist is the skin's playlist editor — mono (`--font-mono`),
  tight rows, no separators, numbered by a **CSS counter** (`.playlist li::before`, so
  `ui.js` keeps writing plain "artist – title"), with the playing row inverted into a solid
  accent block.
- **Playlist rows carry a kebab (⋮) menu** — "play this artist" / "play similar artists" —
  that restarts the session from *that row's* artist (the point of it: in similar mode every row
  is a different artist). Two things keep it from disturbing the row: the button is
  **absolutely positioned**, so the row's text node stays the only inline content and the
  CSS counter + `text-overflow: ellipsis` keep working; and the popup is appended to
  `<body>` and positioned `fixed`, because `.playlist` is `overflow-y: auto` and would clip
  a nested one. Selecting an item just fills the search input and calls `build()` — the
  same path a recent chip takes — so recents/tab-switching stay consistent.

## Deploy

Push to `main` → `.github/workflows/deploy.yml` publishes to GitHub Pages.
Live: https://cjstewart88.github.io/tubalr-2026/

## Verifying changes

The owner prefers to run/test the app themselves — hand off with clear instructions
rather than spinning up servers or browsers. `node --check js/*.js` for a quick syntax
pass is fine. Full playback needs real keys in `js/config.js`.
