// Transport + queue state machine. Owns the play order, lazy video resolution,
// auto-advance, shuffle (reshuffle-and-restart), and play/pause. Talks to youtube.js and
// reports state back to the UI via callbacks passed to init().
window.Tubalr = window.Tubalr || {};

(function (Tubalr) {
  "use strict";

  var youtube = Tubalr.youtube;

  var FAIL_STREAK_STOP = 3; // consecutive unplayable tracks before we stop and explain

  var queue = []; // [{ artist, title, query, videoId }] — also the play order
  var pos = 0; // index of the current track within `queue`
  var playing = false;
  var failStreak = 0; // consecutive unresolved tracks (loop guard)
  var repeatMode = "all"; // "all" = loop the queue; "one" = replay current on end
  var reordered = false; // one-shot: the next notify redraws the rows, not just re-highlights

  var cb = { onChange: function () {}, onStatus: function () {} };

  function currentTrack() {
    return queue[pos];
  }

  function notify() {
    cb.onChange({
      queue: queue,
      currentIndex: queue.length ? pos : -1,
      playing: playing,
      repeatMode: repeatMode,
      reordered: reordered,
    });
    reordered = false; // consumed; only the notify right after a reshuffle redraws rows
  }

  function status(msg, isError) {
    cb.onStatus(msg || "", !!isError);
  }

  function launch(track) {
    youtube.load(track.videoId); // loadVideoById also starts playback
    playing = true;
    status(""); // clear any "finding video…" note; the title isn't shown above the video
    notify();
    prefetchNext();
  }

  // Resolve current track's video (from cache/API if needed), then play it.
  // `dir` is the direction to keep skipping if this track has no video.
  function playAt(p, dir) {
    pos = p;
    var track = currentTrack();
    notify(); // highlight the row immediately, even before the video resolves

    if (track.videoId) {
      failStreak = 0;
      launch(track);
      return;
    }

    status("Finding video for “" + track.title + "”…");
    youtube
      .searchVideoId(track.query)
      .then(function (id) {
        track.videoId = id;
        if (!id) {
          failStreak++;
          if (failStreak >= queue.length) {
            playing = false;
            status("Couldn't find playable videos for this playlist.", true);
            notify();
            return;
          }
          status("No video for “" + track.title + "”, skipping…");
          advance(dir);
          return;
        }
        failStreak = 0;
        launch(track);
      })
      .catch(function (err) {
        playing = false;
        if (err instanceof youtube.QuotaError) {
          status(
            "YouTube search quota reached for today. Playback resumes tomorrow, " +
              "or add quota in the Google Cloud console.",
            true
          );
        } else {
          status(err.message || "Video search failed.", true);
        }
        notify();
      });
  }

  function advance(dir) {
    if (!queue.length) return;
    var p = (pos + dir) % queue.length;
    if (p < 0) p += queue.length; // JS % keeps sign; normalize for dir === -1
    playAt(p, dir);
  }

  // ---- public transport ----

  function start(newQueue) {
    queue = newQueue || [];
    pos = 0;
    failStreak = 0;
    repeatMode = "all"; // each new playlist defaults to looping the whole queue
    if (!queue.length) {
      playing = false;
      status("No tracks found.", true);
      notify();
      return;
    }
    playAt(0, 1);
  }

  function next() {
    failStreak = 0;
    advance(1);
  }

  function prev() {
    failStreak = 0;
    advance(-1);
  }

  // Jump to a specific track by its index in `queue` (playlist-row click).
  function playByQueueIndex(qi) {
    if (qi < 0 || qi >= queue.length) return;
    failStreak = 0;
    playAt(qi, 1);
  }

  // Move a track to a new slot in the queue (the playlist's drag & drop). Whatever
  // is playing keeps playing, uninterrupted — only where it sits changes.
  // `queue` is spliced in place because the UI renders from the same array, and the
  // list *is* the play order, so `pos` just follows the current track to its new slot.
  function moveTrack(from, to) {
    var n = queue.length;
    if (!n || from === to) return;
    if (from < 0 || from >= n || to < 0 || to >= n) return;

    // Where an old queue index lands once `from` is pulled out and reinserted at `to`.
    function remap(i) {
      if (i === from) return to;
      if (from < to) return i > from && i <= to ? i - 1 : i;
      return i >= to && i < from ? i + 1 : i;
    }

    queue.splice(to, 0, queue.splice(from, 1)[0]);
    pos = remap(pos);
    notify();
  }

  function togglePlay() {
    if (!queue.length) return;
    if (playing) youtube.pause();
    else youtube.play();
    // playing flag + button state are synced via the YT state-change handler.
  }

  // Flip between looping the whole queue ("all") and replaying the current track
  // on end ("one"). Only affects natural track-end; manual skips still move tracks.
  function toggleRepeat() {
    repeatMode = repeatMode === "all" ? "one" : "all";
    notify();
  }

  // Reorder the whole visible playlist and immediately play from the new track 1.
  // A one-shot action, not a mode — spam it to reroll the order. The queue is
  // shuffled *in place* (the UI renders from that same array), and `reordered` tells
  // the UI to redraw the rows rather than just re-highlight. Any manual drag order
  // is intentionally thrown away; shuffle rebuilds the list from scratch.
  function shuffleQueue() {
    if (!queue.length) return;
    for (var i = queue.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = queue[i];
      queue[i] = queue[j];
      queue[j] = tmp;
    }
    failStreak = 0;
    reordered = true;
    playAt(0, 1);
  }

  // Prefetch the next track's videoId so the transition is instant (and so the
  // quota hit happens ahead of time rather than mid-gap).
  function prefetchNext() {
    var np = pos + 1;
    if (np >= queue.length) return;
    var t = queue[np];
    if (!t || t.videoId) return;
    youtube
      .searchVideoId(t.query)
      .then(function (id) {
        t.videoId = id;
      })
      .catch(function () {
        /* ignore — real resolution happens when we actually advance */
      });
  }

  function onYtState(state) {
    // YT.PlayerState: 1 PLAYING, 2 PAUSED
    if (state === 1 && !playing) {
      playing = true;
      notify();
    } else if (state === 2 && playing) {
      playing = false;
      notify();
    }
  }

  function onYtError(code) {
    // A video failed (removed / embedding disabled / bot-check block). Skip past
    // isolated failures silently, but once enough fail in a row, stop the session:
    // the user can search again or click a track to reset.
    failStreak++;
    if (failStreak >= Math.min(FAIL_STREAK_STOP, queue.length)) {
      playing = false;
      status("Something went wrong: " + code, true);
      notify();
      return;
    }
    advance(1);
  }

  function init(callbacks) {
    cb = Object.assign(cb, callbacks || {});
    youtube.setHandlers({
      onEnded: function () {
        failStreak = 0;
        if (repeatMode === "one") {
          youtube.replay(); // seek the current video back to 0 and play it again
          playing = true;
          notify();
        } else {
          advance(1);
        }
      },
      onError: onYtError,
      onStateChange: onYtState,
    });
  }

  Tubalr.player = {
    init: init,
    start: start,
    next: next,
    prev: prev,
    togglePlay: togglePlay,
    toggleRepeat: toggleRepeat,
    shuffleQueue: shuffleQueue,
    playByQueueIndex: playByQueueIndex,
    moveTrack: moveTrack,
  };
})(window.Tubalr);
