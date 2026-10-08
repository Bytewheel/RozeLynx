// Chrome Web Store Support Module for RozeLynx - Background
// CRX→XPI conversion support + automated update checking for converted
// extensions (registry rozelynx_cws_installed).
//
// Update flow (event-page safe; everything runs from the alarms API):
//   daily alarm -> for each registry entry:
//     GET clients2.google.com/service/update2/crx (Omaha XML)
//     -> parse updatecheck status/version
//     -> if newer: fetch CRX3, run the shared conversion core headless
//        (lib/convert.js, attestation + XPI rewrite)
//     -> attestation gate: the currently installed sha256 must be present
//        in ~/.config/rozelynx/verified-addons.json (list-verified host
//        action); never auto-update unattested installs
//     -> Phase 1 (semi-auto, default): save XPI to rozelynx-cws/ and post
//        a notification; clicking it opens the XPI (downloads.open) which
//        shows the addon install prompt. No restart needed.
//     -> Phase 2 (auto, opt-in pref rozelynx_cws_autoupdate_mode='auto'):
//        host action install-xpi copies the XPI into the profile's
//        extensions/ dir; Firefox only picks profile-dropped XPIs up at
//        startup, so the user is notified "restart to update". A
//        WebExtension cannot hot-install arbitrary files itself.

(function() {
  'use strict';

  var CWS_HOSTS = ['chrome.google.com', 'chromewebstore.google.com'];
  var REGISTRY_KEY = 'rozelynx_cws_installed';
  var BACKOFF_KEY = 'rozelynx_cws_backoff';
  var PREF_ENABLED = 'rozelynx_cws_autoupdate';
  var PREF_MODE = 'rozelynx_cws_autoupdate_mode';
  var ALARM_NAME = 'rozelynx-cws-update';
  var DIAG_KEY = 'rozelynx_cws_diag';

  var libsLoaded = false;
  var libsPromise = null;

  function cwsDiag(entry) {
    try {
      browser.storage.local.get(DIAG_KEY).then(function(stored) {
        var arr = [];
        try {
          arr = stored[DIAG_KEY] ? JSON.parse(stored[DIAG_KEY]) : [];
        } catch (e) { arr = []; }
        if (!Array.isArray(arr)) arr = [];
        arr.push({ t: Date.now(), msg: entry });
        if (arr.length > 30) arr = arr.slice(-30);
        var d = {};
        d[DIAG_KEY] = JSON.stringify(arr);
        return browser.storage.local.set(d).catch(function() {});
      }).catch(function() {});
    } catch (e) {}
  }

  function loadLibs() {
    if (libsLoaded) return Promise.resolve();
    if (libsPromise) return libsPromise;
    libsPromise = new Promise(function(resolve) {
      var urls = [
        browser.runtime.getURL('modules/chrome-web-store/lib/jszip.min.js'),
        browser.runtime.getURL('modules/chrome-web-store/lib/convert.js'),
      ];
      var idx = 0;
      function next() {
        if (idx >= urls.length) {
          libsLoaded = typeof RozeLynxCWSConvert !== 'undefined';
          if (!libsLoaded) cwsDiag('lib-load-failed');
          resolve();
          return;
        }
        var s = document.createElement('script');
        s.src = urls[idx++];
        s.onload = next;
        s.onerror = function() {
          cwsDiag('lib-error ' + urls[idx - 1]);
          next();
        };
        document.head.appendChild(s);
      }
      next();
    });
    return libsPromise;
  }

  function compareVersions(a, b) {
    var pa = String(a || '').split('.').map(function(x) { return parseInt(x, 10) || 0; });
    var pb = String(b || '').split('.').map(function(x) { return parseInt(x, 10) || 0; });
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x - y;
    }
    return 0;
  }

  // --- Registry ---------------------------------------------------------

  async function loadRegistry() {
    try {
      var stored = await browser.storage.local.get(REGISTRY_KEY);
      var reg = stored[REGISTRY_KEY] ? JSON.parse(stored[REGISTRY_KEY]) : [];
      return Array.isArray(reg) ? reg : [];
    } catch (e) {
      return [];
    }
  }

  async function saveRegistry(reg) {
    var out = {};
    out[REGISTRY_KEY] = JSON.stringify(reg);
    await browser.storage.local.set(out);
  }

  async function loadBackoff() {
    try {
      var stored = await browser.storage.local.get(BACKOFF_KEY);
      var b = stored[BACKOFF_KEY] ? JSON.parse(stored[BACKOFF_KEY]) : {};
      return (b && typeof b === 'object') ? b : {};
    } catch (e) {
      return {};
    }
  }

  async function saveBackoff(b) {
    var out = {};
    out[BACKOFF_KEY] = JSON.stringify(b);
    await browser.storage.local.set(out);
  }

  async function getPrefs() {
    var stored = await browser.storage.local.get([PREF_ENABLED, PREF_MODE]);
    return {
      enabled: stored[PREF_ENABLED] !== false,
      mode: stored[PREF_MODE] === 'auto' ? 'auto' : 'semi',
    };
  }

  // --- Verified-addons attestation gate (host action) --------------------

  async function listVerified() {
    try {
      var resp = await browser.runtime.sendNativeMessage('rozelynx_host', {
        action: 'list-verified',
      });
      if (resp && Array.isArray(resp.verified)) return resp.verified;
      return [];
    } catch (e) {
      cwsDiag('list-verified-error ' + e);
      return [];
    }
  }

  // --- Omaha update check ------------------------------------------------

  function parseUpdateResponse(xmlText, extId) {
    var doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    var apps = doc.getElementsByTagName('app');
    for (var i = 0; i < apps.length; i++) {
      var app = apps[i];
      if (app.getAttribute('appid') !== extId) continue;
      var uc = app.getElementsByTagName('updatecheck')[0];
      if (!uc) return { status: 'missing' };
      var status = uc.getAttribute('status');
      if (status === 'ok') {
        return { status: 'ok', version: uc.getAttribute('version') };
      }
      if (status === 'noupdate') return { status: 'noupdate' };
      return { status: status || 'error' };
    }
    return { status: 'missing' };
  }

  function checkUrlFor(extId, version) {
    // prodversion + acceptformat are REQUIRED: without them the Omaha
    // endpoint answers "noupdate" for every id, even v=0. A recent fixed
    // Chrome prodversion is the standard trick used by CRX downloaders.
    return 'https://clients2.google.com/service/update2/crx?' +
      'prodversion=130.0.0.0&acceptformat=crx2,crx3' +
      '&x=id%3D' + encodeURIComponent(extId) +
      '%26v%3D' + encodeURIComponent(version || '0') +
      '%26uc';
  }

  function downloadUrlFor(extId) {
    // prodversion must be modern: with 91.0 the endpoint answers 204 No
    // Content instead of redirecting to the CRX blob.
    return 'https://clients2.google.com/service/update2/crx?' +
      'response=redirect&prodversion=130.0.0.0&acceptformat=crx2,crx3' +
      '&x=id%3D' + encodeURIComponent(extId) + '%26uc';
  }

  async function checkUpdate(entry) {
    var url = checkUrlFor(entry.extId, entry.version);
    var response = await fetch(url);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    var xmlText = await response.text();
    return parseUpdateResponse(xmlText, entry.extId);
  }

  // --- Install phases -----------------------------------------------------

  async function isAttested(entry, verifiedRecords) {
    // The installed sha256 must be in verified-addons.json.
    if (!entry.sha256) return false;
    for (var i = 0; i < verifiedRecords.length; i++) {
      var r = verifiedRecords[i];
      if (r && r.sha256 && r.sha256.toLowerCase() === String(entry.sha256).toLowerCase()) {
        return true;
      }
    }
    return false;
  }

  async function strictMinOk() {
    try {
      var info = await browser.runtime.getBrowserInfo();
      var convertedMin = '128.0';
      return compareVersions(info.version, convertedMin) >= 0;
    } catch (e) {
      return true;
    }
  }

  async function installUpdate(entry, newVersion, xpiArray) {
    var prefs = await getPrefs();
    var safeName = (entry.name || entry.extId).replace(/[^a-zA-Z0-9_-]/g, '_');
    var filename = 'rozelynx-cws/' + safeName + '-v' + newVersion + '.xpi';

    var blob = new Blob([xpiArray], { type: 'application/x-xpinstall' });

    if (prefs.mode === 'auto') {
      // Phase 2: drop into the profile extensions dir via the host; the
      // user must restart for Firefox to pick it up.
      try {
        var dlId = await browser.downloads.download({
          url: URL.createObjectURL(blob),
          filename: filename,
          conflictAction: 'overwrite',
          saveAs: false,
        });
        var items = await browser.downloads.search({ id: dlId });
        var path = items && items[0] ? items[0].filename : null;
        if (!path) throw new Error('download path unknown');
        var sha = await RozeLynxCWSConvert.sha256Hex(xpiArray);
        var resp = await browser.runtime.sendNativeMessage('rozelynx_host', {
          action: 'install-xpi',
          id: entry.extId + '@rozelynx-converted',
          path: path,
          sha256: sha,
          version: newVersion,
          name: entry.name || entry.extId,
        });
        if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'host refused');
        await browser.notifications.create('cws-update-' + entry.extId, {
          type: 'basic',
          iconUrl: await RozeLynxNotify.iconFor(
            'https://chromewebstore.google.com/detail/' + entry.extId),
          title: 'Update staged: ' + (entry.name || entry.extId),
          message: 'v' + newVersion + ' installed. Restart RozeLynx to use it.',
        });
        cwsDiag('auto-install ok ' + entry.extId + ' -> ' + newVersion);
        return { installed: true, restart: true };
      } catch (e) {
        cwsDiag('auto-install failed ' + e + ' - falling back to semi');
      }
    }

    // Phase 1 (default): download + notification, click opens the XPI.
    var dlId = await browser.downloads.download({
      url: URL.createObjectURL(blob),
      filename: filename,
      conflictAction: 'uniquify',
      saveAs: false,
    });
    await browser.notifications.create('cws-update-' + entry.extId, {
      type: 'basic',
      iconUrl: await RozeLynxNotify.iconFor(
        'https://chromewebstore.google.com/detail/' + entry.extId),
      title: 'Update for ' + (entry.name || entry.extId),
      message: 'v' + newVersion + ' ready - click to install.',
    });
    pendingNotificationDownloads['cws-update-' + entry.extId] = dlId;
    cwsDiag('semi-install ok ' + entry.extId + ' -> ' + newVersion);
    return { installed: false, restart: false };
  }

  var pendingNotificationDownloads = {};

  browser.notifications.onClicked.addListener(function(notifId) {
    var dlId = pendingNotificationDownloads[notifId];
    if (!dlId) return;
    // Opening the XPI starts the addon install prompt.
    browser.downloads.open(dlId).catch(function() {});
    delete pendingNotificationDownloads[notifId];
  });

  // --- The update round ----------------------------------------------------

  async function runUpdateCheck() {
    var prefs = await getPrefs();
    if (!prefs.enabled) {
      cwsDiag('disabled by pref');
      return { checked: 0, updates: [] };
    }
    await loadLibs();
    if (!libsLoaded) {
      cwsDiag('libs unavailable');
      return { checked: 0, updates: [] };
    }
    if (!(await strictMinOk())) {
      cwsDiag('browser too old, skipping');
      return { checked: 0, updates: [] };
    }

    var reg = await loadRegistry();
    var backoff = await loadBackoff();
    var now = Date.now();

    // Backfill sha256 from verified-addons.json for entries converted
    // before the registry existed.
    var verifiedRecords = await listVerified();
    var changed = false;
    for (var i = 0; i < reg.length; i++) {
      var entry = reg[i];
      if (!entry.sha256) {
        for (var j = verifiedRecords.length - 1; j >= 0; j--) {
          var r = verifiedRecords[j];
          if (r && r.id === entry.extId && r.sha256) {
            entry.sha256 = r.sha256.toLowerCase();
            changed = true;
            break;
          }
        }
      }
    }
    if (changed) await saveRegistry(reg);

    var updates = [];
    for (var k = 0; k < reg.length; k++) {
      var e = reg[k];
      if (!e.extId) continue;
      if (backoff[e.extId] && backoff[e.extId] > now) {
        cwsDiag('backoff skip ' + e.extId);
        continue;
      }
      if (!(await isAttested(e, verifiedRecords))) {
        cwsDiag('attestation gate blocks ' + e.extId + ' (no verified sha256)');
        continue;
      }
      try {
        var upd = await checkUpdate(e);
        if (upd.status !== 'ok' || !upd.version) {
          cwsDiag('check ' + e.extId + ': ' + upd.status);
          continue;
        }
        if (compareVersions(upd.version, e.version) <= 0) {
          cwsDiag('up-to-date ' + e.extId + ' (' + e.version + ')');
          continue;
        }
        if (e.offeredVersion && compareVersions(upd.version, e.offeredVersion) <= 0) {
          cwsDiag('already offered ' + upd.version + ' for ' + e.extId);
          continue;
        }
        cwsDiag('update available ' + e.extId + ' ' + e.version + ' -> ' + upd.version);

        var crxResp = await fetch(downloadUrlFor(e.extId));
        if (!crxResp.ok) throw new Error('CRX download HTTP ' + crxResp.status);
        var crxBuffer = await crxResp.arrayBuffer();
        if (crxBuffer.byteLength < 16) throw new Error('CRX too small');

        var converted = await RozeLynxCWSConvert.convertCrxToXpi(crxBuffer, {
          extId: e.extId,
          name: e.name,
        });
        // The update itself must attest against Google's pinned keys too.
        if (!converted.attest.ok) {
          cwsDiag('update attestation failed for ' + e.extId + ': ' +
            converted.attest.detail);
          continue;
        }

        var result = await installUpdate(e, upd.version, converted.xpiArray);
        if (result.installed) {
          e.version = upd.version;
          e.offeredVersion = null;
          e.sha256 = await RozeLynxCWSConvert.sha256Hex(converted.xpiArray);
        } else {
          // Semi-auto: remember what was offered so we don't spam daily.
          e.offeredVersion = upd.version;
        }
        await saveRegistry(reg);
        updates.push({ extId: e.extId, version: upd.version });
      } catch (err) {
        cwsDiag('update error ' + e.extId + ': ' + err);
        // Exponential backoff: 1h * attempts, capped at 7 days.
        var attempts = (backoff[e.extId + ':n'] || 0) + 1;
        backoff[e.extId + ':n'] = attempts;
        backoff[e.extId] = now + Math.min(3600000 * Math.pow(2, attempts - 1), 7 * 86400000);
        await saveBackoff(backoff);
      }
    }
    return { checked: reg.length, updates: updates };
  }

  // --- Legacy message actions --------------------------------------------

  async function installExtension(url, name) {
    try {
      await loadLibs();
      var response = await fetch(url);
      if (!response.ok) throw new Error('Download failed: HTTP ' + response.status);
      var crxBuffer = await response.arrayBuffer();
      if (crxBuffer.byteLength < 16) throw new Error('Response too small');

      var extId = null;
      var m = url.match(/id%3D([a-z]{32})/i);
      if (m) extId = m[1];

      var converted = await RozeLynxCWSConvert.convertCrxToXpi(crxBuffer, {
        extId: extId || '',
        name: name,
      });

      var xpiBlob = new Blob([converted.xpiArray], { type: 'application/x-xpinstall' });
      var extName = (name || 'extension').replace(/[^a-zA-Z0-9_-]/g, '_');
      await browser.downloads.download({
        url: URL.createObjectURL(xpiBlob),
        filename: 'rozelynx-cws/' + extName + '.xpi',
        saveAs: false,
        conflictAction: 'uniquify',
      });

      try {
        var siteUrl = url.indexOf('://') !== -1 ? url :
          'https://chromewebstore.google.com/detail/' + (extId || '');
        await browser.notifications.create('cws-install-' + Date.now(), {
          type: 'basic',
          iconUrl: await RozeLynxNotify.iconFor(siteUrl),
          title: 'Extension Downloaded',
          message: (name || 'Extension') + ' saved. Install via about:addons page.',
        });
      } catch (notifErr) {}

      return { success: true, name: name };
    } catch (e) {
      console.error('[RozeLynx CWS] Install failed:', e);
      return { success: false, error: e.message };
    }
  }

  async function getExtensionInfo(url) {
    try {
      var extId = url.match(/id%3D([a-z]{32})/i);
      if (!extId) return null;

      var metaUrl = 'https://clients2.google.com/service/update2/crx?' +
        'response=redirect&prodversion=91.0&acceptformat=crx2,crx3' +
        '&x=id%3D' + extId[1] + '%26uc';

      var response = await fetch(metaUrl, { method: 'HEAD' });
      var size = response.headers.get('content-length');

      return {
        id: extId[1],
        downloadUrl: metaUrl,
        size: size ? parseInt(size) : null,
      };
    } catch (e) {
      return null;
    }
  }

  // --- Startup: alarm + first check ---------------------------------------

  browser.alarms.create(ALARM_NAME, { periodInMinutes: 1440, delayInMinutes: 60 });
  browser.alarms.onAlarm.addListener(function(alarm) {
    if (alarm.name === ALARM_NAME) {
      runUpdateCheck().catch(function(e) { cwsDiag('alarm-run-error ' + e); });
    }
  });

  // First check shortly after startup (event page wakes via alarm).
  setTimeout(function() {
    browser.storage.local.get(PREF_ENABLED).then(function(stored) {
      if (stored[PREF_ENABLED] === false) return;
      runUpdateCheck().catch(function(e) { cwsDiag('startup-run-error ' + e); });
    }).catch(function() {});
  }, 45000);

  // --- Messages ------------------------------------------------------------

  browser.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    if (!message || message.module !== 'cws') return undefined;

    if (message.action === 'install') {
      installExtension(message.data.url, message.data.name).then(sendResponse);
      return true;
    }

    if (message.action === 'cwsCheck') {
      sendResponse({ available: true });
      return undefined;
    }

    if (message.action === 'getInfo') {
      getExtensionInfo(message.data.url).then(sendResponse);
      return true;
    }

    if (message.action === 'check-updates') {
      runUpdateCheck().then(sendResponse);
      return true;
    }

    if (message.action === 'getStatus') {
      Promise.all([loadRegistry(), getPrefs(), loadBackoff()])
        .then(function(results) {
          sendResponse({
            registry: results[0],
            prefs: results[1],
            backoff: results[2],
          });
        });
      return true;
    }

    return undefined;
  });

  RozeLynxFeatures.loadedModules['chrome-web-store'] = true;
  cwsDiag('module-loaded');
  console.log('[RozeLynx] Chrome Web Store module loaded');
})();
