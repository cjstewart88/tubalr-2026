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

  function renderPlaylist(queue, mode) {
    closeRowMenu(); // a new queue must not leave a menu pointing at a dead row
    finishDrag(false); // ...nor a drag holding a row that's about to be thrown away
    currentQueue = queue;
    els.list.innerHTML = "";
    queue.forEach(function (track, i) {
      var li = document.createElement("li");
      var label = track.artist + " – " + track.title;
      // In "only" mode every row is the same artist, so the prefix is dead
      // weight in a narrow, ellipsized row — show the title alone. The tooltip
      // below keeps the full label either way.
      var rowText = mode === "only" ? track.title : label;
      // .row-text-mask is the flex-sized, clipped viewport between the counter
      // (.playlist li::before) and the kebab's reserved padding; .row-text
      // inside it is what hover/long-press slides. Clipping on the mask rather
      // than the li means the slide can never paint over either neighbor.
      var mask = document.createElement("span");
      mask.className = "row-text-mask";
      var text = document.createElement("span");
      text.className = "row-text";
      text.textContent = rowText;
      mask.appendChild(text);
      li.title = label;
      li.dataset.index = String(i);
      li.appendChild(mask);
      li.appendChild(buildRowMenuButton(track, i));
      bindRowGestures(li);
      els.list.appendChild(li);
    });
    lastCurrent = -1;
  }

  // ---- Row text scroll: reveal truncated titles on hover / long-press -----
  // Rows too wide for the panel are ellipsized by default (.playlist li); this
  // slides the full text left so the tail becomes readable, then loops back.
  var LONG_PRESS_MS = 450;

  function rowScrollDistance(li) {
    var mask = li.querySelector(".row-text-mask");
    var text = li.querySelector(".row-text");
    if (!mask || !text) return 0;
    return Math.max(0, text.offsetWidth - mask.clientWidth);
  }

  function startRowScroll(li) {
    var dist = rowScrollDistance(li);
    if (dist <= 0) return; // fits already; nothing to reveal
    li.style.setProperty("--row-scroll-dist", "-" + dist + "px");
    li.style.setProperty("--row-scroll-duration", Math.max(2.5, dist / 40 + 1.5) + "s");
    li.classList.add("scrolling");
  }

  function stopRowScroll(li) {
    li.classList.remove("scrolling");
  }

  // ---- Row gestures: press-and-hold to drag a row to a new slot ---------
  // One gesture, two payoffs: holding a row lifts it for dragging *and* scrolls
  // its text, so the hold that reorders the queue is also how you read a
  // truncated title on touch (hover does that job with a mouse).
  //
  // The drag itself needs no ghost element or placeholder. Rows are uniform
  // single-line boxes, so it runs off one measured row height: the held row is
  // translated by the pointer delta, and every time that delta passes half a row
  // the node is re-inserted one slot up or down. The DOM order therefore *is*
  // the drop order the moment the press ends — all that's left is to tell the
  // player about it.

  var PRESS_SLOP = 8; // px of movement that turns a hold into a scroll/swipe instead
  var EDGE = 32; // distance from the list's edge where auto-scroll kicks in
  var EDGE_SPEED = 10; // px per frame at the very edge

  var press = null; // a hold that hasn't become a drag yet
  var drag = null; // the active drag, null when idle
  var suppressClick = false; // the release that ends a drag must not play the row

  function cancelPress() {
    if (!press) return;
    clearTimeout(press.timer);
    press = null;
  }

  function beginPress(li, clientY, e) {
    // The kebab is its own control — holding it shouldn't drag the row it sits on.
    if (drag || e.target.closest(".row-menu")) return;
    cancelPress();
    // y0 is the fixed origin the slop is measured against (so a slow drift can't
    // creep past it); y is where the pointer actually is when the hold lands.
    press = { li: li, y0: clientY, y: clientY };
    press.timer = setTimeout(function () {
      var held = press;
      press = null;
      startRowScroll(held.li);
      beginDrag(held.li, held.y);
    }, LONG_PRESS_MS);
  }

  function beginDrag(li, clientY) {
    closeRowMenu();
    drag = {
      li: li,
      from: Number(li.dataset.index),
      slots: 0, // rows travelled from the start position, signed
      rowH: li.offsetHeight || 1,
      count: els.list.children.length,
      startY: clientY,
      pointerY: clientY,
      startScroll: els.list.scrollTop,
      raf: 0,
    };
    li.classList.add("dragging");
    document.body.classList.add("row-dragging");
    if (navigator.vibrate) navigator.vibrate(12); // the row is in hand now
    drag.raf = requestAnimationFrame(dragFrame);
  }

  // How far the held row should appear to have travelled: the pointer's own
  // movement plus any list scrolling underneath it — the row scrolls with the
  // content, so without that term it would drift out from under the pointer.
  function dragDelta() {
    return drag.pointerY - drag.startY + (els.list.scrollTop - drag.startScroll);
  }

  function shiftDragged(dir) {
    var li = drag.li;
    var sibling = dir > 0 ? li.nextElementSibling : li.previousElementSibling;
    if (!sibling) return;
    if (dir > 0) els.list.insertBefore(sibling, li);
    else els.list.insertBefore(li, sibling);
  }

  // Travel available from the row's *starting* slot, in px, signed like the delta.
  function dragLimit(dir) {
    var slots = dir > 0 ? drag.count - 1 - drag.from : -drag.from;
    return slots * drag.rowH + (dir * drag.rowH) / 2; // half a row of overhang at the end
  }

  function applyDrag() {
    // Clamped at both ends, because past the last slot the row has nowhere left
    // to go and an unclamped translate spills scrollable overflow out the bottom
    // of the list — which the auto-scroll then chases, growing scrollTop, which
    // grows the delta, which spills further. That runaway is what made the list
    // stretch forever and snap back on release.
    var delta = Math.min(dragLimit(1), Math.max(dragLimit(-1), dragDelta()));
    var slack = delta - drag.slots * drag.rowH; // how far past its current slot
    while (slack > drag.rowH / 2 && drag.from + drag.slots < drag.count - 1) {
      drag.slots++;
      slack -= drag.rowH;
      shiftDragged(1);
    }
    while (slack < -drag.rowH / 2 && drag.from + drag.slots > 0) {
      drag.slots--;
      slack += drag.rowH;
      shiftDragged(-1);
    }
    drag.li.style.transform = "translateY(" + (delta - drag.slots * drag.rowH) + "px)";
  }

  // One loop for the whole drag: it drives the auto-scroll (dragging against
  // either edge of the panel pulls the list along, so rows off-screen are
  // reachable) and re-applies the transform, which has to follow that scrolling
  // even when the pointer itself is holding still.
  function dragFrame() {
    if (!drag) return;
    var r = els.list.getBoundingClientRect();
    var past = 0; // how far into an edge band the pointer is, signed
    if (drag.pointerY > r.bottom - EDGE) past = drag.pointerY - (r.bottom - EDGE);
    else if (drag.pointerY < r.top + EDGE) past = drag.pointerY - (r.top + EDGE);
    // Nothing to scroll toward once the row is sitting in the end slot.
    var at = drag.from + drag.slots;
    if ((past > 0 && at >= drag.count - 1) || (past < 0 && at <= 0)) past = 0;
    if (past) {
      var speed = (Math.min(Math.abs(past), EDGE) / EDGE) * EDGE_SPEED;
      els.list.scrollTop += past > 0 ? speed : -speed;
    }
    applyDrag();
    drag.raf = requestAnimationFrame(dragFrame);
  }

  // The rows are the source of truth once a drag lands. The visible "1." numbers
  // are a CSS counter and fix themselves; the indices the click and kebab
  // handlers read do not.
  function reindexRows() {
    Array.prototype.forEach.call(els.list.children, function (li, i) {
      li.dataset.index = String(i);
      var kebab = li.querySelector(".row-menu");
      if (kebab) kebab.dataset.index = String(i);
    });
  }

  function finishDrag(commit) {
    if (!drag) return;
    var d = drag;
    drag = null;
    cancelAnimationFrame(d.raf);
    d.li.classList.remove("dragging");
    d.li.style.transform = "";
    document.body.classList.remove("row-dragging");
    // Dropping under a mouse leaves the row hovered, and hovering is its own
    // reason for the text to keep scrolling — mouseenter won't fire again to
    // restart it. On touch there's nothing hovering it, so it stops.
    if (!d.li.matches(":hover")) stopRowScroll(d.li);
    if (!commit) return; // the caller is replacing these rows wholesale
    reindexRows();
    // player.moveTrack splices the same array renderPlaylist drew from, so
    // currentQueue lines up with the re-indexed rows without being rebuilt, and
    // the state it notifies with re-highlights the playing row in its new slot.
    player.moveTrack(d.from, d.from + d.slots);
  }

  function onPressMove(clientY, e) {
    if (drag) {
      drag.pointerY = clientY;
      // Hold the list (and the page behind it) still while a row is in hand.
      if (e.cancelable) e.preventDefault();
      return;
    }
    if (!press) return;
    if (Math.abs(clientY - press.y0) > PRESS_SLOP) cancelPress(); // a scroll, not a hold
    else press.y = clientY;
  }

  function onPressEnd(e) {
    if (drag) {
      finishDrag(true);
      suppressClick = true;
      // Nothing synthesizes a click after a prevented touchend, so clear the
      // flag on the next tick rather than waiting for a click that may not come.
      setTimeout(function () { suppressClick = false; }, 0);
      if (e && e.cancelable) e.preventDefault();
      return;
    }
    cancelPress();
  }

  function bindRowGestures(li) {
    li.addEventListener("mouseenter", function () {
      if (!drag) startRowScroll(li); // rows swept past by a drag stay quiet
    });
    li.addEventListener("mouseleave", function () {
      if (!drag) stopRowScroll(li);
    });
    li.addEventListener("mousedown", function (e) {
      if (e.button === 0) beginPress(li, e.clientY, e);
    });
    li.addEventListener("touchstart", function (e) {
      beginPress(li, e.touches[0].clientY, e);
    }, { passive: true });
  }

  // The rest of the gesture is bound once, not per row. A mouse can wander off
  // the row (and off the list) mid-drag, so those go on the document; a touch
  // gesture always keeps dispatching to the element it started on, so the list
  // itself catches every move. Scoping matters here: touchmove must be
  // non-passive to be cancellable during a drag, and a non-passive listener on
  // the document would opt the whole page out of fast scrolling to buy it.
  function bindDragSurface() {
    document.addEventListener("mousemove", function (e) {
      if (press || drag) onPressMove(e.clientY, e);
    });
    document.addEventListener("mouseup", onPressEnd);
    els.list.addEventListener("touchmove", function (e) {
      if (press || drag) onPressMove(e.touches[0].clientY, e);
    }, { passive: false });
    els.list.addEventListener("touchend", onPressEnd);
    els.list.addEventListener("touchcancel", function () {
      // Drop it where it stands; there's no gesture left to place it any better.
      onPressEnd(null);
    });
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
        renderPlaylist(queue, mode);
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
      if (suppressClick) return; // the mouseup that dropped a dragged row
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
    bindDragSurface();
    wireMediaSession();
    renderRecent();
    renderGenreChips();
    player.init({ onChange: onChange, onStatus: setStatus });
  }

  Tubalr.ui = { init: init, setStatus: setStatus };
})(window.Tubalr);
