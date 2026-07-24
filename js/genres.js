// Curated genre shortcuts. Most-recently-used order, persisted in localStorage
// so a clicked genre moves to the front for next time. Dependency-free.
window.Tubalr = window.Tubalr || {};

(function (Tubalr) {
  "use strict";

  var KEY = "tubalr:genre-order";

  var DEFAULT = [
    // core
    "rock", "pop", "hip hop", "electronic", "jazz", "metal", "indie",
    "classical", "country", "r&b", "folk", "punk", "reggae", "soul",
    "techno", "ambient",
    // rock
    "alternative rock", "classic rock", "hard rock", "prog rock",
    "psychedelic rock", "garage rock", "blues rock", "folk rock",
    "indie rock", "post-rock", "math rock", "noise rock", "stoner rock",
    "grunge",
    // rock/pop crossover
    "britpop", "shoegaze", "dream pop", "indie pop", "synthpop", "new wave",
    // punk/emo
    "post-punk", "hardcore punk", "pop punk", "emo", "screamo",
    // metal
    "metalcore", "death metal", "black metal", "thrash metal", "doom metal",
    "nu metal", "progressive metal", "industrial metal",
    // electronic
    "house", "deep house", "tech house", "trance", "dubstep",
    "drum and bass", "trip hop", "downtempo", "chillout", "lo-fi", "idm",
    "breakbeat", "jungle", "garage", "grime", "edm", "electro", "industrial",
    "synthwave", "vaporwave",
    // hip hop
    "trap", "drill", "boom bap", "conscious hip hop", "gangsta rap",
    // r&b/soul/funk/disco
    "neo soul", "funk", "disco", "gospel", "contemporary r&b",
    // jazz/blues
    "blues", "bebop", "smooth jazz", "fusion", "swing",
    // folk/country/world
    "bluegrass", "americana", "singer-songwriter", "world", "latin",
    "salsa", "reggaeton", "dancehall", "afrobeat",
    // pop extras
    "k-pop", "j-pop", "dance pop",
    // classical/other
    "opera", "soundtrack", "new age", "experimental",
  ];

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      var arr = raw ? JSON.parse(raw) : null;
      if (!Array.isArray(arr)) return DEFAULT.slice();
      // Keep only genres still in DEFAULT (tolerates the curated list changing
      // since this was saved), preserving stored order, then append any
      // default genres not yet in storage.
      var known = arr.filter(function (g) {
        return DEFAULT.indexOf(g) !== -1;
      });
      DEFAULT.forEach(function (g) {
        if (known.indexOf(g) === -1) known.push(g);
      });
      return known;
    } catch (e) {
      return DEFAULT.slice();
    }
  }

  function save(arr) {
    try {
      localStorage.setItem(KEY, JSON.stringify(arr));
    } catch (e) {
      /* storage full or blocked (private mode) — best-effort */
    }
  }

  function list() {
    return load();
  }

  // Move a genre to the front (most-recently-used); everything else shifts
  // back a slot.
  function use(genre) {
    var arr = load().filter(function (g) {
      return g !== genre;
    });
    arr.unshift(genre);
    save(arr);
  }

  Tubalr.genres = { list: list, use: use };
})(window.Tubalr);
