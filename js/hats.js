// Coins + hats: a light cosmetic economy. Finishing a track earns coins;
// coins buy hats for the DJ-mode creature. Balance, owned hats, and the
// equipped hat live in localStorage (same best-effort pattern as recent.js).
// Hats travel the network as catalog *ids* only — every remote id is checked
// with isValid() before it becomes a CSS class, so unknown/hostile strings
// render nothing. Dependency-free; the shop UI lives in creatures.js.
window.Tubalr = window.Tubalr || {};

(function (Tubalr) {
  "use strict";

  var COINS_KEY = "tubalr:coins";
  var OWNED_KEY = "tubalr:hats-owned";
  var EQUIPPED_KEY = "tubalr:hat";
  var COINS_PER_TRACK = 10;

  // Drawn in CSS as .hat-<id> (see styles.css). Cheap → dear.
  var CATALOG = [
    { id: "beanie", name: "beanie", price: 50 },
    { id: "cap", name: "cap", price: 60 },
    { id: "bow", name: "bow", price: 80 },
    { id: "headband", name: "headband", price: 90 },
    { id: "flower", name: "flower", price: 100 },
    { id: "party", name: "party cone", price: 120 },
    { id: "beret", name: "beret", price: 150 },
    { id: "pirate", name: "bandana", price: 180 },
    { id: "cowboy", name: "cowboy", price: 220 },
    { id: "sombrero", name: "sombrero", price: 250 },
    { id: "chef", name: "chef hat", price: 300 },
    { id: "mushroom", name: "mushroom", price: 350 },
    { id: "grad", name: "grad cap", price: 400 },
    { id: "propeller", name: "propeller", price: 500 },
    { id: "viking", name: "viking", price: 600 },
    { id: "santa", name: "santa hat", price: 750 },
    { id: "wizard", name: "wizard hat", price: 900 },
    { id: "tophat", name: "top hat", price: 1200 },
    { id: "halo", name: "halo", price: 1800 },
    { id: "crown", name: "crown", price: 2500 },
  ];

  var byId = {};
  CATALOG.forEach(function (h) {
    byId[h.id] = h;
  });

  var listeners = [];

  function emit() {
    listeners.forEach(function (fn) {
      try {
        fn();
      } catch (e) {
        /* one bad listener shouldn't starve the rest */
      }
    });
  }

  function getCoins() {
    try {
      var n = parseInt(localStorage.getItem(COINS_KEY), 10);
      return isFinite(n) && n > 0 ? n : 0;
    } catch (e) {
      return 0;
    }
  }

  function setCoins(n) {
    try {
      localStorage.setItem(COINS_KEY, String(n));
    } catch (e) {
      /* storage full or blocked (private mode) — coins are best-effort */
    }
  }

  function getOwned() {
    try {
      var arr = JSON.parse(localStorage.getItem(OWNED_KEY) || "[]");
      if (!Array.isArray(arr)) return [];
      return arr.filter(function (id) {
        return typeof id === "string" && byId[id];
      });
    } catch (e) {
      return [];
    }
  }

  function saveOwned(arr) {
    try {
      localStorage.setItem(OWNED_KEY, JSON.stringify(arr));
    } catch (e) {
      /* ignore */
    }
  }

  function owns(id) {
    return getOwned().indexOf(id) !== -1;
  }

  function isValid(id) {
    return typeof id === "string" && !!byId[id];
  }

  function getEquipped() {
    try {
      var id = localStorage.getItem(EQUIPPED_KEY);
      // Equipping is gated on ownership, so a stored id we don't own is stale.
      return isValid(id) && owns(id) ? id : null;
    } catch (e) {
      return null;
    }
  }

  function setEquipped(id) {
    if (id !== null && !(isValid(id) && owns(id))) return;
    try {
      if (id === null) localStorage.removeItem(EQUIPPED_KEY);
      else localStorage.setItem(EQUIPPED_KEY, id);
    } catch (e) {
      /* ignore */
    }
    emit();
  }

  function awardListen() {
    setCoins(getCoins() + COINS_PER_TRACK);
    emit();
  }

  // Dev/testing faucet: `Tubalr.hats.grant(1000)` in the console. Client-side
  // coins are editable via localStorage anyway, so this hides nothing.
  function grant(n) {
    n = Math.floor(Number(n));
    if (!isFinite(n) || n <= 0) return getCoins();
    setCoins(getCoins() + n);
    emit();
    return getCoins();
  }

  // Buy + equip in one step. Returns true when the hat ends up owned.
  function buy(id) {
    if (!isValid(id)) return false;
    if (owns(id)) {
      setEquipped(id);
      return true;
    }
    var price = byId[id].price;
    var coins = getCoins();
    if (coins < price) return false;
    setCoins(coins - price);
    var arr = getOwned();
    arr.push(id);
    saveOwned(arr);
    setEquipped(id); // emits
    return true;
  }

  function onChange(fn) {
    if (typeof fn === "function") listeners.push(fn);
    return function () {
      var i = listeners.indexOf(fn);
      if (i !== -1) listeners.splice(i, 1);
    };
  }

  Tubalr.hats = {
    CATALOG: CATALOG,
    getCoins: getCoins,
    awardListen: awardListen,
    grant: grant,
    getOwned: getOwned,
    owns: owns,
    isValid: isValid,
    buy: buy,
    getEquipped: getEquipped,
    setEquipped: setEquipped,
    onChange: onChange,
  };
})(window.Tubalr);
