// PWA Module for RozeLynx - Background Script
// Adapted from Floorp's PWA and SSB system
// Enables installing sites as Progressive Web Apps with Linux taskbar integration
//
// Launch contract (v1.0.25+):
//  * Every PWA launch URL carries the marker "#rozelynx-pwa=1" so content
//    scripts can recognise app-window pages without asking the background
//    (the background is an event page and may be asleep).
//  * A PWA window is created WITHOUT a url and receives exactly ONE
//    tabs.update() navigation (double navigation broke app hydration).
//  * PWA windows are tracked in rozelynx_pwa_windows; tabs created or
//    navigated out of the app scope are bounced back to a normal window.
//
// Launcher entries: installing a PWA also writes a .desktop entry into
// $XDG_DATA_HOME/applications, which launches it from OUTSIDE the browser
// through `rozelynx --ssb <url>`. The parent process writes that file
// (DesktopEntry below, via rozelynxWindows.writeDesktopEntry) because a
// WebExtension has no filesystem API, and it is the only reason the
// --profile pin and StartupWMClass grouping in the Exec line are reachable
// at all. Gated on rozelynx.pwa.generateDesktopEntries (default true).

(function() {
  'use strict';

  var STORAGE_KEY = 'rozelynx_pwa_sites';
  var WINDOWS_KEY = 'rozelynx_pwa_windows';
  var PWA_MARKER = 'rozelynx-pwa=1';

  // PWA Data Store
  var DIAG_KEY = 'rozelynx_pwa_diag';
  function bgDiag(entry) {
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

  function appendMarker(url) {
    try {
      var u = new URL(url);
      if (u.searchParams && u.searchParams.set) {
        var hash = u.hash || '';
        u.hash = '';
        u.searchParams.set('rozelynx_pwa_ignore', '1'); // placeholder noop
      }
    } catch (e) {}
    // Safe merge: append to the hash, preserving an existing one.
    var sep = url.indexOf('#') >= 0 ? '&' : '#';
    if (url.slice(-1) === '#') sep = '';
    return url + sep + PWA_MARKER;
  }

  function stripMarker(url) {
    if (!url) return url;
    // remove "rozelynx-pwa=1" param and trailing separators
    var out = url.replace(/[#&]rozelynx-pwa=1/, '');
    return out;
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

  function sameOrigin(url1, url2) {
    try {
      return new URL(url1).origin === new URL(url2).origin;
    } catch (e) {
      return false;
    }
  }

  // Find an existing normal (non-PWA) browser window.  Returns the window
  // object or null if all browser windows are PWA windows.
  async function findExistingRegularWindow() {
    try {
      var wins = await browser.windows.getAll({ windowTypes: ['normal'] });
      for (var i = 0; i < wins.length; i++) {
        if (!PWAWindows.isPWAWindow(wins[i].id)) return wins[i];
      }
    } catch (e) {}
    return null;
  }

  var PWAStore = {
    sites: [],

    load: async function() {
      try {
        var stored = await browser.storage.local.get(STORAGE_KEY);
        if (stored[STORAGE_KEY]) {
          PWAStore.sites = JSON.parse(stored[STORAGE_KEY]);
        }
      } catch (e) {
        console.error('[RozeLynx PWA] Failed to load data store:', e);
        PWAStore.sites = [];
      }
    },

    save: async function() {
      try {
        var data = {};
        data[STORAGE_KEY] = JSON.stringify(PWAStore.sites);
        await browser.storage.local.set(data);
      } catch (e) {
        console.error('[RozeLynx PWA] Failed to save data store:', e);
      }
    },

    addSite: function(site) {
      var existing = PWAStore.sites.findIndex(function(s) { return s.id === site.id; });
      if (existing >= 0) {
        PWAStore.sites[existing] = Object.assign({}, PWAStore.sites[existing], site);
      } else {
        PWAStore.sites.push(site);
      }
      PWAStore.save();
    },

    removeSite: function(siteId) {
      PWAStore.sites = PWAStore.sites.filter(function(s) { return s.id !== siteId; });
      PWAStore.save();
    },

    getSite: function(siteId) {
      return PWAStore.sites.find(function(s) { return s.id === siteId; });
    },

    getAll: function() {
      return PWAStore.sites.slice();
    }
  };

  // PWA window registry: windowId -> { siteId, startUrl, scope }
  var PWAWindows = {
    windows: {},

    load: async function() {
      try {
        var stored = await browser.storage.local.get(WINDOWS_KEY);
        if (stored[WINDOWS_KEY]) {
          PWAWindows.windows = JSON.parse(stored[WINDOWS_KEY]);
        }
      } catch (e) {
        PWAWindows.windows = {};
      }
      // Drop entries for windows that no longer exist.
      try {
        var wins = await browser.windows.getAll({ windowTypes: ['popup', 'normal'] });
        var live = {};
        wins.forEach(function(w) { live[w.id] = true; });
        Object.keys(PWAWindows.windows).forEach(function(id) {
          if (!live[id]) delete PWAWindows.windows[id];
        });
        await PWAWindows.save();
      } catch (e) {}
    },

    save: async function() {
      try {
        var data = {};
        data[WINDOWS_KEY] = JSON.stringify(PWAWindows.windows);
        await browser.storage.local.set(data);
      } catch (e) {}
    },

    add: function(windowId, site) {
      PWAWindows.windows[windowId] = {
        siteId: site.id,
        startUrl: site.startUrl,
        scope: site.scope || site.startUrl,
      };
      PWAWindows.save();
    },

    remove: function(windowId) {
      if (PWAWindows.windows[windowId]) {
        delete PWAWindows.windows[windowId];
        PWAWindows.save();
      }
    },

    get: function(windowId) {
      return PWAWindows.windows[windowId];
    },

    isPWAWindow: function(windowId) {
      return !!PWAWindows.windows[windowId];
    }
  };

  // Taskbar Integration - calls RozeLynxLinuxTaskbar XPCOM component via C++
  // The C++ component is compiled into libxul and accessible via XPConnect.
  //
  // The extension cannot touch that contract itself (it is a parent-process
  // XPCOM component), so every call goes through the rozelynxWindows
  // experiment API alongside the other window/chrome helpers. The component is
  // only built with USE=pwa on a GTK widget, so availability is probed ONCE
  // per background-page lifetime and cached as the in-flight promise (latching
  // a boolean instead would let the first launch race the probe and silently
  // skip the taskbar); when it is missing this logs the reason once and the
  // window simply keeps its default class and icon, exactly as before.
  //
  // setWindowClass is what makes a PWA window group under its launcher entry:
  // generateDesktopEntry writes StartupWMClass=rozelynx-<safe name>, and that
  // has to match the window's WM_CLASS for the taskbar/launcher to associate
  // the two. setWindowIcon exists because the icon is stored as a data: URL
  // (ManifestProcessor.fetchIcon) while the C++ takes a path for
  // gdk_pixbuf_new_from_file, so the parent materialises it under
  // Is the --ssb command-line handler reachable?  (PLAN-SESSION-20 G.9)
  //
  // Probed once at module load, not on the first PWA launch, because the whole
  // point is to have the answer in the ring after a plain browser start: the
  // failure this diagnoses is one where nothing PWA-shaped happens at all.  A
  // user clicking a .desktop entry and getting no app window has no reason to
  // go looking in a diagnostic ring that only fills when they launch a PWA.
  //
  // Gecko's handler dispatch (nsCommandLine::EnumerateHandlers) logs "could not
  // be created" and CONTINUES on failure, so a handler that cannot be reached
  // is silent.  Asking for the contract from here is the same probe shape as
  // TaskbarIntegration.isAvailable and reports the exception instead of
  // swallowing it.
  var SsbHandler = {
    _probe: null,

    /* bgDiag's ring holds up to 30 long messages, and a structured clone that
     * size interleaves non-printable bytes INTO the values - "member=function"
     * arrives as "member=fun" plus binary, and a short value is unrecoverable.
     * A separate key, a cap of 3, and messages kept short is what makes this
     * readable; the reconcile line survived precisely because it was one of only
     * two entries in a profile whose ring had not yet grown. This is a second
     * diagnostic channel, and it exists for that reason rather than for taste. */
    _diag: function(msg) {
      try {
        var KEY = 'rozelynx_pwa_ssbdiag';
        // Serialised on purpose. The first version did a bare get-then-set per
        // call, so concurrent calls each read the same array and the last write
        // won - which is exactly how the control's value went missing from the
        // ring. A diagnostic that drops entries under concurrency is worse than
        // no diagnostic, because it looks like a result.
        SsbHandler._diagChain = (SsbHandler._diagChain || Promise.resolve())
          .then(function() {
            return browser.storage.local.get(KEY).then(function(stored) {
              var arr = [];
              try {
                arr = stored && stored[KEY] ? JSON.parse(stored[KEY]) : [];
              } catch (e) { arr = []; }
              if (!Array.isArray(arr)) arr = [];
              arr.push(String(msg).slice(0, 80));
              while (arr.length > 6) arr.shift();
              var d = {};
              d[KEY] = JSON.stringify(arr);
              return browser.storage.local.set(d);
            });
          })
          .catch(function() {});
        return SsbHandler._diagChain;
      } catch (e) {}
    },

    status: function() {
      if (this._probe) return this._probe;
      this._probe = (async function() {
        if (!browser.rozelynxWindows) {
          return {
            ok: true,
            available: false,
            error: 'browser.rozelynxWindows missing entirely (not a USE=pwa build?)',
          };
        }
        // Three facts before the call, because the call itself is what failed
        // last time and a bare rejection said nothing: is the namespace there,
        // what TYPE is the member, and is a KNOWN-GOOD sibling call alive? A
        // control is what separates "the API is broken" from "this one function
        // is broken", and 1.0.61 could not tell them apart.
        SsbHandler._diag('pre api=' + typeof browser.rozelynxWindows +
                 ' mem=' + typeof browser.rozelynxWindows.ssbHandlerStatus +
                 ' ctl=' + typeof browser.rozelynxWindows.getProfilePath);
        var control = 'not attempted';
        try {
          var c = await browser.rozelynxWindows.getProfilePath();
          control = (c && c.ok) ? 'ok' : ('unusable: ' + JSON.stringify(c));
        } catch (ce) {
          control = 'threw ' + (ce && ce.name ? ce.name + ': ' + ce.message : String(ce));
        }
        SsbHandler._diag('ctl ' + String(control).slice(0, 70));
        if (typeof browser.rozelynxWindows.ssbHandlerStatus !== 'function') {
          return {
            ok: true,
            available: false,
            error: 'ssbHandlerStatus is ' + typeof browser.rozelynxWindows.ssbHandlerStatus +
                   ' on the namespace: the parent has the schema entry but not the ' +
                   'implementation, or the XPI the parent loaded is not this one',
          };
        }
        return browser.rozelynxWindows.ssbHandlerStatus();
      })().then(function(res) {
        if (res && res.ok && res.available) {
          bgDiag('ssb-handler available contract=' + res.contract +
                 ' class=' + (res.classDescription || '(none)'));
          SsbHandler._diag('yes ' + String(res.classDescription || '(none)').slice(0, 60));
        } else {
          var reason = (res && res.error) || 'no reason given';
          console.warn('[RozeLynx PWA] --ssb command-line handler unavailable (' +
            reason + '); a .desktop entry will not open an app window, and the ' +
            'browser will open the Exec line\'s bare arguments as URLs instead');
          bgDiag('ssb-handler UNAVAILABLE contract=' +
                 ((res && res.contract) || '@mozilla.org/browser/ssb/clh;1') +
                 ' ' + reason);
          SsbHandler._diag('no ' + String(reason).slice(0, 70));
        }
        return res;
        return res;
      }, function(e) {
        // name, message AND stack: last time only the wrapper's one-line
        // "InvalidStateError: An exception was thrown by the handler" was
        // captured, which names the wrapper and not the cause.
        var detail = 'name=' + (e && e.name) + ' message=' + (e && e.message) +
                     ' stack=' + ((e && e.stack) ? String(e.stack).split('\n').slice(0, 3).join(' | ') : '(none)');
        bgDiag('ssb-handler-probe-throw ' + detail);
        SsbHandler._diag('err ' + (e && e.name) + ': ' +
                         String((e && e.message) || '').slice(0, 60));
        SsbHandler._diag('at ' + String((e && e.stack) || '(no stack)').split('\n')[0].slice(0, 70));
        console.warn('[RozeLynx PWA] --ssb handler probe threw: ' + detail);
        return { ok: false, available: false, error: detail };
      });
      return this._probe;
    },
  };

  // <profile>/pwa-icons/ first.
  var TaskbarIntegration = {
    _probe: null,

    isAvailable: function() {
      if (this._probe) return this._probe;
      this._probe = (async function() {
        if (!browser.rozelynxWindows || !browser.rozelynxWindows.isTaskbarAvailable) {
          return {
            ok: true,
            available: false,
            error: 'rozelynxWindows.isTaskbarAvailable missing (not a USE=pwa build?)',
          };
        }
        return browser.rozelynxWindows.isTaskbarAvailable();
      })().then(function(res) {
        if (!(res && res.ok && res.available)) {
          var reason = (res && res.error) || 'no reason given';
          console.warn('[RozeLynx PWA] Linux taskbar integration unavailable: ' +
            reason + '; PWA windows keep their default class and icon');
          bgDiag('taskbar-unavailable ' + reason);
          return false;
        }
        return true;
      }).catch(function(e) {
        console.warn('[RozeLynx PWA] taskbar probe failed: ' + e);
        bgDiag('taskbar-probe-failed ' + e);
        return false;
      });
      return this._probe;
    },

    setWindowClass: async function(windowId, klass, title) {
      if (!await this.isAvailable()) {
        return { ok: false, error: 'taskbar integration unavailable' };
      }
      try {
        var res = await browser.rozelynxWindows.setWindowClass(windowId, klass, title);
        bgDiag('taskbar-class window=' + windowId + ' class=' + klass +
          ' ok=' + !!(res && res.ok) +
          (res && res.ok
            ? ' via=' + (res.via || '?') +
              // `qiError` is the sandbox QueryInterface's own refusal, kept
              // because the ring used to record this line's failure as the
              // extension's own sentence ("... is not a mozIDOMWindowProxy"),
              // which named no cause and made the next occurrence unreadable.
              (res.qiError ? ' qiError=' + res.qiError : '')
            : ' error=' + ((res && res.error) || 'none')));
        return res;
      } catch (e) {
        bgDiag('taskbar-class-throw window=' + windowId + ' ' + e);
        return { ok: false, error: String(e) };
      }
    },

    setWindowIcon: async function(windowId, site) {
      if (!await this.isAvailable()) {
        return { ok: false, error: 'taskbar integration unavailable' };
      }
      // Both install paths store the manifest icon as a data: URL (see
      // ManifestProcessor.fetchIcon), and a site installed from a URL alone
      // carries no icon at all - both are normal, so neither is an error.
      // materialiseIcon is the same call the launcher entry uses, so the
      // window icon and the .desktop Icon= key are the same file.
      var iconPath = '';
      try {
        iconPath = await materialiseIcon(site);
      } catch (e) {
        bgDiag('taskbar-icon-materialise-throw window=' + windowId + ' ' + e);
      }
      if (!iconPath) {
        bgDiag('taskbar-icon-skip window=' + windowId + ' no-icon-file');
        return { ok: false, error: 'site has no usable icon file' };
      }
      try {
        var res = await browser.rozelynxWindows.setWindowIconFromPath(windowId, iconPath);
        bgDiag('taskbar-icon window=' + windowId + ' path=' + iconPath +
          ' ok=' + !!(res && res.ok) +
          (res && res.ok
            ? ' via=' + (res.via || '?') + (res.qiError ? ' qiError=' + res.qiError : '')
            : ' error=' + ((res && res.error) || 'none')));
        return res;
      } catch (e) {
        bgDiag('taskbar-icon-throw window=' + windowId + ' ' + e);
        return { ok: false, error: String(e) };
      }
    },
  };

  // --- Generated .desktop entries on disk -------------------------------
  // generateDesktopEntry() produces the text; this is what puts it somewhere a
  // launcher can find it. The write happens in the parent process for the same
  // reason writeIconFile does: a WebExtension has no filesystem API.
  //
  // The destination is $XDG_DATA_HOME/applications, falling back to
  // ~/.local/share/applications (the rule Gecko itself applies in
  // ShellService._getLinuxDesktopEntryPath). No desktop database is refreshed:
  // these entries declare no MimeType, so update-desktop-database has nothing
  // to record, and a desktop environment rescans the applications directory
  // on its own.
  //
  // rozelynx.pwa.generateDesktopEntries (default true, declared in
  // files/rozelynx/prefs/rozelynx-prefs.js and previously read by nothing) is
  // the off switch. It is the difference between "installing a PWA writes a
  // file into the user's home directory" and not, so it is read on every
  // install rather than cached: about:config is the project's source of truth
  // for configuration and a stale cache would be its opposite.
  var DesktopEntry = {
    PREF: 'rozelynx.pwa.generateDesktopEntries',
    PREF_DEFAULT: true,
    // Icon name the ebuild installs into the hicolor theme
    // (newicon ... rozelynx.png, ebuild "Install icons and desktop"). An
    // Icon= value is either an absolute path or an icon NAME; the old
    // 'rozelynx-pwa' fallback resolved to nothing in any theme, and
    // site.iconPath carried a data: URL, which the specification does not
    // allow as an Icon value at all.
    FALLBACK_ICON: 'rozelynx',

    _api: function(name) {
      return browser.rozelynxWindows && browser.rozelynxWindows[name] || null;
    },

    enabled: function() {
      var api = (typeof browser.rozelynxPrefs !== 'undefined' &&
                 browser.rozelynxPrefs.getPrefs) ? browser.rozelynxPrefs : null;
      if (!api) {
        // No prefs API (a parent older than it, or a build whose privileged
        // half failed to load): the pref file's own default applies.
        return Promise.resolve(this.PREF_DEFAULT);
      }
      return Promise.resolve(api.getPrefs([this.PREF])).then(function(list) {
        var pref = null;
        (list || []).forEach(function(p) {
          if (p && p.name === DesktopEntry.PREF) pref = p;
        });
        if (pref && pref.type === 'boolean') return !!pref.value;
        return DesktopEntry.PREF_DEFAULT;
      }, function(e) {
        console.warn('[RozeLynx PWA] ' + DesktopEntry.PREF + ' read failed (' + e +
          '); using the default ' + DesktopEntry.PREF_DEFAULT);
        return DesktopEntry.PREF_DEFAULT;
      });
    },

    // Materialise the icon, generate the text, hand both to the parent. Never
    // throws: a PWA is installed and launchable from the browser popup whether
    // or not a launcher entry could be written, so every failure is reported
    // and logged rather than propagated into the install.
    write: async function(site) {
      try {
        if (!site) return { ok: false, error: 'no site' };
        if (!await this.enabled()) {
          bgDiag('desktop-entry-skip pref=' + this.PREF);
          return { ok: false, skipped: 'disabled' };
        }
        var write = this._api('writeDesktopEntry');
        if (!write) {
          return { ok: false, error: 'rozelynxWindows.writeDesktopEntry missing' };
        }
        var iconPath = '';
        try {
          iconPath = await materialiseIcon(site);
        } catch (e) {
          // The entry is still worth writing without a site icon: Icon= falls
          // back to the app icon name.
          bgDiag('desktop-entry-icon-failed site=' + site.id + ' ' + e);
        }
        var entry = await ManifestProcessor.generateDesktopEntry(site, iconPath);
        var res = await write(entry.filename, entry.content);
        if (!res || !res.ok) {
          var reason = (res && res.error) || 'no result';
          bgDiag('desktop-entry-write-failed site=' + site.id + ' ' + reason);
          return { ok: false, error: reason };
        }
        bgDiag('desktop-entry site=' + site.id + ' path=' + res.path +
          ' bytes=' + res.bytes + ' icon=' + (iconPath || '(app icon)'));
        return { ok: true, path: res.path, filename: entry.filename, iconPath: iconPath };
      } catch (e) {
        bgDiag('desktop-entry-throw ' + e);
        return { ok: false, error: String(e) };
      }
    },

    // Deliberately NOT gated on that pref: a user who turns the feature off
    // must still be able to clear the entries an earlier version wrote, and
    // "uninstall" has to mean the file is gone either way.
    remove: async function(site) {
      try {
        if (!site) return { ok: false, error: 'no site' };
        var remove = this._api('removeDesktopEntry');
        if (!remove) {
          return { ok: false, error: 'rozelynxWindows.removeDesktopEntry missing' };
        }
        var filename = pwaDesktopFileName(site);
        var res = await remove(filename);
        if (!res || !res.ok) {
          var reason = (res && res.error) || 'no result';
          bgDiag('desktop-entry-remove-failed site=' + site.id + ' ' + reason);
          return { ok: false, error: reason };
        }
        bgDiag('desktop-entry-removed site=' + site.id + ' path=' + res.path +
          ' removed=' + !!res.removed);
        return { ok: true, path: res.path, filename: filename, removed: !!res.removed };
      } catch (e) {
        bgDiag('desktop-entry-remove-throw ' + e);
        return { ok: false, error: String(e) };
      }
    },

    // Write an entry for every installed app that does not have one.
    //
    // B.4 shipped the writer with both install paths asking for it, and that is
    // only enough for apps installed *after* it: an app installed earlier has a
    // site record and no file, and the extension had no way to change that -
    // write always rewrites, remove always removes, and nothing asked "is it
    // there?". So the launcher entries for every pre-existing install had to be
    // produced by uninstalling and reinstalling each app by hand.
    //
    // This is that missing third operation, run once when the module loads. It
    // is idempotent (one stat per site, and only the missing ones are written),
    // it is gated on the same pref as install, and it is not gated on removal -
    // turning the feature off must not delete what an earlier version wrote.
    //
    // Every failure is per site and swallowed: a reconcile pass that throws
    // would take the rest of the module's start-up with it, and a PWA with no
    // launcher entry is exactly the state this is here to leave.
    reconcile: async function() {
      var written = 0;
      var present = 0;
      var failed = 0;
      try {
        if (!await this.enabled()) {
          bgDiag('desktop-entry-reconcile-skip pref=' + this.PREF);
          return { ok: true, skipped: 'disabled' };
        }
        var has = this._api('hasDesktopEntry');
        if (!has) {
          // A parent older than this build. Nothing to do, and saying so is
          // better than reporting "0 written" as if the pass had run.
          bgDiag('desktop-entry-reconcile-skip no hasDesktopEntry');
          return { ok: false, error: 'rozelynxWindows.hasDesktopEntry missing' };
        }
        if (!PWAStore.sites.length) {
          await PWAStore.load();
        }
        var sites = PWAStore.sites.slice();
        for (var i = 0; i < sites.length; i++) {
          var site = sites[i];
          try {
            if (!site) continue;
            var found = await has(pwaDesktopFileName(site));
            if (found && found.ok && found.exists) {
              present++;
              continue;
            }
            var res = await this.write(site);
            if (res && res.ok) {
              written++;
            } else {
              failed++;
              bgDiag('desktop-entry-reconcile-failed site=' + site.id + ' ' +
                ((res && res.error) || 'unknown'));
            }
          } catch (e) {
            failed++;
            bgDiag('desktop-entry-reconcile-throw site=' +
              ((site && site.id) || '?') + ' ' + e);
          }
        }
        bgDiag('desktop-entry-reconcile sites=' + sites.length +
          ' written=' + written + ' present=' + present + ' failed=' + failed);
        return { ok: failed === 0, written: written, present: present, failed: failed };
      } catch (e) {
        bgDiag('desktop-entry-reconcile-throw ' + e);
        return { ok: false, error: String(e) };
      }
    },
  };

  // --- Generated .desktop entries ---------------------------------------
  // A generated entry launches the app from OUTSIDE the browser, through the
  // shell, so it cannot reach the extension at all: the only thing that
  // carries the "which profile" answer is the command line itself.
  //
  // Firefox identifies a remote instance by the FULL PROFILE PATH, not by the
  // profile name (nsAppRunner.cpp: "Use the full profile path to identify the
  // profile", and nsToolkitProfileService::SelectStartupProfile takes
  // --profile <path> ahead of -P <name> and ahead of the default-profile
  // fallback). An Exec line with no --profile therefore always resolves to the
  // DEFAULT profile: in a secondary-profile workflow the PWA either attaches
  // to / opens in the wrong instance, or spawns a fresh default-profile
  // process. Writing --profile <ProfD> into the Exec line is what makes the
  // entry land back in the profile that installed it.
  //
  // --profile takes a path and REQUIRES it to be an existing directory
  // (SelectStartupProfile prints "Error: argument --profile requires a path to
  // a directory" and aborts startup otherwise), so the value is only emitted
  // when the experiment API could actually resolve ProfD. Without the API -
  // a non-rozelynx build, or an extension whose privileged half failed to
  // load - the entry falls back to today's behaviour rather than emitting a
  // profile flag that could make the browser refuse to start.

  // Three things have to agree on a PWA's derived names: the Exec line's
  // --ssb-class, the StartupWMClass the launcher groups windows by, and the
  // WM_CLASS the compiled taskbar component actually sets when the app is
  // launched from inside the browser. They are computed here once so they
  // cannot drift.
  //
  // The fallback reproduces what PWAManager.launch already produced for a site
  // with no usable name ('RozeLynx App' sanitised to 'rozelynx_app'), so the
  // WM_CLASS of a launch with no stored site is unchanged.
  function pwaSafeName(site) {
    var raw = String((site && site.name) || '')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .toLowerCase();
    return raw || 'rozelynx_app';
  }

  function pwaWindowClass(site) {
    return 'rozelynx-' + pwaSafeName(site);
  }

  // The site id is a hash of the start URL, so it is the part of the name that
  // is actually unique. Two PWAs whose names sanitise to the same string
  // ("My App" and "My.App" both give my_app) would otherwise share one file:
  // the second install would overwrite the first one's launcher entry, and
  // removing either would take the other's with it.
  function pwaDesktopFileName(site) {
    var id = String((site && site.id) || '').replace(/[^A-Za-z0-9_-]/g, '');
    return 'rozelynx-pwa-' + pwaSafeName(site) + (id ? '-' + id : '') + '.desktop';
  }

  // The manifest icon only ever exists as a data: URL (ManifestProcessor.
  // fetchIcon reads it through a FileReader), while both the C++ icon setter
  // and a .desktop Icon= key want a file on disk. One materialiser serves
  // both, so the window icon and the launcher icon can never be two
  // different files. Returns '' for a site with no icon, for a payload that
  // is not a data: URL, and when the privileged write is unavailable - all
  // three are normal, not errors.
  async function materialiseIcon(site) {
    var dataUrl = site && site.icon;
    if (!dataUrl || String(dataUrl).indexOf('data:') !== 0) return '';
    if (!browser.rozelynxWindows || !browser.rozelynxWindows.writeIconFile) return '';
    var written = await browser.rozelynxWindows.writeIconFile(dataUrl, site.id);
    if (!written || !written.ok || !written.path) return '';
    return written.path;
  }

  // Desktop Entry spec quoting for Exec values: "Arguments may be quoted in
  // whole. If an argument contains a reserved character, the argument must be
  // quoted." Reserved = space, tab, newline, " ' \ > < ~ | & ; $ * ? # ( ) and
  // backtick. Inside the quotes, the spec defines exactly four escapes - \",
  // \`, \$ and \\ - and nothing else, so those are the only four escaped here:
  // escaping anything else (an earlier version escaped & too) emits an
  // undefined escape sequence, which a strict parser either rejects or passes
  // through with the backslash still attached, corrupting the URL.
  // The URL used to be wrapped in quotes with nothing escaped at all, so a '"'
  // or '$' in a start URL was already broken; a profile path with a space in
  // the home directory is the likelier offender.
  function quoteExecValue(value) {
    if (!value) return '""';
    if (!/[\s"'\\>$`~|<&;*?#()]/.test(value)) return value;
    return '"' + value.replace(/["\\$`]/g, '\\$&') + '"';
  }

  // Absolute path of the running profile, or '' when it cannot be resolved.
  async function currentProfilePath() {
    try {
      if (browser.rozelynxWindows && browser.rozelynxWindows.getProfilePath) {
        var res = await browser.rozelynxWindows.getProfilePath();
        if (res && res.ok && res.path) return res.path;
        console.warn('[RozeLynx PWA] getProfilePath unavailable: ' +
          ((res && res.error) || 'no result') + '; .desktop entry will not pin a profile');
      } else {
        console.warn('[RozeLynx PWA] browser.rozelynxWindows.getProfilePath missing; ' +
          '.desktop entry will not pin a profile');
      }
    } catch (e) {
      console.warn('[RozeLynx PWA] getProfilePath failed: ' + e +
        '; .desktop entry will not pin a profile');
    }
    return '';
  }

  // Manifest Processor
  var ManifestProcessor = {
    validate: function(manifest) {
      if (!manifest) return false;
      if (!manifest.name && !manifest.short_name) return false;
      return true;
    },

    normalize: function(manifest, documentUrl) {
      var base = new URL(documentUrl);
      var scope = manifest.scope || '/';
      var startUrl = manifest.start_url || '/';

      function resolveURL(url) {
        try {
          return new URL(url, base).href;
        } catch (e) {
          return url;
        }
      }

      return {
        name: manifest.name || manifest.short_name || 'Untitled App',
        shortName: manifest.short_name || manifest.name,
        description: manifest.description || '',
        startUrl: resolveURL(startUrl),
        scope: resolveURL(scope),
        display: manifest.display || 'standalone',
        orientation: manifest.orientation || 'any',
        themeColor: manifest.theme_color || '#8B5CF6',
        backgroundColor: manifest.background_color || '#FFFFFF',
        icons: (manifest.icons || []).map(function(icon) {
          return {
            src: resolveURL(icon.src),
            sizes: icon.sizes || '',
            type: icon.type || 'image/png',
            purpose: icon.purpose || 'any',
          };
        }),
      };
    },

    fetchManifest: async function(url) {
      try {
        var response = await fetch(url);
        if (!response.ok) return null;
        return await response.json();
      } catch (e) {
        console.debug('[RozeLynx PWA] Failed to fetch manifest:', e);
        return null;
      }
    },

    findBestIcon: function(icons, preferredSize) {
      preferredSize = preferredSize || 192;
      if (!icons || icons.length === 0) return null;
      var best = null;
      var bestDiff = Infinity;
      icons.forEach(function(icon) {
        var sizes = [];
        if (icon.sizes) {
          sizes = icon.sizes.split(/\s+/).map(function(s) {
            return parseInt(s.split('x')[0]);
          });
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
    },

    fetchIcon: async function(iconUrl) {
      try {
        var response = await fetch(iconUrl);
        if (!response.ok) return null;
        var blob = await response.blob();
        return new Promise(function(resolve) {
          var reader = new FileReader();
          reader.onloadend = function() { resolve(reader.result); };
          reader.readAsDataURL(blob);
        });
      } catch (e) {
        return null;
      }
    },

    // Async because the Exec line pins the installing profile, which needs
    // the privileged getProfilePath() (see currentProfilePath above). Called
    // from exactly one place, DesktopEntry.write.
    //
    // iconPath is the MATERIALISED icon (an absolute path under
    // <profile>/pwa-icons/, written by writeIconFile). It used to be
    // site.iconPath, which is the manifest icon's data: URL - not a legal
    // Icon= value and not a file the icon setter could open - so this is the
    // first call site that can actually carry a usable icon.
    generateDesktopEntry: async function(site, iconPath) {
      var filename = pwaDesktopFileName(site);
      var profilePath = await currentProfilePath();
      // Both values are quoted per the desktop-entry spec, so a profile
      // directory or a start URL containing a space round-trips as one argv
      // token. --profile must precede --ssb only in the sense that both are
      // read in argv order; what matters is that the flag is present at all.
      var exec = 'rozelynx';
      if (profilePath) {
        exec += ' --profile ' + quoteExecValue(profilePath);
      }
      // --ssb-class and --ssb-icon exist because a .desktop file cannot make
      // a window group under it. StartupWMClass only tells the launcher which
      // class to match; the class itself is set by the compiled taskbar
      // component, and nothing a desktop entry can express reaches that. The
      // --ssb handler therefore reads these two and applies them, which is
      // what makes a launcher-launched app window look identical to one
      // launched from inside the browser. Both are omitted when the value is
      // unknown rather than emitted empty, so a launcher-launched window
      // simply keeps its default class and icon.
      exec += ' --ssb-class ' + quoteExecValue(pwaWindowClass(site));
      if (iconPath) {
        exec += ' --ssb-icon ' + quoteExecValue(iconPath);
      }
      exec += ' --ssb ' + quoteExecValue(site.startUrl);
      var content = [
        '[Desktop Entry]',
        'Version=1.0',
        'Name=' + site.name,
        'Comment=' + (site.description || 'RozeLynx PWA Application'),
        'Exec=' + exec,
        'Icon=' + (iconPath || DesktopEntry.FALLBACK_ICON),
        'Terminal=false',
        'Type=Application',
        'Categories=Network;WebBrowser;',
        'StartupWMClass=' + pwaWindowClass(site),
        'X-RozeLynx-PWA=true',
        'X-RozeLynx-Profile=' + (profilePath || ''),
        'X-RozeLynx-StartURL=' + site.startUrl,
        'X-RozeLynx-Scope=' + site.scope,
        '',
      ].join('\n');
      return { filename: filename, content: content, iconPath: iconPath || '' };
    },

    simpleHash: function(str) {
      var hash = 0;
      for (var i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
      }
      return Math.abs(hash);
    },

    generateSiteId: function(url) {
      return 'pwa-' + ManifestProcessor.simpleHash(url).toString(36);
    }
  };

  // PWA Manager
  var PWAManager = {
    async install(data, tabId) {
      try {
        // Use pre-detected info from content script if available
        var url = data.url;
        var manifestUrl = data.manifestUrl;

        // Fall back to detecting manifest ourselves
        if (!manifestUrl || !url) {
          var results = await browser.tabs.executeScript(tabId, {
            code: [
              '(function() {',
              '  var links = document.querySelectorAll(\'link[rel="manifest"]\');',
              '  var manifests = [];',
              '  links.forEach(function(link) {',
              '    if (link.href) manifests.push({ href: link.href });',
              '  });',
              '  var metaTheme = document.querySelector(\'meta[name="theme-color"]\');',
              '  return {',
              '    manifests: manifests,',
              '    themeColor: metaTheme ? metaTheme.content : null,',
              '    url: window.location.href,',
              '    title: document.title,',
              '  };',
              '})();',
            ].join('\n'),
            frameId: 0,
          });

          var info = results && results[0];
          if (!info || !info.manifests || info.manifests.length === 0) {
            throw new Error('No manifest found on this page');
          }
          url = info.url;
          manifestUrl = new URL(info.manifests[0].href, info.url).href;
        }
        var manifest = await ManifestProcessor.fetchManifest(manifestUrl);

        if (!manifest || !ManifestProcessor.validate(manifest)) {
          throw new Error('Invalid manifest');
        }

        var normalized = ManifestProcessor.normalize(manifest, url);
        var bestIcon = ManifestProcessor.findBestIcon(normalized.icons);
        var iconDataUrl = null;

        if (bestIcon) {
          iconDataUrl = await ManifestProcessor.fetchIcon(bestIcon.src);
        }

        var siteId = ManifestProcessor.generateSiteId(normalized.startUrl);
        var site = {
          id: siteId,
          name: normalized.name,
          shortName: normalized.shortName,
          description: normalized.description,
          startUrl: normalized.startUrl,
          scope: normalized.scope,
          display: normalized.display,
          themeColor: normalized.themeColor,
          backgroundColor: normalized.backgroundColor,
          icon: iconDataUrl,
          installedAt: Date.now(),
          lastUsed: Date.now(),
        };

        PWAStore.addSite(site);

        // Put the launcher entry on disk. Until DesktopEntry existed this
        // method generated the text and returned it in a reply nobody reads:
        // there is no caller of the 'install' action in the extension (the
        // live path is the content script's installPWA, which has no caller
        // here at all), so the site is stored and nothing else happened. The
        // entry is written here too, so this path is correct if a caller is
        // ever added.
        var entry = await DesktopEntry.write(site);

        try {
          await browser.notifications.create('pwa-install-' + siteId, {
            type: 'basic',
            iconUrl: iconDataUrl || browser.runtime.getURL('icons/icon128.png'),
            title: normalized.name + ' installed',
            message: 'PWA has been installed. Click to launch.',
          });
        } catch (notifErr) {}

        return { success: true, site: site, desktopEntry: entry };
      } catch (e) {
        console.error('[RozeLynx PWA] Installation failed:', e);
        return { success: false, error: e.message };
      }
    },

    async uninstall(siteId) {
      try {
        var site = PWAStore.getSite(siteId);
        if (!site) throw new Error('Site not found');
        PWAStore.removeSite(siteId);
        // Removal, not the pref: an entry left in the applications directory
        // keeps launching an app that is no longer installed.
        await DesktopEntry.remove(site);

        try {
          await browser.notifications.create('pwa-uninstall-' + siteId, {
            type: 'basic',
            iconUrl: site.icon || browser.runtime.getURL('icons/icon128.png'),
            title: site.name + ' uninstalled',
            message: 'The PWA has been removed.',
          });
        } catch (notifErr) {}

        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },

    async launch(siteId, data) {
      bgDiag('launch-start siteId=' + siteId + ' data=' + JSON.stringify(data || null));
      try {
        var site = PWAStore.getSite(siteId);
        if (!site) {
          await PWAStore.load();
          site = PWAStore.getSite(siteId);
        }
        bgDiag('after-load sites=' + PWAStore.sites.length + ' found=' + !!site +
          ' startUrl=' + (site && site.startUrl));

        var startUrl = site && site.startUrl;
        if (!startUrl && data && data.startUrl) {
          startUrl = data.startUrl;
        }
        if (!startUrl) throw new Error('Site not found or missing start URL');

        if (site) {
          site.lastUsed = Date.now();
          PWAStore.addSite(site);
        }

        // Launch in a dedicated window (SSB mode). Create WITHOUT a url and
        // do a SINGLE tabs.update() navigation: passing url to
        // windows.create AND navigating again made the page load twice,
        // which broke app hydration (left-click handlers never attached).
        // Window type is 'normal', not 'popup': on Wayland, popup-type
        // windows are unreliable for pointer input (clicks only work after
        // a reload/refocus), and the app look comes from the ssb-mode
        // attribute anyway (ssbChrome.css hides tab strip + nav bar).
        var win = await browser.windows.create({
          type: 'normal',
          width: 1280,
          height: 800,
          state: 'normal',
          focused: true,
        });
        bgDiag('window-created id=' + win.id);

        // Track this window as a PWA window BEFORE the navigation so the
        // is-popup check can already answer correctly when the page's
        // content script runs (out-of-scope tabs get bounced back too).
        var siteObj = site || { id: siteId, startUrl: startUrl, scope: startUrl };
        PWAWindows.add(win.id, siteObj);

        // Apply the SSB chrome BEFORE the first navigation: hiding the tab
        // strip + nav bar (ssbChrome.css) while the page is already loading
        // reflows the browser element mid-load, which on Wayland can leave
        // the content's input hit-testing stale (left clicks do nothing
        // until a reload recomputes the layout). Applying it first lets the
        // page load straight into its final geometry.
        try {
          if (browser.rozelynxWindows && browser.rozelynxWindows.setSsbMode) {
            await browser.rozelynxWindows.setSsbMode(win.id, true);
            bgDiag('ssb-mode set windowId=' + win.id);
          }
        } catch (ssbErr) { bgDiag('ssb-mode-error ' + ssbErr); }

        // Establish the initial tab-strip state: a fresh PWA window holds one
        // tab, so the strip stays hidden until a second tab arrives.
        refreshSsbTabs(win.id);

        var tabId = null;
        // The initial tab may not be registered yet when windows.create
        // resolves (race seen in 1.0.47: the new window then stays on the
        // homepage instead of navigating to the app). Retry briefly.
        for (var qi = 0; qi < 25 && !tabId; qi++) {
          try {
            var tabs = await browser.tabs.query({ windowId: win.id });
            if (tabs.length) tabId = tabs[0].id;
          } catch (qErr) { bgDiag('tab-query-error ' + qErr); }
          if (!tabId) await new Promise(function(r) { setTimeout(r, 100); });
        }
        bgDiag('tab-found ' + tabId + ' tries=' + qi);

        // Let the window settle before the first navigation (1.0.49): the
        // window is created at a requested size and then resized/tiled by
        // the window manager right after mapping. Navigating before that
        // resize lands can make the page's initial CSS transitions (e.g.
        // loading-overlay fades) complete without firing transitionend,
        // leaving invisible click-blocking overlays behind (Flood PWA:
        // left clicks dead until reload). A short settle before
        // tabs.update() lets the app document start in the final geometry,
        // the same environment as a normal tab.
        await new Promise(function(r) { setTimeout(r, 800); });
        bgDiag('settled pre-nav');

        var launchUrl = appendMarker(startUrl);
        if (tabId) {
          await browser.tabs.update(tabId, { url: launchUrl });
          bgDiag('tabs-update done tabId=' + tabId + ' url=' + launchUrl);
        }

        // Force focus: on Wayland/GTK the window manager may not focus a
        // freshly created window, and until it is focused the page does not
        // respond to left clicks (user had to click away and back).
        // windows.update({focused:true}) after the navigation has started
        // is the most reliable point to request focus.
        try {
          await browser.windows.update(win.id, { focused: true });
          bgDiag('window-focused id=' + win.id);
        } catch (fErr) { bgDiag('focus-error ' + fErr); }
        setTimeout(function() {
          browser.windows.update(win.id, { focused: true }).catch(function() {});
        }, 900);

        try {
          var winInfo = await browser.windows.get(win.id);
          bgDiag('window-type ' + winInfo.type);
        } catch (wErr) { bgDiag('windows-get-error ' + wErr); }

        // Wire up taskbar integration for the new window: the compiled C++
        // component sets the window's WM_CLASS (which is what lets the taskbar
        // and a launcher entry agree on this window) and its icon. Both are
        // cosmetic, so a failure here must not turn a launched app into a
        // failed launch - TaskbarIntegration reports, it does not throw.
        //
        // pwaWindowClass is the same helper generateDesktopEntry writes into
        // StartupWMClass and into the --ssb-class flag, which is what makes
        // this window and a launcher-launched one group together.
        var siteName = (site && site.name) || 'RozeLynx App';
        try {
          await TaskbarIntegration.setWindowClass(win.id, pwaWindowClass(site), siteName);
          await TaskbarIntegration.setWindowIcon(win.id, site);
        } catch (taskbarErr) {
          bgDiag('taskbar-error ' + taskbarErr);
        }

        return { success: true, windowId: win.id };
      } catch (e) {
        bgDiag('launch-error ' + e.message);
        return { success: false, error: e.message };
      }
    },

    getAll: function() {
      return PWAStore.getAll();
    }
  };

  // Synchronous tab→window tracking for the webRequest blocker
  var tabWindowMap = new Map();

  function updateTabWindow(tabId, windowId) {
    if (windowId && windowId > 0) tabWindowMap.set(tabId, windowId);
    else tabWindowMap.delete(tabId);
  }

  // Per-tab dedupe + burst cap for external-window opens
  var externalOpenTime = {};
  var BURST_CAP = 3;
  var burstCount = 0;
  var burstStart = Date.now();

  // --- PWA window enforcement -------------------------------------------
  // Same-origin tabs are allowed in the PWA window.  Cross-origin tabs are
  // moved to an existing regular browser window (reused if one exists) or
  // opened in a new regular window.

  // Show the tab strip only while an SSB window holds more than one tab
  // (ssbChrome.css hides it otherwise). Applied on every tab lifecycle event
  // in a PWA window so closing the 2nd tab collapses the strip again.
  // Window detection is robust to the PWA registry being mid-load when the
  // event page wakes: a window counts as PWA if it is registered OR one of
  // its tabs carries the rozelynx-pwa URL marker.
  function refreshSsbTabs(windowId) {
    // Small delay to let the browser fully register the new tab in query results.
    setTimeout(function() {
      browser.tabs.query({ windowId: windowId }).then(function(tabs) {
        var isPWA = PWAWindows.isPWAWindow(windowId) ||
          tabs.some(function(t) { return t.url && t.url.indexOf(PWA_MARKER) >= 0; });
        console.debug('[RozeLynx PWA] refreshSsbTabs win=' + windowId +
          ' isPWA=' + isPWA + ' tabs=' + tabs.length +
          ' urls=' + JSON.stringify(tabs.map(function(t) { return t.url; })));
        if (!isPWA) return;
        var show = tabs.length > 1;
        if (browser.rozelynxWindows && browser.rozelynxWindows.setSsbTabs) {
          return browser.rozelynxWindows.setSsbTabs(windowId, show).then(function(res) {
            var line = 'ssb-tabs window=' + windowId + ' count=' + tabs.length +
              ' show=' + show + ' ok=' + !!(res && res.ok);
            console.debug('[RozeLynx PWA] ' + line);
            bgDiag(line);
          }).catch(function(e) {
            console.error('[RozeLynx PWA] setSsbTabs error: ' + e);
            bgDiag('ssb-tabs-error ' + e);
          });
        }
        console.warn('[RozeLynx PWA] setSsbTabs unavailable');
        return null;
      }).catch(function(e) {
        console.error('[RozeLynx PWA] refreshSsbTabs query error: ' + e);
      });
    }, 200);
  }

  // PWA-window check that does not depend on the in-memory window registry:
  // falls back to looking for the rozelynx-pwa marker on the window's tabs.
  async function isPWAWindowSoft(winId) {
    if (PWAWindows.isPWAWindow(winId)) return true;
    try {
      var tabs = await browser.tabs.query({ windowId: winId });
      return tabs.some(function(t) { return t.url && t.url.indexOf(PWA_MARKER) >= 0; });
    } catch (e) {
      return false;
    }
  }

  // Ensure at least one non-PWA normal window exists, creating one if needed.
  async function ensureRegularWindow() {
    try {
      var wins = await browser.windows.getAll({ windowTypes: ['normal'] });
      for (var i = 0; i < wins.length; i++) {
        if (!PWAWindows.isPWAWindow(wins[i].id)) return wins[i];
      }
    } catch (e) {}
    try {
      return await browser.windows.create({ type: 'normal' });
    } catch (e) {
      return null;
    }
  }

  // Route a cross-origin tab out of its PWA window. When the window keeps at
  // least one other tab the tab itself is MOVED into a normal window (no
  // duplicate, no revert); otherwise moving would orphan the PWA window, so
  // the URL is opened in a normal window and the tab is sent back to scope.
  async function moveOutOfScopedTab(tabId, fromWinId, url, entry) {
    try {
      var tabs = await browser.tabs.query({ windowId: fromWinId });
      if (tabs.length > 1) {
        var targetWin = await ensureRegularWindow();
        if (targetWin) {
          try {
            await browser.tabs.move(tabId, { windowId: targetWin.id, index: -1 });
            var moved = await browser.tabs.get(tabId);
            if (moved && moved.windowId === targetWin.id) {
              browser.windows.update(targetWin.id, { focused: true }).catch(function() {});
              return;
            }
          } catch (moveErr) { bgDiag('move-out-failed ' + moveErr); }
        }
      }
      var existingWin = await findExistingRegularWindow();
      if (existingWin) {
        browser.tabs.create({ windowId: existingWin.id, url: url, active: true }).catch(function() {});
      } else {
        browser.windows.create({ url: url, type: 'normal' }).catch(function() {});
      }
      // No revert of the PWA tab — prevents the bounce loop
    } catch (e) {
      bgDiag('moveOut-error ' + e);
    }
  }

  // New tabs in a PWA window: same-origin stay, cross-origin get moved to a
  // normal window. Tabs whose URL is unknown at creation (the common case for
  // "open link in new tab") are left alone here; the onUpdated listener makes
  // the routing decision once the URL resolves.
  browser.tabs.onCreated.addListener(async function(tab) {
    try {
      var winId = tab.windowId;
      console.debug('[RozeLynx PWA] onCreated tab=' + tab.id + ' win=' + winId +
        ' url=' + (tab.url || tab.pendingUrl || 'none'));
      if (!winId) return;
      updateTabWindow(tab.id, winId);
      var isPWA = await isPWAWindowSoft(winId);
      console.debug('[RozeLynx PWA] onCreated isPWA=' + isPWA + ' win=' + winId);
      if (isPWA) refreshSsbTabs(winId);
      if (!isPWA) return;
      var entry = PWAWindows.get(winId);
      var url = tab.url || (tab.pendingUrl || '');
      if (!entry || !url || url === 'about:blank') return;
      if (url.indexOf('http') === 0) return; // webRequest handles http(s) cross-scope
      if (sameOrigin(url, entry.startUrl)) return;
      bgDiag('bounce-tab window=' + winId + ' tab=' + tab.id + ' url=' + url);
      await moveOutOfScopedTab(tab.id, winId, url, entry);
    } catch (e) {
      bgDiag('onCreated-error ' + e);
    }
  });

  // Out-of-scope navigation of a tab in a PWA window: route the tab to a
  // normal window (moveOutOfScopedTab), keeping the PWA window intact.
  browser.tabs.onUpdated.addListener(async function(tabId, changeInfo, tab) {
    try {
      var winId = tab.windowId;
      if (!winId) return;
      updateTabWindow(tabId, winId);
      if (changeInfo.url) updateTabWindow(tabId, winId);
      var entry = PWAWindows.get(winId);
      if (!entry) {
        console.debug('[RozeLynx PWA] onUpdated no-entry win=' + winId +
          ' tab=' + tabId + ' url=' + (changeInfo.url || 'none'));
        refreshSsbTabs(winId);
        return;
      }
      var url = changeInfo.url;
      if (!url || url.indexOf('about:') === 0) return;
      if (url.indexOf('http') === 0) return; // webRequest handles http(s) cross-scope
      if (sameOrigin(url, entry.startUrl)) return;
      bgDiag('bounce-nav window=' + winId + ' tab=' + tabId + ' url=' + url);
      await moveOutOfScopedTab(tabId, winId, url, entry);
    } catch (e) {
      bgDiag('onUpdated-error ' + e);
    }
  });

  browser.tabs.onRemoved.addListener(async function(tabId, removeInfo) {
    try {
      tabWindowMap.delete(tabId);
      var winId = removeInfo.windowId;
      if (!winId) return;
      var isPWA = await isPWAWindowSoft(winId);
      if (!isPWA) return;
      refreshSsbTabs(winId);
      var tabs = await browser.tabs.query({ windowId: winId });
      if (tabs.length === 0) PWAWindows.remove(winId);
    } catch (e) {}
  });

  browser.windows.onRemoved.addListener(function(windowId) {
    PWAWindows.remove(windowId);
  });

  // Block cross-scope main_frame navigations in PWA tabs BEFORE they commit.
  // Cancels the request and opens the URL once in a normal window (deduped).
  // This replaces the revert-based bounce that caused duplicate-tabs and
  // the external-handler prompt loop.
  browser.webRequest.onBeforeRequest.addListener(
    function(details) {
      if (details.type !== 'main_frame') return {cancel: false};
      if (!details.tabId || details.tabId < 0) return {cancel: false};
      var winId = tabWindowMap.get(details.tabId);
      if (!winId) return {cancel: false};
      var entry = PWAWindows.get(winId);
      if (!entry) return {cancel: false};
      if (sameOrigin(details.url, entry.startUrl)) return {cancel: false};

      var now = Date.now();
      if (externalOpenTime[details.tabId] && now - externalOpenTime[details.tabId] < 1500) {
        return {cancel: true};
      }
      if (now - burstStart > 10000) { burstCount = 0; burstStart = now; }
      if (burstCount >= BURST_CAP) return {cancel: true};
      externalOpenTime[details.tabId] = now;
      burstCount++;

      (async function() {
        try {
          var targetWin = await findExistingRegularWindow();
          if (targetWin) {
            await browser.tabs.create({windowId: targetWin.id, url: details.url, active: true});
          } else {
            await browser.windows.create({url: details.url, type: 'normal'});
          }
        } catch (e) {}
      })();

      return {cancel: true};
    },
    {urls: ["http://*/*", "https://*/*"]},
    ["blocking"]
  );

  // Navigation trace: log every top-level commit in a PWA window so the
  // launch sequence (exactly ONE load expected) is auditable in bgDiag.
  try {
    browser.webNavigation.onCommitted.addListener(function(details) {
      try {
        if (!details.tabId || details.frameId !== 0) return;
        browser.tabs.get(details.tabId).then(function(tab) {
          if (tab && tab.windowId && PWAWindows.isPWAWindow(tab.windowId)) {
            bgDiag('nav-committed win=' + tab.windowId + ' tab=' + details.tabId +
              ' url=' + details.url + ' type=' + (details.transitionType || ''));
          }
        }).catch(function() {});
      } catch (e) {}
    });
  } catch (navErr) { bgDiag('webnav-listener-error ' + navErr); }

  // Initialize.
  //
  // One load, not two. This used to be a bare PWAStore.load() followed by a
  // second PWAStore.load().then(reconcile); load() is not memoised, so that was
  // two storage.local round trips at start-up and two concurrent writers of
  // PWAStore.sites, for one reconcile. The chained call does the same load and
  // then the reconcile, so the bare one bought nothing.
  //
  // Give every installed app a launcher entry, not just the ones installed
  // after B.4 shipped the writer. Runs once, after the store has loaded, and
  // never throws into the rest of start-up. See DesktopEntry.reconcile.
  PWAStore.load()
    .then(function() { return DesktopEntry.reconcile(); })
    .catch(function(e) { bgDiag('desktop-entry-reconcile-rejected ' + e); })
    .then(function() { return SsbHandler.status(); })
    .catch(function(e) { bgDiag('ssb-handler-probe-rejected ' + e); });
  PWAWindows.load().then(async function() {
    // Restore the tab-strip state of PWA windows that survived a browser
    // restart (multi-tab windows keep their strip, single-tab collapse it).
    try {
      var wins = await browser.windows.getAll({ windowTypes: ['normal', 'popup'] });
      for (var i = 0; i < wins.length; i++) {
        if (PWAWindows.isPWAWindow(wins[i].id)) refreshSsbTabs(wins[i].id);
      }
    } catch (e) {}
    // Populate tab→window tracking for existing tabs so the
    // webRequest blocker is effective immediately after wake.
    try {
      var allTabs = await browser.tabs.query({});
      for (var j = 0; j < allTabs.length; j++) {
        var t = allTabs[j];
        if (t.windowId && PWAWindows.isPWAWindow(t.windowId)) {
          updateTabWindow(t.id, t.windowId);
        }
      }
    } catch (e) {}
  });

  // Listen for messages
  browser.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    if (message.module !== 'pwa') return;
    bgDiag('msg-recv action=' + message.action + ' data=' + JSON.stringify(message.data || null));

    switch (message.action) {
      case 'install':
        PWAManager.install(message.data || {}, sender.tab && sender.tab.id)
          .then(sendResponse)
          .catch(function(e) { sendResponse({ success: false, error: e.message }); });
        return true;
      case 'uninstall':
        PWAManager.uninstall(message.data.siteId)
          .then(sendResponse)
          .catch(function(e) { sendResponse({ success: false, error: e.message }); });
        return true;
      // The launcher entry lifecycle, reachable by the two callers that do
      // not go through PWAManager.install: the content script's installPWA
      // (the LIVE install path - see the note there) and the extension
      // popup's remove button (which filters storage.local directly, so
      // PWAManager.uninstall never runs for it).
      case 'write-entry':
        DesktopEntry.write(message.data && message.data.site)
          .then(sendResponse)
          .catch(function(e) { sendResponse({ ok: false, error: e.message }); });
        return true;
      case 'remove-entry':
        DesktopEntry.remove(message.data && message.data.site)
          .then(sendResponse)
          .catch(function(e) { sendResponse({ ok: false, error: e.message }); });
        return true;
      // Same pass start-up runs, reachable on demand so a user whose entry went
      // missing (a wiped ~/.local/share, a hand-cleaned applications directory)
      // can get them back without reinstalling anything.
      case 'reconcile-entries':
        DesktopEntry.reconcile()
          .then(sendResponse)
          .catch(function(e) { sendResponse({ ok: false, error: e.message }); });
        return true;
      case 'launch':
        PWAManager.launch(message.data && message.data.siteId, message.data)
          .then(sendResponse)
          .catch(function(e) { sendResponse({ success: false, error: e.message }); });
        return true;
      case 'getAll':
        sendResponse({ sites: PWAManager.getAll() });
        break;
      case 'is-popup':
        (async function() {
          try {
            if (!sender.tab || !sender.tab.windowId) {
              sendResponse({ isPopup: false });
              return;
            }
            // PWA windows are tracked in the registry regardless of window
            // type (1.0.44+ launches use type 'normal' for Wayland pointer
            // reliability), so answer from the registry instead of the
            // window type. Re-load first: the event page may have just
            // woken and the in-memory registry can be empty.
            await PWAWindows.load();
            sendResponse({ isPopup: PWAWindows.isPWAWindow(sender.tab.windowId) });
          } catch (e) {
            sendResponse({ isPopup: false });
          }
        })();
        return true;
      case 'detect':
        if (sender.tab) {
          browser.tabs.executeScript(sender.tab.id, {
            code: [
              '(function() {',
              '  var link = document.querySelector(\'link[rel="manifest"]\');',
              '  return { hasManifest: !!link, url: link ? link.href : null };',
              '})();',
            ].join('\n'),
            frameId: sender.frameId || 0,
          }).then(function(results) {
            sendResponse(results && results[0] || { hasManifest: false });
          }).catch(function() {
            sendResponse({ hasManifest: false });
          });
        } else {
          sendResponse({ hasManifest: false });
        }
        return true;
      default:
        break;
    }
  });

  // "PWA has been installed. Click to launch." was a lie until now: nothing
  // was listening, so the notification was informational at best and a dead
  // click at worst. It now launches the app through the same PWAManager.launch
  // the popup's Launch button uses, which is the in-browser twin of what the
  // generated .desktop entry does from outside the browser.
  //
  // The event page may be asleep, and launch() re-loads the site store when it
  // cannot find a site, so a cold click works.
  try {
    browser.notifications.onClicked.addListener(function(notificationId) {
      try {
        if (typeof notificationId !== 'string') return;
        if (notificationId.indexOf('pwa-install-') === 0) {
          var siteId = notificationId.slice('pwa-install-'.length);
          bgDiag('notification-click action=launch siteId=' + siteId);
          PWAManager.launch(siteId).then(function(res) {
            if (!res || !res.success) {
              bgDiag('notification-launch-failed siteId=' + siteId + ' ' +
                ((res && res.error) || 'no result'));
            }
            return browser.notifications.clear(notificationId).catch(function() {});
          }).catch(function(e) {
            bgDiag('notification-launch-throw siteId=' + siteId + ' ' + e);
          });
          return;
        }
        if (notificationId.indexOf('pwa-uninstall-') === 0) {
          // Nothing to do: the removal already happened. Clearing it is the
          // whole point of clicking a notification about a deletion.
          browser.notifications.clear(notificationId).catch(function() {});
        }
      } catch (e) {
        bgDiag('notification-click-error ' + e);
      }
    });
  } catch (notifErr) {
    // A build without the notifications permission simply keeps the old
    // behaviour: no click handler, no error in the user's face.
    bgDiag('notification-listener-error ' + notifErr);
  }

  RozeLynxFeatures.loadedModules['pwa'] = true;
  bgDiag('module-loaded');
  console.log('[RozeLynx] PWA module loaded');
})();
