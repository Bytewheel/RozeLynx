// PWA Module for RozeLynx - Content Script
// Self-contained: detects PWA manifests, installs sites into extension storage,
// and launches them in popup windows. No background page required.
//
// Icons (v1.0.73+): installing harvests icons as a ranked LADDER - manifest
// icons first (raster before SVG, size nearest 192 first, 'monochrome'
// templates dropped), then the page's own favicon links (apple-touch-icon
// before a 16px rel=icon, which before /favicon.ico), re-encoding whatever
// won through a canvas to PNG before it is stored. A URL this script cannot
// read (a CDN that answers without CORS headers - a content script's fetch is
// bound by the PAGE's CORS) is kept in the site record as a candidate
// (iconCandidates), because the BACKGROUND page re-fetches candidates with
// the extension's own host permissions, which are not CORS-bound. That is
// how a favicon "listed" in the extension reaches the generated .desktop
// entry instead of leaving it blank or on the old logo fallback.

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

  // Manifest icon ranking, same shape as the background's copy: raster
  // before SVG (a canvas renders SVG, but gdk-pixbuf needs an rsvg loader
  // that is not universal, so PNG is what reaches every consumer), sizes
  // parsed per WxH token (icons may list several), width governing, and
  // 'monochrome' purpose entries dropped - they are tinting templates, not
  // art. src stays unresolved here; the ladder resolves it against the
  // manifest URL, which is what the manifest spec prescribes.
  function rankIconEntries(icons, preferredSize) {
    preferredSize = preferredSize || 192;
    var out = [];
    (icons || []).forEach(function(icon) {
      if (!icon || !icon.src) return;
      var purpose = String(icon.purpose || 'any').toLowerCase();
      if (purpose.split(/\s+/).indexOf('monochrome') >= 0) return;
      var type = String(icon.type || '').toLowerCase().split(';')[0].trim();
      var svg = type === 'image/svg+xml' || /\.svgz?([?#]|$)/i.test(String(icon.src));
      var sizes = [];
      String(icon.sizes || '').trim().split(/\s+/).forEach(function(tok) {
        var m = /^(\d+)[xX](\d+)$/.exec(tok);
        if (m) sizes.push(parseInt(m[1], 10));
      });
      var size = sizes.length ? Math.max.apply(null, sizes) : (svg ? preferredSize : 16);
      out.push({ src: String(icon.src), svg: svg, size: size });
    });
    out.sort(function(a, b) {
      if (a.svg !== b.svg) return a.svg ? 1 : -1;
      return Math.abs(a.size - preferredSize) - Math.abs(b.size - preferredSize);
    });
    return out;
  }

  // The page's own favicon links, in the same preference order: the
  // apple-touch-icon is usually 180x180 PNG (the best favicon-class art a
  // page offers), an explicit rel=icon with sizes next, then anything
  // un-sized (16px-ish). rel~="icon" matches the ICON token only, so the
  // apple-touch tokens are queried for explicitly; mask-icon (a monochrome
  // tint template) is skipped by token on purpose.
  function faviconLinkCandidates() {
    var out = [];
    var links = [];
    try {
      links = Array.prototype.slice.call(document.querySelectorAll(
        'link[rel~="icon"], link[rel~="apple-touch-icon"], ' +
        'link[rel~="apple-touch-icon-precomposed"]'));
    } catch (e) {
      return out;
    }
    links.forEach(function(link) {
      if (!link.href) return;
      var rel = String(link.getAttribute('rel') || '').toLowerCase().split(/\s+/);
      if (rel.indexOf('mask-icon') >= 0) return;
      var sizes = [];
      String(link.getAttribute('sizes') || '').trim().toLowerCase().split(/\s+/)
        .forEach(function(tok) {
          var m = /^(\d+)[xX](\d+)$/.exec(tok);
          if (m) sizes.push(parseInt(m[1], 10));
        });
      var type = String(link.type || '').toLowerCase();
      var svg = type === 'image/svg+xml' || /\.svgz?([?#]|$)/i.test(String(link.href));
      out.push({
        src: String(link.href),
        svg: svg,
        size: sizes.length ? Math.max.apply(null, sizes) : (svg ? 192 : 16),
      });
    });
    out.sort(function(a, b) {
      if (a.svg !== b.svg) return a.svg ? 1 : -1;
      return b.size - a.size;
    });
    return out;
  }

  // Re-encode an image data: URL as PNG through a canvas: SVG and WebP
  // become PNG here (which every gdk-pixbuf build loads), odd sizes land
  // on a square canvas so a launcher makes no aspect-ratio decision, and
  // small favicons are upscaled smoothly instead of nearest-neighbour in a
  // taskbar. A stored PNG passes through untouched - cheaper than a redraw.
  // Answers null for anything this context cannot decode; the ladder keeps
  // the URL as a candidate for the background instead of storing art a
  // .desktop consumer cannot load.
  async function normalizeIconDataUrl(dataUrl) {
    if (!dataUrl || String(dataUrl).indexOf('data:') !== 0) return null;
    if (/^data:image\/png[;,]/i.test(String(dataUrl))) return String(dataUrl);
    try {
      var img = new Image();
      var loaded = new Promise(function(resolve, reject) {
        img.onload = function() { resolve(); };
        img.onerror = function() { reject(new Error('decode failed')); };
      });
      img.src = dataUrl;
      await loaded;
      var nw = img.naturalWidth;
      var nh = img.naturalHeight;
      // An SVG with no intrinsic size answers 0x0 and cannot be drawn.
      if (!nw || !nh) return null;
      var side = Math.max(128, Math.min(256, Math.max(nw, nh)));
      var scale = side / Math.max(nw, nh);
      var dw = Math.max(1, Math.round(nw * scale));
      var dh = Math.max(1, Math.round(nh * scale));
      var canvas = document.createElement('canvas');
      canvas.width = side;
      canvas.height = side;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(img, Math.round((side - dw) / 2), Math.round((side - dh) / 2), dw, dh);
      var out = canvas.toDataURL('image/png');
      return /^data:image\/png[;,]/i.test(out) ? out : null;
    } catch (e) {
      return null;
    }
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
      // A CDN without CORS response headers refuses a content script's
      // fetch; the URL goes back to the ladder as a candidate, because the
      // background page can read exactly what this one cannot.
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

      // The icon ladder (see the file header): manifest icons ranked, then
      // the page's favicon links, then the classic /favicon.ico - the first
      // one that both FETCHES and NORMALLY TO PNG wins. A URL that could not
      // be read (CORS) or could not be re-encoded (this page's canvas cannot
      // decode it) is kept as a candidate for the background page, which
      // re-fetches candidates under host permissions and re-encodes through
      // its own canvas. No winner at all means icon:null and a candidates
      // list - still not a dead end, because materialiseIcon works the same
      // ladder from the background and answers the packaged fallback art.
      var candidates = rankIconEntries(manifest.icons, 192)
        .concat(faviconLinkCandidates());
      var seen = {};
      candidates = candidates.filter(function(c) {
        return c && c.src && !seen[c.src] && (seen[c.src] = true);
      });
      try {
        candidates.push({ src: new URL('/favicon.ico', info.url).href, size: 32, svg: false });
      } catch (rootErr) {}
      var iconDataUrl = null;
      var iconCandidates = [];
      for (var ci = 0; ci < candidates.length && !iconDataUrl; ci++) {
        var cand = candidates[ci];
        // Manifest src resolves against the manifest URL (the spec's base),
        // favicon links are already absolute (link.href).
        var srcAbs = resolveUrl(cand.src, manifestUrl);
        var fetched = await fetchIconDataUrl(srcAbs);
        if (!fetched) {
          iconCandidates.push(srcAbs);
          continue;
        }
        var png = await normalizeIconDataUrl(fetched);
        if (png) {
          iconDataUrl = png;
        } else {
          iconCandidates.push(srcAbs);
        }
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
        // Only kept while nothing won: the list exists for the background
        // retry, not as a record of what was tried.
        iconCandidates: iconDataUrl ? [] : iconCandidates.slice(0, 8),
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
