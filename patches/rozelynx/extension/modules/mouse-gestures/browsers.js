// External browser list bridge: queries the rozelynx_host native messaging
// host for installed browsers and writes the result to storage.local
// (rozelynx_browsers_result), where the content script picks it up.
//
// Reads ?req= for request correlation. On failure (host missing or blocked)
// reports {error:"nohost"}. The host also registers the detected browsers as
// x-scheme-handler/rozelynx-ext handlers (user-level .desktop files) so the
// native "Open URL in" chooser lists them.
(function() {
  'use strict';
  var p = new URLSearchParams(location.search);
  var reqId = p.get('req') || '';

  function reply(result) {
    browser.storage.local.set({
      rozelynx_browsers_result: { req: reqId, result: result, at: Date.now() }
    }).catch(function() {}).then(function() {
      try { window.close(); } catch (e) {}
    });
  }

  try {
    browser.runtime.sendNativeMessage('rozelynx_host', { action: 'list' })
      .then(function(resp) {
        if (resp && resp.browsers) {
          reply({ ok: true, browsers: resp.browsers, terminals: resp.terminals || [] });
        } else {
          reply({ ok: false, error: String(resp && resp.error || 'badresponse') });
        }
      })
      .catch(function(e) {
        reply({ ok: false, error: 'nohost:' + String(e && e.message || e) });
      });
  } catch (e) {
    reply({ ok: false, error: 'nohost-throw:' + String(e && e.message || e) });
  }
})();
