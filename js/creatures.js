// DJ-mode creature layer: every participant in a broadcast appears as a little
// digital creature on a fixed, click-through layer that paints *behind* the UI
// (see #creatures + the stacking notes in styles.css) — the video/app always
// stays on top. The whole viewport is the creature's playground: it floats
// freely in 2D, steered by WASD/arrows or by clicking/tapping any dead spot to
// glide straight to that point; space does a little hop from wherever it is.
// Pure presentation — this module knows nothing about Supabase; live.js feeds
// it remote positions and chat via spawn/applyMove/showChat/remove and receives
// the local creature's movement/chat through the onMove/onChat callbacks.
window.Tubalr = window.Tubalr || {};

(function (Tubalr) {
  "use strict";

  var BASE = 10; // px inset from the viewport bottom the y axis measures from
  var SIZE = 24; // creature footprint, for clamping inside the viewport
  var MOVE_SPEED = 220; // px/s, keys and click-glides alike
  var HOP_V = 300; // px/s upward; ~30px hop at this gravity
  var HOP_GRAVITY = 1500; // px/s²
  var MOVE_SEND_MS = 200; // 5 Hz — stays clear of supabase-js's 10 events/sec cap
  var BUBBLE_MS = 6000; // chat bubbles are ephemeral; no history
  var CHAT_MAX = 120;

  var layer = null; // #creatures, lazily created
  var chatForm = null;
  var chatInput = null;
  var creatures = {}; // id -> { el, bubbleEl, x, y, facing, isSelf, ... }
  var selfId = null;
  var cbs = { onMove: function () {}, onChat: function () {} };
  var keys = { left: false, right: false, up: false, down: false, hop: false };
  var clickTarget = null; // { x, y } — click/tap destination being glided to
  var raf = 0;
  var lastFrame = 0;
  var lastSend = 0;
  var restSent = true; // the one extra packet after motion stops has gone out
  var bubbleTimers = {};

  function maxX() {
    return window.innerWidth - SIZE;
  }

  function maxY() {
    return window.innerHeight - BASE - SIZE;
  }

  function ensureLayer() {
    if (layer) return;
    layer = document.createElement("div");
    layer.id = "creatures";
    layer.setAttribute("aria-hidden", "true");
    document.body.appendChild(layer);
  }

  function makeCreature(id, meta, isSelf) {
    var el = document.createElement("div");
    el.className = "creature idle" + (meta && meta.role === "dj" ? " is-dj" : "") + (isSelf ? " is-self" : "");
    if (meta && meta.color) el.style.setProperty("--creature-color", meta.color);

    var bubble = document.createElement("div");
    bubble.className = "creature-bubble";
    bubble.hidden = true;

    var body = document.createElement("div");
    body.className = "creature-body";

    el.appendChild(bubble);
    el.appendChild(body);
    layer.appendChild(el);

    var c = {
      el: el,
      bubbleEl: bubble,
      // x from the left edge, y up from the BASE line above the bottom — both px
      x: (0.2 + Math.random() * 0.6) * window.innerWidth,
      y: 0,
      targetX: 0,
      targetY: 0,
      facing: 1,
      vx: 0,
      vy: 0,
      hopH: 0, // the hop rides on top of y, so a hop mid-glide arcs naturally
      hopV: 0,
      isSelf: !!isSelf,
      // Until the first move packet lands, this position is a made-up spawn
      // spot — the first packet snaps instead of gliding from fiction.
      fresh: !isSelf,
    };
    c.targetX = c.x;
    place(c);
    return c;
  }

  function place(c) {
    // Position via transform only; the base spot is the layer's bottom-left.
    // Facing goes through a custom property (not an inline transform) so the
    // idle-bob keyframes can compose scaleX(var(--facing)) without stomping it.
    c.el.style.transform = "translate(" + c.x + "px, " + -(BASE + c.y + c.hopH) + "px)";
    c.el.style.setProperty("--facing", String(c.facing));
  }

  function setIdle(c, idle) {
    c.el.classList.toggle("idle", idle);
  }

  // ---- keyboard (self movement) ----

  function isTyping() {
    var a = document.activeElement;
    if (!a) return false;
    var tag = a.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || a.isContentEditable;
  }

  // Enter shouldn't steal focus from other interactive elements either (a
  // focused transport button expects Enter to click it).
  function isInteractive() {
    var a = document.activeElement;
    if (!a) return false;
    return isTyping() || a.tagName === "BUTTON" || a.tagName === "A";
  }

  function keyDir(e) {
    var k = e.key;
    if (k === "a" || k === "A" || k === "ArrowLeft") return "left";
    if (k === "d" || k === "D" || k === "ArrowRight") return "right";
    if (k === "w" || k === "W" || k === "ArrowUp") return "up";
    if (k === "s" || k === "S" || k === "ArrowDown") return "down";
    if (k === " ") return "hop";
    return null;
  }

  function onKeyDown(e) {
    if (isTyping()) return;
    if (e.key === "Enter" && !isInteractive() && chatInput) {
      chatInput.focus();
      e.preventDefault();
      return;
    }
    var dir = keyDir(e);
    if (!dir) return;
    // Arrows scroll and space pages/clicks; the creature owns them while a
    // broadcast is on and focus is loose.
    if (e.key === " " || e.key.indexOf("Arrow") === 0) e.preventDefault();
    keys[dir] = true;
  }

  function onKeyUp(e) {
    var dir = keyDir(e);
    if (dir) keys[dir] = false;
  }

  // ---- click/tap-to-glide (the only movement a phone gets) ----
  // The layer itself is pointer-events: none, so clicks land on the page;
  // listen on the document and take only the ones that hit dead space — a
  // click on anything interactive (or on the opaque panel the creatures walk
  // behind) keeps its normal meaning.
  var CLICK_IGNORE =
    "button, a, input, textarea, select, form, li, iframe, " +
    ".playlist-col, .row-actions, .toast, .join-overlay, .config-banner, " +
    ".listener-bar, .live-row, .brand";

  function onDocClick(e) {
    if (e.defaultPrevented) return;
    if (e.target.closest && e.target.closest(CLICK_IGNORE)) return;
    if (!creatures[selfId]) return;
    // The viewport is the grid: aim the creature's center at the exact point.
    clickTarget = {
      x: Math.min(maxX(), Math.max(0, e.clientX - SIZE / 2)),
      y: Math.min(maxY(), Math.max(0, window.innerHeight - BASE - SIZE / 2 - e.clientY)),
    };
  }

  // ---- animation loop: self physics + remote interpolation ----

  function frame(now) {
    var dt = Math.min(0.05, (now - lastFrame) / 1000 || 0);
    lastFrame = now;

    var self = creatures[selfId];
    if (self) stepSelf(self, dt, now);

    for (var id in creatures) {
      var c = creatures[id];
      if (c.isSelf) continue;
      // Ease toward the last received spot; 5 Hz packets look continuous.
      c.x += (c.targetX - c.x) * Math.min(1, dt * 10);
      c.y += (c.targetY - c.y) * Math.min(1, dt * 10);
      setIdle(c, Math.abs(c.targetX - c.x) < 1 && Math.abs(c.targetY - c.y) < 1);
      place(c);
    }

    raf = requestAnimationFrame(frame);
  }

  function stepSelf(c, dt, now) {
    var kx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    var ky = (keys.up ? 1 : 0) - (keys.down ? 1 : 0);
    if (kx || ky) clickTarget = null; // hands on the keys override a click-glide

    if (clickTarget) {
      var dx = clickTarget.x - c.x;
      var dy = clickTarget.y - c.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var step = MOVE_SPEED * dt;
      if (dist <= step) {
        // Arrived: snap to the spot (no overshoot oscillation).
        c.x = clickTarget.x;
        c.y = clickTarget.y;
        c.vx = 0;
        c.vy = 0;
        clickTarget = null;
      } else {
        c.vx = (dx / dist) * MOVE_SPEED;
        c.vy = (dy / dist) * MOVE_SPEED;
      }
    } else {
      c.vx = kx * MOVE_SPEED;
      c.vy = ky * MOVE_SPEED;
    }

    // The hop is a cosmetic bounce layered on top of wherever the creature is
    // (or is heading) — no gravity pulls the resting position anywhere.
    if (keys.hop && c.hopH === 0 && c.hopV === 0) c.hopV = HOP_V;
    if (c.hopH > 0 || c.hopV > 0) {
      c.hopV -= HOP_GRAVITY * dt;
      c.hopH += c.hopV * dt;
      if (c.hopH <= 0) {
        c.hopH = 0;
        c.hopV = 0;
      }
    }

    if (c.vx) c.facing = c.vx > 0 ? 1 : -1;
    c.x = Math.min(maxX(), Math.max(0, c.x + c.vx * dt));
    c.y = Math.min(maxY(), Math.max(0, c.y + c.vy * dt));
    setIdle(c, !c.vx && !c.vy && !c.hopH);
    place(c);

    var moving = c.vx !== 0 || c.vy !== 0 || c.hopH > 0;
    if (moving) restSent = false;
    if ((moving || !restSent) && now - lastSend >= MOVE_SEND_MS) {
      lastSend = now;
      if (!moving) restSent = true;
      cbs.onMove({
        // Fractions of the viewport, so different window sizes agree on where
        // "the same spot" is. The hop rides along in y so remotes see the arc.
        x: c.x / window.innerWidth,
        y: (c.y + c.hopH) / window.innerHeight,
        d: c.facing,
        j: c.hopH > 0,
      });
    }
  }

  // ---- chat ----

  function ensureChatForm() {
    if (chatForm) return;
    chatForm = document.createElement("form");
    chatForm.id = "creature-chat";
    chatForm.className = "creature-chat";

    chatInput = document.createElement("input");
    chatInput.type = "text";
    chatInput.maxLength = CHAT_MAX;
    chatInput.placeholder = "say something…";
    chatInput.setAttribute("aria-label", "Chat message");

    var send = document.createElement("button");
    send.type = "submit";
    send.className = "btn";
    send.textContent = "say";

    chatForm.appendChild(chatInput);
    chatForm.appendChild(send);
    document.body.appendChild(chatForm);

    chatForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var text = chatInput.value.trim().slice(0, CHAT_MAX);
      chatInput.value = "";
      chatInput.blur();
      if (!text) return;
      cbs.onChat(text);
      showChat(selfId, text); // local echo — broadcasts don't loop back to self
    });
    chatInput.addEventListener("keydown", function (e) {
      if (e.key === "Escape") chatInput.blur();
    });
  }

  // ---- public API ----

  function start(opts) {
    ensureLayer();
    ensureChatForm();
    selfId = opts.selfId;
    cbs.onMove = opts.onMove || function () {};
    cbs.onChat = opts.onChat || function () {};
    if (!creatures[selfId]) {
      creatures[selfId] = makeCreature(selfId, { role: opts.isDj ? "dj" : "listener", color: opts.color }, true);
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("click", onDocClick);
    lastFrame = 0;
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    document.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("keyup", onKeyUp);
    document.removeEventListener("click", onDocClick);
    cancelAnimationFrame(raf);
    raf = 0;
    clickTarget = null;
    for (var id in bubbleTimers) clearTimeout(bubbleTimers[id]);
    bubbleTimers = {};
    creatures = {};
    selfId = null;
    keys.left = keys.right = keys.up = keys.down = keys.hop = false;
    if (layer) {
      layer.remove();
      layer = null;
    }
    if (chatForm) {
      chatForm.remove();
      chatForm = null;
      chatInput = null;
    }
  }

  function spawn(id, meta) {
    if (!layer || !id || id === selfId || creatures[id]) return;
    creatures[id] = makeCreature(id, meta, false);
  }

  function applyMove(id, data) {
    if (!id || id === selfId || !data) return;
    var c = creatures[id] || null;
    if (!c) return; // presence spawn hasn't landed yet; next packet will find it
    c.targetX = Math.min(maxX(), Math.max(0, (data.x || 0) * window.innerWidth));
    c.targetY = Math.min(maxY(), Math.max(0, (data.y || 0) * window.innerHeight));
    if (c.fresh) {
      c.fresh = false;
      c.x = c.targetX;
      c.y = c.targetY;
    }
    if (data.d) c.facing = data.d < 0 ? -1 : 1;
  }

  // Force the next loop tick to emit one position packet even at rest. live.js
  // calls this when someone joins: idle creatures never send moves, so without
  // it a fresh tab would only ever see them at made-up spawn spots.
  function poke() {
    if (raf && creatures[selfId]) restSent = false;
  }

  function showChat(id, text) {
    var c = creatures[id];
    if (!c || !text) return;
    c.bubbleEl.textContent = String(text).slice(0, CHAT_MAX); // textContent only — never markup
    c.bubbleEl.hidden = false;
    if (bubbleTimers[id]) clearTimeout(bubbleTimers[id]);
    bubbleTimers[id] = setTimeout(function () {
      if (c.bubbleEl) c.bubbleEl.hidden = true;
      delete bubbleTimers[id];
    }, BUBBLE_MS);
  }

  function remove(id) {
    var c = creatures[id];
    if (!c || c.isSelf) return;
    if (bubbleTimers[id]) {
      clearTimeout(bubbleTimers[id]);
      delete bubbleTimers[id];
    }
    c.el.remove();
    delete creatures[id];
  }

  Tubalr.creatures = {
    start: start,
    stop: stop,
    spawn: spawn,
    applyMove: applyMove,
    poke: poke,
    showChat: showChat,
    remove: remove,
  };
})(window.Tubalr);
