// DevTools bridge: opens the NATIVE docked DevTools toolbox for the source
// tab (same-tab, like the native Inspect Element) via the rozelynxDevtools
// experiment API, selecting the marked element when given.
// mode=inspect -> inspector panel; mode=a11y -> accessibility panel.
// Result reported via storage.local (rozelynx_dt_result).
// The privileged API opens the toolbox through gDevTools directly, so this
// bridge never loads about:devtools-toolbox and needs no build patch.
(function() {
  'use strict';
  var p = new URLSearchParams(location.search);
  var mode = p.get('mode') || 'inspect';
  var src = p.get('src') || '';
  var mark = p.get('mark') || '';

  function finish(result) {
    browser.storage.local.set({
      rozelynx_dt_result: { mode: mode, result: result, at: Date.now() }
    }).catch(function() {}).then(function() {
      try { window.close(); } catch (e) {}
    });
  }

  if (!src) { finish('error:no src'); return; }

  if (!(browser.rozelynxDevtools && browser.rozelynxDevtools.inspect)) {
    finish('error:no api');
    return;
  }

  browser.rozelynxDevtools.inspect({
    url: src,
    mark: mark,
    tool: mode === 'a11y' ? 'accessibility' : 'inspector'
  }).then(function(r) {
    if (r && r.opened) {
      finish(r.selected ? 'opened' : 'opened-unselected');
    } else {
      finish('error:not opened');
    }
  }).catch(function(e) {
    finish('error:' + String(e && e.message || e));
  });
})();
