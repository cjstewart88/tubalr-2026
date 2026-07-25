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
opening `index.html` directly or serving the folder statically. **One approved
exception:** an optional Supabase project (hosted Postgres + PostgREST + Auth, no
server code authored in this repo) backs a shared, site-wide cache — see
`js/supabase.js` below. The app still ships zero bundler/npm dependencies; it just
makes an additional network call, the same way it already calls Last.fm/YouTube
directly from the browser.

## Architecture

Plain `<script>` tags loaded in dependency order in `index.html`. Every module attaches
to a single global namespace: `window.Tubalr = window.Tubalr || {}`. No ES modules
(so it works from `file://` too). Style is ES5-ish vanilla JS, no dependencies.

Load order and responsibilities:

1. `js/config.js` — defines `window.TUBALR_CONFIG` (`lastfmKey`, `youtubeKey`,
   `supabaseUrl`, `supabaseAnonKey`). Git-ignored.
2. `js/lastfm.js` — `Tubalr.lastfm`: `getTopTracks`, `getSimilarArtists`. Direct browser
   fetch (Last.fm sends `Access-Control-Allow-Origin: *`).
3. `js/supabase.js` — `Tubalr.sharedCache`: `getCachedVideoId`/`cacheVideoId`, a thin
   wrapper over the Supabase JS client (loaded via CDN `<script>` in `index.html`) that
   reads/writes the shared `video_cache` table. Optional — every call resolves `null` /
   no-ops if `supabaseUrl`/`supabaseAnonKey` aren't configured.
4. `js/youtube.js` — `Tubalr.youtube`: `searchVideoId` (shared cache → Data API v3,
   see below) + a thin IFrame Player wrapper (`createPlayer`, `load`, `play`, `pause`,
   `setHandlers`).
5. `js/playlist.js` — `Tubalr.playlist`: `buildOnly`/`buildSimilar` return a queue of
   `{ artist, title, query, videoId: null }`.
6. `js/player.js` — `Tubalr.player`: the transport/queue state machine (play order,
   lazy video resolution, auto-advance, shuffle, play/pause). Talks to `youtube` for
   playback, reports state to the UI via `init({ onChange, onStatus })`.
7. `js/ui.js` — `Tubalr.ui`: DOM rendering + event wiring; also drives the error toast
   (the only status surface, on every viewport — transient loading messages are dropped;
   `Tubalr.ui.toast` shows non-error notices) and the Media Session (lock-screen)
   metadata + action handlers.
8. `js/creatures.js` — `Tubalr.creatures`: DJ mode's avatar layer (see the DJ mode
   section). Pure presentation, knows nothing about Supabase.
9. `js/live.js` — `Tubalr.live`: DJ mode's broadcast/sync layer over Supabase Realtime
   (`initDj`/`initListener`).
10. `js/app.js` — bootstrap: config check + missing-key banner, `?dj=` routing into
    `Tubalr.live`, loads the IFrame API.

Non-script static files: `icons/` (favicon-32 = tab icon, icon-192 = mobile header logo,
icon-512 = Media Session artwork) and `tools/icon-generator.html` (a standalone icon
exporter, never loaded by the app).

Data flow: `ui` → `playlist` (Last.fm) → `player.start(queue)` → `player` lazily calls
`youtube.searchVideoId` per track → `youtube` IFrame plays; `ENDED`/error auto-advance.

## Non-obvious things to preserve

- **YouTube quota is the main constraint.** `search.list` costs 100 units; free quota is
  10,000/day (~100 searches), shared across every visitor to the site. Quota **cannot be
  bought** — only extended via a free audit. So: resolve video IDs **lazily** (only the
  track about to play + a 1-track prefetch) and cache `query -> videoId` — see next
  bullet. Don't change this to resolve the whole playlist up front.
- **Shared video ID cache (Supabase, site-wide, no per-browser cache).**
  `youtube.js#searchVideoId` checks `Tubalr.sharedCache.getCachedVideoId` (backed by
  the `video_cache` table) and only calls `search.list` on a miss, writing the result
  back via `Tubalr.sharedCache.cacheVideoId` so the next visitor to hit that query gets
  it free. There is deliberately **no localStorage cache** for video IDs anymore (every
  visitor's lookups go through the shared cache, even repeats on the same browser) —
  don't reintroduce one without asking; `js/recent.js`'s unrelated "recent searches"
  localStorage store is untouched. `getCachedVideoId`/`cacheVideoId` **must never reject
  or throw** — any failure (missing config, network error, Supabase outage) has to
  resolve/no-op silently, degrading straight to a direct YouTube call rather than
  blocking playback. Schema + RLS live in `supabase/schema.sql` (run by hand in the
  Supabase SQL editor, not applied automatically); writes go through a `cache_video()`
  Postgres RPC, not a direct insert policy, so the public anon/publishable key can't be
  used to write arbitrary rows.
- **Keys are never committed.** `js/config.js` is git-ignored. Local dev: copy
  `js/config.example.js`. Deploy: `.github/workflows/deploy.yml` generates `config.js`
  from repo secrets `LASTFM_KEY` / `YOUTUBE_KEY` (required) and `SUPABASE_URL` /
  `SUPABASE_ANON_KEY` (optional) at build time. A client-side app exposes its keys in
  the browser regardless — the YouTube key is protected by an HTTP-referrer restriction,
  the Supabase anon key by RLS/the `cache_video` RPC, neither by secrecy. Never hardcode
  keys into committed files.
- Last.fm returns HTTP 200 with an `error` field on failure, and track/artist lists are
  "sometimes array, sometimes single object, sometimes missing" — `lastfm.js` normalizes
  both; keep that.
- **The PWA was removed** (manifest, service worker, install/home-screen metadata). Don't
  reintroduce one without asking. The transitional `removeOldServiceWorker()` bootstrap —
  which unregistered any leftover SW and binned its `tubalr-*` caches so returning visitors
  weren't stuck on the old cached shell — has also been removed now that the only user has
  cycled through. If a service worker ever comes back, that teardown may need to come back
  with it.
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
- **Playlist rows are draggable by press-and-hold** (mouse or finger, `LONG_PRESS_MS`).
  Three things to keep in mind. (1) *No ghost node or placeholder*: rows are uniform
  single-line boxes, so `ui.js` translates the held row by the pointer delta and
  re-inserts it one slot at a time as that delta passes half a row — the DOM order **is**
  the drop order when the press ends, and `reindexRows()` only has to renumber
  `data-index` (the visible numbers are a CSS counter). The delta adds the list's
  `scrollTop` change, or auto-scrolling at the panel edge would slide the row out from
  under the pointer. (2) *`player.moveTrack(from, to)` owns the consequences*: it splices
  `queue` **in place** (the UI renders from that same array) and moves `pos` to the
  current track's new slot, so playback never restarts. The visible list **is** the play
  order — there's no separate play-order permutation — because shuffle (`shuffleQueue`)
  reorders `queue` itself and restarts from the top, discarding any manual drag order, so
  `moveTrack` only has to follow the list. (3) The
  hold does double duty: it also starts the row-text scroll, which is how a truncated
  title is read on touch (hover does it with a mouse). Touch listeners are bound to
  `.playlist`, not `document`, because the drag needs a **non-passive** `touchmove` to
  cancel scrolling and a document-level one would deoptimize scrolling page-wide.

## DJ mode (issue #3)

"go live" under the player broadcasts the session; a `?dj=<room>` link joins it as a
listener. Built on **Supabase Realtime Broadcast + Presence** — tableless channels
(`dj:<roomId>`), so no schema and no new config keys; like the shared cache it
silently no-ops when Supabase isn't configured. Things to preserve:

- **Protocol** (see the header comment in `js/live.js`): the DJ sends full-state
  `state` broadcasts `{ seq, queue, currentIndex, playing, repeatMode, currentTime,
  sentAt }` — debounced 150ms after every player notify, every 5s as a heartbeat, and
  on presence joins (instant late-joiner sync). `end`, `move`, `chat` are the other
  events; presence carries only static identity (`{ role, color }`). **Movement goes
  over broadcast at ≤5 Hz, not presence** — `track()` fans out CRDT diffs and
  supabase-js caps a client at 10 events/sec, so don't raise the rate or move
  positions into presence.
- **Listeners never call YouTube search** (quota!). The current track's `videoId`
  always arrives resolved — the DJ resolved it to play it — and
  `player.applyRemoteState` never searches or prefetches. Keep it that way.
- **Follow mode lives in `player.js`**, not a parallel state machine: `setFollowMode`
  makes the transport inert (except play/pause), `applyRemoteState` mirrors DJ state
  through the same `notify()`/`onChange` pipeline the UI already renders from, and
  `setStateHook` is the tap live.js uses (DJ: broadcast on change; listener: detect
  local pause vs DJ pause — a pause while `lastState.playing` is local). Unpausing a
  listener re-applies the DJ's latest state (jumps to their current spot, per spec) —
  it must not just resume. Time extrapolation uses the *listener-local* `receivedAt`
  stamp, never `sentAt` arithmetic across machines (clock skew). Drift reseeks only
  happen on incoming states with a 4s tolerance — no continuous scrubbing.
- **Autoplay gate**: a listener link shows a join overlay; the "join the broadcast"
  click is the user gesture playback needs, and `applyRemoteState` runs synchronously
  in that handler. Don't auto-join on load.
- **Stream-end detection is layered**: explicit `end` broadcast, presence-leave of the
  DJ + 8s grace (cancelled on rejoin), and a 15s heartbeat-staleness watchdog.
  Release hands the listener the queue as a normal session (full controls back).
- **Creatures render behind the UI**: `#creatures` is a fixed, `pointer-events: none`
  layer at `z-index: 1`; `.stage`/`.config-banner` get `position: relative; z-index: 2`
  so static content stacks above it (fixed chrome already does: panel 900, kebab menu
  950, toast 1000, join overlay 1100). Creature facing flips via the `--facing` custom
  property so the idle-bob keyframes can compose `scaleX(var(--facing))` — an inline
  transform would be stomped by the animation. Creatures are pure CSS (CSP `img-src
  'self'` forbids data-URI sprites). Keyboard is ignored while focus is in an
  input/interactive element; Enter focuses the chat box. **Clicking/tapping dead
  space also moves the creature** (walk to the click's x; a click up in the air adds
  a hop on arrival) — the only movement a phone gets; the `CLICK_IGNORE` selector
  keeps clicks on anything interactive (or the opaque panel) meaning what they
  always meant, and held keys override a pending click-walk. Chat renders via
  `textContent` only, clamped to 120 chars on send *and* receive.
- **`beforeunload` shows generic browser text only** — the "ends your stream" wording
  can't be customized; that's a platform limit.
- Known v1 limitation: on the ≤600px app shell the phone user barely sees their own
  creature (the shell covers the viewport); others still see it, and the chat box is
  the phone's participation surface.

## Deploy

Push to `main` → `.github/workflows/deploy.yml` publishes to GitHub Pages.
Live: https://cjstewart88.github.io/tubalr-2026/

## Verifying changes

The owner prefers to run/test the app themselves — hand off with clear instructions
rather than spinning up servers or browsers. `node --check js/*.js` for a quick syntax
pass is fine. Full playback needs real keys in `js/config.js`.
