/* RozeLynx netiface picker popup.
 *
 * Opened by the netiface background module (chip click) with a query
 * param tabId=<id>. Shows the tab's effective interface and lets the
 * user pick a per-tab binding or fall back to "(profile default)"
 * (which clears the tab-layer binding). The actual native binding +
 * persistence happen in the background module (single apply path).
 */

(function() {
  'use strict';

  var LOG_PREFIX = '[RozeLynx:netiface-popup]';

  function log(level, msg) {
    var args = Array.prototype.slice.call(arguments, 1);
    if (level === 'error') {
      console.error.apply(console, [LOG_PREFIX].concat(args));
    } else {
      console.log.apply(console, [LOG_PREFIX].concat(args));
    }
  }

  var params = new URLSearchParams(location.search);
  var tabId = parseInt(params.get('tabId'), 10);
  if (!isNaN(tabId)) {
    tabId = Number(tabId);
  }

  var currentEl = document.getElementById('current');
  var listEl = document.getElementById('iface-list');
  var statusEl = document.getElementById('status');
  var applyBtn = document.getElementById('apply-btn');
  var cancelBtn = document.getElementById('cancel-btn');

  var interfaces = [];
  // Explicit all-interfaces binding for one tab; see RozeLynxNetIface.cpp.
  var ALL_IFACES = '*';
  var effective = { iface: '', layer: '' };
  var profileIface = '';
  var busy = false;

  function showStatus(msg, isError) {
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('error', !!isError);
  }

  function layerText(layer) {
    if (layer === 'tab') return 'tab binding';
    if (layer === 'url') return 'URL rule';
    if (layer === 'container') return 'container default';
    if (layer === 'profile') return 'profile default';
    return 'no binding (default routing)';
  }

  function ifaceDetail(ifc) {
    var parts = [];
    if (ifc.type) parts.push(ifc.type);
    if (ifc.hasIPv4) parts.push('IPv4');
    if (ifc.hasIPv6) parts.push('IPv6');
    return parts.join(' · ');
  }

  function radioRow(value, checked, name, detail, isDefault) {
    var label = document.createElement('label');
    label.className = 'iface' + (isDefault ? ' default' : '');

    var input = document.createElement('input');
    input.type = 'radio';
    input.name = 'netiface';
    input.value = value;
    input.checked = checked;

    var nameSpan = document.createElement('span');
    nameSpan.className = 'name';
    nameSpan.textContent = name;

    label.appendChild(input);
    label.appendChild(nameSpan);
    if (detail) {
      var detailSpan = document.createElement('span');
      detailSpan.className = 'detail';
      detailSpan.textContent = detail;
      label.appendChild(detailSpan);
    }
    return label;
  }

  function renderCurrent() {
    currentEl.textContent = '';
    currentEl.append('Current: ');
    var bold = document.createElement('b');
    bold.textContent = effective.iface || 'default routing';
    currentEl.appendChild(bold);
    currentEl.append(' — ' + layerText(effective.layer) +
      (profileIface ? ' | profile default: ' + profileIface : ''));
    if (effective.layer === 'url') {
      // A URL-rule binding is not a tab binding: the "(profile default)"
      // radio is checked instead, and applying one of them would leave the
      // rule in place. Say so where the user is about to choose.
      var note = document.createElement('div');
      note.className = 'note';
      note.textContent = 'A URL rule matches this page, so it wins over the ' +
        'container and profile defaults. Edit it in the RozeLynx popup ' +
        '(Interface bindings by URL).';
      currentEl.appendChild(note);
    }
  }

  function renderList() {
    listEl.innerHTML = '';
    var tabBound = effective.layer === 'tab';
    var selected = tabBound ? effective.iface : '';

    interfaces.forEach(function(ifc) {
      listEl.appendChild(radioRow(
        ifc.name,
        selected === ifc.name,
        ifc.displayName || ifc.name,
        ifaceDetail(ifc),
        false
      ));
    });

    // An explicit all-interfaces binding for this tab. It has to be a distinct
    // value from '' because the service reads '' as "no tab binding" and would
    // fall through to the profile default; '*' is translated back to empty where
    // the value reaches the socket, keeping the tab layer authoritative.
    listEl.appendChild(radioRow(
      ALL_IFACES,
      tabBound && selected === ALL_IFACES,
      'All interfaces (no binding)',
      'This tab only; overrides the profile default',
      false
    ));

    listEl.appendChild(radioRow(
      '',
      !tabBound && selected !== ALL_IFACES,
      '(profile default)',
      profileIface ? 'falls back to ' + profileIface : 'no profile binding',
      true
    ));
  }

  function load() {
    var calls = [];
    try {
      calls.push(Promise.resolve(browser.rozelynxNetIface.getInterfaces()));
      calls.push(Promise.resolve(browser.rozelynxNetIface.getEffective(tabId)));
      calls.push(Promise.resolve(browser.rozelynxNetIface.getProfileInterface()));
    } catch (e) {
      showStatus('netiface API unavailable: ' + e.message, true);
      return;
    }
    Promise.all(calls).then(function(results) {
      var list = results[0];
      var eff = results[1];
      var prof = results[2];
      if (Array.isArray(list)) {
        interfaces = list.filter(function(i) { return i && i.name; });
      }
      if (eff && typeof eff === 'object') {
        effective = { iface: eff.iface || '', layer: eff.layer || '' };
      } else if (typeof eff === 'string') {
        effective = { iface: eff, layer: '' };
      }
      profileIface = prof || '';
      renderCurrent();
      renderList();
    }).catch(function(e) {
      showStatus('Load failed: ' + (e.message || String(e)), true);
    });
  }

  function selectedIface() {
    var el = listEl.querySelector('input[name="netiface"]:checked');
    return el ? el.value : null;
  }

  applyBtn.addEventListener('click', function() {
    var iface = selectedIface();
    if (iface === null) {
      showStatus('Pick an interface first.', true);
      return;
    }
    if (busy) return;
    busy = true;
    applyBtn.disabled = true;
    showStatus('Applying…');
    browser.runtime.sendMessage({
      action: 'netiface:apply',
      data: { tabId: tabId, iface: iface },
    }).then(function(r) {
      if (!r || !r.ok) {
        throw new Error((r && r.error) || 'no response');
      }
      showStatus('Bound to ' + (iface || '(profile default)'));
      setTimeout(function() { window.close(); }, 250);
    }).catch(function(e) {
      showStatus('Failed: ' + (e.message || String(e)), true);
      applyBtn.disabled = false;
      busy = false;
    });
  });

  cancelBtn.addEventListener('click', function() {
    window.close();
  });

  if (isNaN(tabId)) {
    showStatus('Missing tabId parameter.', true);
  } else {
    load();
  }
})();
