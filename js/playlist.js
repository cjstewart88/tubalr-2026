// Builds track queues from Last.fm data. A track is:
//   { artist, title, query, videoId: null }
// videoId stays null until player.js lazily resolves it via YouTube.
window.Tubalr = window.Tubalr || {};

(function (Tubalr) {
  "use strict";

  var lastfm = Tubalr.lastfm;

  function toTrack(t) {
    return {
      artist: t.artist,
      title: t.title,
      query: t.artist + " " + t.title,
      videoId: null,
    };
  }

  // "only" — top 20 tracks by the searched artist.
  function buildOnly(artist) {
    return lastfm.getTopTracks(artist, 20).then(function (tracks) {
      return tracks.map(toTrack);
    });
  }

  // "similar" — top 10 similar artists, top 2 tracks each (~20 total),
  // ordered artist-by-artist. Missing/failed artists are skipped, not fatal.
  function buildSimilar(artist) {
    return lastfm.getSimilarArtists(artist, 10).then(function (names) {
      if (!names.length) return [];
      var perArtist = names.map(function (name) {
        return lastfm.getTopTracks(name, 2).catch(function () {
          return []; // one artist failing shouldn't sink the whole playlist
        });
      });
      return Promise.all(perArtist).then(function (results) {
        var queue = [];
        results.forEach(function (tracks) {
          tracks.forEach(function (t) {
            queue.push(toTrack(t));
          });
        });
        return queue;
      });
    });
  }

  Tubalr.playlist = {
    buildOnly: buildOnly,
    buildSimilar: buildSimilar,
  };
})(window.Tubalr);
