// DJ-mode creature layer: every participant in a broadcast appears as a little
// digital creature on a fixed, click-through layer that paints *behind* the UI
// chrome (see #creatures + the stacking notes in styles.css). Pure presentation —
// this module knows nothing about Supabase; live.js feeds it remote positions and
// chat via spawn/applyMove/showChat/remove and receives the local creature's
// movement/chat through the onMove/onChat callbacks passed to start().
window.Tubalr = window.Tubalr || {};

(function (Tubalr) {
  "use strict";

  var GROUND = 10; // px above the viewport bottom the creatures walk on
  var WALK_SPEED = 220; // px/s
  var JUMP_V = 560; // px/s upward
  var GRAVITY = 1500; // px/s²
  var MOVE_SEND_MS = 200; // 5 Hz — stays clear of supabase-js's 10 events/sec cap
  var BUBBLE_MS = 6000; // chat bubbles are ephemeral; no history
  var CHAT_MAX = 120;

  var layer = null; // #creatures, lazily created
  var chatForm = null;
  var chatInput = null;
  var creatures = {}; // id -> { el, bodyEl, bubbleEl, x, y, facing, isSelf, ... }
  var selfId = null;
  var cbs = { onMove: function () {}, onChat: function () {} };
  var keys = { left: false, right: false, jump: false };
  var raf = 0;
  var lastFrame = 0;
  var lastSend = 0;
  var restSent = true; // the one extra packet after motion stops has gone out
  var bubbleTimers = {};

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
      bodyEl: body,
      bubbleEl: bubble,
      // x in px from the left edge, y in px above the ground line
      x: (0.2 + Math.random() * 0.6) * window.innerWidth,
      y: 0,
      targetX: 0,
      targetY: 0,
      facing: 1,
      vx: 0,
      vy: 0,
      grounded: true,
      isSelf: !!isSelf,
    };
    c.targetX = c.x;
    place(c);
    return c;
  }

  function place(c) {
    // Position via transform only; the base spot is the layer's bottom-left.
    // Facing goes through a custom property (not an inline transform) so the
    // idle-bob keyframes can compose scaleX(var(--facing)) without stomping it.
    c.el.style.transform = "translate(" + c.x + "px, " + -(GROUND + c.y) + "px)";
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
    if (k === "w" || k === "W" || k === "ArrowUp" || k === " ") return "jump";
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
      setIdle(c, Math.abs(c.targetX - c.x) < 1 && Math.abs(c.targetY - c.y) < 1 && c.targetY === 0);
      place(c);
    }

    raf = requestAnimationFrame(frame);
  }

  function stepSelf(c, dt, now) {
    c.vx = (keys.right ? WALK_SPEED : 0) - (keys.left ? WALK_SPEED : 0);
    if (keys.jump && c.grounded) {
      c.vy = JUMP_V;
      c.grounded = false;
    }
    if (!c.grounded) {
      c.vy -= GRAVITY * dt;
      c.y += c.vy * dt;
      if (c.y <= 0) {
        c.y = 0;
        c.vy = 0;
        c.grounded = true;
      }
    }
    if (c.vx) c.facing = c.vx > 0 ? 1 : -1;
    c.x = Math.min(window.innerWidth - 24, Math.max(0, c.x + c.vx * dt));
    setIdle(c, c.grounded && !c.vx);
    place(c);

    var moving = c.vx !== 0 || !c.grounded;
    if (moving) restSent = false;
    if ((moving || !restSent) && now - lastSend >= MOVE_SEND_MS) {
      lastSend = now;
      if (!moving) restSent = true;
      cbs.onMove({
        x: c.x / window.innerWidth, // fraction, so viewport sizes don't matter
        y: Math.round(c.y),
        d: c.facing,
        j: !c.grounded,
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
    lastFrame = 0;
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    document.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("keyup", onKeyUp);
    cancelAnimationFrame(raf);
    raf = 0;
    for (var id in bubbleTimers) clearTimeout(bubbleTimers[id]);
    bubbleTimers = {};
    creatures = {};
    selfId = null;
    keys.left = keys.right = keys.jump = false;
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
    c.targetX = (data.x || 0) * window.innerWidth;
    c.targetY = Math.max(0, data.y || 0);
    if (data.d) c.facing = data.d < 0 ? -1 : 1;
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
    showChat: showChat,
    remove: remove,
  };
})(window.Tubalr);
