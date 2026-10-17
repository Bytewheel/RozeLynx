// Mouse Gestures - Content Script
// Self-contained: captures RMB gestures, draws trail, executes actions locally,
// and provides a context-aware custom context menu with light/dark theming.

(function() {
  'use strict';

  var MIN_DIST = 15;
  var DIAGONAL_THRESHOLD = 0.4;
  var ENABLED_STORAGE_KEY = 'rozelynx_gestures_enabled';

  var DEFAULT_GESTURES = {
    'RL': 'back',
    'LR': 'forward',
    'UD': 'reload',
    'DU': 'stop',
    'DR': 'close_tab',
    'UR': 'new_tab',
    'UL': 'scroll_top',
    'DL': 'scroll_bottom',
    'RDL': 'close_tab',
    'LDR': 'reopen_tab',
    'ULDR': 'new_window',
    'URDL': 'new_private_window',
    'UDU': 'duplicate_tab',
    'DUD': 'toggle_pin_tab',
    'RUD': 'next_tab',
    'LUD': 'previous_tab',
    'U': 'page_up',
    'D': 'page_down',
  };

  var tracking = false;
  var points = [];
  var directions = [];
  var lastX = 0;
  var lastY = 0;
  var trailCanvas = null;
  var enabled = true;
  var lastRmbDown = 0;
  var rmbDownSeen = false;
  var lastContextTarget = null;
  var lastContextX = 0;
  var lastContextY = 0;
  var ctxSeen = false;
  var ctxIsMedia = false;
  var pageHandledContext = false;
  // tri-state: null = not answered yet, true/false = netiface module present
  var netifaceAvailable = null;
  // Security settings for THIS window, from the pwa module's
  // security-state action. null = not answered yet, not a PWA window, or
  // no pwa module / security API in this build - every one of those
  // means the menu grows no Security section.
  var securitySettings = null;

  function markCtx(msg) {
    try {
      var el = document.documentElement || document.body;
      if (!el) return;
      var prev = el.getAttribute('data-rx-ctx') || '';
      el.setAttribute('data-rx-ctx', (prev ? prev + '>' : '') + msg);
    } catch (e) {}
  }

  // "Open ... in New Tab" menu items route through the background so they
  // honour the about:preferences "switch to it immediately" checkbox
  // (browser.tabs.loadInBackground). A content-script window.open would be
  // diverted per browser.tabs.loadDivertedInBackground (default false) and
  // always switch tabs. Falls back to window.open if the background is down.
  function openInNewTab(url) {
    browser.runtime.sendMessage({
      module: 'mouse-gestures',
      action: 'openTab',
      data: { url: url }
    }).then(function(resp) {
      if (!resp || !resp.ok) window.open(url, '_blank');
    }).catch(function() {
      window.open(url, '_blank');
    });
  }

  // "Open ... in New Window" menu items route through the background so a
  // window opened from a PWA/SSB window is always a plain non-PWA window and
  // the PWA window is left untouched. Falls back to window.open if the
  // background is down.
  function openInNewWindow(url) {
    browser.runtime.sendMessage({
      module: 'mouse-gestures',
      action: 'openWindow',
      data: { url: url }
    }).then(function(resp) {
      if (!resp || !resp.ok) window.open(url, '_blank', 'noopener,noreferrer');
    }).catch(function() {
      window.open(url, '_blank', 'noopener,noreferrer');
    });
  }

  var gestures = Object.assign({}, DEFAULT_GESTURES);

  function getDirection(angle) {
    if (angle >= -45 && angle < 45) return 'R';
    if (angle >= 45 && angle < 135) return 'U';
    if (angle >= -135 && angle < -45) return 'D';
    return 'L';
  }

  function getDiagonalDirection(angle) {
    if (angle >= 0 && angle < 90) return 'UR';
    if (angle >= 90 && angle <= 180) return 'UL';
    if (angle >= -90 && angle < 0) return 'DR';
    return 'DL';
  }

  function addPoint(x, y) {
    points.push({ x: x, y: y });

    if (lastX === 0 && lastY === 0) {
      lastX = x;
      lastY = y;
      return;
    }

    var dx = x - lastX;
    var dy = y - lastY;
    var dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < MIN_DIST) return;

    var angle = Math.atan2(-dy, dx) * (180 / Math.PI);
    var direction = getDirection(angle);

    var adx = Math.abs(dx);
    var ady = Math.abs(dy);
    if (adx > DIAGONAL_THRESHOLD * dist && ady > DIAGONAL_THRESHOLD * dist) {
      direction = getDiagonalDirection(angle);
    }

    if (directions.length === 0 || directions[directions.length - 1] !== direction) {
      directions.push(direction);
    }

    lastX = x;
    lastY = y;
  }

  function reset() {
    tracking = false;
    points = [];
    directions = [];
    lastX = 0;
    lastY = 0;
    lastContextTarget = null;
  }

  function getGesture() {
    return directions.join('');
  }

  function hasMovement() {
    return directions.length > 0;
  }

  function showTrail() {
    if (!trailCanvas) {
      trailCanvas = document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
      trailCanvas.id = 'rozelynx-gesture-trail';
      trailCanvas.style.cssText =
        'position:fixed;top:0;left:0;width:100%;height:100%;' +
        'pointer-events:none;z-index:2147483647;display:none;';
      document.documentElement.appendChild(trailCanvas);
    }
    trailCanvas.width = window.innerWidth;
    trailCanvas.height = window.innerHeight;
    trailCanvas.style.display = 'block';
  }

  function hideTrail() {
    if (trailCanvas) {
      var ctx = trailCanvas.getContext('2d');
      ctx.clearRect(0, 0, trailCanvas.width, trailCanvas.height);
      trailCanvas.style.display = 'none';
    }
  }

  function drawTrail() {
    if (!trailCanvas || points.length < 2) return;
    var ctx = trailCanvas.getContext('2d');
    var color = '#8B5CF6';

    ctx.clearRect(0, 0, trailCanvas.width, trailCanvas.height);
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (var i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();

    var last = points[points.length - 1];
    ctx.shadowBlur = 0;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(last.x, last.y, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  async function loadConfig() {
    try {
      var stored = await browser.storage.local.get([ENABLED_STORAGE_KEY, 'rozelynx_gestures']);
      if (stored[ENABLED_STORAGE_KEY] !== undefined) {
        enabled = stored[ENABLED_STORAGE_KEY];
      }
      if (stored.rozelynx_gestures) {
        gestures = Object.assign({}, DEFAULT_GESTURES, stored.rozelynx_gestures);
      }
    } catch(e) {
      enabled = true;
    }
  }

  function isEditableTarget(el) {
    if (!el) return false;
    return el.isContentEditable ||
      el.tagName === 'INPUT' ||
      el.tagName === 'TEXTAREA' ||
      el.tagName === 'SELECT';
  }

  // Actions that can be executed directly in the page
  function executeLocal(action, gesture) {
    switch (action) {
      case 'back':
        window.history.back();
        return true;
      case 'forward':
        window.history.forward();
        return true;
      case 'reload':
        window.location.reload();
        return true;
      case 'stop':
        window.stop();
        return true;
      case 'scroll_top':
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return true;
      case 'scroll_bottom':
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
        return true;
      case 'page_up':
        window.scrollBy({ top: -window.innerHeight * 0.8, behavior: 'smooth' });
        return true;
      case 'page_down':
        window.scrollBy({ top: window.innerHeight * 0.8, behavior: 'smooth' });
        return true;
      case 'new_tab':
        window.open('about:newtab', '_blank');
        return true;
      case 'duplicate_tab':
        window.open(window.location.href, '_blank');
        return true;
      case 'close_tab':
        window.close();
        return true;
      default:
        return false;
    }
  }

  // =========================================================================
  // Custom in-page context menu. The native menu opens on RMB *press* on
  // GTK/Linux, and a synthetic contextmenu event cannot reopen it in this
  // Firefox build, so on plain right-click (no gesture) we show this menu
  // with the actions that can be executed from the page.
  // =========================================================================
  var customMenu = null;


  function closeCustomMenu() {
    if (!customMenu) return;
    customMenu.remove();
    customMenu = null;
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function() {
        fallbackCopy(text);
      });
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-999px;left:-999px;';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    } catch (e) {}
  }

  // A data: URL names no file at all, and the picker needs a suggested name
  // to prefill, so derive one from the MIME type the URL itself carries. The
  // list is a whitelist rather than a split on '/' because a suggested name is
  // passed straight to the download machinery and must never be a page-chosen
  // string; anything unrecognised prefill nothing and lets the picker default.
  var DATA_URL_NAMES = {
    'image/png': 'image.png',
    'image/jpeg': 'image.jpg',
    'image/gif': 'image.gif',
    'image/webp': 'image.webp',
    'image/svg+xml': 'image.svg',
    'image/bmp': 'image.bmp',
    'video/webm': 'video.webm',
    'video/mp4': 'video.mp4',
    'audio/webm': 'audio.webm',
    'audio/ogg': 'audio.ogg',
    'audio/mpeg': 'audio.mp3',
  };

  // "Save ... As..." for links, images and media. The Save dialog and the
  // download behind it are browser chrome, so the whole entry point is a
  // message to the background, whose downloads.download({saveAs:true})
  // brings up the browser's own file picker.
  //
  // The previous implementation appended a synthetic <a download> to the page
  // and clicked it, and never worked. Downloads-handoff's capture-phase click
  // hook (modules/downloads-handoff/content.js) treats any anchor carrying a
  // download attribute as a hand-off candidate: it eats the click, and - with
  // no manager configured, the default - "restores" it as location.assign(),
  // a navigation, so "Save Image As..." navigated the tab to the image and
  // saved nothing. Even a click the hook never saw was wrong twice: it
  // honoured the download attribute only for same-origin URLs (hence the old
  // isSameOrigin() gates, which hid the entries for most images on the web),
  // and it was a silent drop into the download folder, never a "Save As"
  // dialog at all.
  //
  // The background route fixes both at once: downloads.download issues the
  // request with the target URL's own cookie jar (cookieJarSettings.
  // initWithURI in ext-downloads.js), so cross-origin and authenticated
  // images save the way the native context menu saves them, and the
  // mouse-gestures module is below in this same file's menu, never a page
  // anchor, so no click hook can mistake it for a candidate again.
  function saveAs(src) {
    var filename = '';
    try {
      var u = new URL(src, document.baseURI);
      if (u.protocol === 'data:') {
        var mime = /^data:([^;,]+)/i.exec(src);
        filename = (mime && DATA_URL_NAMES[mime[1].toLowerCase()]) || '';
      }
    } catch (e) {}
    var msg = { module: 'mouse-gestures', action: 'saveAs', data: { url: src } };
    if (filename) msg.data.filename = filename;
    browser.runtime.sendMessage(msg).then(function(resp) {
      if (resp && resp.ok) return;
      var err = (resp && resp.error) || 'no answer from the background';
      // A cancelled picker is the user's own decision, not a failure to
      // report: the API rejects with exactly this message on cancel.
      if (!/cancel/i.test(err)) showToast('Save As failed: ' + err);
    }).catch(function() {
      showToast('Save As needs the RozeLynx background');
    });
  }

  function copyImage(img) {
    var src = img.currentSrc || img.src;
    if (!src) return;
    fetch(src, { mode: 'cors', credentials: 'include' }).then(function(resp) {
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return resp.blob();
    }).then(async function(blob) {
      if (blob.type && blob.type.indexOf('image/') === 0 &&
          blob.type !== 'image/svg+xml') {
        try {
          await navigator.clipboard.write([new ClipboardItem((function() {
            var o = {}; o[blob.type] = blob; return o;
          })())]);
          showToast('Image copied');
          return;
        } catch (e) {}
      }
      var bmp = await createImageBitmap(blob);
      var canvas = document.createElement('canvas');
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      canvas.getContext('2d').drawImage(bmp, 0, 0);
      var png = await new Promise(function(res) { canvas.toBlob(res, 'image/png'); });
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      showToast('Image copied');
    }).catch(function() {
      showToast('Could not copy image (cross-origin?)');
    });
  }

  function openExternal(url) {
    window.location.href = 'rozelynx-ext:' + encodeURIComponent(url);
  }

  function getExternalUrl() {
    if (getMenuContext() === 'link') {
      var link = lastContextTarget && lastContextTarget.closest
        ? lastContextTarget.closest('a[href]') : null;
      if (link && link.href) return link.href;
    }
    return window.location.href;
  }

  // Bridge helpers: open a tiny extension page that performs privileged
  // work (bookmarks, tab capture, devtools) and closes itself.
  function openBridge(page, params) {
    var u = browser.runtime.getURL('modules/mouse-gestures/' + page) +
      (page.indexOf('?') >= 0 ? '&' : '?') + params;
    window.open(u, '_blank', 'popup,width=120,height=80');
  }

  function toggleBookmark(url, title, starBtn) {
    var wasOn = starBtn.classList.contains('rx-star-on');
    starBtn.classList.toggle('rx-star-on', !wasOn);
    openBridge('bookmark.html',
      'url=' + encodeURIComponent(url) + '&title=' + encodeURIComponent(title));
  }

  function takeScreenshot() {
    openBridge('shot.html', 'src=' + encodeURIComponent(window.location.href));
    setTimeout(function() {
      browser.storage.local.get('rozelynx_shot_result').then(function(stored) {
        var r = stored.rozelynx_shot_result;
        if (!r) return;
        try {
          document.documentElement.setAttribute('data-rx-shot-result',
            (r.ok ? 'ok:' : 'fail:') + r.msg);
        } catch (e) {}
        if (!r.ok) showToast('Screenshot failed: ' + (r.msg || 'unknown'));
        else showToast('Screenshot saved');
      }).catch(function() {});
    }, 2500);
  }

  // The bridge page can leave four distinct 'error:...' strings, and they
  // have four different causes, so each one gets its own message.  The raw
  // result is always mirrored onto <html data-rx-dt-result> and kept in
  // storage.local, so about:debugging still carries the exact string.
  var DT_ERROR_TEXT = {
    'error:no src': 'Inspect: the page URL was not available',
    'error:no api': 'Inspect: this build has no DevTools experiment API',
    'error:not opened': 'Inspect: DevTools did not open the toolbox'
  };
  function dtErrorText(result) {
    if (DT_ERROR_TEXT[result]) return DT_ERROR_TEXT[result];
    // 'error:<message>' carries the real reason from the experiment API.
    return 'Inspect failed: ' + result.replace(/^error:/, '');
  }

  function openDevtoolsBridge(mode, targetEl) {
    var mark = '';
    if (targetEl && targetEl.nodeType === 1) {
      mark = 'rx' + Math.random().toString(36).slice(2, 10);
      targetEl.setAttribute('data-rozelynx-inspect', mark);
    }
    // The stored result is never cleared, so a bridge page that fails to open
    // (blocked popup, window.open refused) would leave the *previous*
    // attempt's result behind and toast that instead of this one.  The bridge
    // stamps every result with 'at'; a result older than this attempt is not
    // about this attempt, so say nothing rather than the wrong thing.
    var startedAt = Date.now();
    openBridge('devtools-bridge.html',
      'mode=' + mode + '&src=' + encodeURIComponent(window.location.href) +
      '&mark=' + encodeURIComponent(mark));
    setTimeout(function() {
      browser.storage.local.get('rozelynx_dt_result').then(function(stored) {
        var r = stored.rozelynx_dt_result;
        if (!r) return;
        if (typeof r.at === 'number' && r.at < startedAt) return;
        try {
          document.documentElement.setAttribute('data-rx-dt-result', r.result);
        } catch (e) {}
        if (r.result && r.result.indexOf('error') === 0) {
          showToast(dtErrorText(r.result), 6000);
        }
      }).catch(function() {});
    }, 2500);
  }

  // -------------------------------------------------------------------------
  // Theming: CSS variables switched by .rozelynx-dark on the menu root.
  // Dark triggers: OS prefers-color-scheme, or Dark Reader's
  // data-darkreader-scheme attribute on <html>. Re-themes an open menu live.
  // -------------------------------------------------------------------------
  var menuStyleEl = null;

  var ICON_SHOT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>';
  var ICON_RELOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>';
  var ICON_STAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>';
  var ICON_BACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>';
  var ICON_FORWARD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>';
  var ICON_STOP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
  var ICON_EXTERNAL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>';

  function ensureMenuStyle() {
    if (menuStyleEl) return;
    menuStyleEl = document.createElement('style');
    menuStyleEl.id = 'rozelynx-menu-style';
    menuStyleEl.textContent =
      '#rozelynx-custom-menu {' +
      '--rx-bg:#ffffff;--rx-fg:#1b1b2e;--rx-border:rgba(0,0,0,0.15);' +
      '--rx-hover:#8B5CF6;--rx-hover-fg:#ffffff;--rx-disabled:#9ca3af;--rx-sep:#e5e7eb;' +
      '--rx-btn-hover:rgba(0,0,0,0.08);--rx-accent:#8B5CF6;' +
      '}' +
      '#rozelynx-custom-menu.rozelynx-dark {' +
      '--rx-bg:#2b2a33;--rx-fg:#fbfbfe;--rx-border:rgba(255,255,255,0.18);' +
      '--rx-hover:#A78BFA;--rx-hover-fg:#1b1b2e;--rx-disabled:#6d6d7d;--rx-sep:#3a3946;' +
      '--rx-btn-hover:rgba(255,255,255,0.12);--rx-accent:#A78BFA;' +
      '}' +
      '#rozelynx-custom-menu { position:fixed;z-index:2147483647;min-width:220px;max-width:340px;' +
      'background:var(--rx-bg);border:1px solid var(--rx-border);border-radius:8px;' +
      'box-shadow:0 8px 28px rgba(0,0,0,0.22);padding:6px 0;' +
      'font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
      'color:var(--rx-fg); }' +
      '#rozelynx-custom-menu .rx-sep { height:1px;background:var(--rx-sep);margin:5px 0; }' +
      // Group header: names the owner of the items under it (RozeLynx's own
      // entries, or one other extension's). Not clickable and not selectable -
      // a header that closed the menu would be a trap, and it is not an action.
      '#rozelynx-custom-menu .rx-group-label { padding:6px 14px 3px;font-size:11px;font-weight:600;' +
      'letter-spacing:.05em;text-transform:uppercase;color:var(--rx-disabled);' +
      'pointer-events:none;user-select:none;-webkit-user-select:none; }' +
      '#rozelynx-custom-menu .rozelynx-menu-item { padding:7px 14px;cursor:pointer;white-space:nowrap; }' +
      '#rozelynx-custom-menu .rozelynx-menu-item:hover { background:var(--rx-hover);color:var(--rx-hover-fg); }' +
      '#rozelynx-custom-menu .rozelynx-menu-item.rx-disabled { color:var(--rx-disabled);cursor:default; }' +
      '#rozelynx-custom-menu .rozelynx-menu-item.rx-disabled:hover { background:transparent;color:var(--rx-disabled); }' +
      '#rozelynx-custom-menu .rx-toolbar { display:flex;gap:2px;padding:2px 8px 7px;' +
      'border-bottom:1px solid var(--rx-sep);margin-bottom:4px; }' +
      '#rozelynx-custom-menu .rx-btn { width:30px;height:30px;display:flex;align-items:center;' +
      'justify-content:center;background:transparent;border:none;border-radius:6px;' +
      'color:var(--rx-fg);cursor:pointer;padding:0; }' +
      '#rozelynx-custom-menu .rx-btn:hover { background:var(--rx-btn-hover); }' +
      '#rozelynx-custom-menu .rx-btn svg { width:16px;height:16px; }' +
      '#rozelynx-custom-menu .rx-btn.rx-star-on svg { fill:var(--rx-accent);stroke:var(--rx-accent); }' +
      '#rozelynx-custom-menu .rx-btn.rx-btn-disabled { opacity:0.4;cursor:default; }' +
      '#rozelynx-custom-menu .rx-btn.rx-btn-disabled:hover { background:transparent; }' +
      '#rozelynx-custom-menu .rx-toolbar-divider { width:1px;margin:4px 6px;background:var(--rx-sep); }';
    document.documentElement.appendChild(menuStyleEl);
  }

  function isDarkTheme() {
    try {
      var dr = document.documentElement.getAttribute('data-darkreader-scheme');
      if (dr === 'dark') return true;
      if (dr === 'light') return false;
    } catch (e) {}
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function rethemeMenu() {
    if (customMenu) {
      customMenu.classList.toggle('rozelynx-dark', isDarkTheme());
    }
  }

  // -------------------------------------------------------------------------
  // Top graphical button row: Back, Forward, Reload, Stop, Bookmark,
  // then Screenshot at the far end (mirroring the native context menu row).
  // -------------------------------------------------------------------------
  function makeToolbarBtn(title, icon, fn, disabled) {
    var b = document.createElement('button');
    b.className = 'rx-btn';
    b.title = title;
    b.innerHTML = icon;
    if (disabled) b.classList.add('rx-btn-disabled');
    b.addEventListener('click', function() {
      if (b.classList.contains('rx-btn-disabled')) return;
      closeCustomMenu();
      fn();
    });
    return b;
  }

  function buildToolbar(menu) {
    var row = document.createElement('div');
    row.className = 'rx-toolbar';

    row.appendChild(makeToolbarBtn('Back', ICON_BACK, function() {
      window.history.back();
    }, window.history.length <= 1));
    row.appendChild(makeToolbarBtn('Forward', ICON_FORWARD, function() {
      window.history.forward();
    }));
    row.appendChild(makeToolbarBtn('Reload', ICON_RELOAD, function() {
      window.location.reload();
    }));
    row.appendChild(makeToolbarBtn('Stop', ICON_STOP, function() {
      window.stop();
    }));

    var star = document.createElement('button');
    star.className = 'rx-btn rx-star';
    star.title = 'Bookmark Page';
    star.innerHTML = ICON_STAR;
    star.addEventListener('click', function() {
      closeCustomMenu();
      toggleBookmark(window.location.href, document.title, star);
    });
    row.appendChild(star);

    var divider = document.createElement('div');
    divider.className = 'rx-toolbar-divider';
    row.appendChild(divider);

    row.appendChild(makeToolbarBtn('Take Screenshot', ICON_SHOT, function() {
      takeScreenshot();
    }));

    var extBtn = document.createElement('button');
    extBtn.className = 'rx-btn';
    extBtn.title = 'Open Page in External Browser';
    extBtn.innerHTML = ICON_EXTERNAL;
    extBtn.addEventListener('click', function() {
      closeCustomMenu();
      openExternal(getExternalUrl());
    });
    row.appendChild(extBtn);

    browser.storage.local.get('rozelynx_bookmarks').then(function(stored) {
      var map = stored.rozelynx_bookmarks || {};
      star.classList.toggle('rx-star-on', !!map[window.location.href]);
    }).catch(function() {});

    menu.appendChild(row);
  }

  // -------------------------------------------------------------------------
  // Extension menu forwarding: other extensions' context menu items, fetched
  // from the BACKGROUND and rendered at the bottom of the synthetic menu.
  //
  // It used to be a hidden extension iframe (menus.html) that this content
  // script injected into the page and read the answer back out of
  // storage.local. That could never have worked: browser.menus is registered
  // scopes:["addon_parent"] - extension PAGES only - and a moz-extension://
  // iframe embedded in a content page is a content script, where browser.menus
  // does not exist. The bridge therefore answered {ok:false, error:'noapi'} on
  // every menu open and this section has never rendered a single item. The
  // storage round-trip existed only to get a reply out of that iframe, so both
  // go away with it - along with a moz-extension iframe being injected into
  // every page at document_start for a feature most pages never use.
  //
  // The background is the right place for the same reason Part E's netiface
  // entries are there: the content script cannot read the privileged API, so
  // it asks, and the parent answers.
  // -------------------------------------------------------------------------
  var menuQueryWarned = false;

  function requestExtensionMenuItems() {
    var t = lastContextTarget;
    var info = {
      src: window.location.href, tag: '', href: '', imgSrc: '', mediaSrc: '',
      hasSelection: false
    };
    if (t && t.nodeType === 1) {
      info.tag = t.tagName;
      var link = t.closest ? t.closest('a[href]') : null;
      if (link && link.href) info.href = link.href;
      var img = t.closest ? t.closest('img') : null;
      if (img) info.imgSrc = img.currentSrc || img.src;
      var media = t.closest ? t.closest('video,audio') : null;
      if (media) info.mediaSrc = media.currentSrc || media.src;
    }
    var sel = window.getSelection();
    info.hasSelection = !!(sel && !sel.isCollapsed);

    // A rejected sendMessage means the background module is not in this build.
    // Nothing is rendered either way; the difference is that the reason is
    // logged once instead of leaving an empty section with no explanation.
    return browser.runtime.sendMessage({
      module: 'mouse-gestures',
      action: 'extmenuQuery',
      data: { ctx: info },
    }).then(function(reply) {
      if (!reply || !reply.ok) {
        if (!menuQueryWarned) {
          menuQueryWarned = true;
          console.warn('[RozeLynx MG] no extension menu items: ' +
            ((reply && reply.error) ||
             (reply ? 'the background returned ' + JSON.stringify(reply)
                    : 'the background did not answer')));
        }
        return;
      }
      renderExtensionMenuItems(reply.items);
    }).catch(function(err) {
      if (!menuQueryWarned) {
        menuQueryWarned = true;
        console.warn('[RozeLynx MG] no extension menu items: ' +
          ((err && err.message) || err));
      }
    });
  }

  // The privileged query (dev/ext-menus-rozelynx.patch) hands back a FLAT list
  // in which a submenu's children carry parentId = the parent MenuItem's id.
  // Drawing that flat (one fixed indent for anything with a parentId) loses the
  // shape: children of two different parents both sit at the same indent, and a
  // child whose parent was filtered out is indented under nothing. So rebuild
  // the forest before drawing it.
  //
  // Rows are computed and normalised first and only then appended, so the
  // normalisation can see the whole list rather than the half-built DOM.
  function extensionMenuRows(items) {
    var rows = [];
    var i, k;

    // Separators carry no title and cannot be clicked, so they are not tree
    // nodes: each one is remembered as "a rule goes before the next item". A
    // separator with nothing after it is dropped, because a trailing rule in a
    // panel reads as a rendering bug.
    var nodes = [];
    var sepBefore = [];
    var pendingSep = false;
    for (i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it) continue;
      if (it.type === 'separator') { pendingSep = true; continue; }
      sepBefore.push(pendingSep);
      pendingSep = false;
      nodes.push({ item: it, parent: -1 });
    }
    if (!nodes.length) return rows;

    // MenuItem ids are unique per extension, not per browser, so the lookup is
    // keyed by extension AND id: two extensions may both have an item "1".
    // (These are plain-object keys on purpose - the ids are strings here, so
    // there is no object-to-string collision to guard against.)
    function key(extId, itemId) { return String(extId) + '\u0000' + String(itemId); }
    var byId = {};
    for (i = 0; i < nodes.length; i++) {
      byId[key(nodes[i].item.extId, nodes[i].item.itemId)] = i;
    }

    var kids = {};
    var roots = [];
    for (i = 0; i < nodes.length; i++) {
      var it2 = nodes[i].item;
      var pid = it2.parentId;
      var pi = (pid === undefined || pid === null || pid === '') ? -1
        : byId[key(it2.extId, pid)];
      // A parentId naming an item that is NOT in the list means the parent was
      // filtered out by enabledForContext, or belongs to another extension, or
      // never existed. Either way this item is a root, not a child of a row
      // nobody can see. Same for an item that claims itself as its parent.
      if (pi === undefined || pi === i) pi = -1;
      nodes[i].parent = pi;
      if (pi < 0) {
        roots.push(i);
      } else {
        if (!kids[pi]) kids[pi] = [];
        kids[pi].push(i);
      }
    }

    // Gecko menus nest arbitrarily deep; a 16-level staircase in a 340px panel
    // is unreadable, so the indent caps while every item still renders.
    var MAX_EXT_DEPTH = 3;
    var emitted = [];
    function walk(idx, depth) {
      if (emitted[idx]) return;     // also the cycle guard: parentId chains
      emitted[idx] = true;          // come straight from extension-supplied data.
      if (sepBefore[idx]) rows.push({ kind: 'sep' });
      rows.push({
        kind: 'item', item: nodes[idx].item,
        depth: depth < MAX_EXT_DEPTH ? depth : MAX_EXT_DEPTH
      });
      var list = kids[idx];
      if (!list) return;
      for (k = 0; k < list.length; k++) walk(list[k], depth + 1);
    }
    for (i = 0; i < roots.length; i++) walk(roots[i], 0);
    // Anything the walk never reached sat in a parentId cycle. Show it flat
    // rather than silently dropping an extension's menu item.
    for (i = 0; i < nodes.length; i++) {
      if (emitted[i]) continue;
      emitted[i] = true;
      if (sepBefore[i]) rows.push({ kind: 'sep' });
      rows.push({ kind: 'item', item: nodes[i].item, depth: 0 });
    }

    // Name each extension's run of items. The privileged query iterates its
    // gMenuMap extension by extension, so consecutive runs are lossless
    // grouping; this tolerates an interleaved list anyway. Headers are
    // INSERTED before the first item of a run - building a second array rather
    // than overwriting rows[i], which would drop the item the header belongs to.
    var labelled = [];
    var lastExtId = null;
    var lastText = null;
    for (i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row.kind === 'item') {
        var extId = row.item.extId;
        if (extId !== lastExtId) {
          lastExtId = extId;
          var name = row.item.extName || extId || '';
          // Two different extensions with the same display name would otherwise
          // produce two identical headers; fall back to the id for the second.
          var text = (name && name === lastText) ? (extId || name) : name;
          lastText = text;
          if (text) labelled.push({ kind: 'label', text: text });
        }
      }
      labelled.push(row);
    }
    rows = labelled;

    // Separator normalisation: never two in a row, never straight after a
    // header (the header already separates), never leading, never trailing.
    var out = [];
    for (i = 0; i < rows.length; i++) {
      if (rows[i].kind === 'sep') {
        if (!out.length) continue;
        var prev = out[out.length - 1];
        if (prev.kind === 'sep' || prev.kind === 'label') continue;
      }
      out.push(rows[i]);
    }
    while (out.length && out[out.length - 1].kind === 'sep') out.pop();
    return out;
  }

  function renderExtensionMenuItems(items) {
    if (!customMenu || !items || !items.length) return;
    var old = customMenu.querySelectorAll('.rx-extmenu, .rx-extmenu-sep, .rx-extgroup');
    for (var i = 0; i < old.length; i++) old[i].remove();

    var rows = extensionMenuRows(items);
    if (!rows.length) return;

    // Added after normalisation, so the leading rule of the section is not
    // mistaken for the redundant one the list itself may start with.
    var sep = document.createElement('div');
    sep.className = 'rx-sep rx-extmenu-sep';
    customMenu.appendChild(sep);

    rows.forEach(function(row) {
      if (row.kind === 'sep') {
        var s = document.createElement('div');
        s.className = 'rx-sep rx-extmenu-sep';
        customMenu.appendChild(s);
        return;
      }
      if (row.kind === 'label') {
        var lbl = document.createElement('div');
        lbl.className = 'rx-group-label rx-extgroup';
        lbl.textContent = row.text;
        customMenu.appendChild(lbl);
        return;
      }

      var item = row.item;
      var el = document.createElement('div');
      el.className = 'rozelynx-menu-item rx-extmenu';
      // Base padding is 14px; one level of nesting is 30px, which is what the
      // old flat renderer used for every parented item.
      el.style.paddingLeft = (14 + row.depth * 16) + 'px';
      var prefix = item.type === 'checkbox' || item.type === 'radio'
        ? (item.checked ? '\u2713 ' : '') : '';
      el.textContent = prefix + item.title;
      if (item.enabled === false) el.classList.add('rx-disabled');
      if (item.extName) el.title = item.extName;
      el.addEventListener('click', function() {
        closeCustomMenu();
        if (item.enabled === false) return;
        // Straight to the background, which is where the privileged
        // rozelynxTrigger lives. This used to write rozelynx_menu_click into
        // storage.local for the menus.js bridge to watch - a second hop, and a
        // stored key that outlived the click it belonged to. The reply is
        // awaited only so a refusal is logged once rather than vanishing.
        browser.runtime.sendMessage({
          module: 'mouse-gestures',
          action: 'extmenuTrigger',
          data: { request: {
            extId: item.extId,
            itemId: item.itemId,
            src: window.location.href,
          } },
        }).then(function(reply) {
          if (reply && reply.ok === false) {
            console.warn('[RozeLynx MG] ' + (item.extName || item.extId) +
              ' refused "' + item.title + '": ' + (reply.error || 'unknown'));
          }
        }).catch(function(err) {
          console.warn('[RozeLynx MG] could not trigger "' + item.title +
            '": ' + ((err && err.message) || err));
        });
      });
      customMenu.appendChild(el);
    });
  }

  // -------------------------------------------------------------------------
  // External browser support: clicking the toolbar button navigates to a
  // rozelynx-ext: URL, which Firefox hands to its native "Open URL in"
  // application chooser. The chooser lists "Default browser" (system
  // desktop entry) plus one entry per detected browser, registered as
  // user-level .desktop files by the rozelynx_host native messaging host.
  // The host list is refreshed via a tiny full-privilege popup
  // (browsers.html) when the cache is stale (~30s), on menu open and on
  // hover of the button.
  // -------------------------------------------------------------------------
  var browsersReqId = 0;
  var browsersCache = null;      // {ok, browsers, terminals, at}
  var BROWSERS_TTL = 30000;
  var browsersPopupPending = false;

  function requestBrowsersList() {
    if (browsersCache && Date.now() - browsersCache.at < BROWSERS_TTL) return;
    if (browsersPopupPending) return;
    browsersPopupPending = true;
    browsersReqId++;
    openBridge('browsers.html', 'req=' + browsersReqId);
    setTimeout(function() { browsersPopupPending = false; }, 10000);
  }

  // -------------------------------------------------------------------------
  // Network-interface binding entry: opens the netiface picker popup for THIS
  // tab. Both halves of it have to live in the parent - the picker is a chrome
  // popup window (browser.windows.create) and the binding itself goes through
  // the privileged rozelynxNetIface experiment API - so the content script
  // only sends messages, and the netiface background module resolves the tab
  // from sender.tab, which is the tab that was right-clicked even when the
  // right-click landed in a sub-frame.
  // -------------------------------------------------------------------------
  function probeNetiface() {
    return browser.runtime.sendMessage({ action: 'netiface:available' }).then(function(resp) {
      // The netiface module answers in the standard {ok, data} envelope every
      // other action in this extension uses, so the flag is resp.data.available.
      netifaceAvailable = !!(resp && resp.ok && resp.data && resp.data.available);
    }).catch(function() {
      // No netiface module in this build: nothing answers, so the entry is
      // dropped from the menu entirely.
      netifaceAvailable = false;
    });
  }

  function openNetifacePicker() {
    browser.runtime.sendMessage({ action: 'netiface:open-picker' }).then(function(resp) {
      if (!resp || !resp.ok) {
        showToast('Interface binding unavailable: ' +
          ((resp && resp.error) || 'no response from the netiface module'));
      }
    }).catch(function() {
      showToast('Interface binding needs a net-iface build of RozeLynx');
    });
  }

  // -------------------------------------------------------------------------
  // Security settings entry: HTML5 canvas data for THIS PWA window.
  //
  // Fingerprinting protection spoofs canvas data (toDataURL / toBlob /
  // getImageData return noise) unless the "canvas" site permission is
  // allowed for the origin - and a PWA is a fixed origin, so the toggle
  // is per-app by construction. Both halves of it have to live in the
  // parent: the permission manager is XPCOM, and the PWA-window gate
  // (an ordinary browsing window must not grow a canvas grant entry) is
  // the pwa background's registry, the same one is-popup answers from.
  // So this only sends messages, exactly like the netiface entry above.
  // -------------------------------------------------------------------------
  function probeSecurity() {
    return browser.runtime.sendMessage({
      module: 'pwa', action: 'security-state',
      data: { origin: window.location.origin }
    }).then(function(resp) {
      if (resp && resp.ok && resp.data && resp.data.pwaWindow) {
        securitySettings = { canvas: !!resp.data.canvasEnabled };
      } else {
        securitySettings = null;
      }
    }).catch(function() {
      // No pwa module in this build (nothing answers), or the message
      // could not be delivered: either way there is no Security section.
      securitySettings = null;
    });
  }

  function toggleCanvasData() {
    var next = !(securitySettings && securitySettings.canvas);
    browser.runtime.sendMessage({
      module: 'pwa', action: 'set-canvas',
      data: { origin: window.location.origin, enable: next }
    }).then(function(resp) {
      if (resp && resp.ok && resp.data) {
        // Keep the cached state in step with the permission manager, so
        // the next menu open shows the toggle where it now is without
        // waiting for another probe round-trip.
        securitySettings = { canvas: !!resp.data.canvasEnabled };
        showToast(resp.data.canvasEnabled
          ? 'HTML5 canvas data enabled for this app'
          : 'HTML5 canvas data revoked for this app');
      } else {
        showToast('Canvas toggle unavailable: ' +
          ((resp && resp.error) || 'no response from the pwa module'));
      }
    }).catch(function() {
      showToast('Canvas toggle needs a pwa build of RozeLynx');
    });
  }

  // -------------------------------------------------------------------------
  // Menu item construction (context-aware, mirroring nsContextMenu)
  // -------------------------------------------------------------------------
  function getMenuContext() {
    var t = lastContextTarget;
    if (!t || t.nodeType !== 1) return 'page';
    var link = t.closest ? t.closest('a[href]') : null;
    if (link && link.href) return 'link';
    var img = t.closest ? t.closest('img') : null;
    if (img) return 'image';
    var media = t.closest ? t.closest('video,audio') : null;
    if (media) return 'media';
    if (t.tagName === 'IFRAME' || t.tagName === 'FRAME' || t.tagName === 'EMBED') return 'frame';
    var sel = window.getSelection();
    if (sel && !sel.isCollapsed && t.nodeType === 1 && sel.containsNode(t, true)) return 'selection';
    return 'page';
  }

  var EMAIL_RE = /^[\w.+-]+@[\w-]+\.[\w.]+$/;

  function buildMenuItems() {
    var items = [];
    var ctx = getMenuContext();
    var t = lastContextTarget;

    // Everything below this point is RozeLynx's own, in every context, and the
    // header says so: the synthetic menu is a mix of the page's context items,
    // RozeLynx's, and - below the section separator that renderExtensionMenuItems
    // draws - other installed extensions'. The group is emitted by one call in
    // each context arm rather than threading a flag through six switches, and it
    // always has at least one item under it, so it can never render as a lone
    // trailing header.
    function rozelynxGroup(targetEl) {
      items.push({ group: 'RozeLynx' });
      items.push({ label: 'Gesture Guide', fn: function() { showGestureGuide(); } });
      items.push({ label: 'Inspect', fn: function() { openDevtoolsBridge('inspect', targetEl); } });
      items.push({ label: 'Show Accessibility Properties',
        fn: function() { openDevtoolsBridge('a11y', targetEl); } });
    }

    switch (ctx) {
      case 'link': {
        var link = t.closest('a[href]');
        var href = link.href;
        items.push({ label: 'Open Link in New Tab', fn: function() { openInNewTab(href); } });
        items.push({ label: 'Open Link in New Window', fn: function() { openInNewWindow(href); } });
        items.push({ sep: true });
        items.push({ label: 'Copy Link Address', fn: function() { copyText(href); } });
        var mailTo = /^mailto:/i.test(href);
        var linkText = (link.textContent || '').trim();
        if (mailTo || EMAIL_RE.test(linkText)) {
          var addr = mailTo
            ? decodeURIComponent(href.replace(/^mailto:/i, '').split('?')[0])
            : linkText;
          items.push({ label: 'Copy Email Address', fn: function() { copyText(addr); } });
        }
        items.push({ label: 'Save Link As...', fn: function() { saveAs(href); } });
        items.push({ sep: true });
        rozelynxGroup(link);
        break;
      }

      case 'image': {
        var img = t.closest('img');
        var src = img.currentSrc || img.src;
        items.push({ label: 'View Image', fn: function() { window.location.href = src; } });
        items.push({ label: 'Open Image in New Tab', fn: function() { openInNewTab(src); } });
        items.push({ sep: true });
        items.push({ label: 'Copy Image', fn: function() { copyImage(img); } });
        items.push({ label: 'Copy Image Link', fn: function() { copyText(src); } });
        items.push({ label: 'Save Image As...', fn: function() { saveAs(src); } });
        items.push({ sep: true });
        rozelynxGroup(img);
        break;
      }

      case 'media': {
        var media = t.closest('video,audio');
        items.push({
          label: media.paused ? 'Play' : 'Pause',
          fn: function() { media.paused ? media.play() : media.pause(); }
        });
        items.push({
          label: media.muted ? 'Unmute' : 'Mute',
          fn: function() { media.muted = !media.muted; }
        });
        items.push({
          label: 'Loop' + (media.loop ? ' \u2713' : ''),
          fn: function() { media.loop = !media.loop; }
        });
        items.push({ label: 'Full Screen', fn: function() { media.requestFullscreen(); } });
        items.push({ sep: true });
        var msrc = media.currentSrc || media.src;
        if (msrc) {
          items.push({ label: 'Open in New Tab', fn: function() { openInNewTab(msrc); } });
          items.push({ label: 'Copy Link', fn: function() { copyText(msrc); } });
          items.push({ label: 'Save As...', fn: function() { saveAs(msrc); } });
          items.push({ sep: true });
        }
        rozelynxGroup(media);
        break;
      }

      case 'frame': {
        var fsrc = t.src || '';
        if (fsrc) {
          items.push({ label: 'Open Frame in New Tab', fn: function() { openInNewTab(fsrc); } });
          items.push({ label: 'Open Frame in New Window', fn: function() { openInNewWindow(fsrc); } });
          items.push({ sep: true });
          items.push({ label: 'Show Only This Frame', fn: function() { window.location.href = fsrc; } });
          items.push({ label: 'View Frame Source', fn: function() { window.open('view-source:' + fsrc, '_blank'); } });
          items.push({ sep: true });
        }
        pageExtras(items);
        items.push({ sep: true });
        rozelynxGroup(t);
        break;
      }

      case 'selection': {
        var selText = window.getSelection().toString();
        items.push({ label: 'Copy', fn: function() { copyText(selText); } });
        items.push({ label: 'Select All', fn: function() { selectAll(); } });
        items.push({ sep: true });
        items.push({ label: 'View Selection Source', fn: function() {
          var blob = new Blob(['<pre>' + escapeHtml(selText) + '</pre>'], { type: 'text/html' });
          var url = URL.createObjectURL(blob);
          window.open(url, '_blank');
        } });
        items.push({ sep: true });
        rozelynxGroup(t);
        break;
      }

      default: { // page
        items.push({ label: 'Select All', fn: function() { selectAll(); } });
        items.push({ label: 'View Page Source', fn: function() { window.location.href = 'view-source:' + window.location.href; } });
        items.push({ label: 'Print...', fn: function() { window.print(); } });
        if (navigator.share) {
          items.push({ label: 'Share', fn: function() {
            navigator.share({ title: document.title, url: window.location.href })
              .catch(function() {});
          } });
        }
        items.push({ sep: true });
        pageExtras(items);
        items.push({ sep: true });
        rozelynxGroup(t);
        break;
      }
    }

    // Tab-scoped, so the same entry in every context: the binding belongs to
    // the tab, not to whatever element was clicked. null (probe still in
    // flight) counts as "show" so a right-click in the first milliseconds
    // after page load still offers it; a definitive false - no netiface
    // module, or none with a usable experiment API - hides it for good.
    // It is the last member of the RozeLynx group rather than a group of its
    // own, so it needs no separator of its own any more.
    if (netifaceAvailable !== false) {
      items.push({ label: 'Bind Network Interface…', fn: openNetifacePicker });
    }

    // Security settings, only in PWA windows: securitySettings is only
    // ever non-null in one (the probe nulls itself for every other
    // answer - no pwa module, no security API, not a PWA window). The
    // canvas item carries its state as a leading check mark because the
    // synthetic menu has no native checkbox row; the group header is
    // where the next per-window security toggle goes.
    if (securitySettings) {
      items.push({ group: 'Security settings' });
      items.push({
        label: (securitySettings.canvas ? '\u2713 ' : '') +
               'Allow HTML5 canvas data (this app)',
        fn: toggleCanvasData,
      });
    }

    return items;
  }

  function pageExtras(items) {
    items.push({ label: 'Copy Page URL', fn: function() { copyText(window.location.href); } });
    items.push({ label: 'Scroll to Top', act: 'scroll_top' });
    items.push({ label: 'Scroll to Bottom', act: 'scroll_bottom' });
  }

  function selectAll() {
    if (document.execCommand) {
      try { document.execCommand('selectAll'); return; } catch (e) {}
    }
    var sel = window.getSelection();
    sel.selectAllChildren(document.body);
  }

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function showCustomMenu(x, y) {
    closeCustomMenu();
    ensureMenuStyle();

    var menu = document.createElement('div');
    menu.id = 'rozelynx-custom-menu';
    menu.classList.toggle('rozelynx-dark', isDarkTheme());

    buildToolbar(menu);

    var items = buildMenuItems();
    items.forEach(function(item) {
      if (item.sep) {
        var sep = document.createElement('div');
        sep.className = 'rx-sep';
        menu.appendChild(sep);
        return;
      }
      if (item.group) {
        // A header, not an action: no listener at all, so it cannot close the
        // menu or fire anything. See the .rx-group-label rule in the stylesheet.
        var lbl = document.createElement('div');
        lbl.className = 'rx-group-label';
        lbl.textContent = item.group;
        menu.appendChild(lbl);
        return;
      }
      var el = document.createElement('div');
      el.className = 'rozelynx-menu-item';
      el.textContent = item.label;
      if (item.enabled === false) {
        el.classList.add('rx-disabled');
      }
      el.addEventListener('click', function() {
        closeCustomMenu();
        if (item.enabled === false) return;
        if (item.fn) item.fn();
        else if (item.act) executeLocal(item.act, item.act);
      });
      menu.appendChild(el);
    });

    document.documentElement.appendChild(menu);
    customMenu = menu;

    requestExtensionMenuItems();

    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var mw = menu.offsetWidth;
    var mh = menu.offsetHeight;
    var px = Math.min(x, vw - mw - 6);
    var py = Math.min(y, vh - mh - 6);
    menu.style.left = Math.max(6, px) + 'px';
    menu.style.top = Math.max(6, py) + 'px';
  }

  // doesn't match, try collapsing diagonal tokens to one of their axes.
  function findAction(dirs) {
    var diagAxes = { UR: ['U', 'R'], UL: ['U', 'L'], DR: ['D', 'R'], DL: ['D', 'L'] };

    function matches(arr) {
      var t = arr.join('');
      return gestures[t] ? { token: t, action: gestures[t] } : null;
    }

    var exact = matches(dirs);
    if (exact) return exact;

    // Single-diagonal substitution variants
    for (var i = 0; i < dirs.length; i++) {
      if (dirs[i].length !== 2 || !diagAxes[dirs[i]]) continue;
      for (var k = 0; k < 2; k++) {
        var cand = dirs.slice();
        cand[i] = diagAxes[dirs[i]][k];
        var m = matches(cand);
        if (m) return m;
      }
    }

    // All-diagonal collapse variants
    var allH = dirs.map(function(t) { return t.length === 2 ? diagAxes[t][1] : t; });
    var mH = matches(allH);
    if (mH) return mH;
    var allV = dirs.map(function(t) { return t.length === 2 ? diagAxes[t][0] : t; });
    return matches(allV) || null;
  }

  var feedbackEl = null;
  function showToast(msg, ms) {
    if (!feedbackEl) {
      feedbackEl = document.createElement('div');
      feedbackEl.id = 'rozelynx-gesture-feedback';
      feedbackEl.style.cssText =
        'position:fixed;bottom:40px;left:50%;transform:translateX(-50%);' +
        'background:rgba(27,27,46,0.92);color:#fff;padding:8px 16px;' +
        'border-radius:8px;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
        'z-index:2147483647;pointer-events:none;opacity:0;transition:opacity 0.25s;' +
        'white-space:pre-line;text-align:center;max-width:80vw;';
      document.documentElement.appendChild(feedbackEl);
    }
    feedbackEl.textContent = msg;
    feedbackEl.style.opacity = '1';
    clearTimeout(feedbackEl._t);
    feedbackEl._t = setTimeout(function() { feedbackEl.style.opacity = '0'; }, ms || 1800);
  }

  function showGestureFeedback(token, action) {
    showToast(action ? (token + ' \u2192 ' + action) : (token + ' (no action)'));
  }

  function showGestureGuide() {
    var lines = [];
    Object.keys(DEFAULT_GESTURES).forEach(function(k) {
      lines.push(k + ' \u2192 ' + DEFAULT_GESTURES[k]);
    });
    showToast(lines.join('\n'), 6000);
  }

  function executeGesture(gestureStr) {
    var match = findAction(directions);
    if (!match) {
      showGestureFeedback(gestureStr, null);
      console.debug('[RozeLynx MG] No action for gesture:', gestureStr);
      return;
    }
    showGestureFeedback(match.token, match.action);
    var action = match.action;

    // Try local execution first (works without background page)
    if (executeLocal(action, gestureStr)) return;

    // Fall back to background for tab/window-level actions
    var payload = {
      module: 'mouse-gestures',
      action: 'execute',
      data: { gesture: gestureStr }
    };
    try {
      browser.runtime.sendMessage(payload).catch(function(e) {
        if (String(e).indexOf('Could not establish') >= 0) {
          setTimeout(function() {
            browser.runtime.sendMessage(payload).catch(function() {});
          }, 400);
        }
      });
    } catch(e) {}
  }

  // Best-effort dismissal of a page-owned context menu via synthetic Escape
  // key events. Some pages ignore untrusted events; in that case the menu
  // stays until the user clicks it away.
  function dismissPageMenu() {
    try {
      var opts = {
        key: 'Escape', code: 'Escape', keyCode: 27, which: 27,
        bubbles: true, cancelable: true, composed: true
      };
      document.dispatchEvent(new KeyboardEvent('keydown', opts));
      document.dispatchEvent(new KeyboardEvent('keyup', opts));
    } catch (e) {}
  }

  // Start tracking on RMB press
  document.addEventListener('mousedown', function(e) {
    if (!enabled) return;
    if (e.button !== 2) return;
    if (isEditableTarget(e.target)) return;

    lastRmbDown = Date.now();
    rmbDownSeen = true;
    ctxSeen = false;
    pageHandledContext = false;
    markCtx('down');
    reset();
    tracking = true;

    addPoint(e.clientX, e.clientY);
    lastX = e.clientX;
    lastY = e.clientY;

    showTrail();
    drawTrail();
  }, true);

  // The native menu opens on RMB *press* on GTK/Linux. Pages that implement
  // their own right-click menu preventDefault() the contextmenu event, so we
  // must not blindly suppress it. Strategy: record the event in the capture
  // phase, then attach a one-shot bubble listener at window that is appended
  // to the END of the window listener list and therefore runs AFTER all of
  // the page's handlers. If the page handled the menu, leave it alone;
  // otherwise suppress the native menu so our custom menu can show on RMB
  // release. Media elements with native controls are special: Firefox's UA
  // widget consumes mousedown/mouseup over the video surface, so no release
  // ever reaches us. For those we show the menu on press instead.
  document.addEventListener('contextmenu', function(e) {
    if (!e.isTrusted) return;
    if (!enabled) return;
    if (isEditableTarget(e.target)) return;
    var isMedia = e.target.closest && !!e.target.closest('video,audio');
    if (!isMedia && Date.now() - lastRmbDown > 1200) return;

    ctxSeen = true;
    ctxIsMedia = isMedia;
    lastContextTarget = e.target;
    lastContextX = e.clientX;
    lastContextY = e.clientY;
    markCtx('ctx-seen');

    var ev = e;
    var finRan = false;
    window.addEventListener('contextmenu', function fin(e2) {
      window.removeEventListener('contextmenu', fin, false);
      if (e2 !== ev) return; // stale one-shot from an earlier event
      finRan = true;
      if (e2.defaultPrevented) {
        pageHandledContext = true;
        markCtx('page-handled');
        return;
      }
      e2.preventDefault();
      e2.stopPropagation();
      markCtx('suppressed');
      if (ctxIsMedia && !rmbDownSeen) {
        showCustomMenu(lastContextX, lastContextY);
      }
    }, false);

    // Backup: if the page stopped propagation before the bubble listener
    // above could run, infer its intent from the final event state.
    setTimeout(function() {
      if (!finRan && (ev.defaultPrevented || ev.cancelBubble)) {
        pageHandledContext = true;
        markCtx('async-handled');
      }
    }, 0);
  }, true);

  // Track mouse movement while RMB is held
  document.addEventListener('mousemove', function(e) {
    if (!tracking) return;
    if (customMenu) closeCustomMenu();
    e.preventDefault();
    addPoint(e.clientX, e.clientY);
    drawTrail();
  }, true);

  // On RMB release: execute gesture, or restore context menu for plain clicks
  document.addEventListener('mouseup', function(e) {
    if (!tracking) return;
    if (e.button !== 2) return;

    tracking = false;
    rmbDownSeen = false;
    hideTrail();
    closeCustomMenu();

    if (hasMovement()) {
      if (pageHandledContext) dismissPageMenu();
      executeGesture(getGesture());
    } else if (ctxSeen && !pageHandledContext) {
      // Plain right-click: (re)open the custom menu at the release point
      markCtx('menu-shown');
      showCustomMenu(lastContextX, lastContextY);
    } else {
      markCtx('menu-skip ph=' + pageHandledContext + ' cs=' + ctxSeen);
    }

    reset();
  }, true);

  loadConfig();
  probeNetiface();
  probeSecurity();

  // Dismiss the custom menu on any click outside it, Escape, or scroll
  document.addEventListener('mousedown', function(e) {
    if (customMenu && !customMenu.contains(e.target)) {
      closeCustomMenu();
    }
  }, true);
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && customMenu) {
      closeCustomMenu();
    }
  }, true);
  window.addEventListener('scroll', function() {
    if (customMenu) closeCustomMenu();
  }, true);

  // Live theme tracking: OS scheme changes + Dark Reader toggles
  var darkMedia = window.matchMedia('(prefers-color-scheme: dark)');
  try { darkMedia.addEventListener('change', rethemeMenu); } catch (e) {}
  var drObserver = new MutationObserver(rethemeMenu);
  drObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-darkreader-scheme']
  });

  // Keep the bookmark star in sync if another context toggles it, and
  // render forwarded extension menu items when the bridge answers.
  browser.storage.onChanged.addListener(function(changes, area) {
    if (area !== 'local') return;
    if (changes.rozelynx_bookmarks && customMenu) {
      var map = changes.rozelynx_bookmarks.newValue || {};
      var star = customMenu.querySelector('.rx-star');
      if (star) star.classList.toggle('rx-star-on', !!map[window.location.href]);
    }
    if (changes.rozelynx_browsers_result) {
      var br = changes.rozelynx_browsers_result.newValue;
      if (br && br.result) {
        browsersCache = {
          ok: !!br.result.ok,
          browsers: br.result.browsers || [],
          terminals: br.result.terminals || [],
          at: Date.now()
        };
        try {
          document.documentElement.setAttribute('data-rx-browsers-result',
            br.result.ok
              ? 'ok:' + (br.result.browsers || []).length
              : 'err:' + (br.result.error || 'unknown'));
        } catch (e) {}
      }
    }
  });

  browser.runtime.onMessage.addListener(function(message) {
    if (message && message.action === 'mgStateChanged') {
      enabled = message.data && message.data.enabled;
    }
  });
})();
