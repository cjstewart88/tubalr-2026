// DJ mode: live broadcasting over Supabase Realtime (Broadcast + Presence on a
// tableless channel — no schema, no extra config). The DJ's player state fans out
// as `state` broadcasts; listeners mirror it through player.applyRemoteState.
// Presence carries who's here (role + creature color); `move`/`chat` broadcasts
// drive the creature layer. Optional like the shared cache: everything no-ops
// when Supabase isn't configured.
//
// Protocol (channel "dj:<roomId>"):
//   state  DJ → all   { seq, queue, currentIndex, playing, repeatMode,
//                       currentTime, sentAt }  — debounced after every player
//                      change, every 5s as a heartbeat, and on presence joins.
//   end    DJ → all   {}                        — explicit stream end.
//   move   any → all  { id, x, y, d, j }        — ≤5 Hz per client (creatures.js
//                      throttles; supabase-js caps clients at 10 events/sec).
//                      x/y are absolute *world* px (one shared coordinate space),
//                      not viewport fractions — see the header in creatures.js.
//   chat   any → all  { id, text }              — clamped to 120 chars both ends.
window.Tubalr = window.Tubalr || {};

(function (Tubalr) {
  "use strict";

  var HEARTBEAT_MS = 5000; // full-state cadence; also the listener's drift-check rate
  var STATE_DEBOUNCE_MS = 150; // coalesce notify bursts (shuffle = reorder + track change)
  var DJ_GRACE_MS = 8000; // presence-leave grace before listeners are released
  var STALE_MS = 15000; // no heartbeat for this long = the DJ tab is wedged/gone
  var JOIN_DEADLINE_MS = 10000; // opening a link to a silent room = it's dead
  var CHAT_MAX = 120;
  var DJ_COLOR = "#a06bff"; // --accent; keep in sync with styles.css
  var PALETTE = ["#7fd6a4", "#6bb8ff", "#ffb86b", "#ff6b9e", "#ede480", "#63e0e0", "#c98bff", "#8bdff0"];

  var channel = null;
  var role = null; // "dj" | "listener" | null
  var clientId = null;
  var roomId = null;
  var seq = 0; // DJ: last sent; listener: last accepted (stale-drop filter)
  var lastState = null; // listener: newest DJ state, stamped with receivedAt
  var joined = false; // listener clicked through the autoplay gate
  var localPaused = false; // listener paused on their own; queue keeps syncing silently
  var lastLocalPlaying = false; // edge detector for pause/resume via the iframe itself
  var heartbeatTimer = null;
  var sendTimer = null;
  var graceTimer = null;
  var staleTimer = null;
  var joinTimer = null;
  var els = {};

  function $(id) {
    return document.getElementById(id);
  }

  function randId(len) {
    var bytes = new Uint8Array(len);
    crypto.getRandomValues(bytes);
    var out = "";
    for (var i = 0; i < len; i++) out += (bytes[i] % 36).toString(36);
    return out;
  }

  function myColor() {
    var sum = 0;
    for (var i = 0; i < clientId.length; i++) sum += clientId.charCodeAt(i);
    return PALETTE[sum % PALETTE.length];
  }

  function shareUrl() {
    var u = new URL(location.href);
    u.searchParams.set("dj", roomId);
    return u.href;
  }

  function makeChannel(client) {
    return client.channel("dj:" + roomId, {
      config: {
        broadcast: { self: false },
        presence: { key: clientId },
      },
    });
  }

  function send(event, payload) {
    if (!channel) return;
    // Fire-and-forget, same contract as the shared cache: a dropped or
    // rate-limited packet must never surface — the next heartbeat heals it.
    channel
      .send({ type: "broadcast", event: event, payload: payload })
      .then(function () {}, function () {});
  }

  function sendMove(data) {
    send("move", { id: clientId, x: data.x, y: data.y, d: data.d, j: data.j });
  }

  function sendChat(text) {
    send("chat", { id: clientId, text: String(text).slice(0, CHAT_MAX) });
  }

  function onMoveMsg(msg) {
    var p = msg && msg.payload;
    if (!p || !p.id) return;
    // A move can race ahead of the presence sync that would spawn its creature
    // (spawn is idempotent, so this is a no-op once the roster has landed).
    var metas = channel && channel.presenceState()[p.id];
    if (metas && metas[0]) Tubalr.creatures.spawn(p.id, metas[0]);
    Tubalr.creatures.applyMove(p.id, p);
  }

  function onChatMsg(msg) {
    var p = msg && msg.payload;
    if (p && p.id && p.text) {
      Tubalr.creatures.showChat(p.id, String(p.text).slice(0, CHAT_MAX));
    }
  }

  // Presence is the roster for both roles: creature spawns/despawns and the
  // listener count. `sync` fires with the full state after every join/leave, so
  // spawning from it (idempotent) also backfills peers who arrived before we did.
  function onPresenceSync() {
    if (!channel) return;
    var state = channel.presenceState();
    var listeners = 0;
    Object.keys(state).forEach(function (key) {
      var meta = state[key][0] || {};
      if (meta.role === "listener") listeners++;
      if (key !== clientId) Tubalr.creatures.spawn(key, meta);
    });
    var label = listeners + " listening";
    if (els.count) els.count.textContent = label;
    if (els.barCount) els.barCount.textContent = label;
  }

  function hasDj() {
    var state = channel ? channel.presenceState() : {};
    return Object.keys(state).some(function (key) {
      return (state[key][0] || {}).role === "dj";
    });
  }

  // ---------------------------------------------------------------- DJ side

  function initDj() {
    if (!Tubalr.supa.getClient()) return; // unconfigured: the button never exists
    els.row = $("live-row");
    els.goLive = $("btn-go-live");
    els.status = $("live-status");
    els.count = $("live-count");
    els.url = $("live-url");
    els.copy = $("btn-copy-live");
    els.end = $("btn-end-live");
    if (!els.row) return;
    els.row.hidden = false; // .now-playing gates visibility until a session runs
    els.goLive.addEventListener("click", goLive);
    els.end.addEventListener("click", endBroadcast);
    els.copy.addEventListener("click", copyShareUrl);
  }

  function goLive() {
    if (channel) return;
    var client = Tubalr.supa.getClient();
    if (!client) return;
    role = "dj";
    clientId = randId(8);
    roomId = randId(10);
    seq = 0;
    els.goLive.disabled = true;

    var started = false;
    channel = makeChannel(client)
      .on("broadcast", { event: "move" }, onMoveMsg)
      .on("broadcast", { event: "chat" }, onChatMsg)
      .on("presence", { event: "sync" }, onPresenceSync)
      .on("presence", { event: "join" }, function () {
        queueStateSend(); // fresh joiner gets state now, not at the next heartbeat
        Tubalr.creatures.poke(); // ...and our creature's real spot, idle or not
      })
      .on("presence", { event: "leave" }, function (e) {
        Tubalr.creatures.remove(e.key);
      })
      .subscribe(function (status) {
        if (status === "SUBSCRIBED" && !started) {
          started = true;
          onDjLive();
        } else if ((status === "CHANNEL_ERROR" || status === "TIMED_OUT") && !started) {
          Tubalr.ui.setStatus("Couldn't start the broadcast. Try again in a moment.", true);
          teardownDj();
        }
      });
  }

  function onDjLive() {
    Tubalr.creatures.start({
      selfId: clientId,
      isDj: true,
      color: DJ_COLOR,
      onMove: sendMove,
      onChat: sendChat,
    });
    Tubalr.creatures.poke(); // tell the room where we spawned
    channel.track({ role: "dj", color: DJ_COLOR }).then(function () {}, function () {});
    Tubalr.player.setStateHook(queueStateSend);
    heartbeatTimer = setInterval(sendState, HEARTBEAT_MS);
    window.addEventListener("beforeunload", confirmLeave);
    window.addEventListener("pagehide", onPageHide);
    els.goLive.hidden = true;
    els.goLive.disabled = false;
    els.status.hidden = false;
    els.url.value = shareUrl();
    sendState();
  }

  function queueStateSend() {
    if (sendTimer) return;
    sendTimer = setTimeout(function () {
      sendTimer = null;
      sendState();
    }, STATE_DEBOUNCE_MS);
  }

  function sendState() {
    if (!channel || role !== "dj") return;
    var snap = Tubalr.player.getSnapshot();
    send("state", {
      seq: ++seq,
      queue: snap.queue,
      currentIndex: snap.currentIndex,
      playing: snap.playing,
      repeatMode: snap.repeatMode,
      currentTime: Tubalr.youtube.getCurrentTime(),
      sentAt: Date.now(),
    });
  }

  function confirmLeave(e) {
    // Browsers only show generic wording here; the "ends your stream" warning
    // itself can't be customized — that's a platform limit, not a choice.
    e.preventDefault();
    e.returnValue = "";
  }

  function onPageHide() {
    send("end", {}); // best-effort; listeners also have grace/stale detection
  }

  function copyShareUrl() {
    var url = els.url.value;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(
        function () {
          Tubalr.ui.toast("Broadcast link copied.");
        },
        function () {
          els.url.select();
        }
      );
    } else {
      els.url.select();
    }
  }

  function endBroadcast() {
    send("end", {});
    teardownDj();
  }

  function teardownDj() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    if (sendTimer) clearTimeout(sendTimer);
    sendTimer = null;
    window.removeEventListener("beforeunload", confirmLeave);
    window.removeEventListener("pagehide", onPageHide);
    Tubalr.player.setStateHook(null);
    Tubalr.creatures.stop();
    dropChannel();
    role = null;
    if (els.status) els.status.hidden = true;
    if (els.goLive) {
      els.goLive.hidden = false;
      els.goLive.disabled = false;
    }
  }

  // ---------------------------------------------------------- listener side

  function initListener(room) {
    var client = Tubalr.supa.getClient();
    if (!client) {
      Tubalr.ui.toast("This broadcast link can't be opened right now.");
      return;
    }
    role = "listener";
    roomId = room;
    clientId = randId(8);
    seq = 0;
    document.body.classList.add("listener");
    buildJoinOverlay();

    channel = makeChannel(client)
      .on("broadcast", { event: "state" }, onState)
      .on("broadcast", { event: "end" }, function () {
        release("The DJ ended the broadcast — the playlist is yours now.");
      })
      .on("broadcast", { event: "move" }, onMoveMsg)
      .on("broadcast", { event: "chat" }, onChatMsg)
      .on("presence", { event: "sync" }, onPresenceSync)
      .on("presence", { event: "join" }, function (e) {
        Tubalr.creatures.poke(); // announce our creature's spot to the newcomer
        var isDj = (e.newPresences || []).some(function (m) {
          return m.role === "dj";
        });
        if (isDj && graceTimer) {
          clearTimeout(graceTimer); // transient drop, the DJ came back
          graceTimer = null;
        }
      })
      .on("presence", { event: "leave" }, function (e) {
        Tubalr.creatures.remove(e.key);
        var wasDj = (e.leftPresences || []).some(function (m) {
          return m.role === "dj";
        });
        if (wasDj && !hasDj() && !graceTimer) {
          graceTimer = setTimeout(function () {
            release("The DJ disappeared — the playlist is yours now.");
          }, DJ_GRACE_MS);
        }
      })
      .subscribe(function (status) {
        if ((status === "CHANNEL_ERROR" || status === "TIMED_OUT") && !lastState) {
          deadRoom("Couldn't connect to this broadcast.");
        }
      });

    joinTimer = setTimeout(function () {
      if (!lastState) deadRoom("This broadcast has ended.");
    }, JOIN_DEADLINE_MS);
  }

  function onState(msg) {
    var p = msg && msg.payload;
    if (!p || typeof p.seq !== "number" || p.seq <= seq) return;
    seq = p.seq;
    p.receivedAt = Date.now(); // local clock, so DJ/listener skew never matters
    var first = !lastState;
    lastState = p;
    resetStaleTimer();
    if (first && els.join) {
      els.join.disabled = false;
      els.join.textContent = "join the broadcast";
    }
    if (joined) {
      Tubalr.player.applyRemoteState(lastState, { suppressPlay: localPaused });
    }
  }

  function resetStaleTimer() {
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = setTimeout(function () {
      release("Lost the DJ's signal — the playlist is yours now.");
    }, STALE_MS);
  }

  function buildJoinOverlay() {
    els.overlay = document.createElement("div");
    els.overlay.className = "join-overlay";

    var card = document.createElement("div");
    card.className = "join-card";

    var badge = document.createElement("span");
    badge.className = "live-badge";
    var dot = document.createElement("span");
    dot.className = "live-dot";
    badge.appendChild(dot);
    badge.appendChild(document.createTextNode("LIVE"));

    els.overlayText = document.createElement("p");
    els.overlayText.className = "join-text";
    els.overlayText.textContent = "Someone's broadcasting live on tubalr. Join in and hear what they're hearing.";

    els.join = document.createElement("button");
    els.join.type = "button";
    els.join.className = "btn btn-join";
    els.join.textContent = "connecting…";
    els.join.disabled = true;
    els.join.addEventListener("click", joinBroadcast);

    card.appendChild(badge);
    card.appendChild(els.overlayText);
    card.appendChild(els.join);
    els.overlay.appendChild(card);
    document.body.appendChild(els.overlay);
  }

  // The click is the user gesture unmuted autoplay needs: applyRemoteState runs
  // synchronously here, so loadVideoById starts inside the gesture context.
  function joinBroadcast() {
    if (!lastState || joined) return;
    joined = true;
    if (joinTimer) clearTimeout(joinTimer);
    joinTimer = null;
    els.overlay.remove();
    els.overlay = null;

    Tubalr.player.setFollowMode(true, { onResumeRequest: resumeToDj });
    Tubalr.player.setStateHook(onListenerNotify);
    Tubalr.player.applyRemoteState(lastState);
    lastLocalPlaying = true;

    channel.track({ role: "listener", color: myColor() }).then(function () {}, function () {});
    Tubalr.creatures.start({
      selfId: clientId,
      isDj: false,
      color: myColor(),
      onMove: sendMove,
      onChat: sendChat,
    });
    Tubalr.creatures.poke(); // tell the room where we spawned
    buildListenerBar();
    onPresenceSync();
  }

  function buildListenerBar() {
    var frame = document.querySelector(".player-frame");
    if (!frame) return;
    els.bar = document.createElement("div");
    els.bar.className = "listener-bar";

    var badge = document.createElement("span");
    badge.className = "live-badge";
    var dot = document.createElement("span");
    dot.className = "live-dot";
    badge.appendChild(dot);
    badge.appendChild(document.createTextNode("LIVE"));

    els.barCount = document.createElement("span");
    els.barCount.className = "live-count";
    els.barCount.textContent = "1 listening";

    els.bar.appendChild(badge);
    els.bar.appendChild(els.barCount);
    frame.parentNode.insertBefore(els.bar, frame.nextSibling);
  }

  // Watches the player's own notifies to tell a *local* pause (DJ still playing,
  // per spec: allowed, and unpausing must jump back to the DJ) apart from
  // mirroring a DJ pause — and to catch resumes done via the iframe's own button.
  function onListenerNotify() {
    var snap = Tubalr.player.getSnapshot();
    if (snap.playing === lastLocalPlaying) return;
    lastLocalPlaying = snap.playing;
    if (!snap.playing) {
      if (lastState && lastState.playing) localPaused = true;
    } else if (localPaused) {
      localPaused = false;
      resumeToDj();
    }
  }

  function resumeToDj() {
    localPaused = false;
    if (lastState) Tubalr.player.applyRemoteState(lastState);
  }

  // The stream is over but the music isn't: the listener keeps the queue and
  // gets the full transport back as a normal session.
  function release(msg) {
    if (role !== "listener" || !channel) return;
    if (!joined) {
      deadRoom("This broadcast has ended.");
      return;
    }
    clearListenerTimers();
    Tubalr.player.setStateHook(null);
    Tubalr.player.setFollowMode(false);
    Tubalr.creatures.stop();
    dropChannel();
    role = null;
    joined = false;
    localPaused = false;
    document.body.classList.remove("listener");
    if (els.bar) {
      els.bar.remove();
      els.bar = null;
      els.barCount = null;
    }
    stripDjParam();
    Tubalr.ui.toast(msg);
  }

  // A room with no DJ in it (dead link, failed connect): keep the overlay up and
  // let the visitor bail to the landing page.
  function deadRoom(msg) {
    clearListenerTimers();
    dropChannel();
    role = null;
    if (!els.overlay || els.overlay.dataset.dead) return;
    els.overlay.dataset.dead = "1";
    els.overlayText.textContent = msg;
    if (els.join) {
      els.join.remove();
      els.join = null;
    }
    var link = document.createElement("a");
    link.className = "btn btn-join";
    link.href = "./"; // relative: strips ?dj= and stays under the Pages subpath
    link.textContent = "go to tubalr";
    els.overlay.querySelector(".join-card").appendChild(link);
  }

  function clearListenerTimers() {
    if (joinTimer) clearTimeout(joinTimer);
    if (graceTimer) clearTimeout(graceTimer);
    if (staleTimer) clearTimeout(staleTimer);
    joinTimer = graceTimer = staleTimer = null;
  }

  function stripDjParam() {
    try {
      var u = new URL(location.href);
      u.searchParams.delete("dj");
      history.replaceState(null, "", u.href);
    } catch (e) {
      /* cosmetic only */
    }
  }

  function dropChannel() {
    if (!channel) return;
    var client = Tubalr.supa.getClient();
    var ch = channel;
    channel = null;
    if (client) client.removeChannel(ch);
  }

  Tubalr.live = {
    initDj: initDj,
    initListener: initListener,
  };
})(window.Tubalr);
