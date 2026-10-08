/* RozeLynx external-link chooser page.
 *
 * Loaded as a tab by ExternalLinkCommandLineHandler.sys.mjs with query
 * params: url=<encoded target>&current=<ProfD leaf of this profile>.
 * Asks the external-link background module for the profile list (native
 * host) and this profile's netiface list, then dispatches the open.
 */

(function() {
  'use strict';

  var LOG_PREFIX = '[RozeLynx:external-link]';

  var params = new URLSearchParams(location.search);
  var targetUrl = params.get('url') || '';
  var currentDir = params.get('current') || '';

  var urlDisplay = document.getElementById('url-display');
  var profileSelect = document.getElementById('profile-select');
  var profileHint = document.getElementById('profile-hint');
  var ifaceSelect = document.getElementById('iface-select');
  var setDefaultBox = document.getElementById('set-default');
  var statusEl = document.getElementById('status');
  var openBtn = document.getElementById('open-btn');
  var form = document.getElementById('picker-form');

  var profiles = [];
  var interfaces = [];
  var busy = false;

  if (urlDisplay) {
    urlDisplay.textContent = targetUrl || '(empty URL)';
  }

  function showStatus(msg, isError) {
    statusEl.textContent = msg;
    statusEl.classList.toggle('error', !!isError);
  }

  function option(value, text, opts) {
    var el = document.createElement('option');
    el.value = value;
    el.textContent = text;
    if (opts) {
      if (opts.selected) el.selected = true;
      if (opts.title) el.title = opts.title;
    }
    return el;
  }

  function isRunning(p) {
    return !!(p && p.running);
  }

  function populateProfiles() {
    profileSelect.innerHTML = '';
    if (!profiles.length) {
      profileSelect.appendChild(option('', '(no other profiles)'));
      profileHint.textContent = '';
      return;
    }

    var best = null;
    profiles.forEach(function(p) {
      // Prefer a running non-current profile, then any running, then current.
      if (p.path === currentDir) return; // handled below
      if (!best && isRunning(p)) {
        best = p;
      } else if (!best && !isRunning(p) && !profiles.some(function(q) {
        return q.path !== currentDir && isRunning(q);
      })) {
        best = p;
      }
    });

    profiles.forEach(function(p) {
      var state = isRunning(p) ? 'running' : 'not running';
      var text = p.displayName || p.path;
      if (p.path === currentDir) {
        text += ' (this window)';
      } else if (p.default) {
        text += ' (default)';
      }
      var el = option(p.path, text + ' \u2014 ' + state, {
        title: p.path,
      });
      if (p.path === currentDir || (best && p.path === best.path)) {
        el.selected = true;
      }
      profileSelect.appendChild(el);
    });

    updateProfileHint();
  }

  function updateProfileHint() {
    var p = profiles.filter(function(q) { return q.path === profileSelect.value; })[0];
    profileHint.textContent = p && p.running
      ? 'Opens in the already-running window of this profile.'
      : p && p.path !== currentDir
        ? 'Starts this profile in a new window.'
        : '';
  }

  function populateInterfaces() {
    ifaceSelect.innerHTML = '';
    var currentDefault = '';
    try {
      if (browser.rozelynxNetIface && browser.rozelynxNetIface.getProfileInterface) {
        currentDefault = browser.rozelynxNetIface.getProfileInterface() || '';
      }
    } catch (e) {}
    var matched = false;
    interfaces.forEach(function(ifc) {
      var label = ifc.displayName || ifc.name;
      if (ifc.type) label += ' (' + ifc.type + ')';
      var isDefault = ifc.name === currentDefault;
      if (isDefault) matched = true;
      ifaceSelect.appendChild(option(ifc.name, label, {
        selected: isDefault,
      }));
    });
    // A REAL per-tab binding, the same '*' sentinel the chip picker stores:
    // setAssignment keeps it, ResolveForLoad translates it back to empty in
    // the tab layer, and the tab then routes unbound while still overriding
    // the profile default. (Before this, the row carried '' -- which is NOT
    // that: bindTab no-ops on empty, so the tab inherited the profile
    // default, whatever that was. The option that replaced "(profile
    // default)" in 8ab07e5c was inheritance all along, mislabelled.)
    ifaceSelect.appendChild(option('*', 'All interfaces (no binding)'));
    // The inheritance row, restored at the very bottom to match the chip
    // picker, whose "(profile default)" row sits last too: no per-tab
    // binding at all, so the opened tab inherits the profile default (and
    // when that default is empty, that is all interfaces as well). Selected
    // whenever no interface matched -- an empty profile default, or one
    // naming an interface this list does not carry (a stale pref) --
    // because inheriting is the safe fallback the old "(profile default)"
    // row used to provide.
    ifaceSelect.appendChild(option('', 'Use profile default', {
      selected: !matched,
    }));
  }

  function loadProfiles() {
    return browser.runtime.sendMessage({ action: 'external-link:profiles' })
      .then(function(r) {
        if (!r || !r.ok) {
          throw new Error((r && r.error) || 'no response');
        }
        var data = r.data || {};
        profiles = data.profiles || [];
        // Merge display names from the host list into a consistent shape.
        profiles.forEach(function(p) {
          p.path = p.dir || p.path || '';
          p.displayName = p.name || p.path;
        });
        populateProfiles();
        return r;
      })
      .catch(function(e) {
        showStatus('Cannot list profiles: ' + e.message, true);
        openBtn.disabled = true;
      });
  }

  function applyInterfaces(list) {
    interfaces = (list || []).filter(function(i) {
      return i && i.name;
    });
    populateInterfaces();
  }

  function fetchInterfacesFromHost() {
    return browser.runtime.sendMessage({ action: 'external-link:netifaces' })
      .then(function(r) {
        return (r && r.ok && r.data && r.data.interfaces) || [];
      })
      .catch(function() {
        return [];
      });
  }

  function loadInterfaces() {
    var pending = null;
    try {
      if (browser.rozelynxNetIface && browser.rozelynxNetIface.getInterfaces) {
        pending = browser.rozelynxNetIface.getInterfaces();
      }
    } catch (e) {}
    if (!pending) {
      pending = fetchInterfacesFromHost();
    }
    Promise.resolve(pending)
      .then(function(list) {
        if (list && list.length) {
          applyInterfaces(list);
        } else {
          // Service present but reported nothing (or unavailable build):
          // fall back to the native host's richer view.
          return fetchInterfacesFromHost().then(applyInterfaces);
        }
      })
      .catch(function() {
        return fetchInterfacesFromHost().then(applyInterfaces);
      });
  }

  profileSelect.addEventListener('change', updateProfileHint);

  form.addEventListener('submit', function(ev) {
    ev.preventDefault();
    if (busy) return;
    busy = true;
    openBtn.disabled = true;

    var profile = profileSelect.value;
    var iface = ifaceSelect.value || '';
    // Deliberately not gated on a non-empty iface: "all interfaces" is a real,
    // selectable default and must be settable as the profile default too. A
    // '*' iface is the per-tab all-interfaces sentinel and passes through as
    // the tab binding; the background translates it to the empty pref before
    // writing the profile default.
    var setDefault = setDefaultBox.checked;

    if (!profile) {
      showStatus('No profile selected.', true);
      openBtn.disabled = false;
      busy = false;
      return;
    }
    if (!targetUrl) {
      showStatus('No target URL.', true);
      openBtn.disabled = false;
      busy = false;
      return;
    }

    showStatus('Opening\u2026');
    browser.runtime.sendMessage({
      action: 'external-link:open',
      data: {
        url: targetUrl,
        profile: profile,
        iface: iface,
        setDefault: setDefault,
        current: currentDir,
      },
    }).then(function(r) {
      if (!r || !r.ok) {
        throw new Error((r && r.error) || 'no response');
      }
      var openedIn = (function() {
        for (var i = 0; i < profiles.length; i++) {
          if (profiles[i].path === profile) return profiles[i].displayName;
        }
        return profile;
      })();
      showStatus((r.data && r.data.mode === 'launch') ? 'Opening in ' + openedIn + '\u2026' : 'Opened in ' + openedIn + '\u2026');
      setTimeout(function() { window.close(); }, 900);
    }).catch(function(e) {
      showStatus('Failed: ' + e.message, true);
      openBtn.disabled = false;
      busy = false;
    });
  });

  loadInterfaces();
  loadProfiles();
})();