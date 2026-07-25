// DJ-mode creature layer: every participant in a broadcast appears as a little
// digital creature on a fixed, click-through layer that paints *behind* the UI
// (see #creatures + the stacking notes in styles.css) — the video/app always
// stays on top. The world is *infinite*: creatures float freely in 2D world
// space, and a camera follows the local creature — when it nears a screen edge
// the whole world (creatures + procedural plants) slides the other way, so you
// can wander outward forever. Steer with WASD/arrows or by clicking/tapping any
// dead spot to glide there; space does a little hop; the "home" button warps you
// back beside the DJ if you get lost.
//
// Coordinates: creature x/y are *world* pixels (unbounded); the viewport maps to
// world space through `cam` (screen = world − cam). Move packets carry absolute
// world px (not viewport fractions), so every client shares one coordinate space
// and sees everyone in the same place. Glowing plants are generated as a pure
// function of world position (a seeded hash per grid cell), so the world is both
// infinite and stable with no storage and no networking — only cells near the
// viewport are ever instantiated, and they recycle as the camera moves.
//
// Pure presentation — this module knows nothing about Supabase; live.js feeds
// it remote positions and chat via spawn/applyMove/showChat/remove and receives
// the local creature's movement/chat through the onMove/onChat callbacks.
window.Tubalr = window.Tubalr || {};

(function (Tubalr) {
  "use strict";

  var BASE = 10; // px inset from the viewport bottom the y axis measures from
  var SIZE = 24; // creature footprint, for centring the camera on it
  var START_Y = 0; // world y the shared spawn/home spot sits at (up from BASE)
  var MOVE_SPEED = 220; // px/s, keys and click-glides alike
  var HOP_V = 300; // px/s upward; ~30px hop at this gravity
  var HOP_GRAVITY = 1500; // px/s²
  var MOVE_SEND_MS = 200; // 5 Hz — stays clear of supabase-js's 10 events/sec cap
  var BUBBLE_MS = 6000; // chat bubbles are ephemeral; no history
  var CHAT_MAX = 120;

  // Procedural flora: the world is diced into CELL-px cells; each cell's contents
  // are a pure function of its integer coords, so a spot always looks the same.
  var CELL = 320;
  var PLANT_DENSITY = 0.4; // fraction of cells that grow a plant
  var PLANT_COLORS = ["#7fd6a4", "#6bb8ff", "#ffb86b", "#ff6b9e", "#ede480", "#63e0e0", "#c98bff"];

  var layer = null; // #creatures, lazily created
  var flora = null; // .flora sub-layer (painted under the creatures)
  var chatForm = null;
  var chatInput = null;
  var creatures = {}; // id -> { el, bubbleEl, x, y, facing, isSelf, isDj, ... }
  var plants = {}; // "cx,cy" -> plant obj, or null once a cell is known empty
  var selfId = null;
  var cam = { x: 0, y: 0 }; // world coord the viewport origin maps to
  var bounds = { right: 0, ceilingSy: Infinity }; // right wall + roam-band ceiling
  var cbs = { onMove: function () {}, onChat: function () {} };
  var keys = { left: false, right: false, up: false, down: false, hop: false };
  var clickTarget = null; // { x, y } — click/tap world destination being glided to
  var pointerHeld = false; // mouse/finger held down: chase the pointer continuously
  var heldScreen = { x: 0, y: 0 }; // last pointer position (screen px) while held
  var raf = 0;
  var lastFrame = 0;
  var lastSend = 0;
  var restSent = true; // the one extra packet after motion stops has gone out
  var bubbleTimers = {};

  // Proportional camera deadzone (game-dev style): the camera holds still while
  // the creature roams this fraction of the walkable area and only scrolls once
  // it pushes past. The vertical band is biased low so creatures live *below* the
  // centred video player, not behind it.
  var DEADZONE_X = 0.25; // roam the middle 50% of the width before the world scrolls
  var DEADZONE_TOP = 0.32; // headroom above the resting band
  var DEADZONE_BOTTOM = 0.16; // small band below — creatures rest low and visible
  var SPAWN_Y_FRAC = 0.2; // resting height on spawn/home, up from the bottom
  var PLAYER_GAP = 48; // min clearance kept between the roam band and the player's bottom

  // Tallest screen-space y (above BASE) a creature can sit at, for camera maths.
  function maxScreenY() {
    return window.innerHeight - BASE - SIZE;
  }

  // The right wall is the playlist's left edge (it's an opaque fixed column on
  // desktop), so creatures treat the panel as the edge of the world rather than
  // wandering behind it. When the panel is hidden or docked below (mobile) the
  // wall is just the window's right edge.
  function computeBounds() {
    bounds.right = window.innerWidth;
    var pl = document.querySelector(".playlist-col");
    if (pl) {
      var r = pl.getBoundingClientRect();
      if (r.width > 0 && r.left > window.innerWidth * 0.4 && r.left < window.innerWidth) {
        bounds.right = r.left;
      }
    }
    // Ceiling for the roam band: keep it PLAYER_GAP below the video player's
    // bottom so creatures never crowd up against the player/logo — the world
    // scrolls instead of letting them drift behind it.
    bounds.ceilingSy = Infinity;
    var pf = document.querySelector(".player-frame");
    if (pf) {
      var pr = pf.getBoundingClientRect();
      if (pr.height > 0) {
        // Convert "screen px from top" to the creature's height-above-BASE axis.
        bounds.ceilingSy = window.innerHeight - BASE - SIZE - (pr.bottom + PLAYER_GAP);
      }
    }
  }

  // Park the camera so creature c rests centred horizontally but low vertically —
  // in the open area below the player, where it's actually visible.
  function centerCamOn(c) {
    cam.x = c.x - (bounds.right - SIZE) / 2;
    cam.y = c.y - maxScreenY() * SPAWN_Y_FRAC;
  }

  function ensureLayer() {
    if (layer) return;
    layer = document.createElement("div");
    layer.id = "creatures";
    layer.setAttribute("aria-hidden", "true");
    // Flora goes in first so it paints *under* every creature.
    flora = document.createElement("div");
    flora.className = "flora";
    layer.appendChild(flora);
    document.body.appendChild(layer);
  }

  function makeCreature(id, meta, isSelf) {
    var isDj = !!(meta && meta.role === "dj");
    var el = document.createElement("div");
    el.className = "creature idle" + (isDj ? " is-dj" : "") + (isSelf ? " is-self" : "");
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
      // World coordinates: x from the origin, y up from the BASE line. Everyone
      // spawns at the shared origin so they start clustered, then wander apart.
      x: 0,
      y: START_Y,
      targetX: 0,
      targetY: START_Y,
      facing: 1,
      vx: 0,
      vy: 0,
      hopH: 0, // the hop rides on top of y, so a hop mid-glide arcs naturally
      hopV: 0,
      isSelf: !!isSelf,
      isDj: isDj,
      // Until the first move packet lands, this position is a made-up spawn
      // spot — the first packet snaps instead of gliding from fiction.
      fresh: !isSelf,
    };
    if (isSelf) centerCamOn(c); // the camera is anchored to our own creature
    place(c);
    return c;
  }

  function place(c) {
    // Screen position = world − camera. Facing goes through a custom property
    // (not an inline transform) so the idle-bob keyframes can compose
    // scaleX(var(--facing)) without stomping it. The hop is a screen-space
    // cosmetic bump added after the camera transform.
    var sx = c.x - cam.x;
    var sy = c.y - cam.y;
    c.el.style.transform = "translate(" + sx + "px, " + -(BASE + sy + c.hopH) + "px)";
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

  // ---- pointer-to-move: tap to glide, or hold to keep chasing the pointer ----
  // The layer itself is pointer-events: none, so pointer events land on the page;
  // listen on the document and take only the ones that hit dead space — a
  // press on anything interactive (or on the opaque panel the creatures walk
  // behind) keeps its normal meaning. A quick press glides to the point; holding
  // makes the creature chase the pointer, so holding near a wall walks you
  // outward as the camera follows. Pointer events unify mouse, touch and pen.
  var CLICK_IGNORE =
    "button, a, input, textarea, select, form, li, iframe, " +
    ".playlist-col, .row-actions, .toast, .join-overlay, .config-banner, " +
    ".listener-bar, .live-row, .brand";

  // Aim the creature's center at a screen point, converted screen → world by
  // adding the camera. No clamp: heading toward an edge keeps you walking outward.
  function screenToWorld(clientX, clientY) {
    return {
      x: clientX - SIZE / 2 + cam.x,
      y: window.innerHeight - BASE - SIZE / 2 - clientY + cam.y,
    };
  }

  function onPointerDown(e) {
    if (e.button != null && e.button !== 0) return; // primary button / touch only
    if (e.defaultPrevented) return;
    if (e.target.closest && e.target.closest(CLICK_IGNORE)) return;
    if (!creatures[selfId]) return;
    pointerHeld = true;
    heldScreen.x = e.clientX;
    heldScreen.y = e.clientY;
    clickTarget = screenToWorld(e.clientX, e.clientY);
  }

  function onPointerMove(e) {
    if (!pointerHeld) return;
    heldScreen.x = e.clientX;
    heldScreen.y = e.clientY;
  }

  function onPointerUp() {
    // Release leaves clickTarget where it last was, so a plain tap still glides
    // to the point; a hold simply stops chasing.
    pointerHeld = false;
  }

  // ---- animation loop: self physics + remote interpolation + flora ----

  function frame(now) {
    var dt = Math.min(0.05, (now - lastFrame) / 1000 || 0);
    lastFrame = now;

    var self = creatures[selfId];
    if (self) stepSelf(self, dt, now); // may move the camera

    for (var id in creatures) {
      var c = creatures[id];
      if (c.isSelf) continue;
      // Ease toward the last received spot; 5 Hz packets look continuous.
      c.x += (c.targetX - c.x) * Math.min(1, dt * 10);
      c.y += (c.targetY - c.y) * Math.min(1, dt * 10);
      setIdle(c, Math.abs(c.targetX - c.x) < 1 && Math.abs(c.targetY - c.y) < 1);
      place(c);
    }

    updateFlora(); // uses the camera the self-step just settled

    raf = requestAnimationFrame(frame);
  }

  function stepSelf(c, dt, now) {
    var kx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    var ky = (keys.up ? 1 : 0) - (keys.down ? 1 : 0);
    if (kx || ky) clickTarget = null; // hands on the keys override a pointer-glide
    // While held, chase the pointer's *current* screen spot each frame, so
    // holding near a wall keeps you walking as the world scrolls underneath.
    else if (pointerHeld) clickTarget = screenToWorld(heldScreen.x, heldScreen.y);

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
    // Infinite world: no clamp — the creature roams freely and the camera
    // follows it.
    c.x += c.vx * dt;
    c.y += c.vy * dt;
    followCamera(c);
    setIdle(c, !c.vx && !c.vy && !c.hopH);
    place(c);

    var moving = c.vx !== 0 || c.vy !== 0 || c.hopH > 0;
    if (moving) restSent = false;
    if ((moving || !restSent) && now - lastSend >= MOVE_SEND_MS) {
      lastSend = now;
      if (!moving) restSent = true;
      cbs.onMove({
        // Absolute world px, so every client shares one coordinate space. The
        // hop rides along in y so remotes see the arc.
        x: c.x,
        y: c.y + c.hopH,
        d: c.facing,
        j: c.hopH > 0,
      });
    }
  }

  // Slide the camera once the creature pushes past the proportional deadzone —
  // "the world moves away as you approach the edge". The right wall is the
  // playlist's left edge (bounds.right); the deadzone is biased low so the
  // resting band sits below the player.
  function followCamera(c) {
    var w = bounds.right;
    var top = maxScreenY();
    var mX = w * DEADZONE_X;
    var mBot = top * DEADZONE_BOTTOM;
    // The band's top is the proportional headroom, but never higher than the
    // measured ceiling below the player (and never inverted past the bottom).
    var deadTop = Math.min(top - top * DEADZONE_TOP, bounds.ceilingSy);
    if (deadTop < mBot) deadTop = mBot;
    var sx = c.x - cam.x;
    var sy = c.y - cam.y;
    if (sx < mX) cam.x = c.x - mX;
    else if (sx > w - SIZE - mX) cam.x = c.x - (w - SIZE - mX);
    if (sy < mBot) cam.y = c.y - mBot;
    else if (sy > deadTop) cam.y = c.y - deadTop;
  }

  // Warp the local creature back beside the DJ (or to the shared origin if we
  // *are* the DJ / there's no DJ yet), snap the camera to it, and push a packet
  // so the room sees the jump.
  function homeSelf() {
    var self = creatures[selfId];
    if (!self) return;
    var dj = null;
    for (var id in creatures) {
      if (id !== selfId && creatures[id].isDj) {
        dj = creatures[id];
        break;
      }
    }
    if (dj) {
      self.x = dj.targetX + SIZE * 2;
      self.y = dj.targetY;
    } else {
      self.x = 0;
      self.y = START_Y;
    }
    self.vx = self.vy = 0;
    clickTarget = null;
    centerCamOn(self);
    place(self);
    restSent = false; // emit our new spot next tick
  }

  // ---- procedural flora ----

  // A stable hash of the cell coords + a salt → a value in [0,1). Same inputs
  // always give the same output, so a cell always grows the same plant.
  function cellRand(cx, cy, salt) {
    var h = Math.imul(cx | 0, 374761393) ^ Math.imul(cy | 0, 668265263) ^ Math.imul(salt | 0, 2147483647);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  function makePlant(cx, cy) {
    if (cellRand(cx, cy, 0) >= PLANT_DENSITY) return null; // no plant in this cell
    var el = document.createElement("div");
    var variant = Math.floor(cellRand(cx, cy, 3) * 3);
    el.className = "plant plant-v" + variant;
    el.style.setProperty("--plant-color", PLANT_COLORS[Math.floor(cellRand(cx, cy, 5) * PLANT_COLORS.length)]);
    el.style.setProperty("--plant-scale", (0.7 + cellRand(cx, cy, 4) * 0.7).toFixed(3));

    var body = document.createElement("div");
    body.className = "plant-body";
    el.appendChild(body);
    flora.appendChild(el);

    return {
      el: el,
      // World position of the plant's base, offset within its cell.
      x: cx * CELL + cellRand(cx, cy, 1) * CELL,
      y: cy * CELL + cellRand(cx, cy, 2) * CELL,
      grown: false,
    };
  }

  function placePlant(p) {
    var sx = p.x - cam.x;
    var sy = p.y - cam.y;
    p.el.style.transform = "translate(" + sx + "px, " + -(BASE + sy) + "px)";
    // Grow it in once it enters the viewport (plus a small band), so plants
    // visibly sprout as you approach rather than popping in fully formed.
    if (!p.grown && sx > -60 && sx < window.innerWidth + 60 && BASE + sy > -60 && BASE + sy < window.innerHeight + 60) {
      p.grown = true;
      p.el.classList.add("grown");
    }
  }

  // Keep DOM only for the cells within (viewport + one-cell margin); create new
  // ones as the camera reveals them and drop ones it leaves behind.
  function updateFlora() {
    if (!flora) return;
    var cxLo = Math.floor((cam.x - CELL) / CELL);
    var cxHi = Math.floor((cam.x + window.innerWidth + CELL) / CELL);
    var cyLo = Math.floor((cam.y - BASE - CELL) / CELL);
    var cyHi = Math.floor((cam.y + window.innerHeight - BASE + CELL) / CELL);

    var need = {};
    for (var cx = cxLo; cx <= cxHi; cx++) {
      for (var cy = cyLo; cy <= cyHi; cy++) {
        var key = cx + "," + cy;
        need[key] = true;
        var p = plants[key];
        if (p === undefined) p = plants[key] = makePlant(cx, cy); // null = empty cell
        if (p) placePlant(p);
      }
    }
    for (var k in plants) {
      if (!need[k]) {
        if (plants[k] && plants[k].el) plants[k].el.remove();
        delete plants[k];
      }
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

    // Warp back to the group — the escape hatch for an infinite world.
    var home = document.createElement("button");
    home.type = "button";
    home.className = "btn btn-home";
    home.textContent = "teleport home";
    home.title = "Back to start";
    home.setAttribute("aria-label", "Return to the starting spot");

    chatForm.appendChild(chatInput);
    chatForm.appendChild(send);
    chatForm.appendChild(home);
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
    home.addEventListener("click", function (e) {
      e.preventDefault();
      homeSelf();
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
    computeBounds(); // the right wall, before we centre the camera on our creature
    if (!creatures[selfId]) {
      creatures[selfId] = makeCreature(selfId, { role: opts.isDj ? "dj" : "listener", color: opts.color }, true);
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("resize", computeBounds);
    lastFrame = 0;
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    document.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("keyup", onKeyUp);
    document.removeEventListener("pointerdown", onPointerDown);
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
    document.removeEventListener("pointercancel", onPointerUp);
    window.removeEventListener("resize", computeBounds);
    cancelAnimationFrame(raf);
    raf = 0;
    clickTarget = null;
    pointerHeld = false;
    for (var id in bubbleTimers) clearTimeout(bubbleTimers[id]);
    bubbleTimers = {};
    creatures = {};
    plants = {};
    selfId = null;
    cam.x = 0;
    cam.y = 0;
    keys.left = keys.right = keys.up = keys.down = keys.hop = false;
    if (layer) {
      layer.remove();
      layer = null;
      flora = null;
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
    // Absolute world px — a world px is a world px on every client, so no
    // viewport scaling and no clamp.
    c.targetX = data.x || 0;
    c.targetY = data.y || 0;
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
