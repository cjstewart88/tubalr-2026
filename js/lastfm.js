// Last.fm data layer. Both methods used here are public (no OAuth) and the
// endpoint sends `Access-Control-Allow-Origin: *`, so plain browser fetch works.
window.Tubalr = window.Tubalr || {};

(function (Tubalr) {
  "use strict";

  var BASE = "https://ws.audioscrobbler.com/2.0/";

  function apiKey() {
    return (window.TUBALR_CONFIG && window.TUBALR_CONFIG.lastfmKey) || "";
  }

  function call(method, params) {
    var query = Object.assign(
      { method: method, api_key: apiKey(), format: "json" },
      params
    );
    var qs = Object.keys(query)
      .map(function (k) {
        return encodeURIComponent(k) + "=" + encodeURIComponent(query[k]);
      })
      .join("&");

    return fetch(BASE + "?" + qs).then(function (res) {
      return res.json().then(function (data) {
        // Last.fm returns HTTP 200 with an `error` field for bad keys / not found.
        if (data && data.error) {
          throw new Error(data.message || "Last.fm error " + data.error);
        }
        if (!res.ok) {
          throw new Error("Last.fm request failed (" + res.status + ")");
        }
        return data;
      });
    });
  }

  // Normalize Last.fm's "sometimes array, sometimes single object, sometimes missing".
  function asArray(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  }

  // -> [{ artist, title }]
  function getTopTracks(artist, limit) {
    return call("artist.getTopTracks", {
      artist: artist,
      limit: limit || 20,
      autocorrect: 1,
    }).then(function (data) {
      var tracks = asArray(data.toptracks && data.toptracks.track);
      return tracks.map(function (t) {
        return {
          artist: (t.artist && t.artist.name) || artist,
          title: t.name,
        };
      });
    });
  }

  // -> [artistName]
  function getSimilarArtists(artist, limit) {
    return call("artist.getSimilar", {
      artist: artist,
      limit: limit || 10,
      autocorrect: 1,
    }).then(function (data) {
      var artists = asArray(data.similarartists && data.similarartists.artist);
      return artists.map(function (a) {
        return a.name;
      });
    });
  }

  // -> [artistName]
  function getTagTopArtists(tag, limit) {
    // tag.getTopArtists has no autocorrect param (unlike artist.* methods).
    return call("tag.getTopArtists", {
      tag: tag,
      limit: limit || 10,
    }).then(function (data) {
      var artists = asArray(data.topartists && data.topartists.artist);
      return artists.map(function (a) {
        return a.name;
      });
    });
  }

  Tubalr.lastfm = {
    getTopTracks: getTopTracks,
    getSimilarArtists: getSimilarArtists,
    getTagTopArtists: getTagTopArtists,
  };
})(window.Tubalr);
