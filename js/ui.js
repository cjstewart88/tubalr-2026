// DOM layer: renders the playlist, wires the search form + transport buttons,
// and reflects player state (current row, play/pause icon, shuffle pressed).
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
    els.playIcon = $("play-pause-icon");
  }

  // Icon markup for the action the play/pause button performs (the opposite of
  // the current state): show "pause" while playing, "play" while paused.
  var ICON_PLAY = '<polygon points="6 4 20 12 6 20 6 4"/>';
  var ICON_PAUSE = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';

  function setStatus(msg, isError) {
    els.status.textContent = msg || "";
    els.status.classList.toggle("error", !!isError);
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

  function reflectShuffle(isShuffle) {
    els.shuffle.setAttribute("aria-pressed", isShuffle ? "true" : "false");
  }

  // player -> UI
  function onChange(state) {
    highlightCurrent(state.currentIndex);
    reflectPlaying(state.playing);
    reflectShuffle(state.shuffle);
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

    els.shuffle.addEventListener("click", player.toggleShuffle);
    els.prev.addEventListener("click", player.prev);
    els.play.addEventListener("click", player.togglePlay);
    els.next.addEventListener("click", player.next);
  }

  function init() {
    cacheEls();
    wire();
    player.init({ onChange: onChange, onStatus: setStatus });
  }

  Tubalr.ui = { init: init, setStatus: setStatus };
})(window.Tubalr);
