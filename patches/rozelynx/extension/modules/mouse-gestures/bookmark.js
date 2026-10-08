// Bookmark bridge: toggles a bookmark for the given URL and records the
// resulting state in storage.local so the content script can show the star.
(function() {
  'use strict';
  var p = new URLSearchParams(location.search);
  var url = p.get('url') || '';
  var title = p.get('title') || url;

  function done() {
    try { window.close(); } catch (e) {}
  }

  if (!url) { done(); return; }

  browser.bookmarks.search({ url: url }).then(function(results) {
    var nowOn = false;
    var ops;
    if (results.length) {
      ops = results.map(function(b) { return browser.bookmarks.remove(b.id); });
    } else {
      ops = [browser.bookmarks.create({ url: url, title: title })];
      nowOn = true;
    }
    return Promise.all(ops).then(function() {
      return browser.storage.local.get('rozelynx_bookmarks');
    }).then(function(stored) {
      var map = stored.rozelynx_bookmarks || {};
      if (nowOn) map[url] = true;
      else delete map[url];
      return browser.storage.local.set({ rozelynx_bookmarks: map });
    });
  }).catch(function() {}).then(done);
})();
