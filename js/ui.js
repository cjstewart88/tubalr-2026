// DOM layer: renders the playlist, wires the search form + transport buttons,
// and reflects player state (current row, play/pause icon).
window.Tubalr = window.Tubalr || {};

(function (Tubalr) {
  "use strict";

  var playlist = Tubalr.playlist;
  var player = Tubalr.player;
  var recent = Tubalr.recent;
  var genres = Tubalr.genres;

  var BUILDERS = { only: playlist.buildOnly, similar: playlist.buildSimilar, genre: playlist.buildGenre };
  var STATUS_VERB = { only: "top tracks for ", similar: "artists similar to ", genre: "the genre " };
  var GENRE_VISIBLE = 8; // chips shown before the "+N more" chip

  var els = {};
  var lastCurrent = -1;
  var building = false;
  var currentQueue = []; // the rendered queue, so a row's kebab knows its artist
  var genresExpanded = false; // "+N more" was clicked; resets on next genre pick

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
    els.shuffle = $("btn-shuffle");
    els.prev = $("btn-prev");
    els.play = $("btn-play");
    els.next = $("btn-next");
    els.repeat = $("btn-repeat");
    els.playIcon = $("play-pause-icon");
    els.repeatIcon = $("repeat-icon");
    els.recentSection = $("recent");
    els.recentList = $("recent-list");
    els.tabQueue = $("tab-queue");
    els.tabRecent = $("tab-recent");
    els.recentPanel = $("panel-recent");
    els.recentPanelList = $("recent-panel-list");
    els.genreChipList = $("genre-chip-list");
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

  // Error toast — the only status surface on every viewport. Created lazily and
  // auto-dismissed; re-triggering restarts the timer.
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

  // Only real errors surface — the transient loading messages are dropped so the
  // view stays quiet during normal playback.
  function setStatus(msg, isError) {
    if (isError && msg) showToast(msg);
  }

  function renderPlaylist(queue) {
    closeRowMenu(); // a new queue must not leave a menu pointing at a dead row
    currentQueue = queue;
    els.list.innerHTML = "";
    queue.forEach(function (track, i) {
      var li = document.createElement("li");
      // Plain text node: the CSS counter (.playlist li::before) and the row's
      // text-overflow both work off the row's inline content. The kebab below is
      // absolutely positioned, so it stays out of that flow.
      li.textContent = track.artist + " – " + track.title;
      li.title = li.textContent;
      li.dataset.index = String(i);
      li.appendChild(buildRowMenuButton(track, i));
      els.list.appendChild(li);
    });
    lastCurrent = -1;
  }

  // ---- Row menu: start a fresh session from any track's artist ----------
  // Mid-session (especially in "similar" mode, where every row is a different
  // artist) the kebab is the way to chase one of them without retyping it.

  function buildRowMenuButton(track, i) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "row-menu";
    btn.dataset.index = String(i);
    btn.setAttribute("aria-haspopup", "menu");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-label", "Options for " + track.artist);
    btn.textContent = "⋮";
    return btn;
  }

  // One reusable popup, created lazily like the toast. It lives on <body>, not
  // inside the row: .playlist scrolls (overflow-y: auto), which would clip it.
  var menuEl = null;
  var menuBtn = null; // the kebab that opened it, so we can reset aria-expanded

  function menuItem(label, mode) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "row-action";
    b.setAttribute("role", "menuitem");
    b.dataset.mode = mode;
    b.textContent = label;
    return b;
  }

  function ensureMenu() {
    if (menuEl) return menuEl;
    menuEl = document.createElement("div");
    menuEl.className = "row-actions";
    menuEl.setAttribute("role", "menu");
    menuEl.hidden = true;

    menuEl.appendChild(menuItem("play this artist", "only"));
    menuEl.appendChild(menuItem("play similar artists", "similar"));

    // Picking an item is the same move as clicking a recent chip: fill the
    // input, then hand off to build() for the reset + search.
    menuEl.addEventListener("click", function (e) {
      var item = e.target.closest(".row-action");
      if (!item || !menuEl.dataset.artist) return;
      els.input.value = menuEl.dataset.artist;
      var mode = item.dataset.mode;
      closeRowMenu();
      build(mode);
    });

    document.body.appendChild(menuEl);
    return menuEl;
  }

  function onDocClick(e) {
    if (menuEl && !menuEl.contains(e.target) && !e.target.closest(".row-menu")) {
      closeRowMenu();
    }
  }

  function onDocKeydown(e) {
    if (e.key === "Escape") closeRowMenu();
  }

  function openRowMenu(btn, track) {
    if (!track) return;
    var menu = ensureMenu();
    if (menuBtn === btn) return closeRowMenu(); // second click toggles it shut
    closeRowMenu();

    menu.dataset.artist = track.artist;
    menu.hidden = false;

    // Fixed-positioned off the button, flipped above it near the viewport floor.
    var r = btn.getBoundingClientRect();
    var h = menu.offsetHeight;
    var w = menu.offsetWidth;
    var top = r.bottom + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
    menu.style.top = top + "px";
    menu.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + "px";

    menuBtn = btn;
    btn.setAttribute("aria-expanded", "true");
    btn.classList.add("open");

    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onDocKeydown);
    els.list.addEventListener("scroll", closeRowMenu);
    window.addEventListener("resize", closeRowMenu);
  }

  function closeRowMenu() {
    if (!menuEl || menuEl.hidden) return;
    menuEl.hidden = true;
    if (menuBtn) {
      menuBtn.setAttribute("aria-expanded", "false");
      menuBtn.classList.remove("open");
      menuBtn = null;
    }
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onDocKeydown);
    els.list.removeEventListener("scroll", closeRowMenu);
    window.removeEventListener("resize", closeRowMenu);
  }

  // Recent searches: chips of past artist+mode searches. They appear in two
  // places from one store — the landing-view #recent list and the playlist
  // panel's Recent tab — so the same markup builds both.

  // One chip, built with textContent (artist names are user input — never
  // innerHTML), carrying a play button and a × remove button.
  function buildChip(item) {
    var li = document.createElement("li");
    li.className = "recent-chip";

    var play = document.createElement("button");
    play.type = "button";
    play.className = "recent-chip-play";
    play.dataset.artist = item.artist;
    play.dataset.mode = item.mode;

    var name = document.createElement("span");
    name.className = "recent-chip-name";
    name.textContent = item.artist;

    var tag = document.createElement("span");
    tag.className = "recent-chip-mode";
    tag.textContent = item.mode;

    play.appendChild(name);
    play.appendChild(tag);

    var remove = document.createElement("button");
    remove.type = "button";
    remove.className = "recent-chip-remove";
    remove.dataset.artist = item.artist;
    remove.dataset.mode = item.mode;
    remove.setAttribute(
      "aria-label",
      "Remove " + item.artist + " (" + item.mode + ")"
    );
    remove.textContent = "×"; // ×

    li.appendChild(play);
    li.appendChild(remove);
    return li;
  }

  function fillChips(listEl, items) {
    listEl.innerHTML = "";
    items.forEach(function (item) {
      listEl.appendChild(buildChip(item));
    });
  }

  // Swap the panel between the live queue and the recent list.
  function setActiveTab(name) {
    var showRecent = name === "recent";
    els.tabQueue.classList.toggle("active", !showRecent);
    els.tabRecent.classList.toggle("active", showRecent);
    els.tabQueue.setAttribute("aria-selected", showRecent ? "false" : "true");
    els.tabRecent.setAttribute("aria-selected", showRecent ? "true" : "false");
    els.list.hidden = showRecent;
    els.recentPanel.hidden = !showRecent;
  }

  // Repaint both surfaces from the store; each hides itself while empty. The
  // Recent tab disappears when there's nothing to show — and if it was the
  // active tab, fall back to the queue.
  function renderRecent() {
    var items = recent.list();
    var has = items.length > 0;
    fillChips(els.recentList, items);
    fillChips(els.recentPanelList, items);
    els.recentSection.hidden = !has;
    els.tabRecent.hidden = !has;
    if (!has && els.tabRecent.classList.contains("active")) setActiveTab("queue");
  }

  // Genre shortcuts: an MRU-ordered, localStorage-backed list (js/genres.js).
  // Only the first GENRE_VISIBLE show; a trailing "+N more" chip reveals the
  // rest. Picking a genre moves it to the front for next time and collapses
  // back to the compact view.

  function buildGenreChip(name) {
    var li = document.createElement("li");
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "genre-chip";
    btn.dataset.genre = name;
    btn.textContent = name;
    li.appendChild(btn);
    return li;
  }

  function buildToggleChip(label, extraClass) {
    var li = document.createElement("li");
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "genre-chip " + extraClass;
    btn.textContent = label;
    li.appendChild(btn);
    return li;
  }

  function renderGenreChips() {
    var all = genres.list();
    var visible = genresExpanded ? all : all.slice(0, GENRE_VISIBLE);
    els.genreChipList.innerHTML = "";
    visible.forEach(function (name) {
      els.genreChipList.appendChild(buildGenreChip(name));
    });
    if (genresExpanded) {
      if (all.length > GENRE_VISIBLE) {
        els.genreChipList.appendChild(buildToggleChip("collapse", "genre-chip-collapse"));
      }
    } else {
      var hidden = all.length - visible.length;
      if (hidden > 0) {
        els.genreChipList.appendChild(buildToggleChip("+" + hidden + " more", "genre-chip-more"));
      }
    }
  }

  // Shared by both chip lists: × forgets an entry; the chip body fills the input
  // and starts that session (build() then flips to the Queue tab).
  function onRecentClick(e) {
    var remove = e.target.closest(".recent-chip-remove");
    if (remove) {
      recent.remove(remove.dataset.artist, remove.dataset.mode);
      renderRecent();
      return;
    }
    var play = e.target.closest(".recent-chip-play");
    if (!play) return;
    els.input.value = play.dataset.artist;
    build(play.dataset.mode);
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

  // ---- Tab title: reflects the current track, falls back to the app name ----

  var BASE_TITLE = "tubalr";

  function updateDocumentTitle(state) {
    var track = state.queue[state.currentIndex];
    if (!track) {
      document.title = BASE_TITLE;
      return;
    }
    document.title =
      (state.playing ? "▶ " : "❚❚ ") +
      track.artist +
      " – " +
      track.title +
      " · " +
      BASE_TITLE;
  }

  // player -> UI
  function onChange(state) {
    highlightCurrent(state.currentIndex);
    reflectPlaying(state.playing);
    reflectRepeat(state.repeatMode);
    updateMediaSession(state);
    updateDocumentTitle(state);
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
    setStatus("Loading " + (STATUS_VERB[mode] || STATUS_VERB.only) + "“" + artist + "”…");

    var promise = (BUILDERS[mode] || playlist.buildOnly)(artist);

    promise
      .then(function (queue) {
        if (!queue.length) {
          setStatus("No results for “" + artist + "”. Check the spelling?", true);
          return;
        }
        renderPlaylist(queue);
        player.start(queue);
        recent.add(artist, mode);
        renderRecent();
        setActiveTab("queue"); // a new queue takes focus over the recent list
      })
      .catch(function (err) {
        setStatus(err.message || "Something went wrong.", true);
      })
      .then(function () {
        setBuilding(false);
      });
  }

  // If what's typed matches a curated genre exactly (case-insensitive), genre
  // mode wins no matter which button is clicked — "rap" + "similar" should
  // play the genre, not fail trying to look up an artist named "rap".
  function modeFor(requested) {
    var text = els.input.value.trim().toLowerCase();
    var isGenre = genres.list().some(function (g) {
      return g.toLowerCase() === text;
    });
    return isGenre ? "genre" : requested;
  }

  function wire() {
    // Submit (Enter or the "only" button) defaults to "only".
    els.form.addEventListener("submit", function (e) {
      e.preventDefault();
      build(modeFor("only"));
    });
    // Every other mode button (currently just "similar") builds its own mode
    // on click, keyed generically off data-mode rather than hardcoded.
    els.modeButtons.forEach(function (b) {
      if (b.type !== "submit") {
        b.addEventListener("click", function () {
          build(modeFor(b.dataset.mode));
        });
      }
    });

    els.list.addEventListener("click", function (e) {
      var kebab = e.target.closest(".row-menu");
      if (kebab) {
        // The kebab opens the menu instead of playing the row it sits on.
        openRowMenu(kebab, currentQueue[Number(kebab.dataset.index)]);
        return;
      }
      var li = e.target.closest("li");
      if (!li) return;
      player.playByQueueIndex(Number(li.dataset.index));
    });

    // Recent chips live in two lists (landing + panel tab); both share one
    // handler. The tab bar swaps the panel between the queue and the recents.
    els.recentList.addEventListener("click", onRecentClick);
    els.recentPanelList.addEventListener("click", onRecentClick);

    // Genre mode has no mode button of its own — a chip fills the input with
    // its tag and calls build("genre") directly, same handoff a recent chip
    // uses. The trailing "+N more"/"collapse" chip just toggles the list
    // instead of playing.
    els.genreChipList.addEventListener("click", function (e) {
      var more = e.target.closest(".genre-chip-more");
      if (more) {
        genresExpanded = true;
        renderGenreChips();
        return;
      }
      var collapse = e.target.closest(".genre-chip-collapse");
      if (collapse) {
        genresExpanded = false;
        renderGenreChips();
        return;
      }
      var chip = e.target.closest(".genre-chip");
      if (!chip) return;
      var name = chip.dataset.genre;
      els.input.value = name;
      genres.use(name);
      genresExpanded = false; // back to the compact view for next time
      renderGenreChips();
      build("genre");
    });

    els.tabQueue.addEventListener("click", function () { setActiveTab("queue"); });
    els.tabRecent.addEventListener("click", function () { setActiveTab("recent"); });

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
    renderRecent();
    renderGenreChips();
    player.init({ onChange: onChange, onStatus: setStatus });
  }

  Tubalr.ui = { init: init, setStatus: setStatus };
})(window.Tubalr);
