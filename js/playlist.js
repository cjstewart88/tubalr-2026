// Builds track queues from Last.fm data. A track is:
//   { artist, title, query, videoId: null }
// videoId stays null until player.js lazily resolves it via YouTube.
window.Tubalr = window.Tubalr || {};

(function (Tubalr) {
  "use strict";

  var lastfm = Tubalr.lastfm;

  // Session sizes. Video IDs resolve lazily in player.js, so a longer queue
  // costs no extra YouTube quota upfront — tune these freely.
  var ONLY_LIMIT = 50; // "only" mode: top tracks by the searched artist.
  var SIMILAR_ARTISTS = 10; // "similar" mode: how many similar artists to pull.
  var SIMILAR_TRACKS_PER = 4; // "similar" mode: top tracks per similar artist.
  var GENRE_ARTISTS = 10; // "genre" mode: how many top artists to pull for the tag.
  var GENRE_TRACKS_PER = 4; // "genre" mode: top tracks per artist.

  function toTrack(t) {
    return {
      artist: t.artist,
      title: t.title,
      query: t.artist + " " + t.title,
      videoId: null,
    };
  }

  // Drop repeat tracks (collabs / shared songs across similar artists),
  // keyed on artist+title, preserving first-seen order.
  function dedupe(tracks) {
    var seen = {};
    var out = [];
    tracks.forEach(function (t) {
      var key = (t.artist + " " + t.title).toLowerCase();
      if (!seen[key]) {
        seen[key] = true;
        out.push(t);
      }
    });
    return out;
  }

  // Interleave per-artist track lists column-by-column: every artist's track #1,
  // then every artist's #2, and so on. Exhausted (short/failed) lists are just
  // skipped, so no artist plays a block back-to-back.
  function roundRobin(lists) {
    var out = [];
    var maxLen = lists.reduce(function (m, list) {
      return Math.max(m, list.length);
    }, 0);
    for (var col = 0; col < maxLen; col++) {
      for (var i = 0; i < lists.length; i++) {
        if (col < lists[i].length) out.push(lists[i][col]);
      }
    }
    return out;
  }

  // "only" — top tracks by the searched artist.
  function buildOnly(artist) {
    return lastfm.getTopTracks(artist, ONLY_LIMIT).then(function (tracks) {
      return dedupe(tracks.map(toTrack));
    });
  }

  // "similar" — top similar artists, top tracks each, interleaved and de-duped.
  // Missing/failed artists are skipped, not fatal.
  function buildSimilar(artist) {
    return lastfm
      .getSimilarArtists(artist, SIMILAR_ARTISTS)
      .then(function (names) {
        if (!names.length) return [];
        var perArtist = names.map(function (name) {
          return lastfm
            .getTopTracks(name, SIMILAR_TRACKS_PER)
            .catch(function () {
              return []; // one artist failing shouldn't sink the whole playlist
            });
        });
        return Promise.all(perArtist).then(function (results) {
          var lists = results.map(function (tracks) {
            return tracks.map(toTrack);
          });
          return dedupe(roundRobin(lists));
        });
      });
  }

  // "genre" — top artists for a tag, top tracks each, interleaved and de-duped.
  // Missing/failed artists are skipped, not fatal.
  function buildGenre(genre) {
    return lastfm
      .getTagTopArtists(genre, GENRE_ARTISTS)
      .then(function (names) {
        if (!names.length) return [];
        var perArtist = names.map(function (name) {
          return lastfm
            .getTopTracks(name, GENRE_TRACKS_PER)
            .catch(function () {
              return []; // one artist failing shouldn't sink the whole playlist
            });
        });
        return Promise.all(perArtist).then(function (results) {
          var lists = results.map(function (tracks) {
            return tracks.map(toTrack);
          });
          return dedupe(roundRobin(lists));
        });
      });
  }

  Tubalr.playlist = {
    buildOnly: buildOnly,
    buildSimilar: buildSimilar,
    buildGenre: buildGenre,
  };
})(window.Tubalr);
