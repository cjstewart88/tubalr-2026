// Recent searches store. Remembers artist+mode searches in localStorage so the
// homescreen can offer one-tap resume. Dependency-free. Newest-first, capped,
// deduped by artist+mode.
window.Tubalr = window.Tubalr || {};

(function (Tubalr) {
  "use strict";

  var KEY = "tubalr:recent";
  var CAP = 12;

  // Case-insensitive on artist, exact on mode — "Radiohead" and "radiohead" in
  // the same mode are one entry, but only/similar stay distinct.
  function keyOf(artist, mode) {
    return String(artist).toLowerCase() + "\n" + mode;
  }

  function list() {
    try {
      var raw = localStorage.getItem(KEY);
      var arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) return [];
      // Keep only well-formed entries; tolerate anything else in storage.
      return arr.filter(function (e) {
        return e && typeof e.artist === "string" && (e.mode === "only" || e.mode === "similar");
      });
    } catch (e) {
      return [];
    }
  }

  function save(arr) {
    try {
      localStorage.setItem(KEY, JSON.stringify(arr));
    } catch (e) {
      /* storage full or blocked (private mode) — recents are best-effort */
    }
  }

  // Move an existing artist+mode to the front (refreshing its display casing),
  // otherwise prepend. Trim to the cap.
  function add(artist, mode) {
    var name = String(artist).trim();
    if (!name || (mode !== "only" && mode !== "similar")) return;
    var k = keyOf(name, mode);
    var arr = list().filter(function (e) {
      return keyOf(e.artist, e.mode) !== k;
    });
    arr.unshift({ artist: name, mode: mode });
    save(arr.slice(0, CAP));
  }

  function remove(artist, mode) {
    var k = keyOf(artist, mode);
    save(
      list().filter(function (e) {
        return keyOf(e.artist, e.mode) !== k;
      })
    );
  }

  function clear() {
    try {
      localStorage.removeItem(KEY);
    } catch (e) {
      /* ignore */
    }
  }

  Tubalr.recent = { list: list, add: add, remove: remove, clear: clear };
})(window.Tubalr);
