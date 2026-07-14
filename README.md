# tubalr

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
  **cached in `localStorage`** and resolved **lazily** (only the track you're about to
  play, plus a prefetch of the next one).
- **[YouTube IFrame Player API](https://developers.google.com/youtube/iframe_api_reference)**
  handles playback and auto-advances the queue when a video ends.

### ⚠️ YouTube quota

The free YouTube Data API quota is **10,000 units/day**, and each search costs **100
units** — about **100 track lookups per day**. Lazy resolution + caching stretch this a
long way (replaying a cached track costs nothing), but a heavy day of brand-new artists
can hit the ceiling. If you need more, request additional quota in the Google Cloud
console. When the quota is exhausted the app shows a message instead of failing silently.

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

## Run

Open `index.html` directly in a browser, **or** serve the folder statically:

```sh
python -m http.server 8000
# then visit http://localhost:8000
```

A static server is recommended — if you restrict the YouTube key by referrer, playback
from `file://` (origin `null`) won't be allowed.

## Deploy to GitHub Pages

Deployment uses [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml), which
injects the keys from **repository secrets** at build time — so `js/config.js` never
gets committed, yet the deployed site still has working keys.

One-time setup on GitHub:

1. **Add the secrets** — repo **Settings → Secrets and variables → Actions →
   New repository secret**, twice:
   - `LASTFM_KEY` = your Last.fm key
   - `YOUTUBE_KEY` = your YouTube Data API key
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
index.html            layout: header, player, playlist, transport
css/styles.css        styles
js/config.example.js  API-key template (copy to js/config.js)
js/lastfm.js          Last.fm data layer
js/youtube.js         YouTube search (cached) + IFrame player wrapper
js/playlist.js        builds the "only" / "similar" queues
js/player.js          transport + queue state machine (lazy resolve, auto-advance)
js/ui.js              DOM rendering + event wiring
js/app.js             bootstrap
```
