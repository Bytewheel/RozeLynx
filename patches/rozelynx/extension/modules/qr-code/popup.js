// QR Code Popup Script
(function() {
  'use strict';

  var canvas = document.getElementById('qr-canvas');
  var loading = document.getElementById('loading');
  var error = document.getElementById('error');
  var urlDisplay = document.getElementById('url-display');
  var copyBtn = document.getElementById('copy-btn');

  function showError(msg) {
    loading.style.display = 'none';
    error.style.display = 'block';
    error.textContent = msg;
  }

  function showQR(dataURL, url) {
    loading.style.display = 'none';
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

  browser.tabs.query({ active: true, currentWindow: true }).then(function(tabs) {
    if (!tabs || tabs.length === 0) {
      showError('No active tab');
      return;
    }
    var url = tabs[0].url;
    var title = tabs[0].title;

    if (!url || url.startsWith('about:') || url.startsWith('moz-extension:')) {
      showError('Cannot generate QR code for this page');
      return;
    }

    generateQR(url);
  }).catch(function() {
    showError('Could not access tab');
  });

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

  copyBtn.addEventListener('click', function() {
    browser.tabs.query({ active: true, currentWindow: true }).then(function(tabs) {
      navigator.clipboard.writeText(tabs[0].url).then(function() {
        copyBtn.textContent = 'Copied!';
        setTimeout(function() { copyBtn.textContent = 'Copy URL'; }, 1500);
      }).catch(function() {
        copyBtn.textContent = 'Copy failed';
        setTimeout(function() { copyBtn.textContent = 'Copy URL'; }, 1500);
      });
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
  // message, which is the same guard the urlrules section uses: an extension
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

  // Per-URL interface rules editor (modules/netiface/urlrules-ui.js), appended
  // to this popup as the collapsible section under "Installed Apps".
  //
  // Loaded dynamically and only when the netiface experiment API exists: that
  // module is not in the XPI at all on a build without USE=net-iface, so a
  // static <script src> tag would log a missing-resource error every time the
  // popup was opened. The editor's own guard is a second line of defence for an
  // older extension whose parent API predates the rule functions.
  (function loadUrlRulesUI() {
    if (typeof browser === 'undefined' || !browser.rozelynxNetIface) {
      return;
    }
    var script = document.createElement('script');
    script.src = '../netiface/urlrules-ui.js';
    script.onerror = function() {
      // Nothing to show: the section stays hidden.
    };
    document.body.appendChild(script);
  })();

  // Download hand-off handler editor
  // (modules/downloads-handoff/handlers-ui.js), appended as the collapsible
  // section under the URL-rules one.
  //
  // The guard here is a MESSAGE, not an API presence check, and that is a
  // deliberate difference from the loader above. The netiface editor can ask
  // "is browser.rozelynxNetIface there?" because the experiment API exists
  // independently of whether its module was assembled. The hand-off module
  // has no such marker: it is a background script, so the only honest test is
  // whether anything answers one of its messages. A rejected sendMessage means
  // the module is not in this build, and the section stays hidden.
  (function loadHandoffUI() {
    if (typeof browser === 'undefined' || !browser.runtime) {
      return;
    }
    browser.runtime.sendMessage({ action: 'downloads-handoff:handlers' })
      .then(function() {
        var script = document.createElement('script');
        script.src = '../downloads-handoff/handlers-ui.js';
        script.onerror = function() {
          // Nothing to show: the section stays hidden.
        };
        document.body.appendChild(script);
      })
      .catch(function() {
        // No downloads-handoff module in this build.
      });
  })();
})();
