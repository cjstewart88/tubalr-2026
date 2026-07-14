// Transport + queue state machine. Owns the play order, lazy video resolution,
// auto-advance, shuffle, and play/pause. Talks to youtube.js for playback and
// reports state back to the UI via callbacks passed to init().
window.Tubalr = window.Tubalr || {};

(function (Tubalr) {
  "use strict";

  var youtube = Tubalr.youtube;

  var queue = []; // [{ artist, title, query, videoId }]
  var order = []; // permutation of queue indices = the play order
  var pos = 0; // position within `order`
  var shuffle = false;
  var playing = false;
  var failStreak = 0; // consecutive unresolved tracks (loop guard)

  var cb = { onChange: function () {}, onStatus: function () {} };

  function range(n) {
    var a = [];
    for (var i = 0; i < n; i++) a.push(i);
    return a;
  }

  function shuffled(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = a[i];
      a[i] = a[j];
      a[j] = tmp;
    }
    return a;
  }

  function currentTrack() {
    return queue[order[pos]];
  }

  function notify() {
    cb.onChange({
      queue: queue,
      currentIndex: queue.length ? order[pos] : -1,
      playing: playing,
      shuffle: shuffle,
    });
  }

  function status(msg, isError) {
    cb.onStatus(msg || "", !!isError);
  }

  function launch(track) {
    youtube.load(track.videoId); // loadVideoById also starts playback
    playing = true;
    status(track.artist + " – " + track.title);
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
          if (failStreak >= order.length) {
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
    var p = pos + dir;
    if (p < 0) {
      status("Start of playlist.");
      return;
    }
    if (p >= order.length) {
      playing = false;
      status("End of playlist.");
      notify();
      return;
    }
    playAt(p, dir);
  }

  // ---- public transport ----

  function start(newQueue) {
    queue = newQueue || [];
    order = range(queue.length);
    shuffle = false;
    pos = 0;
    failStreak = 0;
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
    var p = order.indexOf(qi);
    if (p < 0) return;
    failStreak = 0;
    playAt(p, 1);
  }

  function togglePlay() {
    if (!queue.length) return;
    if (playing) youtube.pause();
    else youtube.play();
    // playing flag + button state are synced via the YT state-change handler.
  }

  function toggleShuffle() {
    if (!queue.length) return;
    var currentQI = order[pos];
    shuffle = !shuffle;
    if (shuffle) {
      order = shuffled(range(queue.length));
      var at = order.indexOf(currentQI);
      order.splice(at, 1);
      order.unshift(currentQI); // keep the current track playing, first in order
      pos = 0;
    } else {
      order = range(queue.length);
      pos = currentQI;
    }
    notify();
  }

  // Prefetch the next track's videoId so the transition is instant (and so the
  // quota hit happens ahead of time rather than mid-gap).
  function prefetchNext() {
    var np = pos + 1;
    if (np >= order.length) return;
    var t = queue[order[np]];
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

  function onYtError() {
    // Current video failed to play (removed / embedding disabled) — skip it.
    failStreak++;
    if (failStreak >= order.length) {
      playing = false;
      status("Couldn't play this playlist (videos unavailable).", true);
      notify();
      return;
    }
    status("Video unavailable, skipping…");
    advance(1);
  }

  function init(callbacks) {
    cb = Object.assign(cb, callbacks || {});
    youtube.setHandlers({
      onEnded: function () {
        failStreak = 0;
        advance(1);
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
    toggleShuffle: toggleShuffle,
    playByQueueIndex: playByQueueIndex,
  };
})(window.Tubalr);
