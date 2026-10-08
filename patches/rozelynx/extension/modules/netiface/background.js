// netiface module for RozeLynx Features extension
// Per-tab / per-container / per-profile network-interface assignment
// via SO_BINDTODEVICE (CAP_NET_RAW) + per-iface DoH TRR override.
//
// The native binding happens through the rozelynxNetIface experiment API
// (lib/experiments/netiface-api.js -> nsIRozeLynxNetIface.setTabInterface).
// Every selection surface goes through the SAME applyIface() path:
// native bind first, then persistence, then UI refresh.
//
// UI surfaces:
//   * tab context menu  - radio list, checked state recomputed on menu show
//   * window chip       - pill in the TabsToolbar showing the ACTIVE tab's
//                          effective interface; click opens the picker popup
//   * picker popup      - modules/netiface/popup.html (opened via chip click)
//   * synthetic page menu - the mouse-gestures content script's
//                          "Bind Network Interface..." entry, which reaches
//                          this module through the netiface:open-picker
//                          message action (it cannot create the popup itself)
//                          and is gated on netiface:available
//
// Persistence is TWO-LAYERED:
//   1. a SessionStore TAB VALUE (extData) - written parent-side by the
//      experiment API's setAssignment and read back via getTabInfo; it
//      follows the tab through sessionstore and survives restarts. This
//      is the per-tab source of truth.
//   2. storage.local keyed by browserId - fast in-session rebind when a
//      tab is discarded / swapped (browserId is preserved for those
//      paths). BrowserIds are PER-PROCESS: the map is purged at startup,
//      otherwise stale ids from the previous session collide with fresh
//      tabs and bind them wrongly.
// rebindTab prefers the tab value, then the storage cache. Restored tabs
// repopulate their tab value asynchronously (restoreTab), so the rebind
// is retried on tabs.onUpdated (status complete) and once more ~2s after
// onStartup; it is a no-op for tabs whose binding is already in place.
// KNOWN LIMITATION: bindings applied by the external-link CHOOSER
// (ExternalLinkCommandLineHandler.sys.mjs path) call the native
// setTabInterface directly and are not persisted - they do not survive a
// browser restart.

(function() {
  'use strict';

  var STORAGE_KEY = 'rozelynx_netiface_tabs';
  var LOG_PREFIX = '[RozeLynx:netiface]';
  var MENU_PARENT = 'rozelynx-netiface';
  var MENU_PREFIX = 'rozelynx-netiface-';
  var MENU_DEFAULT = 'rozelynx-netiface-__default__';

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

  function api() {
    return (typeof browser.rozelynxNetIface !== 'undefined') ? browser.rozelynxNetIface : null;
  }

  var state = {
    interfaces: [],
    menuCreated: false,
    // tabId -> {iface, layer}; last-known effective assignment, kept
    // synchronous so contextMenus.onShown can refresh radios without awaits.
    effectiveCache: {},
    // browser windowId -> picker popup windowId (avoid stacking pickers)
    pickerWindows: {},
    // one-time startup purge of the browserId-keyed cache (see
    // ensureStoragePurged); resolves once the cache is safe to touch.
    storageReady: null,
  };

  // ── Persistence (storage.local: PLAIN object keyed by browserId) ──

  // Every read/write of the storage cache goes through here, and each
  // waits for the startup purge first: rebind triggers (tabs.onCreated
  // etc.) fire synchronously during init, while the purge is still in
  // flight - without the gate a tab restored in that window could read
  // a stale entry and bind to another session's interface.
  function getAssignments() {
    return ensureStoragePurged().then(function() {
      return browser.storage.local.get(STORAGE_KEY).then(function(stored) {
        var val = stored && stored[STORAGE_KEY];
        if (!val) {
          return {};
        }
        if (typeof val === 'string') {
          // Legacy bug: older builds stored JSON.stringify(assignments).
          // Migrate (parse) or discard on parse failure.
          try {
            val = JSON.parse(val);
          } catch (e) {
            return {};
          }
        }
        if (!val || typeof val !== 'object' || Array.isArray(val)) {
          return {};
        }
        return val;
      }).catch(function() { return {}; });
    });
  }

  function saveAssignments(assignments) {
    var d = {};
    d[STORAGE_KEY] = assignments;
    return browser.storage.local.set(d);
  }

  function persistAssignment(browserId, iface) {
    return getAssignments().then(function(assignments) {
      if (iface) {
        assignments[String(browserId)] = iface;
      } else {
        delete assignments[String(browserId)];
      }
      return saveAssignments(assignments);
    });
  }

  // BrowserIds are per-process: every entry left over from a previous
  // process references a dead id. Purge the cache once at startup so
  // stale ids cannot collide with fresh tabs (including the phantom
  // entries written by pre-native-binding builds). Bindings that still
  // matter are re-added either by the user or by the tab-value restore
  // path below. ensureStoragePurged memoizes the purge so every cache
  // access (getAssignments) waits for it exactly once.
  function purgeStaleAssignments() {
    return browser.storage.local.remove(STORAGE_KEY).catch(function() {});
  }

  function ensureStoragePurged() {
    if (!state.storageReady) {
      state.storageReady = purgeStaleAssignments();
    }
    return state.storageReady;
  }

  // ── Single apply path: native bind + persist + refresh ──────────

  function applyIface(tab, iface) {
    var cleanIface = iface || '';
    var svc = api();
    if (!tab || typeof tab.id !== 'number' || !svc || !svc.setAssignment) {
      return Promise.resolve(false);
    }
    return Promise.resolve(svc.setAssignment(tab.id, cleanIface)).then(function(ok) {
      var infoPromise = svc.getTabInfo
        ? Promise.resolve(svc.getTabInfo(tab.id)).catch(function() { return {browserId: 0, userContextId: 0}; })
        : Promise.resolve({browserId: 0, userContextId: 0});
      return infoPromise.then(function(info) {
        var persistPromise = info.browserId
          ? persistAssignment(info.browserId, cleanIface)
          : Promise.resolve();
        return persistPromise.then(function() {
          log('info', 'applyIface tab=' + tab.id + ' browserId=' + (info.browserId || 0) +
            ' -> ' + (cleanIface || '(profile default)') + (ok ? '' : ' [native set FAILED]'));
          return refreshEffective(tab.id).then(function() {
            // The chip must reflect the just-applied binding immediately
            // (the picker closes right after Apply; without this the chip
            // keeps the pre-apply label until the next tab switch).
            refreshChipsForTab(tab);
            return ok;
          });
        });
      });
    }).catch(function(e) {
      log('error', 'applyIface failed:', (e && e.message) || String(e));
      return false;
    });
  }

  function getEffectiveInterface(tab) {
    var svc = api();
    if (!tab || typeof tab.id !== 'number' || !svc || !svc.getEffective) {
      return Promise.resolve({ iface: '', layer: '' });
    }
    return Promise.resolve(svc.getEffective(tab.id)).then(function(r) {
      if (r && typeof r === 'object') {
        return { iface: r.iface || '', layer: r.layer || '' };
      }
      // Older API shape (bare string) - degrade gracefully.
      return { iface: (typeof r === 'string' ? r : ''), layer: '' };
    }).catch(function() {
      return { iface: '', layer: '' };
    });
  }

  function refreshEffective(tabId) {
    return browser.tabs.get(tabId).then(function(tab) {
      return getEffectiveInterface(tab).then(function(eff) {
        state.effectiveCache[tabId] = eff;
        return eff;
      });
    }).catch(function() {
      delete state.effectiveCache[tabId];
      return { iface: '', layer: '' };
    });
  }

  // ── Interface list (native enumeration, direct call) ────────────

  function refreshInterfaces() {
    var svc = api();
    if (!svc || !svc.getInterfaces) {
      return Promise.resolve([]);
    }
    return Promise.resolve(svc.getInterfaces()).then(function(list) {
      state.interfaces = (list || []).filter(function(i) { return i && i.name; });
      log('info', 'interfaces:', state.interfaces.map(function(i) { return i.name; }).join(', '));
      return state.interfaces;
    }).catch(function(e) {
      state.interfaces = [];
      log('warn', 'getInterfaces failed:', (e && e.message) || String(e));
      return state.interfaces;
    });
  }

  // ── Window chip (TabsToolbar pill, click -> picker popup) ────────

  // Layer names as the user should read them. "url" is the per-URL rule layer
  // (the URL rules edited in the extension popup): the chip used to print the
  // raw layer key, which told the user nothing about where a binding came from.
  var LAYER_TEXT = {
    tab: 'tab binding',
    url: 'URL rule',
    container: 'container default',
    profile: 'profile default',
  };

  function layerText(layer) {
    return LAYER_TEXT[layer] || layer || 'none';
  }

  // '*' means this tab is explicitly bound to all interfaces; see
  // NS_NETIFACE_ALL_IFACES in RozeLynxNetIface.cpp.
  var ALL_IFACES = '*';

  function isAllIfaces(eff) {
    return !!(eff && eff.iface === ALL_IFACES);
  }

  function chipLabel(eff, profileIface) {
    if (isAllIfaces(eff)) return 'all';
    return eff.iface ? eff.iface : 'default';
  }

  function chipTooltip(eff, profileIface) {
    var s = 'RozeLynx network interface: ';
    if (isAllIfaces(eff)) {
      s += 'all interfaces (layer: ' + layerText(eff.layer) + ')';
    } else if (eff.iface) {
      s += eff.iface + ' (layer: ' + layerText(eff.layer) + ')';
    } else {
      s += 'default routing';
    }
    s += profileIface ? ' | profile default: ' + profileIface : ' | profile default: unassigned';
    return s + ' — click to change';
  }

  function updateChipForWindow(windowId) {
    var svc = api();
    if (!svc || !svc.updateChip) {
      return Promise.resolve();
    }
    return browser.tabs.query({ active: true, windowId: windowId }).then(function(tabs) {
      var tab = tabs && tabs[0];
      if (!tab) {
        return;
      }
      return getEffectiveInterface(tab).then(function(eff) {
        state.effectiveCache[tab.id] = eff;
        return Promise.resolve(svc.getProfileInterface ? svc.getProfileInterface() : '').then(function(profileIface) {
          return svc.updateChip(windowId, chipLabel(eff, profileIface),
            chipTooltip(eff, profileIface), eff.iface ? 'lock' : 'globe');
        });
      });
    }).catch(function(e) {
      log('warn', 'updateChip window ' + windowId + ' failed:', (e && e.message) || String(e));
    });
  }

  function ensureChipForWindow(windowId) {
    var svc = api();
    if (!svc || !svc.ensureChip) {
      return Promise.resolve();
    }
    return Promise.resolve(svc.ensureChip(windowId)).then(function(r) {
      if (r && r.ok) {
        return updateChipForWindow(windowId);
      }
      return r;
    }).catch(function(e) {
      log('debug', 'ensureChip window ' + windowId + ' failed:', (e && e.message) || String(e));
    });
  }

  function ensureAllChips() {
    return browser.windows.getAll().then(function(wins) {
      (wins || []).forEach(function(win) {
        if (win.type === 'normal') {
          ensureChipForWindow(win.id);
        }
      });
    }).catch(function() {});
  }

  // Re-read the effective assignment of every normal window's active tab and
  // repaint its chip. The URL-rule editor in the extension popup calls this
  // after a rule change: the service re-resolves on the next channel, but
  // nothing else would repaint a window the user is not looking at, so its
  // chip would keep the pre-change label until the next tab switch.
  //
  // ensureChipForWindow is idempotent and already ends in updateChipForWindow,
  // so it is the whole job - and it also heals a chip lost to a startup race,
  // which a bare updateChipForWindow would not.
  function refreshChips() {
    return browser.windows.getAll().then(function(wins) {
      var jobs = (wins || [])
        .filter(function(win) { return win.type === 'normal'; })
        .map(function(win) { return ensureChipForWindow(win.id); });
      return Promise.all(jobs).then(function() { return true; });
    }).catch(function(e) {
      log('warn', 'refreshChips failed:', (e && e.message) || String(e));
      return false;
    });
  }

  // Picker popup, resolved for a concrete TAB.
  //
  // The chip click only ever has a windowId and resolves the active tab, but
  // the synthetic right-click menu (mouse-gestures content script) must open
  // the picker for the tab that was right-clicked, which is not necessarily
  // the active one - a background tab whose window lost focus can still be
  // right-clicked, and a right-click inside a sub-frame still has the
  // containing tab as sender.tab. So the tab is the argument and the window is
  // derived from it; the anti-stacking guard stays keyed by windowId, i.e.
  // one picker per window whichever entry point opened it.
  function openPickerForTab(tab) {
    if (!tab || typeof tab.id !== 'number' || typeof tab.windowId !== 'number') {
      log('warn', 'openPickerForTab: no usable tab, not opening the picker');
      return Promise.resolve(null);
    }
    var windowId = tab.windowId;
    var closeOld = state.pickerWindows[windowId]
      ? browser.windows.remove(state.pickerWindows[windowId]).catch(function() {})
      : Promise.resolve();
    return closeOld.then(function() {
      var url = browser.runtime.getURL('modules/netiface/popup.html?tabId=' + tab.id);
      return browser.windows.create({ type: 'popup', url: url, width: 380, height: 440 }).then(function(win) {
        var pickerId = win.id;
        state.pickerWindows[windowId] = pickerId;
        // Forget the picker when it closes. Compare against the id captured
        // here and not state.pickerWindows[windowId]: a second open in the
        // same window replaces that entry, and the first (by then stale)
        // listener must not be able to erase the live one.
        browser.windows.onRemoved.addListener(function removed(removedId) {
          if (removedId === pickerId) {
            browser.windows.onRemoved.removeListener(removed);
            if (state.pickerWindows[windowId] === pickerId) {
              delete state.pickerWindows[windowId];
            }
          }
        });
        return pickerId;
      });
    }).catch(function(e) {
      log('error', 'openPicker failed:', (e && e.message) || String(e));
      return null;
    });
  }

  function openPicker(windowId) {
    return browser.tabs.query({ active: true, windowId: windowId }).then(function(tabs) {
      return openPickerForTab(tabs && tabs[0]);
    }).catch(function(e) {
      log('error', 'openPicker failed:', (e && e.message) || String(e));
    });
  }

  // ── Context menu (radios recomputed on menu show) ────────────────

  function menuIdFor(iface) {
    return MENU_PREFIX + iface;
  }

  function createMenu() {
    if (state.menuCreated || typeof browser.contextMenus === 'undefined') {
      return;
    }
    state.menuCreated = true;

    browser.contextMenus.create({
      id: MENU_PARENT,
      title: 'RozeLynx: Bind to interface…',
      contexts: ['tab'],
    }, function() {
      // create() with callback never rejects; swallow creation races.
      void browser.runtime.lastError;
    });

    state.interfaces.forEach(function(ifc) {
      browser.contextMenus.create({
        id: menuIdFor(ifc.name),
        title: menuTitleFor(ifc),
        parentId: MENU_PARENT,
        type: 'radio',
        checked: false,
      }, function() { void browser.runtime.lastError; });
    });

    browser.contextMenus.create({
      id: MENU_DEFAULT,
      title: '(profile default)',
      parentId: MENU_PARENT,
      type: 'radio',
      checked: false,
    }, function() { void browser.runtime.lastError; });

    browser.contextMenus.onClicked.addListener(function(info, tab) {
      var id = info && info.menuItemId;
      if (typeof id !== 'string' || id.indexOf(MENU_PREFIX) !== 0 || !tab || !tab.id) {
        return;
      }
      var iface = id === MENU_DEFAULT ? '' : id.slice(MENU_PREFIX.length);
      applyIface(tab, iface);
    });

    // Recompute radio checked-state whenever the menu is shown. The
    // menus.onShown event fires synchronously before the menu is drawn;
    // update() + refresh() keep the radios truthful for the tab that
    // was right-clicked. Uses the synchronous effectiveCache, then
    // refreshes the cache in the background for the next invocation.
    if (browser.contextMenus.onShown) {
      browser.contextMenus.onShown.addListener(function(info, tab) {
        if (!state.menuCreated) {
          return;
        }
        var mine = (info && info.menuIds || []).some(function(id) {
          return typeof id === 'string' && id.indexOf(MENU_PREFIX) === 0;
        });
        if (!mine) {
          return;
        }
        var eff = (tab && state.effectiveCache[tab.id]) || { iface: '', layer: '' };
        state.interfaces.forEach(function(ifc) {
          browser.contextMenus.update(menuIdFor(ifc.name), {
            checked: eff.iface === ifc.name && eff.layer === 'tab',
          }).catch(function() {});
        });
        browser.contextMenus.update(MENU_DEFAULT, {
          checked: eff.layer !== 'tab',
        }).catch(function() {});
        browser.contextMenus.refresh();
        if (tab && tab.id) {
          refreshEffective(tab.id);
        }
      });
    }
  }

  function menuTitleFor(ifc) {
    var parts = [];
    if (ifc.hasIPv4) parts.push('v4');
    if (ifc.hasIPv6) parts.push('v6');
    var flags = parts.length ? ' [' + parts.join('+') + ']' : '';
    return (ifc.displayName || ifc.name) + flags;
  }

  // ── Session-restore rebind ──────────────────────────────────────
  // Two-layer lookup per tab, TAB VALUE FIRST (it follows the tab through
  // sessionstore and is the per-tab source of truth), then the storage
  // cache keyed by browserId (in-session paths where browserId IS stable,
  // e.g. discard/swap). A storage hit cannot happen right after startup:
  // the cache was purged, so restored bindings always come from the tab
  // value; a tab-value hit re-persists under the fresh browserId for
  // later in-session lookups. Tabs that already carry the right tab-layer
  // binding are left alone (makes the onUpdated retry a no-op for
  // healthy tabs). Chooser-set bindings (sys.mjs path) are not persisted.

  function rebindTab(tab) {
    if (!tab || !tab.id) {
      return Promise.resolve(false);
    }
    var svc = api();
    if (!svc || !svc.getTabInfo || !svc.setAssignment) {
      return Promise.resolve(false);
    }
    return Promise.resolve(svc.getTabInfo(tab.id)).then(function(info) {
      if (!info.browserId) {
        return false;
      }
      var fromTabValue = typeof info.tabValue === 'string' && !!info.tabValue;
      var storedPromise = getAssignments().then(function(assignments) {
        return assignments[String(info.browserId)];
      });
      return storedPromise.then(function(fromStorage) {
        var iface = fromTabValue ? info.tabValue : fromStorage;
        if (!iface || typeof iface !== 'string') {
          return false;
        }
        var effNow = (svc.getEffective)
          ? Promise.resolve(svc.getEffective(tab.id)).catch(function() { return null; })
          : Promise.resolve(null);
        return effNow.then(function(eff) {
          if (eff && eff.iface === iface && eff.layer === 'tab') {
            return false;
          }
          return Promise.resolve(svc.setAssignment(tab.id, iface)).then(function(ok) {
            log('info', 'restored binding tab=' + tab.id + ' browserId=' + info.browserId +
              ' -> ' + iface + (fromTabValue ? ' (session tab value)' : ' (storage)'));
            // Restored-from-tab-value: the browserId changed across restart;
            // re-persist under the fresh browserId for in-session lookups.
            var persist = fromTabValue ? persistAssignment(info.browserId, iface) : Promise.resolve();
            return persist.then(function() {
              refreshEffective(tab.id);
              return ok;
            });
          });
        });
      });
    }).catch(function() { return false; });
  }

  function rebindAllTabs() {
    return browser.tabs.query({}).then(function(tabs) {
      // Refresh the chip after each rebind (like the onCreated path does):
      // otherwise a restored ACTIVE tab keeps the startup-time chip label
      // (profile default) even though the native binding was reapplied.
      (tabs || []).forEach(function(tab) {
        rebindTab(tab).then(function() { refreshChipsForTab(tab); });
      });
    }).catch(function() {});
  }

  function refreshChipsForTab(tab) {
    if (!tab || !tab.windowId) {
      return;
    }
    browser.tabs.query({ active: true, windowId: tab.windowId }).then(function(tabs) {
      if (tabs && tabs[0] && tabs[0].id === tab.id) {
        // ensure (idempotent) + update: heals a chip lost to a startup
        // race on the first tab activity after it.
        ensureChipForWindow(tab.windowId);
      }
    }).catch(function() {});
  }

  // ── Feature loader entry ─────────────────────────────────────────

  function init() {
    log('info', 'netiface module init');
    if (!api()) {
      log('warn', 'rozelynxNetIface experiment API unavailable - module inactive');
      return;
    }
    // Purge the browserId-keyed cache BEFORE the first rebind pass: ids
    // are per-process, anything left from the previous process is stale.
    refreshInterfaces().then(function() {
      return ensureStoragePurged();
    }).then(function() {
      createMenu();
      ensureAllChips();
      rebindAllTabs();
      // Startup robustness: the first pass can lose races - the window
      // may not be registered with the extension window tracker yet
      // (restored windows, addon-update transitions), and nothing else
      // re-runs ensureAllChips later. ensureChip is idempotent, so a few
      // delayed retries are free.
      [5000, 15000, 45000].forEach(function(ms) {
        setTimeout(function() { ensureAllChips(); }, ms);
      });
    });

    // Chip lifecycle: track windows, keep the chip label live.
    if (browser.windows && browser.windows.onCreated) {
      browser.windows.onCreated.addListener(function(win) {
        if (win && win.type === 'normal') {
          ensureChipForWindow(win.id);
        }
      });
    }

    if (browser.rozelynxNetIface && browser.rozelynxNetIface.onChipClick) {
      browser.rozelynxNetIface.onChipClick.addListener(function(info) {
        if (info && typeof info.windowId === 'number') {
          openPicker(info.windowId);
        }
      });
    }

    browser.tabs.onActivated.addListener(function(activeInfo) {
      // Activation is the only trigger a lazily-restored tab is guaranteed to
      // produce. Session restore does NOT navigate background tabs - collapsed
      // tab groups in particular are restored without any load - so for those
      // neither onCreated's sessionstore read nor onUpdated's
      // `status === 'complete'` guard ever fires, and the single catch-up pass
      // ~2s after onStartup has long since closed. Those tabs were left on the
      // default layer (profile / container / URL rule) and did their DNS on the
      // wrong interface, which is why restore looked intermittent: it came down
      // to whether that particular tab happened to load inside the 2s window.
      //
      // Rebind BEFORE refreshing, so the chip and the assignment agree instead
      // of the chip reporting the default and the binding catching up later.
      // rebindTab is idempotent - it returns early when the effective binding
      // already matches - so an ordinary activation costs one lookup.
      Promise.resolve(browser.tabs.get(activeInfo.tabId))
        .then(rebindTab)
        .catch(function() {})
        .then(function() { return refreshEffective(activeInfo.tabId); })
        .then(function() {
          // ensure (idempotent, no-op when the chip exists) before the
          // live label refresh: heals a chip lost to a startup race.
          ensureChipForWindow(activeInfo.windowId);
        });
    });

    browser.tabs.onUpdated.addListener(function(tabId, changeInfo, tab) {
      if (changeInfo.status !== 'complete') {
        return;
      }
      // Restored tabs can finish loading before their sessionstore tab
      // value existed at onCreated time - re-check now. This is a no-op
      // for tabs whose binding is already in place.
      rebindTab(tab).then(function() { refreshChipsForTab(tab); });
      if (tab && tab.active) {
        refreshEffective(tabId).then(function() {
          refreshChipsForTab(tab);
        });
      }
    });

    // Session restore / new tabs: re-bind from the tab value (storage
    // cache as in-session fallback).
    browser.tabs.onCreated.addListener(function(tab) {
      rebindTab(tab).then(function() { refreshChipsForTab(tab); });
    });

    browser.tabs.onReplaced.addListener(function(addedTabId) {
      browser.tabs.get(addedTabId).then(function(tab) {
        rebindTab(tab).then(function() { refreshChipsForTab(tab); });
      }).catch(function() {});
    });

    if (browser.runtime && browser.runtime.onStartup) {
      browser.runtime.onStartup.addListener(function() {
        rebindAllTabs();
        // Lazy/slow restores repopulate tab values asynchronously; catch
        // anything the immediate pass ran too early for.
        setTimeout(rebindAllTabs, 2000);
      });
    }
  }

  if (typeof RozeLynxFeatures !== 'undefined' && RozeLynxFeatures.loadedModules) {
    RozeLynxFeatures.loadedModules.netiface = true;
  }

  // ── Message routing (picker popup, synthetic page menu) ───────────

  // The synthetic right-click menu is page-scoped, so its entry point is a
  // CONTENT SCRIPT: it has neither browser.tabs/browser.windows nor the
  // privileged experiment API, and the picker itself is a chrome popup window
  // that only the parent can create. Hence two parent-side actions:
  //   netiface:available   - "should I offer the menu entry at all?"
  //   netiface:open-picker - open the picker for the tab that was clicked
  // Plus netiface:refresh, which the extension popup's URL-rule editor uses
  // after a rule change (see refreshChips).
  browser.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    var action = message && message.action;
    if (action !== 'netiface:apply' && action !== 'netiface:effective' &&
        action !== 'netiface:available' && action !== 'netiface:open-picker' &&
        action !== 'netiface:refresh') {
      return false;
    }
    var data = (message && message.data) || {};
    Promise.resolve()
      .then(function() {
        if (action === 'netiface:available') {
          // A build without the netiface module has no listener at all, so
          // sendMessage never gets this far; a module whose experiment API is
          // missing answers available:false. Either way the content script
          // ends up with a definitive answer.
          return { available: !!api() };
        }
        if (action === 'netiface:refresh') {
          return refreshChips();
        }
        if (action === 'netiface:open-picker') {
          if (!api()) {
            throw new Error('netiface API unavailable');
          }
          // sender.tab is the tab hosting the page that was right-clicked -
          // including when that page is a sub-frame. An explicit tabId wins,
          // which is what makes the action usable from an extension page (the
          // picker popup has no reason to ask, but tests and future entry
          // points do).
          var wanted = (typeof data.tabId === 'number') ? data.tabId
            : (sender && sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : null);
          if (wanted === null) {
            throw new Error('no tab to bind');
          }
          return browser.tabs.get(wanted).then(function(tab) {
            return openPickerForTab(tab).then(function(pickerWindowId) {
              if (pickerWindowId === null) {
                throw new Error('could not open the interface picker');
              }
              return { tabId: tab.id, windowId: tab.windowId, pickerWindowId: pickerWindowId };
            });
          });
        }
        if (action === 'netiface:effective') {
          return browser.tabs.get(data.tabId).then(getEffectiveInterface);
        }
        return browser.tabs.get(data.tabId).then(function(tab) {
          return applyIface(tab, data.iface || '');
        });
      })
      .then(function(result) {
        sendResponse({ ok: true, data: result });
      })
      .catch(function(err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      });
    return true;
  });

  init();
})();
