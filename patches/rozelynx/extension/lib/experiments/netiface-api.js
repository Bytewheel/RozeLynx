/* RozeLynx experiment API: network-interface binding (parent side).
 *
 * Bridges the extension to the compiled XPCOM service
 * (@bytewheel.org/netiface;1, nsIRozeLynxNetIface, USE=net-iface):
 *
 *   getInterfaces()            enumerate usable interfaces
 *   getEffective(tabId)        resolve {iface, layer} for a tab; the tab's URL
 *                              is passed to the service so the URL-rule layer
 *                              is included, and layer can be "url"
 *   setAssignment(tabId, ifc)  bind a tab ("" clears the binding); also
 *                              persists it as a SessionStore tab value
 *                              (extData) so it survives restarts
 *   getTabInfo(tabId)          resolve {browserId, userContextId, tabValue, url}
 *   set/getProfileInterface()  profile-layer assignment
 *   getIfaceTrrURI(ifc)        per-iface DoH TRR override
 *   get/setUrlRules()          the per-URL rule list (pref-backed, below)
 *   setUrlRulesEnabled()       the URL-rule master switch
 *   matchUrlRule(url)          which rule a URL hits, and which layer wins
 *
 * Precedence, as resolved by the service (see RozeLynxNetIface.h):
 *   tab > url rule > container > profile > "" (default routing)
 *
 * Per-URL rules are PREF-backed - the service rebuilds its rule list from the
 * rozelynx.netiface.* pref observer - so this side reads and writes prefs
 * directly (the same Services.prefs the prefs experiment API uses) instead of
 * routing through it: one round trip for a whole list, and the pref file stays
 * the single source of truth that about:config shows.
 *
 *   rozelynx.netiface.urlrules.enabled          master switch (default on)
 *   rozelynx.netiface.urlrule.<n>.pattern       e.g. "*.example.com"
 *   rozelynx.netiface.urlrule.<n>.iface         "" = force default routing
 *   rozelynx.netiface.urlrule.<n>.enabled       optional, default true
 *
 * Tab resolution uses context.extension.tabManager (the sandbox has no
 * `browser` global - the WebExtension tabId is mapped to the XUL tab,
 * whose linkedBrowser's top BrowsingContext carries the stable BrowserId
 * that the native service keys its tab map by).
 *
 * Window decoration chip: ensureChip/updateChip/removeChip create a small
 * pill element in the TabsToolbar of a browser window; onChipClick is
 * fired (with {windowId}) when the user clicks it. The extension module
 * owns the picker popup; this side only renders and reports clicks.
 * The chip outlives MV3 event-page idle suspension (teardown only on
 * real extension shutdown), and onChipClick is a PERSISTED event so a
 * click while the background is suspended wakes it and replays.
 *
 * The experiment sandbox provides ExtensionAPI, ExtensionCommon,
 * Services, Cc, Ci and ChromeUtils as globals.
 */

const NETIFACE_TABVALUE_KEY = "rozelynxNetIface";
const URLRULE_PREFIX = "rozelynx.netiface.urlrule.";
const URLRULE_FIELDS = ["pattern", "iface", "enabled"];
const URLRULES_ENABLED_PREF = "rozelynx.netiface.urlrules.enabled";
// Human-readable layer names, shared by the chip's first paint here and by
// modules/netiface/background.js's chipTooltip. "url" is the URL-rule layer.
const LAYER_TEXT = {
  tab: 'tab binding',
  url: 'URL rule',
  container: 'container default',
  profile: 'profile default',
};
// Must match kMaxUrlRules in cpp/net-iface/RozeLynxNetIface.h: the service
// silently drops anything past the cap, so the editor refuses it up front
// rather than letting a row look saved when it is not.
const URLRULE_MAX = 256;

var rozelynxNetIfaceChipRegistry = {
  // windowId -> { chromeWin, el }
  chips: new Map(),
  // onChipClick listener closures (one per registered listener). While the
  // MV3 event page is suspended this holds the PRIMED closure, whose fire
  // queues the click and wakes the background (see PERSISTENT_EVENTS).
  fires: new Set(),
};

// Chip click dispatch: every registered onChipClick listener gets the
// {windowId} info. Closures swallow their own errors; a dead (unloaded
// context) fire is a no-op inside EventManager, a primed fire wakes the
// background and replays the click once the listener re-registers.
function chipClickDispatch(info) {
  rozelynxNetIfaceChipRegistry.fires.forEach(function(listener) {
    try {
      listener(info);
    } catch (e) {}
  });
}

// Remove a window's chip element + registry entry. Module-level: called
// both from getAPI helpers and from the class-level onShutdown below.
function removeChipInWindow(windowId) {
  const entry = rozelynxNetIfaceChipRegistry.chips.get(windowId);
  rozelynxNetIfaceChipRegistry.chips.delete(windowId);
  if (!entry || !entry.el) {
    return false;
  }
  try {
    const el = entry.el;
    if (el.parentNode) {
      el.parentNode.removeChild(el);
    }
    el.removeEventListener('click', entry.clickHandler);
    el.removeEventListener('mouseenter', entry.hoverIn);
    el.removeEventListener('mouseleave', entry.hoverOut);
    if (entry.chromeWin && !entry.chromeWin.closed) {
      entry.chromeWin.removeEventListener('unload', entry.unload);
    }
  } catch (e) {}
  return true;
}

this.rozelynxNetIface = class extends ExtensionAPIPersistent {
  // The background is an MV3 EVENT PAGE: Firefox suspends it after idle.
  // onChipClick is a PERSISTED event: while the background is suspended a
  // PRIMED listener stays registered here, so a chip click wakes the
  // background and is replayed to the freshly-registered listener (the
  // picker opens exactly as if the page had been running).
  PERSISTENT_EVENTS = {
    onChipClick({ fire }) {
      const listener = info => {
        try {
          Promise.resolve(fire.async(info)).catch(function() {});
        } catch (e) {}
      };
      rozelynxNetIfaceChipRegistry.fires.add(listener);
      return {
        unregister() {
          rozelynxNetIfaceChipRegistry.fires.delete(listener);
        },
        convert(newFire) {
          fire = newFire;
        },
      };
    },
  };

  // Chips are shared chrome-DOM decorations and the chip is the ONLY
  // user surface while the event page is suspended: they must SURVIVE
  // idle suspension. Teardown therefore happens on real extension
  // shutdown only (disable/uninstall/update/app shutdown) - NOT on the
  // per-context close that fires for every event-page suspend.
  onShutdown(_isAppShutdown) {
    for (const windowId of Array.from(rozelynxNetIfaceChipRegistry.chips.keys())) {
      removeChipInWindow(windowId);
    }
    rozelynxNetIfaceChipRegistry.fires.clear();
  }

  getAPI(context) {
    const { Services } = ChromeUtils;

    const CHIP_ID = "rozelynx-netiface-chip";
    // The chip is a chrome-window decoration running OUTSIDE extension
    // styling rules, so the icon must not depend on emoji fonts (which
    // are not guaranteed to be installed / substituted in the toolbar
    // font chain). Inline SVG data URIs render identically everywhere.
    const CHIP_ICONS = {
      lock: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M5 6V4a3 3 0 0 1 6 0v2h1a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h1zm1 0h4V4a2 2 0 1 0-4 0z' fill='%237c7c85'/%3E%3C/svg%3E\")",
      globe: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cg fill='none' stroke='%237c7c85' stroke-width='1.3'%3E%3Ccircle cx='8' cy='8' r='6'/%3E%3Cellipse cx='8' cy='8' rx='2.6' ry='6'/%3E%3Cpath d='M2 8h12'/%3E%3Cpath d='M3.4 4.6h9.2M3.4 11.4h9.2'/%3E%3C/g%3E%3C/svg%3E\")",
    };
    const CHIP_STYLE =
      "margin: 0 4px; padding: 0 8px 0 25px; border-radius: 99px; align-self: center;" +
      " border: 1px solid color-mix(in srgb, currentColor 25%, transparent);" +
      " background-color: color-mix(in srgb, currentColor 8%, transparent);" +
      " background-repeat: no-repeat; background-size: 13px 13px;" +
      " background-position: 6px center;" +
      " color: inherit; font: inherit; font-size: 12px; display: flex; align-items: center; min-height: 16px; line-height: 16px;" +
      " white-space: nowrap; cursor: pointer; -moz-user-focus: none;";
    const CHIP_HOVER_STYLE =
      "margin: 0 4px; padding: 0 8px 0 25px; border-radius: 99px; align-self: center;" +
      " border: 1px solid color-mix(in srgb, currentColor 35%, transparent);" +
      " background-color: color-mix(in srgb, currentColor 16%, transparent);" +
      " background-repeat: no-repeat; background-size: 13px 13px;" +
      " background-position: 6px center;" +
      " color: inherit; font: inherit; font-size: 12px; display: flex; align-items: center; min-height: 16px; line-height: 16px;" +
      " white-space: nowrap; cursor: pointer; -moz-user-focus: none;";

    // Fallback: enumerate network interfaces without the compiled XPCOM
    // service (@bytewheel.org/netiface;1). The service is only present when
    // Firefox is built with USE=net-iface; without it, Cc resolve throws and
    // getInterfaces() used to return [] (empty netiface dropdown). The sysfs
    // fallback (~/class/net) mirrors the service's enumeration: skip loopback
    // and interfaces that are administratively down.
    function readSmallFile(path) {
      try {
        const f = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
        f.initWithPath(path);
        if (!f.exists() || !f.isFile()) {
          return '';
        }
        const stream = Cc['@mozilla.org/network/file-input-stream;1'].createInstance(
          Ci.nsIFileInputStream
        );
        stream.init(f, -1, 0, 0);
        const conv = Cc['@mozilla.org/intl/converter-input-stream;1'].createInstance(
          Ci.nsIConverterInputStream
        );
        conv.init(stream, 'UTF-8');
        let out = '';
        for (;;) {
          const chunk = {};
          const read = conv.readString(0xffffffff, chunk);
          out += chunk.value || '';
          if (!read) {
            break;
          }
        }
        conv.close();
        stream.close();
        return out;
      } catch (e) {
        return '';
      }
    }

    function listInterfacesFromSysfs() {
      const out = [];
      try {
        const dir = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
        dir.initWithPath('/sys/class/net');
        if (!dir.exists() || !dir.isDirectory()) {
          return out;
        }
        const entries = dir.directoryEntries;
        while (entries.hasMoreElements()) {
          const name = entries.nextElement().QueryInterface(Ci.nsIFile).leafName;
          if (!name || name === 'lo') {
            continue;
          }
          const flagsHex = readSmallFile('/sys/class/net/' + name + '/flags').trim();
          const flags = parseInt(flagsHex, 16);
          if (isNaN(flags) || !(flags & 0x1)) {
            continue;
          }
          const type = readSmallFile('/sys/class/net/' + name + '/type').trim();
          out.push({ name, displayName: name, type, up: true, hasIPv4: false, hasIPv6: false, loopback: false });
        }
      } catch (e) {}
      return out;
    }

    function netifaceService() {
      return Cc['@bytewheel.org/netiface;1'].getService(
        Ci.nsIRozeLynxNetIface
      );
    }

    // Session-store tab values: this build has NO nsISessionStore XPCOM
    // contract (@mozilla.org/browser/sessionstore;1 is not in Cc). The
    // SessionStore ES module's custom-tab-value API is the sanctioned path
    // (the same backing the WebExtension `sessions` tab values use);
    // values ride in tab extData and survive session restore by design.
    //
    // Firefox 156 moved browser ES modules from resource:///modules/... to
    // the moz-src:/// scheme (sessionstore's own components.conf and
    // sibling modules now import from
    // "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs").
    // The old resource:/// URL fails to resolve and logs
    // "Missing chrome or resource URL" on every call - silently, because
    // every caller wraps this in try/catch - which meant setAssignment
    // NEVER persisted a tab value and getTabInfo ALWAYS read tabValue:null,
    // so every browser restart lost every per-tab binding (the "I have to
    // set the interface back to wlan0" complaint).
    function sessionStoreModule() {
      return ChromeUtils.importESModule(
        "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs"
      );
    }

    /**
     * Resolve a WebExtension tabId to the keys the native service uses
     * plus the persisted binding: the top BrowsingContext's BrowserId, the
     * tab's container id, the tab's URL (for the URL-rule layer) and the
     * SessionStore tab value (extData).
     * Returns {browserId: 0, userContextId: 0, tabValue: null, url: ''} on
     * failure.
     */
    function tabInfoFor(tabId) {
      try {
        const tab = context.extension.tabManager.get(tabId);
        const nativeTab = tab && tab.nativeTab;
        if (!nativeTab) {
          return { browserId: 0, userContextId: 0, tabValue: null, url: '' };
        }
        let browserId = 0;
        try {
          const bc = nativeTab.linkedBrowser && nativeTab.linkedBrowser.browsingContext;
          if (bc) {
            const top = bc.top || bc;
            browserId = Number(top.browserId) || 0;
          }
        } catch (e) {}
        let userContextId = 0;
        try {
          userContextId = Number(nativeTab.userContextId) || 0;
        } catch (e) {}
        let tabValue = null;
        try {
          const { SessionStore } = sessionStoreModule();
          const raw = SessionStore.getCustomTabValue(nativeTab, NETIFACE_TABVALUE_KEY);
          if (raw) {
            tabValue = JSON.parse(raw);
          }
        } catch (e) {}
        return {
          browserId: browserId,
          userContextId: userContextId,
          tabValue: tabValue,
          url: tabUrlFor(tab, nativeTab),
        };
      } catch (e) {
        return { browserId: 0, userContextId: 0, tabValue: null, url: '' };
      }
    }

    /**
     * The tab's current document URL, for the URL-rule layer.  The service
     * accepts a bare host, a host+path or a full URL, so whatever is
     * available works; the ExtensionTab's own url is preferred and the linked
     * browser's currentURI is the fallback.  Empty on failure, which the
     * service treats as "skip the URL layer" (pre-URL-rule behavior).
     */
    function tabUrlFor(tab, nativeTab) {
      try {
        if (tab && typeof tab.url === 'string' && tab.url) {
          return tab.url;
        }
      } catch (e) {}
      try {
        const lb = nativeTab && nativeTab.linkedBrowser;
        const uri = lb && lb.currentURI;
        if (uri && uri.spec) {
          return String(uri.spec);
        }
      } catch (e) {}
      return '';
    }

    // ── Per-URL rules (pref-backed; see the header) ────────────────

    /** Every <n> that has at least one urlrule.<n>.* pref. */
    function urlRuleIndices() {
      const found = new Set();
      let names = [];
      try {
        names = Services.prefs.getChildList(URLRULE_PREFIX);
      } catch (e) {
        return [];
      }
      names.forEach(function(name) {
        // Pref names are "<n>.<field>": only a bare integer head counts, so
        // "urlrule.x.iface" and "urlrules.enabled" are not mistaken for rules.
        const tail = String(name).slice(URLRULE_PREFIX.length);
        const dot = tail.indexOf('.');
        if (dot <= 0) {
          return;
        }
        const head = tail.slice(0, dot);
        const n = parseInt(head, 10);
        if (!isNaN(n) && n >= 0 && head === String(n)) {
          found.add(n);
        }
      });
      return Array.from(found).sort(function(a, b) { return a - b; });
    }

    function readUrlRules() {
      const rules = urlRuleIndices().map(function(n) {
        const rule = { index: n, pattern: '', iface: '', enabled: true };
        try {
          rule.pattern =
            Services.prefs.getStringPref(URLRULE_PREFIX + n + '.pattern', '') || '';
        } catch (e) {}
        try {
          rule.iface =
            Services.prefs.getStringPref(URLRULE_PREFIX + n + '.iface', '') || '';
        } catch (e) {}
        try {
          rule.enabled =
            Services.prefs.getBoolPref(URLRULE_PREFIX + n + '.enabled', true);
        } catch (e) {}
        return rule;
      });
      let enabled = true;
      try {
        enabled = Services.prefs.getBoolPref(URLRULES_ENABLED_PREF, true);
      } catch (e) {}
      return { enabled: enabled, rules: rules };
    }

    /**
     * Replace the whole rule list.  Writing the prefs is enough to reach the
     * service - its rozelynx.netiface.* observer rebuilds the list - and
     * indices past the new length are CLEARED, so deleting the last row in
     * the editor cannot leave a live rule behind in about:config.
     *
     * Returns the RE-READ list, so the editor shows what is actually stored
     * rather than what it hoped to store.
     */
    function writeUrlRules(rules) {
      const list = Array.isArray(rules) ? rules : [];
      const read = readUrlRules();
      if (list.length > URLRULE_MAX) {
        return {
          ok: false,
          error: 'too many rules (max ' + URLRULE_MAX + ')',
          enabled: read.enabled,
          rules: read.rules,
        };
      }
      const errors = [];
      const stale = urlRuleIndices();
      list.forEach(function(rule, n) {
        const pattern = String((rule && rule.pattern) || '').trim();
        if (!pattern) {
          errors.push('rule ' + n + ': empty pattern');
          return;
        }
        const base = URLRULE_PREFIX + n + '.';
        const iface = rule.iface == null ? '' : String(rule.iface);
        try {
          Services.prefs.setStringPref(base + 'pattern', pattern);
          Services.prefs.setStringPref(base + 'iface', iface);
          // Written as an explicit true, not left absent: a user who unticked
          // the box must not have it come back ticked because the pref was
          // cleared rather than set.
          Services.prefs.setBoolPref(base + 'enabled', rule.enabled !== false);
        } catch (e) {
          errors.push('rule ' + n + ': ' + ((e && e.message) || String(e)));
        }
      });
      stale.forEach(function(n) {
        if (n >= list.length) {
          URLRULE_FIELDS.forEach(function(field) {
            try {
              Services.prefs.clearUserPref(URLRULE_PREFIX + n + '.' + field);
            } catch (e) {}
          });
        }
      });
      const after = readUrlRules();
      return {
        ok: errors.length === 0,
        error: errors.join('; '),
        enabled: after.enabled,
        rules: after.rules,
      };
    }

    /**
     * Resolve a chrome window from a WebExtension window ID.
     * Tries the extension windowManager first, then falls back to
     * enumerating all browser windows (same pattern as windows-api.js).
     */
    function resolveChromeWindow(windowId) {
      try {
        const winWrapper = context.extension.windowManager.get(windowId);
        if (winWrapper && winWrapper.window) {
          return winWrapper.window;
        }
      } catch (e) {}

      try {
        const enumerator = Services.wm.getEnumerator('navigator:browser');
        while (enumerator.hasMoreElements()) {
          const w = enumerator.getNext();
          // windowID is a string (nsID-style); WebExtension window ids
          // are numbers - compare as strings or this never matches.
          if (w && w.gBrowser && String(w.windowID) === String(windowId)) {
            return w;
          }
        }
      } catch (e) {}

      return null;
    }

    function chipClickHandler(windowId) {
      return function() {
        chipClickDispatch({ windowId: windowId });
      };
    }

    // Synchronous first paint for the chip. The module's refresh chain
    // runs from the MV3 event page and can lose the race with idle
    // suspension during startup; this side has chrome access, so the
    // label / tooltip / icon are computed here from the native service
    // for the ACTIVE tab at (re)creation time. The module's updateChip
    // remains the canonical live-refresh path afterwards - the strings
    // below mirror chipLabel/chipTooltip in modules/netiface/background.js.
    function paintChipInitialState(el, chromeWin) {
      let iface = '';
      let layer = '';
      try {
        const svc = netifaceService();
        try {
          const nativeTab = chromeWin.gBrowser && chromeWin.gBrowser.selectedTab;
          if (nativeTab && nativeTab.linkedBrowser) {
            const bc = nativeTab.linkedBrowser.browsingContext;
            if (bc) {
              const browserId = Number((bc.top || bc).browserId) || 0;
              const userContextId = Number(nativeTab.userContextId) || 0;
              if (browserId) {
                const out = {};
                // The URL is the third argument: the service's getEffective
                // signature carries the URL-rule layer, so omitting it here
                // would leave the chip unable to report a URL-bound tab.
                iface = svc.getEffective(browserId, userContextId,
                                         tabUrlFor(null, nativeTab), out) || '';
                layer = out.value || '';
              }
            }
          }
        } catch (e) {}
        let profileIface = '';
        try {
          profileIface = svc.getProfileInterface() || '';
        } catch (e) {}
        const label = iface || 'default';
        let tooltip = 'RozeLynx network interface: ';
        tooltip += iface
          ? iface + ' (layer: ' + (LAYER_TEXT[layer] || layer || 'none') + ')'
          : 'default routing';
        tooltip += profileIface
          ? ' | profile default: ' + profileIface
          : ' | profile default: unassigned';
        tooltip += ' — click to change';
        el.textContent = label;
        el.setAttribute('tooltiptext', tooltip);
        el.style.backgroundImage = iface ? CHIP_ICONS.lock : CHIP_ICONS.globe;
      } catch (e) {
        // No compiled netiface service (e.g. built without USE=net-iface):
        // neutral defaults; a later module refresh takes over if it can.
        try {
          el.textContent = 'default';
          el.style.backgroundImage = CHIP_ICONS.globe;
        } catch (e2) {}
      }
    }

    /**
     * Create (or find) the chip in a window's TabsToolbar. Returns the
     * element or null when the window has no tab toolbar (e.g. popup
     * windows, SSB windows).
     */
    function ensureChipInWindow(chromeWin, windowId) {
      if (!chromeWin || chromeWin.closed) {
        return null;
      }
      const doc = chromeWin.document;
      if (!doc || !doc.documentElement) {
        return null;
      }
      let el = doc.getElementById(CHIP_ID);
      if (el) {
        // Created earlier (e.g. by a previous context of this API script -
        // the module-level registry is shared). Make sure updateChip can
        // find it; its click handler already dispatches to the shared
        // fire set.
        if (!rozelynxNetIfaceChipRegistry.chips.has(windowId)) {
          rozelynxNetIfaceChipRegistry.chips.set(windowId, { chromeWin: chromeWin, el: el });
        }
        paintChipInitialState(el, chromeWin);
        return el;
      }
      const tabsToolbar = doc.getElementById('TabsToolbar');
      if (!tabsToolbar) {
        return null;
      }

      el = doc.createElement('label');
      el.setAttribute('id', CHIP_ID);
      el.textContent = '';
      el.setAttribute('tooltiptext', 'RozeLynx network interface');
      el.setAttribute('style', CHIP_STYLE);
      el.style.backgroundImage = CHIP_ICONS.lock;
      const clickHandler = chipClickHandler(windowId);
      // Only touch border/background-color on hover: the whole style attr
      // overwrite pattern would wipe the CSSOM-set backgroundImage icon.
      const hoverIn = function() {
        el.style.borderColor = 'color-mix(in srgb, currentColor 35%, transparent)';
        el.style.backgroundColor = 'color-mix(in srgb, currentColor 16%, transparent)';
      };
      const hoverOut = function() {
        el.style.borderColor = 'color-mix(in srgb, currentColor 25%, transparent)';
        el.style.backgroundColor = 'color-mix(in srgb, currentColor 8%, transparent)';
      };
      el.addEventListener('click', clickHandler);
      el.addEventListener('mouseenter', hoverIn);
      el.addEventListener('mouseleave', hoverOut);

      // Right of the tab strip, left of the post-tabs spacer / window
      // controls, so it never collides with the window buttons.
      let anchor = null;
      try {
        anchor = tabsToolbar.querySelector('.titlebar-spacer[type="post-tabs"]');
      } catch (e) {}
      if (anchor && anchor.parentNode === tabsToolbar) {
        tabsToolbar.insertBefore(el, anchor);
      } else {
        tabsToolbar.appendChild(el);
      }

      // Drop the registry entry when the window goes away.
      const unload = function() {
        rozelynxNetIfaceChipRegistry.chips.delete(windowId);
      };
      chromeWin.addEventListener('unload', unload);

      rozelynxNetIfaceChipRegistry.chips.set(windowId, {
        chromeWin: chromeWin, el: el,
        clickHandler: clickHandler, hoverIn: hoverIn, hoverOut: hoverOut,
        unload: unload,
      });
      paintChipInitialState(el, chromeWin);
      return el;
    }

    // Chip teardown on real extension shutdown (reload/disable/uninstall)
    // lives on the CLASS-level onShutdown above. It must NOT be hooked to
    // context.callOnClose: getAPI() runs for EVERY extension context that
    // touches this namespace (the picker popup included), and for MV3
    // event pages the BACKGROUND context itself closes on every idle
    // suspend - tearing the chips down there removed every window's chip
    // about half a minute after the user stopped interacting, leaving no
    // way to reach the picker (the chip is the only wake surface).

    return {
      rozelynxNetIface: {
        getInterfaces() {
          try {
            const arr = netifaceService().interfaces;
            return arr ? Array.from(arr).map(function(info) {
              return {
                name: info.name || '',
                displayName: info.displayName || info.name || '',
                type: info.type || '',
                up: !!info.up,
                hasIPv4: !!info.hasIPv4,
                hasIPv6: !!info.hasIPv6,
                loopback: !!info.loopback,
              };
            }) : [];
          } catch (e) {
            return listInterfacesFromSysfs();
          }
        },

        getEffective(tabId) {
          try {
            const info = tabInfoFor(tabId);
            if (!info.browserId) {
              return { iface: '', layer: '' };
            }
            const layer = {};
            const iface = netifaceService().getEffective(
              info.browserId, info.userContextId, info.url || '', layer) || '';
            return { iface: iface, layer: layer.value || '' };
          } catch (e) {
            return { iface: '', layer: '' };
          }
        },

        // NOTE: "*" is the explicit all-interfaces binding (see
        // NS_NETIFACE_ALL_IFACES in RozeLynxNetIface.cpp). It is truthy here, so
        // it is stored natively and persisted, whereas "" clears the tab binding
        // and falls through to the lower layers. Do not normalise "*" to "".
        setAssignment(tabId, ifaceName) {
          try {
            const tab = context.extension.tabManager.get(tabId);
            const nativeTab = tab && tab.nativeTab;
            if (!nativeTab) {
              return false;
            }
            const info = tabInfoFor(tabId);
            if (!info.browserId) {
              return false;
            }
            netifaceService().setTabInterface(info.browserId, ifaceName || '');
            try {
              const { SessionStore } = sessionStoreModule();
              if (ifaceName) {
                SessionStore.setCustomTabValue(
                  nativeTab, NETIFACE_TABVALUE_KEY, JSON.stringify(String(ifaceName))
                );
              } else {
                SessionStore.deleteCustomTabValue(nativeTab, NETIFACE_TABVALUE_KEY);
              }
            } catch (e) {}
            return true;
          } catch (e) {
            return false;
          }
        },

        getTabInfo(tabId) {
          return tabInfoFor(tabId);
        },

        setProfileInterface(ifaceName) {
          try {
            const svc = netifaceService();
            if (svc.setProfileInterface) {
              svc.setProfileInterface(ifaceName || '');
              return true;
            }
          } catch (e) {}
          return false;
        },

        getProfileInterface() {
          try {
            const svc = netifaceService();
            if (svc.getProfileInterface) {
              return svc.getProfileInterface() || '';
            }
          } catch (e) {}
          return '';
        },

        getIfaceTrrURI(ifaceName) {
          try {
            const svc = netifaceService();
            if (svc.getIfaceTrrURI) {
              return svc.getIfaceTrrURI(ifaceName) || '';
            }
          } catch (e) {}
          return '';
        },

        // ── Per-URL rules ───────────────────────────────────────────

        getUrlRules() {
          return readUrlRules();
        },

        setUrlRules(rules) {
          return writeUrlRules(rules);
        },

        setUrlRulesEnabled(enabled) {
          try {
            Services.prefs.setBoolPref(URLRULES_ENABLED_PREF, !!enabled);
            return { ok: true, enabled: !!enabled };
          } catch (e) {
            return {
              ok: false,
              error: String((e && e.message) || e),
              enabled: readUrlRules().enabled,
            };
          }
        },

        /**
         * Ask the service which rule a URL hits.  The answer comes from the
         * service's own matcher (not a JS re-implementation), so the popup's
         * match preview cannot disagree with what the socket path will do.
         */
        matchUrlRule(url) {
          try {
            const svc = netifaceService();
            if (!svc.matchUrlRule) {
              return { matched: false, index: -1, pattern: '', iface: '' };
            }
            const out = {};
            const matched = !!svc.matchUrlRule(String(url || ''), out);
            return {
              matched: matched,
              index: out.index ?? -1,
              pattern: out.pattern || '',
              iface: out.iface || '',
            };
          } catch (e) {
            return { matched: false, index: -1, pattern: '', iface: '' };
          }
        },

        // ── Window decoration chip ───────────────────────────────────

        ensureChip(windowId) {
          const chromeWin = resolveChromeWindow(windowId);
          if (!chromeWin) {
            return { ok: false, error: 'window not found: ' + windowId };
          }
          const el = ensureChipInWindow(chromeWin, windowId);
          if (!el) {
            return { ok: false, error: 'no tab toolbar in window ' + windowId };
          }
          return { ok: true };
        },

        updateChip(windowId, text, tooltip, icon) {
          const entry = rozelynxNetIfaceChipRegistry.chips.get(windowId);
          if (!entry || !entry.el) {
            return { ok: false, error: 'no chip in window ' + windowId };
          }
          try {
            if (entry.chromeWin.closed) {
              rozelynxNetIfaceChipRegistry.chips.delete(windowId);
              return { ok: false, error: 'window closed: ' + windowId };
            }
            const label = String(text || '');
            entry.el.textContent = label;
            entry.el.setAttribute('tooltiptext', String(tooltip || ''));
            if (icon && CHIP_ICONS[icon]) {
              entry.el.style.backgroundImage = CHIP_ICONS[icon];
            }
            return { ok: true };
          } catch (e) {
            return { ok: false, error: String(e) };
          }
        },

        removeChip(windowId) {
          return { ok: removeChipInWindow(windowId) };
        },

        onChipClick: new ExtensionCommon.EventManager({
          context,
          module: 'rozelynxNetIface',
          event: 'onChipClick',
          inputHandling: true,
          extensionApi: this,
        }).api(),
      },
    };
  }
};
