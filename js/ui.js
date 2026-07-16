// DOM layer: renders the playlist, wires the search form + transport buttons,
// and reflects player state (current row, play/pause icon).
window.Tubalr = window.Tubalr || {};

(function (Tubalr) {
  "use strict";

  var playlist = Tubalr.playlist;
  var player = Tubalr.player;

  var els = {};
  var lastCurrent = -1;
  var building = false;

  function $(id) {
    return document.getElementById(id);
  }

  function cacheEls() {
    els.form = $("search-form");
    els.input = $("search-input");
    els.modeButtons = Array.prototype.slice.call(
      document.querySelectorAll(".btn-mode")
    );
    els.list = $("playlist");
    els.status = $("status");
    els.shuffle = $("btn-shuffle");
    els.prev = $("btn-prev");
    els.play = $("btn-play");
    els.next = $("btn-next");
    els.repeat = $("btn-repeat");
    els.playIcon = $("play-pause-icon");
    els.repeatIcon = $("repeat-icon");
  }

  // Icon markup for the action the play/pause button performs (the opposite of
  // the current state): show "pause" while playing, "play" while paused.
  var ICON_PLAY = '<polygon points="6 4 20 12 6 20 6 4"/>';
  var ICON_PAUSE = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';

  // Repeat icon: the loop for "all"; the loop plus a small "1" for "one".
  var REPEAT_LOOP = '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>';
  var ICON_REPEAT_ALL = REPEAT_LOOP;
  // Solid "1" digit filled in the loop's center so the mode reads at a glance.
  var ICON_REPEAT_ONE =
    REPEAT_LOOP +
    '<polygon fill="currentColor" stroke="none" points="12.9,9.3 12.9,14.9 11.5,14.9 11.5,11 10.4,11 10.4,10 11.6,9.3"/>';

  // Error toast (shown on mobile via CSS; harmlessly hidden on desktop). Created
  // lazily and auto-dismissed; re-triggering restarts the timer.
  var toastEl = null;
  var toastTimer = null;

  function showToast(msg) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "toast";
      toastEl.setAttribute("role", "status");
      toastEl.setAttribute("aria-live", "polite");
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    void toastEl.offsetWidth; // reflow so the transition replays if already shown
    toastEl.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove("show");
    }, 4500);
  }

  function setStatus(msg, isError) {
    els.status.textContent = msg || "";
    els.status.classList.toggle("error", !!isError);
    // Only real errors toast — the transient loading messages are skipped so the
    // mobile view stays quiet during normal playback.
    if (isError && msg) showToast(msg);
  }

  function renderPlaylist(queue) {
    els.list.innerHTML = "";
    queue.forEach(function (track, i) {
      var li = document.createElement("li");
      li.textContent = track.artist + " – " + track.title;
      li.title = li.textContent;
      li.dataset.index = String(i);
      els.list.appendChild(li);
    });
    lastCurrent = -1;
  }

  function highlightCurrent(index) {
    if (index === lastCurrent) return;
    var rows = els.list.children;
    if (lastCurrent >= 0 && rows[lastCurrent]) {
      rows[lastCurrent].classList.remove("current");
    }
    if (index >= 0 && rows[index]) {
      rows[index].classList.add("current");
      rows[index].scrollIntoView({ block: "nearest" });
    }
    lastCurrent = index;
  }

  function reflectPlaying(isPlaying) {
    els.playIcon.innerHTML = isPlaying ? ICON_PAUSE : ICON_PLAY;
    els.play.setAttribute("aria-label", isPlaying ? "Pause" : "Play");
  }

  function reflectRepeat(mode) {
    var one = mode === "one";
    els.repeatIcon.innerHTML = one ? ICON_REPEAT_ONE : ICON_REPEAT_ALL;
    els.repeat.classList.toggle("active", one);
    var label = one ? "Repeat one" : "Repeat all";
    els.repeat.setAttribute("aria-label", label);
    els.repeat.setAttribute("title", label);
  }

  // ---- Media Session: lock-screen / hardware media controls (mobile) ----
  // Feature-detected; a no-op on browsers without support (incl. most desktop).

  function mediaSessionSupported() {
    return "mediaSession" in navigator;
  }

  function wireMediaSession() {
    if (!mediaSessionSupported()) return;
    var ms = navigator.mediaSession;
    // Route the OS transport buttons back into the player state machine.
    var handlers = {
      play: player.togglePlay,
      pause: player.togglePlay,
      previoustrack: player.prev,
      nexttrack: player.next,
    };
    Object.keys(handlers).forEach(function (action) {
      try {
        ms.setActionHandler(action, handlers[action]);
      } catch (e) {
        /* unsupported action on this browser — ignore */
      }
    });
  }

  function updateMediaSession(state) {
    if (!mediaSessionSupported()) return;
    var ms = navigator.mediaSession;
    var track = state.queue[state.currentIndex];
    if (track && window.MediaMetadata) {
      ms.metadata = new window.MediaMetadata({
        title: track.title,
        artist: track.artist,
        album: "Tubalr",
        artwork: [
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      });
    }
    // playbackState drives the lock-screen play/pause glyph.
    ms.playbackState = state.playing ? "playing" : "paused";
  }

  // player -> UI
  function onChange(state) {
    highlightCurrent(state.currentIndex);
    reflectPlaying(state.playing);
    reflectRepeat(state.repeatMode);
    updateMediaSession(state);
  }

  function setBuilding(on) {
    building = on;
    els.modeButtons.forEach(function (b) {
      b.disabled = on;
    });
  }

  function build(mode) {
    var artist = els.input.value.trim();
    if (!artist || building) return;
    // Dismiss the mobile keyboard once a search starts.
    els.input.blur();
    setBuilding(true);
    setStatus("Loading " + (mode === "similar" ? "artists similar to " : "top tracks for ") + "“" + artist + "”…");

    var promise =
      mode === "similar"
        ? playlist.buildSimilar(artist)
        : playlist.buildOnly(artist);

    promise
      .then(function (queue) {
        if (!queue.length) {
          setStatus("No results for “" + artist + "”. Check the spelling?", true);
          return;
        }
        renderPlaylist(queue);
        player.start(queue);
      })
      .catch(function (err) {
        setStatus(err.message || "Something went wrong.", true);
      })
      .then(function () {
        setBuilding(false);
      });
  }

  function wire() {
    // Submit (Enter or the "only" button) defaults to "only".
    els.form.addEventListener("submit", function (e) {
      e.preventDefault();
      build("only");
    });
    // "similar" button.
    els.modeButtons.forEach(function (b) {
      if (b.dataset.mode === "similar") {
        b.addEventListener("click", function () {
          build("similar");
        });
      }
    });

    els.list.addEventListener("click", function (e) {
      var li = e.target.closest("li");
      if (!li) return;
      player.playByQueueIndex(Number(li.dataset.index));
    });

    els.shuffle.addEventListener("click", player.shuffleQueue);
    els.prev.addEventListener("click", player.prev);
    els.play.addEventListener("click", player.togglePlay);
    els.next.addEventListener("click", player.next);
    els.repeat.addEventListener("click", player.toggleRepeat);
  }

  function init() {
    cacheEls();
    wire();
    wireMediaSession();
    player.init({ onChange: onChange, onStatus: setStatus });
  }

  Tubalr.ui = { init: init, setStatus: setStatus };
})(window.Tubalr);
