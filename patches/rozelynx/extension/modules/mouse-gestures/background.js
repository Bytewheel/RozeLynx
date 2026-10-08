// Mouse Gestures - Background Script
// Handles gesture action execution and configuration

(function() {
  'use strict';

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

  var gestures = Object.assign({}, DEFAULT_GESTURES);
  var enabled = true;
  var ENABLED_STORAGE_KEY = 'rozelynx_gestures_enabled';
  var GESTURES_STORAGE_KEY = 'rozelynx_gestures';

  async function loadGestures() {
    try {
      var result = await browser.storage.local.get(GESTURES_STORAGE_KEY);
      if (result[GESTURES_STORAGE_KEY]) {
        gestures = Object.assign({}, DEFAULT_GESTURES, result[GESTURES_STORAGE_KEY]);
      } else {
        gestures = Object.assign({}, DEFAULT_GESTURES);
      }
    } catch(e) {
      gestures = Object.assign({}, DEFAULT_GESTURES);
    }
  }

  async function loadEnabled() {
    try {
      var result = await browser.storage.local.get(ENABLED_STORAGE_KEY);
      if (result[ENABLED_STORAGE_KEY] !== undefined) {
        enabled = result[ENABLED_STORAGE_KEY];
      }
    } catch(e) {
      enabled = true;
    }
  }

  async function saveGestures() {
    try {
      await browser.storage.local.set(JSON.parse('{"' + GESTURES_STORAGE_KEY + '":' + JSON.stringify(gestures) + '}'));
    } catch(e) {}
  }

  async function saveEnabled() {
    try {
      var data = {};
      data[ENABLED_STORAGE_KEY] = enabled;
      await browser.storage.local.set(data);
      // Notify content scripts
      browser.tabs.query({}).then(function(tabs) {
        tabs.forEach(function(tab) {
          browser.tabs.sendMessage(tab.id, {
            action: 'mgStateChanged',
            data: { enabled: enabled }
          }).catch(function() {});
        });
      });
    } catch(e) {}
  }

  async function executeAction(action) {
    try {
      var tabs = await browser.tabs.query({ currentWindow: true, active: true });
      var tab = tabs[0];
      if (!tab) return false;

      switch (action) {
        case 'back':
          browser.tabs.goBack(tab.id);
          break;
        case 'forward':
          browser.tabs.goForward(tab.id);
          break;
        case 'reload':
          browser.tabs.reload(tab.id);
          break;
        case 'stop':
          browser.tabs.executeScript(tab.id, { code: 'window.stop();' }).catch(function(){});
          break;
        case 'new_tab':
          browser.tabs.create({});
          break;
        case 'close_tab':
          browser.tabs.remove(tab.id);
          break;
        case 'reopen_tab':
          browser.sessions.restore();
          break;
        case 'next_tab':
          switchTab(1);
          break;
        case 'previous_tab':
          switchTab(-1);
          break;
        case 'duplicate_tab':
          browser.tabs.duplicate(tab.id);
          break;
        case 'toggle_pin_tab':
          browser.tabs.update(tab.id, { pinned: !tab.pinned });
          break;
        case 'scroll_top':
          browser.tabs.executeScript(tab.id, { code: 'window.scrollTo({top:0,behavior:"smooth"});' }).catch(function(){});
          break;
        case 'scroll_bottom':
          browser.tabs.executeScript(tab.id, { code: 'window.scrollTo({top:document.body.scrollHeight,behavior:"smooth"});' }).catch(function(){});
          break;
        case 'page_up':
          browser.tabs.executeScript(tab.id, { code: 'window.scrollBy({top:-window.innerHeight*0.8,behavior:"smooth"});' }).catch(function(){});
          break;
        case 'page_down':
          browser.tabs.executeScript(tab.id, { code: 'window.scrollBy({top:window.innerHeight*0.8,behavior:"smooth"});' }).catch(function(){});
          break;
        case 'new_window':
          browser.windows.create({});
          break;
        case 'new_private_window':
          browser.windows.create({ incognito: true });
          break;
        case 'bookmark':
          browser.bookmarks.create({ title: tab.title, url: tab.url }).catch(function(){});
          break;
        case 'home':
          browser.tabs.update(tab.id, { url: 'about:home' });
          break;
        case 'fullscreen':
          browser.windows.getCurrent().then(function(w) {
            browser.windows.update(w.id, { state: w.state === 'fullscreen' ? 'normal' : 'fullscreen' });
          });
          break;
        default:
          return false;
      }
      return true;
    } catch(e) {
      console.error('[RozeLynx MG] Action execution failed:', e);
      return false;
    }
  }

  async function switchTab(direction) {
    try {
      var tabs = await browser.tabs.query({ currentWindow: true });
      var activeTab = tabs.find(function(t) { return t.active; });
      if (!activeTab) return;
      var newIndex = (activeTab.index + direction + tabs.length) % tabs.length;
      if (tabs[newIndex]) {
        browser.tabs.update(tabs[newIndex].id, { active: true });
      }
    } catch(e) {}
  }

  browser.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    if (message.module !== 'mouse-gestures') return;

    switch (message.action) {
      case 'execute':
        var gestureStr = message.data && message.data.gesture;
        var action = gestures[gestureStr];
        if (action) {
          executeAction(action).then(function(result) {
            sendResponse({ success: result, action: action });
          });
        } else {
          sendResponse({ success: false, gesture: gestureStr });
        }
        return true;
      case 'getGestures':
        sendResponse({ gestures: Object.assign({}, gestures) });
        break;
      case 'setGesture':
        gestures[message.data.gesture] = message.data.action;
        saveGestures();
        sendResponse({ success: true });
        break;
      case 'resetGestures':
        gestures = Object.assign({}, DEFAULT_GESTURES);
        saveGestures();
        sendResponse({ success: true });
        break;
      case 'toggle':
        enabled = !enabled;
        saveEnabled();
        sendResponse({ enabled: enabled });
        break;
      case 'openTab': {
        // Open a URL in a new tab honouring the about:preferences
        // "switch to it immediately" checkbox (browser.tabs.loadInBackground).
        // Content scripts cannot read prefs, and their window.open calls are
        // diverted to browser.tabs.loadDivertedInBackground (default false),
        // which ignored the checkbox - so route the open through here.
        var url = message.data && message.data.url;
        if (!url) {
          sendResponse({ ok: false, error: 'no url' });
          break;
        }
        (async function() {
          // Pin the tab to the sender's window: tabs.create without a
          // windowId lands in "the current window", which on Wayland/focus
          // quirks can be a different window than the one the user actually
          // right-clicked in (e.g. opening into the main window from a PWA
          // app window makes the action look like it did nothing).
          var createOpts = { url: url };
          if (sender.tab && sender.tab.windowId) {
            createOpts.windowId = sender.tab.windowId;
          }
          // Try to read browser.tabs.loadInBackground to decide whether
          // the new tab should be active.  If the experiment API is
          // unavailable or fails, omit `active` entirely so Firefox uses
          // its own default (honouring the about:preferences checkbox).
          var active = null;
          try {
            if (browser.rozelynxPrefs && browser.rozelynxPrefs.getPrefs) {
              var prefs = await browser.rozelynxPrefs.getPrefs(['browser.tabs.loadInBackground']);
              var entry = prefs && prefs.find(function(p) {
                return p.name === 'browser.tabs.loadInBackground';
              });
              if (entry && entry.type === 'boolean') {
                active = !entry.value;
                createOpts.active = active;
              }
            }
          } catch (prefErr) {}
          try {
            console.debug('[RozeLynx MG] openTab url=' + url + ' targetWindow=' +
              (createOpts.windowId !== undefined ? createOpts.windowId : 'current') +
              ' active=' + (active === null ? 'default' : active));
            await browser.tabs.create(createOpts);
            sendResponse({ ok: true, active: active });
          } catch (tabErr) {
            sendResponse({ ok: false, error: String(tabErr) });
          }
        })();
        return true;
      }
      case 'openWindow': {
        // Open a URL in a brand-new regular window. Never a PWA/SSB window:
        // with the PWA module's window registry this is always non-PWA, and
        // the opener's window is left untouched.
        var owUrl = message.data && message.data.url;
        if (!owUrl) {
          sendResponse({ ok: false, error: 'no url' });
          break;
        }
        browser.windows.create({ url: owUrl, type: 'normal' }).then(function() {
          sendResponse({ ok: true });
        }).catch(function(owErr) {
          sendResponse({ ok: false, error: String(owErr) });
        });
        return true;
      }
      case 'getStatus':
        sendResponse({ enabled: enabled, gestureCount: Object.keys(gestures).length });
        break;

      // ── other extensions' context-menu items ─────────────────────────
      //
      // These two live HERE, in the background, and not in the content script
      // that shows the menu, and that is not a style choice. Gecko registers
      // `menus` with scopes:["addon_parent"] - extension pages only
      // (browser/components/extensions/ext-browser.json; see
      // toolkit/components/extensions/docs/basics.md, "addon_parent ...
      // Extension pages" vs "content_parent ... Content scripts"). A content
      // script has no `browser.menus` at all - not restricted, absent.
      //
      // They used to be reached through menus.html: a web-accessible
      // moz-extension:// iframe injected into the page by the content script.
      // That is still a content script, so `browser.menus` was undefined
      // there, the bridge answered {ok:false, error:'noapi'} on every single
      // menu open, and the synthetic menu has never shown another extension's
      // items. It was invisible to every harness because the harness stub
      // provided `menus`; a stand-in for the platform cannot report that the
      // platform is absent.
      //
      // The content script already had a working message path to this page
      // (gestures, openTab, the netiface entries), so this is a move rather
      // than new machinery - and it deletes a moz-extension iframe that was
      // being injected into every page at document_start.
      case 'extmenuQuery': {
        var ctx = (message.data && message.data.ctx) || {};
        if (!browser.menus || typeof browser.menus.rozelynxQuery !== 'function') {
          // Named, and logged: a silent empty section is exactly what made
          // this take a whole session to find.
          var why = 'browser.menus.rozelynxQuery is not available to this build';
          console.warn('[RozeLynx MG] extension menu items unavailable: ' + why);
          sendResponse({ ok: false, error: why });
          break;
        }
        browser.menus.rozelynxQuery(ctx).then(function(items) {
          sendResponse({ ok: true, items: items || [] });
        }).catch(function(qErr) {
          var msg = String((qErr && qErr.message) || qErr);
          console.warn('[RozeLynx MG] extension menu query failed: ' + msg);
          sendResponse({ ok: false, error: msg });
        });
        return true;
      }
      case 'extmenuTrigger': {
        var req = (message.data && message.data.request) || {};
        if (!browser.menus || typeof browser.menus.rozelynxTrigger !== 'function') {
          sendResponse({ ok: false, error: 'browser.menus.rozelynxTrigger is not available to this build' });
          break;
        }
        browser.menus.rozelynxTrigger({
          extId: req.extId,
          itemId: req.itemId,
          src: req.src,
        }).then(function() {
          sendResponse({ ok: true });
        }).catch(function(tErr) {
          sendResponse({ ok: false, error: String((tErr && tErr.message) || tErr) });
        });
        return true;
      }
      default:
        break;
    }
  });

  loadGestures();
  loadEnabled();
  RozeLynxFeatures.loadedModules['mouse-gestures'] = true;
  console.log('[RozeLynx] Mouse Gestures module loaded');
})();
