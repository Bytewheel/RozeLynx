(function() {
  'use strict';

  var ROZELYNX_VERSION = '1.0.51';
  var LOG_PREFIX = '[RozeLynx]';

  var DIAG_LINES = [];
  function dumpLog(msg) {
    DIAG_LINES.push(Date.now() + ' ' + msg);
    try { dump('[RozeLynx] ' + msg + '\n'); } catch(e) {}
    console.log('[RozeLynx] ' + msg);
  }

  dumpLog('BG background.js executing');
  dumpLog('BG document: ' + typeof document + ', head: ' + (typeof document !== 'undefined' ? String(!!document.head) : 'n/a'));
  dumpLog('BG browser: ' + typeof browser + ', runtime: ' + (typeof browser !== 'undefined' ? typeof browser.runtime : 'n/a'));
  dumpLog('BG RozeLynxFeatures at script start: ' + typeof RozeLynxFeatures);

  window.addEventListener('error', function(ev) {
    dumpLog('BG window error: ' + ev.message + ' @ ' + ev.filename + ':' + ev.lineno);
  });

  function flushDiag() {
    var report = DIAG_LINES.join('\n');
    var url = 'data:text/plain;charset=utf-8,' + encodeURIComponent(report);
    browser.downloads.download({
      url: url,
      filename: 'rozelynx-diag-' + Date.now() + '.txt',
      conflictAction: 'uniquify'
    }).catch(function(e) {
      dump('[RozeLynx] diag download failed: ' + e.message + '\n');
    });
  }

  function log(level, msg) {
    var args = Array.prototype.slice.call(arguments, 1);
    if (level === 'error') {
      console.error.apply(console, [LOG_PREFIX].concat(args));
    } else if (level === 'warn') {
      console.warn.apply(console, [LOG_PREFIX].concat(args));
    } else if (level === 'debug') {
      console.debug.apply(console, [LOG_PREFIX].concat(args));
    } else {
      console.log.apply(console, [LOG_PREFIX].concat(args));
    }
  }

  log('info', 'Background script starting (v' + ROZELYNX_VERSION + ')');
  log('info', 'Extension ID:', browser.runtime.id);
  log('info', 'Manifest version:', browser.runtime.getManifest().manifest_version);

  var MAX_WAIT = 15000;
  var startTime = Date.now();
  var initComplete = false;
  var initTimer = null;

  function checkReady() {
    if (initComplete) return;
    if (typeof RozeLynxFeatures !== 'undefined' && RozeLynxFeatures.init) {
      log('info', 'Feature loader found, running init...');
      try {
        RozeLynxFeatures.init();
        log('info', 'Feature loader init complete');
        log('info', 'Loaded modules:', Object.keys(RozeLynxFeatures.loadedModules || {}).join(', ') || 'none');
        initComplete = true;
        if (initTimer) clearTimeout(initTimer);
      } catch(e) {
        log('error', 'Feature loader init failed:', e.message, e.stack);
      }
      return;
    }
    if (Date.now() - startTime > MAX_WAIT) {
      log('warn', 'Feature loader timed out after ' + MAX_WAIT + 'ms');
      log('warn', 'rozelynxFeatures typeof:', typeof RozeLynxFeatures);
      initComplete = true;
      return;
    }
    initTimer = setTimeout(checkReady, 100);
  }

  browser.runtime.onInstalled.addListener(function(details) {
    log('info', 'onInstalled: reason=' + details.reason +
      ', previousVersion=' + (details.previousVersion || 'none') +
      ', temporary=' + (details.temporary || false));
    if (details.reason === 'install') {
      log('info', 'First install detected');
    } else if (details.reason === 'update') {
      log('info', 'Extension updated from', details.previousVersion);
    }
  });

  browser.runtime.onStartup.addListener(function() {
    log('info', 'Browser startup detected');
  });

  browser.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    var action = message && message.action;
    var data = message && message.data;

    if (!action) {
      log('debug', 'Message without action received from', (sender && sender.url));
      return false;
    }

    switch(action) {
      case 'getFeatures':
        sendResponse({
          features: Object.keys(RozeLynxFeatures ? RozeLynxFeatures.loadedModules : {}),
          version: ROZELYNX_VERSION,
          initComplete: initComplete,
        });
        break;
      case 'getFeatureStatus':
        sendResponse({
          enabled: RozeLynxFeatures &&
            RozeLynxFeatures.loadedModules &&
            RozeLynxFeatures.loadedModules[data && data.feature] || false,
        });
        break;
      case 'getDiagnostics':
        sendResponse({
          extensionId: browser.runtime.id,
          manifestVersion: browser.runtime.getManifest().manifest_version,
          initComplete: initComplete,
          loadedModules: RozeLynxFeatures ? Object.keys(RozeLynxFeatures.loadedModules) : [],
          featuresConfig: RozeLynxFeatures ? Object.keys(RozeLynxFeatures.FEATURES || {}) : [],
        });
        break;
      case 'rozelynxPing':
        sendResponse({ pong: true, version: ROZELYNX_VERSION, initComplete: initComplete });
        break;
      default:
        return false;
    }
    return false;
  });

  browser.management.getSelf().then(function(info) {
    log('info', 'Extension management info:',
      'id=' + info.id,
      'name=' + info.name,
      'enabled=' + info.enabled,
      'type=' + info.type,
      'installType=' + info.installType);
  }).catch(function(e) {
    log('warn', 'Could not get self info:', e.message);
  });

  checkReady();

  // Keep the event-page background alive: a periodic alarm wakes it just
  // before the idle-suspend timeout, so runtime messages never hit the
  // "wakes up but drops the message" race.
  try {
    browser.alarms.create('rozelynx-keepalive', { periodInMinutes: 0.5 });
  } catch (e) {
    try {
      browser.alarms.create('rozelynx-keepalive', { periodInMinutes: 1 });
    } catch (e2) {}
  }
  browser.alarms.onAlarm.addListener(function(alarm) {
    if (alarm.name === 'rozelynx-keepalive') {
      log('debug', 'keepalive tick');
    }
  });

  // Shared notification icon helper. The notification image is the favicon
  // of the site that triggered the notification; the RozeLynx logo is the
  // app badge shown by the notification daemon (system icon theme).
  //
  // Firefox accepts http(s) iconUrl for notifications.create and fetches
  // the icon natively, so this needs no host permissions, no data-URL
  // conversion and no third-party favicon service. Prefer the favicon the
  // browser already has for an open tab of the triggering site; fall back
  // to a stable known favicon URL for sites that notify without a tab
  // (AMO langpack installs), then to the RozeLynx logo.
  globalThis.RozeLynxNotify = {
    HOST_FAVICONS: {
      'addons.mozilla.org': 'https://addons.mozilla.org/favicon.ico',
    },
    iconFor: async function(siteUrl) {
      try {
        var u = new URL(siteUrl);
        var patterns = ['*://' + u.hostname + '/*'];
        if (u.hostname === 'chrome.google.com') {
          patterns.push('*://chromewebstore.google.com/*');
        } else if (u.hostname === 'chromewebstore.google.com') {
          patterns.push('*://chrome.google.com/*');
        }
        var tabs = await browser.tabs.query({ url: patterns });
        for (var i = 0; i < tabs.length; i++) {
          if (tabs[i].favIconUrl) return tabs[i].favIconUrl;
        }
        if (this.HOST_FAVICONS[u.hostname]) {
          return this.HOST_FAVICONS[u.hostname];
        }
      } catch (e) {}
      return browser.runtime.getURL('icons/icon128.png');
    },
  };
})();
