// external-link module for RozeLynx Features extension
//
// Backs the profile & network-interface chooser page (choose.html) that the
// browser shows when a link is opened from another program (see
// ExternalLinkCommandLineHandler.sys.mjs / the rozelynx wrapper):
//
//   external-link:profiles  -> list profiles + running state (native host)
//   external-link:open      -> open {url} in {profile}, binding {iface}
//
// When the chosen profile is the profile hosting the chooser, the tab is
// created here directly and bound per-tab via the netiface experiment API.
// Any other profile is dispatched through the native host, which launches
// `rozelynx -P <dir> --external-link-open <url> --external-link-iface <n>`;
// the D-Bus remote lands that in the running instance of that profile (or
// a fresh one), where the same command-line handler opens the tab and binds
// its interface.

(function() {
  'use strict';

  var LOG_PREFIX = '[RozeLynx:external-link]';
  var HOST = 'rozelynx_host';
  var ADDON_ID = 'rozelynx-features@bytewheel.org';

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

  function native(action, extra) {
    var message = extra || {};
    message.action = action;
    return browser.runtime.sendNativeMessage(HOST, message).then(function(r) {
      if (r && r.ok) {
        return r;
      }
      var err = r && r.error ? r.error : 'no native host response';
      throw new Error(err);
    });
  }

  function bindTab(tabId, iface) {
    if (!iface) {
      return Promise.resolve();
    }
    try {
      if (browser.rozelynxNetIface && browser.rozelynxNetIface.setAssignment) {
        return Promise.resolve(browser.rozelynxNetIface.setAssignment(tabId, iface));
      }
    } catch (e) {
      log('warn', 'netiface API unavailable, no tab binding:', e.message);
    }
    return Promise.resolve(null);
  }

  function setCurrentProfileDefault(iface, currentDir) {
    // Live effect across every channel of this profile immediately.
    try {
      if (browser.rozelynxNetIface && browser.rozelynxNetIface.setProfileInterface) {
        browser.rozelynxNetIface.setProfileInterface(iface);
      }
    } catch (e) {
      log('warn', 'setProfileInterface failed:', e.message);
    }
    // Persist for the next start via the native host (merge-safe user.js).
    if (!currentDir) {
      log('warn', 'no current profile dir; default iface not persisted');
      return Promise.resolve();
    }
    return native('set-prefs', {
      profile: currentDir,
      prefs: { 'rozelynx.netiface.profile': iface },
    }).then(function() {
      log('info', 'set profile default iface ->', iface);
    });
  }

  function listProfiles() {
    return native('profiles').then(function(r) {
      return {
        profiles: r.profiles || [],
        defaultDir: r.default || '',
        currentDir: '',
      };
    });
  }

  function openLink(data) {
    var url = (data && data.url) || '';
    var profile = (data && data.profile) || '';
    var iface = (data && data.iface) || '';
    var setDefault = !!(data && data.setDefault);
    var current = (data && data.current) || '';

    if (!url) {
      return Promise.reject(new Error('no url'));
    }

    if (profile === current) {
      // Same profile as the chooser: create the tab here and bind per-tab.
      return browser.tabs.create({ url: url }).then(function(tab) {
        return bindTab(tab && tab.id, iface).then(function() {
          // Empty iface == all interfaces, and that is a legitimate profile
          // default, so this is not gated on a non-empty value. The '*'
          // sentinel is the PER-TAB flavour of the same thing: ResolveForLoad
          // translates it back to empty in the TAB layer only, so it must
          // never be written as the profile default -- the profile layer
          // would hand it to SO_BINDTODEVICE verbatim and refuse every bind.
          // Its profile-default equivalent is the empty pref.
          if (setDefault) {
            var profileIface = iface === '*' ? '' : iface;
            return setCurrentProfileDefault(profileIface, current).then(function() {
              return { mode: 'tab', tabId: tab && tab.id };
            });
          }
          return { mode: 'tab', tabId: tab && tab.id };
        });
      });
    }

    // Another profile: the native host launches this profile (via the
    // wrapper) with --external-link-open/-iface, which lands in its running
    // instance or starts it fresh.
    return native('open-rozelynx-profile', {
      profile: profile,
      url: url,
      iface: iface,
      setDefault: setDefault,
    }).then(function() {
      return { mode: 'launch' };
    });
  }

  // ── Message routing ─────────────────────────────────────────────

  function dispatch(action, message) {
    if (action === 'external-link:profiles') {
      return listProfiles();
    }
    if (action === 'external-link:netifaces') {
      // Fallback source for the interface dropdown when the compiled
      // netiface service (@bytewheel.org/netiface;1) is unavailable.
      return native('netifaces').then(function(r) {
        return { interfaces: (r && r.interfaces) || [] };
      });
    }
    return openLink(message.data || {});
  }

  browser.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    var action = message && message.action;
    if (action !== 'external-link:profiles' &&
        action !== 'external-link:netifaces' &&
        action !== 'external-link:open') {
      return false;
    }
    Promise.resolve()
      .then(function() {
        return dispatch(action, message);
      })
      .then(function(result) {
        sendResponse({ ok: true, data: result });
      })
      .catch(function(err) {
        log('error', action, '->', String(err));
        sendResponse({ ok: false, error: String(err.message || err) });
      });
    return true;
  });

  // ── Feature loader entry ─────────────────────────────────────────

  if (typeof RozeLynxFeatures !== 'undefined' && RozeLynxFeatures.loadedModules) {
    RozeLynxFeatures.loadedModules['external-link'] = true;
  }

  log('info', 'external-link module init');
})();