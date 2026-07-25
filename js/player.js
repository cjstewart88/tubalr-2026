// Transport + queue state machine. Owns the play order, lazy video resolution,
// auto-advance, shuffle (reshuffle-and-restart), and play/pause. Talks to youtube.js and
// reports state back to the UI via callbacks passed to init().
window.Tubalr = window.Tubalr || {};

(function (Tubalr) {
  "use strict";

  var youtube = Tubalr.youtube;

  var FAIL_STREAK_STOP = 3; // consecutive unplayable tracks before we stop and explain
  var DRIFT_TOLERANCE = 4; // seconds off the DJ before a follow-mode reseek

  var queue = []; // [{ artist, title, query, videoId }] — also the play order
  var pos = 0; // index of the current track within `queue`
  var playing = false;
  var failStreak = 0; // consecutive unresolved tracks (loop guard)
  var repeatMode = "all"; // "all" = loop the queue; "one" = replay current on end
  var reordered = false; // one-shot: the next notify redraws the rows, not just re-highlights

  // DJ-mode follow mode (listener side): the queue mirrors a remote DJ's session.
  // Local transport is inert except play/pause; unpausing asks live.js to re-sync
  // to the DJ's current spot rather than resuming from where the pause left off.
  var followMode = false;
  var followCb = { onResumeRequest: function () {} };
  var stateHook = null; // extra notify() tap; live.js uses it to broadcast/observe
  var loadedVideoId = null; // last videoId handed to youtube.load (dedup for follow mode)

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
      // Remote queues always render as "artist – title": in similar-style lists
      // every row can be a different artist, and the listener never knows which
      // mode the DJ searched in.
      mode: followMode ? "similar" : null,
    });
    reordered = false; // consumed; only the notify right after a reshuffle redraws rows
    if (stateHook) stateHook();
  }

  function status(msg, isError) {
    cb.onStatus(msg || "", !!isError);
  }

  function launch(track) {
    loadedVideoId = track.videoId;
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
    if (followMode) return;
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
    if (followMode) return;
    failStreak = 0;
    advance(1);
  }

  function prev() {
    if (followMode) return;
    failStreak = 0;
    advance(-1);
  }

  // Jump to a specific track by its index in `queue` (playlist-row click).
  function playByQueueIndex(qi) {
    if (followMode) return;
    if (qi < 0 || qi >= queue.length) return;
    failStreak = 0;
    playAt(qi, 1);
  }

  // Move a track to a new slot in the queue (the playlist's drag & drop). Whatever
  // is playing keeps playing, uninterrupted — only where it sits changes.
  // `queue` is spliced in place because the UI renders from the same array, and the
  // list *is* the play order, so `pos` just follows the current track to its new slot.
  function moveTrack(from, to) {
    if (followMode) return;
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
    if (followMode && !playing) {
      // Unpausing a live broadcast doesn't resume where the pause left off — it
      // jumps back to wherever the DJ is now (possibly a different song).
      followCb.onResumeRequest();
      return;
    }
    if (playing) youtube.pause();
    else youtube.play();
    // playing flag + button state are synced via the YT state-change handler.
  }

  // Flip between looping the whole queue ("all") and replaying the current track
  // on end ("one"). Only affects natural track-end; manual skips still move tracks.
  function toggleRepeat() {
    if (followMode) return;
    repeatMode = repeatMode === "all" ? "one" : "all";
    notify();
  }

  // Reorder the whole visible playlist and immediately play from the new track 1.
  // A one-shot action, not a mode — spam it to reroll the order. The queue is
  // shuffled *in place* (the UI renders from that same array), and `reordered` tells
  // the UI to redraw the rows rather than just re-highlight. Any manual drag order
  // is intentionally thrown away; shuffle rebuilds the list from scratch.
  function shuffleQueue() {
    if (followMode || !queue.length) return;
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

  // ---- DJ-mode follow mode ----

  // What the DJ's clock says the track position is *now*: the broadcast position
  // plus however long ago live.js received it (a local timestamp, so listener/DJ
  // clock skew never enters the math — only network latency does).
  function remoteTime(remote) {
    var t = remote.currentTime || 0;
    if (remote.playing && remote.receivedAt) {
      t += Math.max(0, (Date.now() - remote.receivedAt) / 1000);
    }
    return t;
  }

  // Mirror a DJ state broadcast. Never searches, never prefetches — the current
  // track's videoId always arrives resolved (the DJ resolved it to play it), so
  // listeners cost zero YouTube quota. `opts.suppressPlay` keeps the queue/pos
  // updating while the listener is locally paused without starting playback.
  function applyRemoteState(remote, opts) {
    if (!followMode || !remote) return;
    opts = opts || {};
    var rq = remote.queue || [];

    // Diff by shape; adopt incoming videoIds either way (they only ever become
    // more resolved on the DJ side).
    var changed = rq.length !== queue.length;
    if (!changed) {
      for (var i = 0; i < rq.length; i++) {
        if (rq[i].query !== queue[i].query) {
          changed = true;
          break;
        }
        if (rq[i].videoId && !queue[i].videoId) queue[i].videoId = rq[i].videoId;
      }
    }
    if (changed) {
      queue = rq.map(function (t) {
        return { artist: t.artist, title: t.title, query: t.query, videoId: t.videoId || null };
      });
      reordered = true;
    }

    if (queue.length) {
      pos = Math.min(Math.max(remote.currentIndex || 0, 0), queue.length - 1);
    }
    repeatMode = remote.repeatMode || "all";

    var track = queue[pos];
    if (track && track.videoId && !opts.suppressPlay) {
      var target = remoteTime(remote);
      if (track.videoId !== loadedVideoId) {
        loadedVideoId = track.videoId;
        youtube.load(track.videoId, target); // auto-plays
        playing = true;
        if (!remote.playing) youtube.pause();
      } else if (remote.playing) {
        if (!playing) {
          youtube.play();
          playing = true;
        }
        // Drift check only here — states arrive seconds apart, so this never
        // turns into constant scrubbing.
        if (Math.abs(youtube.getCurrentTime() - target) > DRIFT_TOLERANCE) {
          youtube.seekTo(target);
        }
      } else if (playing) {
        youtube.pause(); // the DJ paused; flag syncs via the YT state handler
      }
    }
    notify();
  }

  function setFollowMode(on, cbs) {
    followMode = !!on;
    if (cbs) followCb = Object.assign(followCb, cbs);
    // Leaving follow mode keeps queue/pos/playing — the session just becomes a
    // normal one (auto-advance and lazy resolution take over from here).
    if (queue.length) notify();
  }

  function getSnapshot() {
    return {
      queue: queue,
      currentIndex: queue.length ? pos : -1,
      playing: playing,
      repeatMode: repeatMode,
    };
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
    if (followMode) {
      // Don't self-advance — wait for the DJ's next broadcast to move things on.
      playing = false;
      notify();
      return;
    }
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
        // A finished track earns coins for whoever heard it — including
        // follow-mode listeners, whose own player fires ENDED too.
        if (Tubalr.hats) Tubalr.hats.awardListen();
        if (followMode) {
          // The listener's copy finished slightly ahead of the DJ's. Don't
          // self-advance: it would race the DJ's own track-change broadcast
          // (arriving within seconds) and cost quota resolving the next id.
          playing = false;
          notify();
          return;
        }
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
    // DJ mode
    setStateHook: function (fn) {
      stateHook = fn;
    },
    setFollowMode: setFollowMode,
    applyRemoteState: applyRemoteState,
    getSnapshot: getSnapshot,
  };
})(window.Tubalr);
