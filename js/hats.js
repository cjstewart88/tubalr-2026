// Hats: cosmetic headwear for the DJ-mode creature. Every catalog hat is
// freely available; only the equipped choice persists (localStorage, same
// best-effort pattern as recent.js). Hats travel the network as catalog *ids*
// only — every remote id is checked with isValid() before it becomes a CSS
// class, so unknown/hostile strings render nothing. Dependency-free; the
// picker UI lives in creatures.js.
window.Tubalr = window.Tubalr || {};

(function (Tubalr) {
  "use strict";

  var EQUIPPED_KEY = "tubalr:hat";

  // Leftovers from the retired coin economy — clear them so old browsers
  // don't carry dead state around.
  try {
    localStorage.removeItem("tubalr:coins");
    localStorage.removeItem("tubalr:hats-owned");
  } catch (e) {
    /* ignore */
  }

  // Drawn in CSS as .hat-<id> (see styles.css).
  var CATALOG = [
    { id: "beanie", name: "beanie" },
    { id: "cap", name: "cap" },
    { id: "bow", name: "bow" },
    { id: "headband", name: "headband" },
    { id: "flower", name: "flower" },
    { id: "party", name: "party cone" },
    { id: "beret", name: "beret" },
    { id: "pirate", name: "bandana" },
    { id: "cowboy", name: "cowboy" },
    { id: "sombrero", name: "sombrero" },
    { id: "chef", name: "chef hat" },
    { id: "mushroom", name: "mushroom" },
    { id: "grad", name: "grad cap" },
    { id: "propeller", name: "propeller" },
    { id: "viking", name: "viking" },
    { id: "santa", name: "santa hat" },
    { id: "wizard", name: "wizard hat" },
    { id: "tophat", name: "top hat" },
    { id: "halo", name: "halo" },
    { id: "crown", name: "crown" },
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

  function isValid(id) {
    return typeof id === "string" && !!byId[id];
  }

  function getEquipped() {
    try {
      var id = localStorage.getItem(EQUIPPED_KEY);
      return isValid(id) ? id : null;
    } catch (e) {
      return null;
    }
  }

  function setEquipped(id) {
    if (id !== null && !isValid(id)) return;
    try {
      if (id === null) localStorage.removeItem(EQUIPPED_KEY);
      else localStorage.setItem(EQUIPPED_KEY, id);
    } catch (e) {
      /* ignore */
    }
    emit();
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
    isValid: isValid,
    getEquipped: getEquipped,
    setEquipped: setEquipped,
    onChange: onChange,
  };
})(window.Tubalr);
