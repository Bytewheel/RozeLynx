/* RozeLynx: account-less state sync - engine.
 *
 * One click on the popup's sync button gathers the browser's state:
 *   - every open tab, per window (url, title, pinned, active);
 *   - browsing history (depth chosen per sync: 500 / 5000 / all);
 *   - all cookies;
 *   - the installed extensions (id, name, version, enabled - the list is
 *     restored as install-page tabs, since the XPIs themselves cannot ride
 *     a link);
 *   - the configuration: every user-set rozelynx.* pref (about:config's
 *     own view of the RozeLynx settings) plus this extension's
 *     storage.local (feature toggles, PWA list, ...).
 *
 * The payload is gzipped (CompressionStream), encrypted with AES-GCM-256
 * under a key generated FOR THIS LINK ONLY (WebCrypto), and packed into a
 * magic link:
 *
 *   rozelynxsync://sync/#v=1&k=<key>&i=<iv>&d=<payload>
 *
 * all base64url, all in the fragment so nothing is ever sent to a server -
 * there is no server. The link carries both the payload and the decryption
 * key because the user asked for exactly that: a self-contained link they
 * can send themselves. Whoever holds the link holds the state; the UI says
 * so.
 *
 * The RECEIVING side: the browser's rozelynxsync:// protocol handler (see
 * patches/rozelynx/cpp/sync-scheme/) parks the URL and notifies the
 * rozelynxSync experiment API, which wakes this background and replays the
 * link through onSyncLink. Decrypt - decompress - parse - apply: prefs
 * first, then storage, cookies, history, tabs (one window per source
 * window, pinned tabs re-pinned), and one install-page tab per extension
 * that is missing. Another RozeLynx ends up in the same state the link was
 * made from, which is the whole point.
 *
 * Magic-link SIZE is the one honest limit and it is surfaced, not hidden:
 * a full history can make the link megabytes long, and while RozeLynx's own
 * URL bar handles that, chat and mail transports truncate and a single
 * command-line argument is capped at 128 KiB by the kernel (clicking such a
 * link from ANOTHER app may fail - pasting it into RozeLynx's address bar
 * always works). The UI warns by size class, and history depth is chosen
 * per sync.
 */
(function() {
  'use strict';

  var LOG_PREFIX = '[RozeLynx:sync]';
  var LINK_PREFIX = 'rozelynxsync://sync/#';
  var SCHEME = 'rozelynxsync:';

  function log(level, msg) {
    var args = Array.prototype.slice.call(arguments, 1);
    if (level === 'error') {
      console.error.apply(console, [LOG_PREFIX].concat(args));
    } else if (level === 'warn') {
      console.warn.apply(console, [LOG_PREFIX].concat(args));
    } else {
      console.log.apply(console, [LOG_PREFIX].concat(args));
    }
  }

  // ── bytes <-> base64url ─────────────────────────────────────────────

  function bytesToB64url(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) {
      s += String.fromCharCode(bytes[i]);
    }
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64urlToBytes(str) {
    var s = str.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  }

  // ── compress / encrypt ──────────────────────────────────────────────

  function gzip(text) {
    var stream = new Blob([text]).stream()
      .pipeThrough(new CompressionStream('gzip'));
    return new Response(stream).arrayBuffer()
      .then(function(buf) { return new Uint8Array(buf); });
  }

  function gunzip(bytes) {
    var stream = new Blob([bytes]).stream()
      .pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
  }

  function encrypt(plaintextBytes) {
    return crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 }, true, ['encrypt']
    ).then(function(key) {
      var iv = crypto.getRandomValues(new Uint8Array(12));
      return crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv }, key, plaintextBytes
      ).then(function(cipher) {
        return crypto.subtle.exportKey('raw', key).then(function(rawKey) {
          return {
            key: new Uint8Array(rawKey),
            iv: iv,
            data: new Uint8Array(cipher),
          };
        });
      });
    });
  }

  function decrypt(keyBytes, ivBytes, dataBytes) {
    return crypto.subtle.importKey(
      'raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']
    ).then(function(key) {
      return crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: ivBytes }, key, dataBytes
      );
    }).then(function(buf) { return new Uint8Array(buf); });
  }

  // ── gather ──────────────────────────────────────────────────────────

  function gatherTabs() {
    return browser.tabs.query({}).then(function(tabs) {
      var windows = [];
      var byWindow = {};
      (tabs || []).forEach(function(t) {
        if (!t.url || /^(about|moz-extension|chrome):/i.test(t.url)) {
          // Restoring internal pages that only made sense in the OLD
          // profile would open a pile of error tabs; keep web pages.
          return;
        }
        if (!byWindow[t.windowId]) {
          byWindow[t.windowId] = { windowId: t.windowId, tabs: [] };
          windows.push(byWindow[t.windowId]);
        }
        byWindow[t.windowId].tabs.push({
          url: t.url,
          title: t.title || '',
          pinned: !!t.pinned,
          active: !!t.active,
        });
      });
      return windows;
    });
  }

  function gatherHistory(depth) {
    if (!browser.history) {
      return Promise.resolve([]);
    }
    var max = depth === 'all' ? 1000000 : (parseInt(depth, 10) || 5000);
    return browser.history.search({
      text: '',
      startTime: 0,
      maxResults: max,
    }).then(function(items) {
      // newest first from the API; store oldest first so a restore replays
      // history in the order it happened.
      return (items || []).map(function(h) {
        return {
          url: h.url,
          title: h.title || '',
          lastVisitTime: h.lastVisitTime || 0,
        };
      }).sort(function(a, b) { return a.lastVisitTime - b.lastVisitTime; });
    }).catch(function(e) {
      log('warn', 'history gather failed:', e && e.message);
      return [];
    });
  }

  function gatherCookies() {
    if (!browser.cookies) {
      return Promise.resolve([]);
    }
    return browser.cookies.getAll({}).then(function(list) {
      return (list || []).map(function(c) {
        return {
          domain: c.domain, name: c.name, value: c.value,
          path: c.path || '/', secure: !!c.secure,
          httpOnly: !!c.httpOnly,
          sameSite: c.sameSite || 'no_restriction',
          expirationDate: c.expirationDate || null,
          hostOnly: !!c.hostOnly,
        };
      });
    }).catch(function(e) {
      log('warn', 'cookie gather failed:', e && e.message);
      return [];
    });
  }

  function gatherExtensions() {
    if (!browser.management) {
      return Promise.resolve([]);
    }
    return browser.management.getAll().then(function(list) {
      return (list || []).filter(function(a) {
        return a.type === 'extension' && a.id !== browser.runtime.id;
      }).map(function(a) {
        return {
          id: a.id, name: a.name, version: a.version || '',
          enabled: a.enabled !== false,
          homepageURL: a.homepageURL || '',
          installURL: a.installURL || '',
        };
      });
    }).catch(function(e) {
      log('warn', 'extension gather failed:', e && e.message);
      return [];
    });
  }

  function gatherPrefs() {
    var api = browser.rozelynxPrefs;
    if (!api || !api.getPrefsByPrefix) {
      return Promise.resolve([]);
    }
    return api.getPrefsByPrefix('rozelynx.').catch(function(e) {
      log('warn', 'prefs gather failed:', e && e.message);
      return [];
    });
  }

  function gatherStorage() {
    return browser.storage.local.get(null).catch(function(e) {
      log('warn', 'storage gather failed:', e && e.message);
      return {};
    });
  }

  // ── the magic link ──────────────────────────────────────────────────

  function createLink(historyDepth) {
    return Promise.all([
      gatherTabs(),
      gatherHistory(historyDepth),
      gatherCookies(),
      gatherExtensions(),
      gatherPrefs(),
      gatherStorage(),
    ]).then(function(parts) {
      var payload = {
        v: 1,
        at: Date.now(),
        from: browser.runtime.getManifest().version,
        tabs: parts[0],
        history: parts[1],
        cookies: parts[2],
        extensions: parts[3],
        prefs: parts[4],
        storage: parts[5],
      };
      var json = JSON.stringify(payload);
      log('info', 'payload: ' + json.length + ' bytes of JSON (' +
          payload.history.length + ' history, ' + payload.cookies.length +
          ' cookies, ' + payload.tabs.length + ' window(s), ' +
          payload.extensions.length + ' extension(s), ' +
          payload.prefs.length + ' pref(s))');
      return gzip(json);
    }).then(encrypt).then(function(enc) {
      var url = LINK_PREFIX + 'v=1' +
        '&k=' + bytesToB64url(enc.key) +
        '&i=' + bytesToB64url(enc.iv) +
        '&d=' + bytesToB64url(enc.data);
      var warning = '';
      if (url.length > 128 * 1024) {
        warning = 'This link is ' + Math.round(url.length / 1024) +
          ' KiB - larger than one command-line argument (128 KiB), so ' +
          'clicking it from another app may fail. Paste it into RozeLynx\u2019s ' +
          'address bar instead, or make another link with less history.';
      } else if (url.length > 100 * 1024) {
        warning = 'This link is around ' +
          Math.round(url.length / 1024) + ' KiB; some chat and mail ' +
          'transports truncate long links. Pastes into RozeLynx\u2019s address ' +
          'bar always work.';
      }
      return { ok: true, url: url, warning: warning };
    }).catch(function(e) {
      log('error', 'link creation failed:', e && e.message);
      return { ok: false, error: (e && e.message) || String(e) };
    });
  }

  // ── restore ─────────────────────────────────────────────────────────

  function parseLink(url) {
    var frag = url.indexOf('#');
    if (frag < 0 || url.indexOf(SCHEME) !== 0) {
      throw new Error('not a rozelynxsync link');
    }
    var params = {};
    url.slice(frag + 1).split('&').forEach(function(kv) {
      var eq = kv.indexOf('=');
      if (eq > 0) {
        params[kv.slice(0, eq)] = kv.slice(eq + 1);
      }
    });
    if (!params.k || !params.i || !params.d) {
      throw new Error('the link is missing its payload or key');
    }
    return {
      key: b64urlToBytes(params.k),
      iv: b64urlToBytes(params.i),
      data: b64urlToBytes(params.d),
    };
  }

  function closeSyncTabs() {
    // The browser's protocol handler parks the link and cancels the
    // navigation, but the tab the link opened in can still be sitting
    // there (and a pasted link navigates a tab). Close every
    // rozelynxsync:// tab so the restored state starts clean.
    return browser.tabs.query({}).then(function(tabs) {
      var doomed = (tabs || []).filter(function(t) {
        return typeof t.url === 'string' &&
          t.url.toLowerCase().indexOf(SCHEME) === 0;
      });
      return Promise.all(doomed.map(function(t) {
        return browser.tabs.remove(t.id).catch(function() {});
      }));
    }).catch(function() {});
  }

  function applyPrefs(list) {
    var api = browser.rozelynxPrefs;
    if (!api || !Array.isArray(list) || !list.length) {
      return Promise.resolve(0);
    }
    var set = {};
    var kept = 0;
    list.forEach(function(p) {
      if (!p || !p.name || p.name.indexOf('rozelynx.') !== 0) {
        // Only rozelynx.* crosses the link, on purpose: anything else is
        // either a build default (not state) or machine-specific (not
        // portable). The gather side sends only user-set values anyway; this
        // is the receiving side enforcing it on untrusted input.
        return;
      }
      if (p.type === 'boolean' || p.type === 'string' || p.type === 'integer') {
        set[p.name] = p.value;
        kept++;
      }
    });
    if (!kept) {
      return Promise.resolve(0);
    }
    return api.setPrefs(set).then(function(res) {
      if (res && res.ok === false) {
        log('warn', 'pref restore reported:', res.error);
      }
      return kept;
    });
  }

  function applyStorage(obj) {
    if (!obj || typeof obj !== 'object' ||
        !Object.keys(obj).length) {
      return Promise.resolve(0);
    }
    return browser.storage.local.set(obj).then(function() {
      return Object.keys(obj).length;
    }).catch(function(e) {
      log('warn', 'storage restore failed:', e && e.message);
      return 0;
    });
  }

  function cookieUrlFor(c) {
    var host = String(c.domain || '').replace(/^\./, '');
    var scheme = c.secure ? 'https' : 'http';
    return scheme + '://' + host + (c.path || '/');
  }

  function applyCookies(list) {
    if (!browser.cookies || !Array.isArray(list)) {
      return Promise.resolve(0);
  }
    var done = 0;
    var one = function(i) {
      if (i >= list.length) {
        return Promise.resolve(done);
      }
      var c = list[i] || {};
      if (!c.name || !c.domain) {
        return one(i + 1);
      }
      var details = {
        url: cookieUrlFor(c),
        name: c.name,
        value: String(c.value == null ? '' : c.value),
        path: c.path || '/',
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
      };
      if (!c.hostOnly) {
        details.domain = c.domain;
      }
      if (typeof c.expirationDate === 'number' && c.expirationDate > 0) {
        details.expirationDate = c.expirationDate;
      }
      return browser.cookies.set(details).then(function() {
        done++;
      }, function() {
        // A single bad cookie (bad domain, partitioned, expired) must not
        // lose the rest; the count at the end says how many made it.
      }).then(function() {
        return one(i + 1);
      });
    };
    return one(0).catch(function(e) {
      log('warn', 'cookie restore failed:', e && e.message);
      return done;
    });
  }

  function applyHistory(list) {
    if (!browser.history || !Array.isArray(list) || !list.length) {
      return Promise.resolve(0);
    }
    var done = 0;
    var one = function(i) {
      if (i >= list.length) {
        return Promise.resolve(done);
      }
      var h = list[i] || {};
      if (!h.url || !/^https?:/i.test(h.url)) {
        return one(i + 1);
      }
      return browser.history.addUrl({
        url: h.url,
        title: h.title || undefined,
      }).then(function() {
        done++;
      }, function() {}).then(function() {
        return one(i + 1);
      });
    };
    return one(0);
  }

  function applyTabs(windows) {
    if (!Array.isArray(windows)) {
      return Promise.resolve(0);
    }
    var opened = 0;
    var one = function(i) {
      if (i >= windows.length) {
        return Promise.resolve(opened);
      }
      var w = windows[i] || {};
      var urls = (w.tabs || []).map(function(t) { return t.url; });
      if (!urls.length) {
        return one(i + 1);
      }
      // One window per source window; pinned tabs are re-pinned by index
      // once the window exists (windows.create has no per-tab pinning).
      return browser.windows.create({ url: urls, focused: false })
        .then(function(win) {
          opened += urls.length;
          if (!win || !win.id) {
            return null;
          }
          var pins = (w.tabs || []).map(function(t, k) {
            return t.pinned ? k : -1;
          }).filter(function(k) { return k >= 0; });
          if (!pins.length) {
            return null;
          }
          return browser.tabs.query({ windowId: win.id }).then(function(fresh) {
            return Promise.all(pins.map(function(k) {
              if (fresh[k] && fresh[k].id) {
                return browser.tabs.update(fresh[k].id, { pinned: true })
                  .catch(function() {});
              }
            }));
          });
        }).catch(function(e) {
          log('warn', 'window restore failed:', e && e.message);
        }).then(function() {
          return one(i + 1);
        });
    };
    return one(0);
  }

  function installPageFor(ext) {
    if (ext.installURL) return ext.installURL;
    if (ext.homepageURL) return ext.homepageURL;
    if (/@addons\.mozilla\.org$/.test(ext.id)) {
      return 'https://addons.mozilla.org/firefox/addon/' +
        ext.id.replace(/@addons\.mozilla\.org$/, '') + '/';
    }
    if (/@chromium\.org$/.test(ext.id) || ext.id.indexOf('chrom') >= 0) {
      return 'https://chromewebstore.google.com/detail/' + ext.id;
    }
    return 'https://addons.mozilla.org/firefox/search/?q=' +
      encodeURIComponent(ext.name || ext.id);
  }

  function applyExtensions(list, installedById) {
    if (!Array.isArray(list)) {
      return Promise.resolve(0);
    }
    var missing = list.filter(function(ext) {
      return ext && ext.id && !installedById[ext.id];
    });
    if (!missing.length) {
      return Promise.resolve(0);
    }
    // The XPIs cannot ride the link; what the link carries is the LIST, and
    // the restore opens one install-page tab per extension that is not
    // already here. Missing+disabled entries are included: an extension the
    // source had switched off still ends up available to switch off here.
    var urls = missing.map(installPageFor);
    return browser.windows.create({ url: urls, focused: true })
      .then(function() { return missing.length; })
      .catch(function(e) {
        log('warn', 'extension install-page restore failed:', e && e.message);
        return 0;
      });
  }

  function notify(text) {
    try {
      browser.notifications.create({
        type: 'basic',
        iconUrl: browser.runtime.getURL('icons/icon128.png'),
        title: 'RozeLynx sync',
        message: text,
      });
    } catch (e) {}
  }

  function restoreFromLink(url) {
    var payload = null;
    return closeSyncTabs().then(function() {
      var enc = parseLink(url);
      return decrypt(enc.key, enc.iv, enc.data);
    }).then(function(plain) {
      return gunzip(plain);
    }).then(function(json) {
      payload = JSON.parse(json);
      if (!payload || payload.v !== 1) {
        throw new Error('unknown sync payload version');
      }
      log('info', 'restoring a link made ' + new Date(payload.at).toISOString());
      return applyPrefs(payload.prefs);
    }).then(function() {
      return applyStorage(payload.storage);
    }).then(function() {
      return applyCookies(payload.cookies);
    }).then(function() {
      return applyHistory(payload.history);
    }).then(function() {
      return applyTabs(payload.tabs);
    }).then(function(tabsOpened) {
      var installedById = {};
      var listExtensions = browser.management
        ? browser.management.getAll().catch(function() { return []; })
        : Promise.resolve([]);
      return listExtensions.then(function(list) {
        (list || []).forEach(function(a) { installedById[a.id] = true; });
        return applyExtensions(payload.extensions, installedById);
      }).then(function(extPages) {
        notify('State restored: ' + tabsOpened + ' tab(s), ' +
          (payload.cookies ? payload.cookies.length : 0) + ' cookie(s), ' +
          (payload.history ? payload.history.length : 0) +
          ' history entr(ies)' +
          (extPages ? ', ' + extPages +
            ' extension install page(s) opened' : '') + '.');
      });
    }).catch(function(e) {
      log('error', 'restore failed:', e && e.message);
      notify('The sync link could not be restored: ' +
        ((e && e.message) || e));
    });
  }

  // ── wiring ───────────────────────────────────────────────────────────

  browser.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    var action = message && message.action;
    if (action === 'sync:present') {
      sendResponse({ ok: true, version: browser.runtime.getManifest().version });
      return false;
    }
    if (action === 'sync:create') {
      createLink(message.historyDepth || '5000').then(sendResponse);
      return true;
    }
    if (action === 'sync:parse') {
      // Used by the UI's "restore from a pasted link" box: decrypt and
      // restore right here, same path as onSyncLink.
      try {
        restoreFromLink(String(message.url || '')).then(function() {
          sendResponse({ ok: true });
        });
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) || String(e) });
      }
      return true;
    }
    return false;
  });

  // The live event: fired by the rozelynxSync experiment API whenever the
  // browser sees a rozelynxsync:// navigation (persisted event, so a link
  // that arrives while this event page is suspended wakes it and replays).
  if (browser.rozelynxSync && browser.rozelynxSync.onSyncLink) {
    browser.rozelynxSync.onSyncLink.addListener(function(info) {
      if (info && info.url) {
        log('info', 'sync link received');
        restoreFromLink(info.url);
      }
    });
    // A link can arrive while the background is DOWN (browser just
    // launched with the link on the command line, the event page wakes
    // after the notification): the experiment API parks it, and the slot is
    // drained here, once, at startup.
    try {
      Promise.resolve(browser.rozelynxSync.getPendingLink()).then(function(url) {
        if (url) {
          log('info', 'draining a parked sync link');
          restoreFromLink(url);
        }
      }).catch(function() {});
    } catch (e) {}
  }

  log('info', 'sync engine ready');
})();
