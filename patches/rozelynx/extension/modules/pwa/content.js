// PWA Module for RozeLynx - Content Script
// Self-contained: detects PWA manifests, installs sites into extension storage,
// and launches them in popup windows. No background page required.

(function() {
  'use strict';

  var STORAGE_KEY = 'rozelynx_pwa_sites';

  function detectPWA() {
    var manifestLink = document.querySelector('link[rel="manifest"]');
    if (!manifestLink || !manifestLink.href) return null;

    var themeColor = document.querySelector('meta[name="theme-color"]');

    return {
      manifestUrl: manifestLink.href,
      themeColor: themeColor ? themeColor.content : null,
      appName: document.title,
      url: window.location.href,
      hasSW: 'serviceWorker' in navigator,
    };
  }

  function simpleHash(str) {
    var hash = 0;
    for (var i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  function resolveUrl(url, base) {
    try {
      return new URL(url, base).href;
    } catch (e) {
      return url;
    }
  }

  async function fetchManifest(url) {
    var response = await fetch(url);
    if (!response.ok) return null;
    return await response.json();
  }

  function findBestIcon(icons, preferredSize) {
    preferredSize = preferredSize || 192;
    if (!icons || icons.length === 0) return null;
    var best = null;
    var bestDiff = Infinity;
    icons.forEach(function(icon) {
      var sizes = [];
      if (icon.sizes) {
        sizes = icon.sizes.split(/\s+/).map(function(s) {
          return parseInt(s.split('x')[0]);
        }).filter(function(n) { return !isNaN(n); });
      }
      sizes.forEach(function(size) {
        var diff = Math.abs(size - preferredSize);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = icon;
        }
      });
    });
    return best || icons[0];
  }

  async function fetchIconDataUrl(iconUrl) {
    try {
      var response = await fetch(iconUrl);
      if (!response.ok) return null;
      var blob = await response.blob();
      return await new Promise(function(resolve) {
        var reader = new FileReader();
        reader.onloadend = function() { resolve(reader.result); };
        reader.onerror = function() { resolve(null); };
        reader.readAsDataURL(blob);
      });
    } catch (e) {
      return null;
    }
  }

  async function loadSites() {
    try {
      var stored = await browser.storage.local.get(STORAGE_KEY);
      if (stored[STORAGE_KEY]) {
        return JSON.parse(stored[STORAGE_KEY]);
      }
    } catch (e) {}
    return [];
  }

  async function saveSites(sites) {
    try {
      var data = {};
      data[STORAGE_KEY] = JSON.stringify(sites);
      await browser.storage.local.set(data);
      return true;
    } catch (e) {
      console.error('[RozeLynx PWA] Failed to save sites:', e);
      return false;
    }
  }

  async function installPWA(info, btn) {
    try {
      var manifestUrl = resolveUrl(info.manifestUrl, info.url);
      var manifest = await fetchManifest(manifestUrl);

      if (!manifest || (!manifest.name && !manifest.short_name)) {
        throw new Error('Invalid manifest');
      }

      var name = manifest.name || manifest.short_name || 'Untitled App';
      var startUrl = resolveUrl(manifest.start_url || '/', info.url);
      var scope = resolveUrl(manifest.scope || '/', info.url);

      var bestIcon = findBestIcon(manifest.icons, 192);
      var iconDataUrl = null;
      if (bestIcon) {
        iconDataUrl = await fetchIconDataUrl(resolveUrl(bestIcon.src, info.url));
      }

      var siteId = 'pwa-' + simpleHash(startUrl).toString(36);
      var site = {
        id: siteId,
        name: name,
        shortName: manifest.short_name || name,
        description: manifest.description || '',
        startUrl: startUrl,
        scope: scope,
        display: manifest.display || 'standalone',
        themeColor: manifest.theme_color || info.themeColor || '#8B5CF6',
        backgroundColor: manifest.background_color || '#FFFFFF',
        icon: iconDataUrl,
        installedAt: Date.now(),
        lastUsed: Date.now(),
      };

      var sites = await loadSites();
      var existing = sites.findIndex(function(s) { return s.id === siteId; });
      if (existing >= 0) {
        sites[existing] = Object.assign({}, sites[existing], site);
      } else {
        sites.push(site);
      }
      var saved = await saveSites(sites);
      if (!saved) throw new Error('Storage unavailable');

      // Materialise the launcher entry for this site. This function is the
      // LIVE install path: the background's own PWAManager.install has no
      // caller in the extension at all, so until now installing a PWA wrote
      // the site record and nothing else - no .desktop file, which left the
      // whole --ssb launch path (profile pin, StartupWMClass, URL marker)
      // with nothing on disk to act on.
      //
      // Failure here must not fail the install: the app is installed and
      // launchable from the extension popup either way, so the error is
      // swallowed (the background has already logged it to its own diag key).
      try {
        await sendToBackground({
          module: 'pwa',
          action: 'write-entry',
          data: { site: site }
        }, 3);
      } catch (entryErr) {}

      return site;
    } catch (e) {
      throw e;
    }
  }

  function urlInScope(url, scope) {
    try {
      var u = new URL(url);
      var s = new URL(scope);
      if (u.origin !== s.origin) return false;
      var up = u.pathname;
      var sp = s.pathname;
      if (!sp || sp === '/') return true;
      if (up === sp) return true;
      if (sp[sp.length - 1] === '/') return up.indexOf(sp) === 0;
      return up.indexOf(sp + '/') === 0;
    } catch (e) {
      return false;
    }
  }

  function findInstalledSite(sites, url) {
    var clean = stripPwaMarker(url);
    for (var i = 0; i < sites.length; i++) {
      var s = sites[i];
      var scope = s.scope || s.startUrl;
      if (scope && urlInScope(clean, scope)) return s;
      if (s.startUrl && urlInScope(clean, s.startUrl)) return s;
    }
    return null;
  }

  function hasPwaMarker(url) {
    return /[#&]rozelynx-pwa=1/.test(url || '');
  }

  function stripPwaMarker(url) {
    if (!url) return url;
    return url.replace(/[#&]rozelynx-pwa=1/, '');
  }

  function appendPwaMarker(url) {
    var sep = url.indexOf('#') >= 0 ? '&' : '#';
    if (url.slice(-1) === '#') sep = '';
    return url + sep + 'rozelynx-pwa=1';
  }

  function createInstallButton(info) {
    if (document.getElementById('rozelynx-pwa-install-btn')) return;

    var btn = document.createElement('div');
    btn.id = 'rozelynx-pwa-install-btn';
    btn.textContent = 'Install App';
    btn.style.cssText =
      'position: fixed; top: 12px; right: 12px; z-index: 2147483646;' +
      'background: #8B5CF6; color: white; padding: 8px 16px;' +
      'border-radius: 6px; font-family: -apple-system, sans-serif;' +
      'font-size: 13px; font-weight: 500; cursor: pointer;' +
      'box-shadow: 0 2px 8px rgba(139, 92, 246, 0.4);' +
      'transition: opacity 0.2s;';

    btn.addEventListener('mouseover', function() { btn.style.opacity = '0.9'; });
    btn.addEventListener('mouseout', function() { btn.style.opacity = '1'; });

    btn.addEventListener('click', async function() {
      btn.textContent = 'Installing...';
      btn.style.opacity = '0.7';

      try {
        await installPWA(info, btn);
        btn.textContent = 'App Installed!';
        btn.style.background = '#059669';
        setTimeout(function() { btn.remove(); }, 3000);
      } catch (e) {
        btn.textContent = 'Install Failed: ' + (e.message || 'unknown');
        btn.style.background = '#DC2626';
        setTimeout(function() {
          btn.textContent = 'Install App';
          btn.style.background = '#8B5CF6';
          btn.style.opacity = '1';
        }, 3000);
      }
    });

    document.body.appendChild(btn);

    setTimeout(function() {
      if (btn.textContent === 'Install App') {
        btn.style.transition = 'opacity 0.5s';
        btn.style.opacity = '0';
        setTimeout(function() { btn.remove(); }, 500);
      }
    }, 10000);
  }

  function createOpenButton(site) {
    if (document.getElementById('rozelynx-pwa-open-btn')) return;

    var btn = document.createElement('div');
    btn.id = 'rozelynx-pwa-open-btn';
    btn.textContent = 'Open in App';
    btn.style.cssText =
      'position: fixed; top: 12px; right: 12px; z-index: 2147483646;' +
      'background: #059669; color: white; padding: 8px 16px;' +
      'border-radius: 6px; font-family: -apple-system, sans-serif;' +
      'font-size: 13px; font-weight: 500; cursor: pointer;' +
      'box-shadow: 0 2px 8px rgba(5, 150, 105, 0.4);';

    btn.addEventListener('click', function() {
      var diag = document.createElement('div');
      diag.id = 'rozelynx-pwa-diag';
      diag.style.cssText = 'position:fixed;left:-9999px;top:0;';
      document.body.appendChild(diag);
      var report = function(msg) {
        try {
          diag.textContent = (diag.textContent ? diag.textContent + '|' : '') + JSON.stringify(msg);
        } catch (e) {}
      };

      var opened = false;
      var fallbackOpen = function() {
        if (opened) return;
        opened = true;
        try {
          // Last resort: a content-script window.open cannot create a popup
          // window type, so mark the URL; the install/open button will at
          // least not be shown inside this window.
          window.open(appendPwaMarker(site.startUrl), '_blank', 'width=1280,height=800,noopener');
          report({ fallback: true, url: site.startUrl });
        } catch (e2) {
          report({ fallback: false, error: String(e2) });
        }
      };

      try {
        sendToBackground({
          module: 'pwa',
          action: 'launch',
          data: { siteId: site.id, startUrl: site.startUrl }
        }, 6).then(function(resp) {
          report({ resp: resp });
          if (!resp || !resp.success) fallbackOpen();
        }).catch(function(e) {
          report({ sendError: String(e) });
          fallbackOpen();
        });
      } catch (e) {
        report({ sendThrow: String(e) });
        fallbackOpen();
      }
      btn.remove();
    });

    document.body.appendChild(btn);

    setTimeout(function() {
      if (btn.textContent === 'Open in App') {
        btn.style.transition = 'opacity 0.5s';
        btn.style.opacity = '0';
        setTimeout(function() { btn.remove(); }, 500);
      }
    }, 10000);
  }

  function sendToBackground(msg, retries) {
    retries = retries || 0;
    try {
      return browser.runtime.sendMessage(msg).catch(function(e) {
        var msgStr = String(e);
        if (retries > 0 && (msgStr.indexOf('Could not establish') >= 0 || msgStr.indexOf('receiving end') >= 0)) {
          // Event-page background may be asleep: retry with growing delay.
          var delay = 400 + (6 - retries) * 300;
          return new Promise(function(res) {
            setTimeout(function() {
              sendToBackground(msg, retries - 1).then(res, res);
            }, delay);
          });
        }
        throw e;
      });
    } catch (e) {
      return Promise.reject(e);
    }
  }

  function isPopupWindow() {
    return sendToBackground({
      module: 'pwa',
      action: 'is-popup'
    }, 3).then(function(resp) {
      return !!(resp && resp.isPopup);
    }).catch(function() {
      return false;
    });
  }

  async function maybeShowInstallButton(info) {
    // Pages inside PWA windows carry the URL marker; the marker check is
    // background-independent (works even when the event page is asleep).
    if (hasPwaMarker(info.url)) return;

    var inAppWindow = false;
    try {
      inAppWindow = await isPopupWindow();
    } catch (e) {}
    if (inAppWindow) return;

    var installed = null;
    try {
      var sites = await loadSites();
      installed = findInstalledSite(sites, info.url);
    } catch (e) {}
    if (installed) {
      createOpenButton(installed);
    } else {
      createInstallButton(info);
    }
  }

  var info = detectPWA();
  if (info) {
    maybeShowInstallButton(info);
  }
})();
