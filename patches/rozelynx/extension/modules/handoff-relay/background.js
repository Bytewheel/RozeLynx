/* RozeLynx: hand-off ext: relay.
 *
 * The download hand-off engine is browser code (Settings > General >
 * Download hand-off, uriloader/exthandler/rozelynx-handoff/). It handles
 * the gate, the prefs, the uget builtin and cmd: programs natively - but
 * an ext:<id> handler means "deliver this download message to another
 * extension", and cross-extension runtime messaging is something only an
 * extension can do. This module is the whole relay: forward the payload,
 * report the answer. Nothing else.
 *
 * The second, equally small job is the probe cache: the engine cannot ask
 * AddonManager whether an extension is installed, so this pushes
 * rozelynx.downloads.handoff.extensions (JSON {"<id>": enabled}) on
 * startup and on every management event that can change it. Without this
 * module the engine reports every ext: handler unavailable - the honest
 * answer, because nobody could deliver to it.
 *
 * A build without USE=download-handoff has no engine, no observer and no
 * need for this module; it ships only with that flag.
 */
(function() {
  'use strict';

  var LOG_PREFIX = '[RozeLynx:handoff-relay]';
  var PREF_EXT_STATES = 'rozelynx.downloads.handoff.extensions';

  function log(level, msg) {
    if (level === 'error') {
      console.error(LOG_PREFIX, msg);
    } else {
      console.log(LOG_PREFIX, msg);
    }
  }

  // ── the probe cache ────────────────────────────────────────────────

  function pushExtStates() {
    if (!browser.management || !browser.rozelynxPrefs) {
      return;
    }
    browser.management.getAll().then(function(list) {
      var states = {};
      (list || []).forEach(function(a) {
        if (a.type === 'extension') {
          states[a.id] = a.enabled !== false;
        }
      });
      return browser.rozelynxPrefs.setPrefs(
        { [PREF_EXT_STATES]: JSON.stringify(states) });
    }).catch(function(e) {
      log('warn', 'could not push the extension states: ' + e);
    });
  }

  ['onInstalled', 'onEnabled', 'onDisabled', 'onUninstalled'].forEach(
    function(event) {
      if (browser.management && browser.management[event]) {
        browser.management[event].addListener(pushExtStates);
      }
    });

  // ── the relay ──────────────────────────────────────────────────────

  if (!browser.rozelynxHandoff || !browser.rozelynxHandoff.onHandoffRequest) {
    // The experiment API is missing (older parent build): the engine
    // already treats ext: handlers as unavailable; nothing to relay.
    return;
  }

  browser.rozelynxHandoff.onHandoffRequest.addListener(function(info) {
    info = info || {};
    if (!info.extId || !info.url) {
      // Decline fast on a malformed request: the engine's wait is short
      // and hanging it wastes the download's 1.5 seconds.
      browser.rozelynxHandoff.respond(info.requestId, false, 'malformed request')
        .catch(function() {});
      return;
    }
    // The message is the one the old extension module sent, contract and
    // all: {target: 'download', url, filename, referer}, answered with
    // {ok: true}. A download-manager extension written against the old
    // extension keeps working unchanged.
    var payload = {
      target: 'download',
      url: info.url,
      filename: info.filename || '',
      referer: info.referer || '',
    };
    Promise.resolve(
      browser.runtime.sendMessage(info.extId, payload)
    ).then(function(reply) {
      var ok = !!(reply && reply.ok === true);
      return browser.rozelynxHandoff.respond(
        info.requestId, ok,
        ok ? '' : 'the extension did not acknowledge');
    }).catch(function(e) {
      // Not installed, no listener, or it errored: decline so the engine
      // tries the next handler instead of burning its whole timeout.
      return browser.rozelynxHandoff.respond(
        info.requestId, false,
        (e && e.message) ? e.message : String(e));
    }).catch(function(e) {
      log('error', 'could not answer the hand-off engine: ' + e);
    });
  });

  pushExtStates();
  log('info', 'relay ready (ext: handler delivery for the browser engine)');
})();
