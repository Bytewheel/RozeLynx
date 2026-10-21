// QR Code Popup Script
(function() {
  'use strict';

  var canvas = document.getElementById('qr-canvas');
  var error = document.getElementById('error');
  var urlDisplay = document.getElementById('url-display');
  var generateBtn = document.getElementById('generate-btn');
  var copyBtn = document.getElementById('copy-btn');

  var currentUrl = '';
  var currentTitle = '';

  function showError(msg) {
    error.style.display = 'block';
    error.textContent = msg;
  }

  function clearError() {
    error.style.display = 'none';
    error.textContent = '';
  }

  function showQR(dataURL, url) {
    canvas.style.display = 'inline';
    urlDisplay.style.display = 'block';
    copyBtn.style.display = 'inline';

    var ctx = canvas.getContext('2d');
    var img = new Image();
    img.onload = function() {
      ctx.drawImage(img, 0, 0, 240, 240);
    };
    img.src = dataURL;

    var shortUrl = url.length > 60 ? url.substring(0, 57) + '...' : url;
    urlDisplay.textContent = shortUrl;
  }

  function generateQR(data) {
    if (typeof qrcode === 'undefined') {
      showError('QR library failed to load');
      return;
    }
    try {
      qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
    } catch (e) {}

    var qr;
    try {
      qr = qrcode(0, 'H');
      qr.addData(data);
      qr.make();
    } catch (e) {
      showError('Could not encode URL: ' + e.message);
      return;
    }

    var size = 240;
    var count = qr.getModuleCount();
    var quiet = 4;
    var scale = Math.max(1, Math.floor(size / (count + quiet * 2)));
    var offset = Math.floor((size - count * scale) / 2);

    var c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    var ctx = c.getContext('2d');

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, size, size);

    ctx.fillStyle = '#000000';
    for (var row = 0; row < count; row++) {
      for (var col = 0; col < count; col++) {
        if (qr.isDark(row, col)) {
          ctx.fillRect(offset + col * scale, offset + row * scale, scale, scale);
        }
      }
    }

    // Small centered brand mark. Error correction level H leaves ample
    // capacity so the overlaid modules still decode.
    var center = size / 2;
    var r = Math.floor(scale * 1.6);
    ctx.fillStyle = '#8B5CF6';
    ctx.beginPath();
    ctx.arc(center, center, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(center, center, r * 0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1A1A2E';
    ctx.beginPath();
    ctx.arc(center, center, r * 0.25, 0, Math.PI * 2);
    ctx.fill();

    var dataURL = c.toDataURL('image/png');
    showQR(dataURL, data);
  }

  // The QR code is generated only when the button is clicked, never on
  // popup open. The active tab is read up-front (cheap), the encode work
  // is not.
  browser.tabs.query({ active: true, currentWindow: true }).then(function(tabs) {
    if (!tabs || tabs.length === 0) {
      generateBtn.disabled = true;
      showError('No active tab');
      return;
    }
    currentUrl = tabs[0].url;
    currentTitle = tabs[0].title;

    if (!currentUrl || currentUrl.startsWith('about:') ||
        currentUrl.startsWith('moz-extension:')) {
      generateBtn.disabled = true;
      showError('Cannot generate QR code for this page');
      return;
    }
  }).catch(function() {
    generateBtn.disabled = true;
    showError('Could not access tab');
  });

  generateBtn.addEventListener('click', function() {
    clearError();
    if (!currentUrl) {
      showError('Cannot generate QR code for this page');
      return;
    }
    generateBtn.disabled = true;
    try {
      generateQR(currentUrl);
    } finally {
      generateBtn.disabled = false;
    }
  });

  copyBtn.addEventListener('click', function() {
    navigator.clipboard.writeText(currentUrl).then(function() {
      copyBtn.textContent = 'Copied!';
      setTimeout(function() { copyBtn.textContent = 'Copy URL'; }, 1500);
    }).catch(function() {
      copyBtn.textContent = 'Copy failed';
      setTimeout(function() { copyBtn.textContent = 'Copy URL'; }, 1500);
    });
  });

  // Installed PWAs (stored by the pwa module's content script)
  var PWA_KEY = 'rozelynx_pwa_sites';
  var pwaList = document.getElementById('pwa-list');
  var pwaEmpty = document.getElementById('pwa-empty');

  function loadSites() {
    return browser.storage.local.get(PWA_KEY).then(function(stored) {
      try {
        return stored[PWA_KEY] ? JSON.parse(stored[PWA_KEY]) : [];
      } catch (e) {
        return [];
      }
    });
  }

  function renderPWAs() {
    loadSites().then(function(sites) {
      pwaList.textContent = '';
      pwaEmpty.style.display = sites.length ? 'none' : 'block';

      sites.forEach(function(site) {
        var row = document.createElement('div');
        row.className = 'pwa-row';

        if (site.icon) {
          var img = document.createElement('img');
          img.className = 'pwa-icon';
          img.src = site.icon;
          row.appendChild(img);
        }

        var name = document.createElement('span');
        name.className = 'pwa-name';
        name.textContent = site.name;
        name.title = site.startUrl;
        row.appendChild(name);

        var launch = document.createElement('button');
        launch.textContent = 'Launch';
        launch.addEventListener('click', function() {
          launch.textContent = 'Launching...';
          launch.disabled = true;
          // Route through the PWA background module so the app window gets
          // the full SSB treatment: popup type, ssb-mode chrome, window
          // tracking and (1.0.39+) dark-mode color-scheme override.
          var fallbackPopup = function() {
            // Background down (post-update wedge): still open an app-like
            // window by applying the SSB chrome straight from this
            // extension page - the experiment API runs in the parent
            // process and does not need the event page to be alive.
            var launchUrl = site.startUrl;
            var sep = launchUrl.indexOf('#') >= 0 ? '&' : '#';
            if (launchUrl.slice(-1) === '#') sep = '';
            launchUrl = launchUrl + sep + 'rozelynx-pwa=1';
            browser.windows.create({
              url: launchUrl,
              type: 'normal',
              width: 1280,
              height: 800,
              focused: true,
            }).then(function(w) {
              if (!w || !w.id) return;
              if (browser.rozelynxWindows && browser.rozelynxWindows.setSsbMode) {
                browser.rozelynxWindows.setSsbMode(w.id, true).catch(function() {});
              }
              browser.windows.update(w.id, { focused: true }).catch(function() {});
            }).catch(function() {});
          };
          browser.runtime.sendMessage({
            module: 'pwa',
            action: 'launch',
            data: { siteId: site.id, startUrl: site.startUrl }
          }).then(function(resp) {
            window.close();
            if (!resp || !resp.success) fallbackPopup();
          }).catch(function() {
            window.close();
            fallbackPopup();
          });
        });
        row.appendChild(launch);

        var rm = document.createElement('button');
        rm.textContent = 'X';
        rm.className = 'pwa-remove';
        rm.title = 'Remove';
        rm.addEventListener('click', function() {
          loadSites().then(function(all) {
            all = all.filter(function(s) { return s.id !== site.id; });
            var data = {};
            data[PWA_KEY] = JSON.stringify(all);
            // Take the launcher entry with it. This button filters
            // storage.local directly, so the background's uninstall action
            // never runs for it, and a .desktop file left behind in
            // ~/.local/share/applications keeps launching an app the user
            // just removed. A missing pwa module is fine: it never wrote an
            // entry, so there is nothing to remove.
            try {
              browser.runtime.sendMessage({
                module: 'pwa',
                action: 'remove-entry',
                data: { site: site }
              }).catch(function() {});
            } catch (e) {}
            browser.storage.local.set(data).then(renderPWAs);
          });
        });
        row.appendChild(rm);

        pwaList.appendChild(row);
      });
    });
  }

  // "Create missing launcher entries" - the on-demand half of
  // DesktopEntry.reconcile, which otherwise only runs once at start-up.
  //
  // The button is only revealed once the pwa module has actually answered a
  // message, which is the same guard the rules sections use: an extension
  // page cannot ask "is the API there?", so it asks the thing that would work.
  // A build without USE=pwa has no listener and the message rejects, so the
  // button never appears rather than sitting there failing on click.
  var reconcileBtn = document.getElementById('pwa-reconcile');
  function revealReconcile() {
    if (!reconcileBtn) return;
    try {
      browser.runtime.sendMessage({ module: 'pwa', action: 'getAll' })
        .then(function(resp) {
          if (resp && resp.sites) reconcileBtn.hidden = false;
        })
        .catch(function() {});
    } catch (e) {}
  }

  if (reconcileBtn) {
    reconcileBtn.addEventListener('click', function() {
      var label = reconcileBtn.textContent;
      reconcileBtn.disabled = true;
      reconcileBtn.textContent = 'Working...';
      try {
        browser.runtime.sendMessage({ module: 'pwa', action: 'reconcile-entries' })
          .then(function(resp) {
            var n = resp && typeof resp.written === 'number' ? resp.written : 0;
            reconcileBtn.textContent = n
              ? 'Created ' + n + ' launcher ' + (n === 1 ? 'entry' : 'entries')
              : (resp && resp.skipped === 'disabled'
                  ? 'Turned off in about:config'
                  : 'Nothing was missing');
          })
          .catch(function(e) {
            reconcileBtn.textContent = 'Could not create entries: ' + e;
          });
      } catch (e) {
        reconcileBtn.textContent = 'Could not create entries: ' + e;
      }
      // Re-enable once the reply has been put on screen, so a slow or failed
      // pass is retryable rather than leaving a dead button behind.
      setTimeout(function() {
        reconcileBtn.disabled = false;
        if (reconcileBtn.textContent === 'Working...') {
          reconcileBtn.textContent = label;
        }
      }, 1500);
    });
  }

  renderPWAs();
  revealReconcile();

  // ── dynamic module UI loading ─────────────────────────────────────
  // Each section's script is loaded only when its module is present in
  // this build, by asking the thing that would work (the netiface
  // experiment API, a background message). A static <script> tag would
  // log a missing-resource error on every popup open for every module
  // the build does not carry.

  function loadScript(src, onerror) {
    var script = document.createElement('script');
    script.src = src;
    if (onerror) script.onerror = onerror;
    document.body.appendChild(script);
  }

  // User agent switcher (modules/user-agent/ua-ui.js): the section markup
  // is in this popup, between the QR section and the PWA section, and the
  // script that owns it lives in the user-agent module so it is absent from
  // a build without USE=user-agent.
  (function loadUaUI() {
    if (typeof browser === 'undefined' || !browser.runtime) {
      return;
    }
    browser.runtime.sendMessage({ action: 'user-agent:present' })
      .then(function(resp) {
        if (!resp || !resp.ok) return;
        loadScript('../user-agent/ua-ui.js');
      })
      .catch(function() {});
  })();

  // Per-URL interface rules (modules/netiface/urlrules-ui.js): guarded by
  // the netiface experiment API's presence, exactly as before - only the
  // section it renders is now the compact one, with the list in the modal.
  (function loadUrlRulesUI() {
    if (typeof browser === 'undefined' || !browser.rozelynxNetIface) {
      return;
    }
    loadScript('../netiface/urlrules-ui.js');
  })();

  // The sync panel (modules/sync/sync-ui.js), opened by the header button.
  // A build without USE=sync has no module to answer 'sync:present', so
  // the button explains itself instead of opening a dead panel.
  var syncBtn = document.getElementById('sync-btn');
  (function loadSyncUI() {
    if (typeof browser === 'undefined' || !browser.runtime || !syncBtn) {
      return;
    }
    browser.runtime.sendMessage({ action: 'sync:present' })
      .then(function(resp) {
        if (!resp || !resp.ok) {
          syncBtn.title = 'The sync module is not in this build';
          return;
        }
        syncBtn.addEventListener('click', function() {
          var panel = document.getElementById('sync-panel');
          if (!panel.hidden && panel.dataset.loaded === '1') {
            panel.hidden = !panel.hidden;
            return;
          }
          panel.hidden = false;
          if (panel.dataset.loaded === '1') return;
          loadScript('../sync/sync-ui.js', function() {
            panel.textContent =
              'The sync module UI failed to load in this build.';
          });
        });
      })
      .catch(function() {
        syncBtn.title = 'The sync module is not in this build';
      });
  })();
})();
