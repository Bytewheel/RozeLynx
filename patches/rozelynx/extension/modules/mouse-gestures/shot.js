// Screenshot bridge: captures the source tab and saves a PNG via the
// downloads API (blob URL from this extension page, like the CWS converter).
// Result is reported through storage.local (rozelynx_shot_result).
(function() {
  'use strict';
  var p = new URLSearchParams(location.search);
  var src = p.get('src') || '';

  function finish(ok, msg) {
    browser.storage.local.set({
      rozelynx_shot_result: { ok: ok, msg: msg || '', at: Date.now() }
    }).catch(function() {}).then(function() {
      try { window.close(); } catch (e) {}
    });
  }

  if (!src) { finish(false, 'no source url'); return; }

  browser.tabs.query({ url: src }).then(function(tabs) {
    var tab = tabs[0];
    if (!tab) { finish(false, 'tab not found'); return; }

    var capture;
    if (browser.tabs.captureTab) {
      capture = browser.tabs.captureTab(tab.id, { format: 'png' });
    } else if (browser.tabs.captureVisibleTab) {
      capture = browser.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    } else {
      finish(false, 'no capture api');
      return;
    }

    return capture.then(function(dataUrl) {
      return fetch(dataUrl).then(function(r) { return r.blob(); });
    }).then(function(blob) {
      var name = 'rozelynx-screenshot-' +
        new Date().toISOString().replace(/[:.]/g, '-') + '.png';
      var objUrl = URL.createObjectURL(blob);
      return browser.downloads.download({
        url: objUrl,
        filename: name,
        conflictAction: 'uniquify',
      }).then(function(id) {
        // Keep this popup alive until the download manager has consumed
        // the blob; closing early can abort the download.
        return new Promise(function(resolve) {
          var t = setTimeout(function() { resolve('timeout'); }, 15000);
          function onCh(c) {
            if (c.id === id && c.state &&
                (c.state.current === 'complete' || c.state.current === 'interrupted')) {
              clearTimeout(t);
              try { browser.downloads.onChanged.removeListener(onCh); } catch (e) {}
              resolve(c.state.current);
            }
          }
          try {
            browser.downloads.onChanged.addListener(onCh);
          } catch (e) {
            clearTimeout(t);
            resolve('noevents');
          }
        });
      });
    }).then(function(state) {
      finish(state === 'complete', state === 'complete' ? 'saved' : 'state:' + state);
    });
  }).catch(function(e) {
    finish(false, String(e && e.message || e));
  });
})();
