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
    // Empty is not "inherit the profile": an empty bindIface is what every one of
    // the sixteen consumers in net-iface-necko.patch guards on with !IsEmpty(), so
    // it means the socket is never SO_BINDTODEVICE'd and traffic takes the normal
    // route -- i.e. all interfaces. It is the default for a fresh profile, so it
    // has to be selectable again once a real interface has been chosen, both for
    // this one tab and as the profile default.
    ifaceSelect.appendChild(option('', 'All interfaces (no binding)', {
      selected: currentDefault === '',
    }));
    interfaces.forEach(function(ifc) {
      var label = ifc.displayName || ifc.name;
      if (ifc.type) label += ' (' + ifc.type + ')';
      ifaceSelect.appendChild(option(ifc.name, label, {
        selected: ifc.name === currentDefault,
      }));
    });
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
    // selectable default and must be settable as the profile default too.
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