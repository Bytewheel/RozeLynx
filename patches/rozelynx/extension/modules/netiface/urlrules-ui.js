/* RozeLynx: per-URL interface rules editor.
 *
 * Renders the collapsible "Interface bindings by URL" section at the bottom of
 * the extension popup (the qr-code one, which is the extension's only popup).
 * The markup is already in modules/qr-code/popup.html; this script owns it and
 * leaves it `hidden` unless the netiface experiment API is present, so a build
 * without USE=net-iface shows no empty box.
 *
 * Storage model, deliberately not its own: a rule is two prefs
 * (rozelynx.netiface.urlrule.<n>.pattern / .iface, plus an optional .enabled)
 * and the whole list is replaced through browser.rozelynxNetIface.setUrlRules().
 * That means the prefs stay the single source of truth - about:config shows
 * exactly what the editor shows - and the native service picks the change up
 * through its own rozelynx.netiface.* pref observer. This file never resolves
 * which rule wins: it asks the service (matchUrlRule), so the preview below
 * cannot disagree with the socket path.
 *
 * The one piece of local state is the collapsed/expanded flag, in
 * storage.local, because it is a UI preference and not a binding.
 */
(function() {
  'use strict';

  var STORAGE_KEY = 'rozelynx_netiface_urlrules_expanded';
  var LOG_PREFIX = '[RozeLynx:urlrules]';

  function api() {
    return (typeof browser !== 'undefined' && browser.rozelynxNetIface) ||
      null;
  }

  var section = document.getElementById('urlrules-section');
  if (!section) {
    return;
  }

  var svc = api();
  // No experiment API (a build without USE=net-iface) or no rule support (an
  // older parent): the section stays hidden and this file does nothing.
  if (!svc || !svc.getUrlRules || !svc.setUrlRules || !svc.matchUrlRule) {
    return;
  }

  var header = document.getElementById('urlrules-header');
  var count = document.getElementById('urlrules-count');
  var body = document.getElementById('urlrules-body');
  var master = document.getElementById('urlrules-enabled');
  var preview = document.getElementById('urlrules-preview');
  var listEl = document.getElementById('urlrules-list');
  var emptyEl = document.getElementById('urlrules-empty');
  var addCurrentBtn = document.getElementById('urlrules-add-current');
  var newPattern = document.getElementById('urlrules-new-pattern');
  var newIface = document.getElementById('urlrules-new-iface');
  var addBtn = document.getElementById('urlrules-add-btn');
  var statusEl = document.getElementById('urlrules-status');

  var rules = [];
  var interfaces = [];
  var activeTab = null;
  var activeUrl = '';
  var expanded = false;

  function log(msg) {
    try {
      console.log(LOG_PREFIX, msg);
    } catch (e) {}
  }

  function showStatus(msg, isError) {
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('error', !!isError);
  }

  // ── expand / collapse ────────────────────────────────────────────
  // A real <button>, so Enter and Space already work and the popup stays
  // keyboard-navigable; aria-expanded is the only state to keep in sync.
  function setExpanded(value) {
    expanded = !!value;
    header.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    body.hidden = !expanded;
    if (expanded) {
      refreshPreview();
    }
    try {
      browser.storage.local.set((function() {
        var d = {};
        d[STORAGE_KEY] = expanded;
        return d;
      })());
    } catch (e) {}
  }

  header.addEventListener('click', function() {
    setExpanded(!expanded);
  });

  // ── data ─────────────────────────────────────────────────────────

  function readState() {
    return Promise.resolve(svc.getUrlRules()).then(function(state) {
      state = state || {};
      rules = Array.isArray(state.rules) ? state.rules : [];
      master.checked = state.enabled !== false;
      return loadInterfaces();
    }).then(render).catch(function(e) {
      showStatus('Could not read the URL rules: ' + ((e && e.message) || e), true);
    });
  }

  function loadInterfaces() {
    return Promise.resolve(svc.getInterfaces ? svc.getInterfaces() : [])
      .then(function(list) {
        interfaces = (list || []).filter(function(i) { return i && i.name; });
      })
      .catch(function() {
        interfaces = [];
      });
  }

  function write(nextRules) {
    return Promise.resolve(svc.setUrlRules(nextRules)).then(function(res) {
      res = res || {};
      if (Array.isArray(res.rules)) {
        rules = res.rules;
      } else {
        rules = nextRules;
      }
      if (typeof res.enabled === 'boolean') {
        master.checked = res.enabled;
      }
      render();
      refreshPreview();
      if (res.ok === false) {
        showStatus(res.error || 'Could not save the rules.', true);
      } else {
        showStatus('');
      }
      // The service already re-resolves on the next channel; this only makes
      // every window's chip show the new binding now instead of at the next
      // tab switch. A suspended event page is not worth an error here.
      return Promise.resolve(browser.runtime.sendMessage({
        action: 'netiface:refresh',
      })).catch(function() {});
    }).catch(function(e) {
      showStatus('Could not save the rules: ' + ((e && e.message) || e), true);
    });
  }

  // ── render ───────────────────────────────────────────────────────

  function optionEl(value, label, selected) {
    var o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    o.selected = !!selected;
    return o;
  }

  /**
   * "(default routing)" first, then every usable interface, then - if the
   * stored rule names one that is not currently up (a laptop with a VPN that
   * is off) - that interface, still shown. Silently falling back to the first
   * entry would rewrite the rule to a different interface on the next save.
   */
  function fillIfaceSelect(sel, selected) {
    sel.textContent = '';
    sel.appendChild(optionEl('', '(default routing)', !selected));
    interfaces.forEach(function(ifc) {
      sel.appendChild(optionEl(ifc.name, ifc.displayName || ifc.name,
        ifc.name === selected));
    });
    if (selected && !interfaces.some(function(ifc) { return ifc.name === selected; })) {
      sel.appendChild(optionEl(selected, selected + ' (not available)', true));
    }
  }

  /**
   * A rule as the setUrlRules schema declares it. The rows rendered here
   * come from getUrlRules(), whose records carry an extra `index` field -
   * and Firefox's schema layer rejects a whole call over a single unknown
   * object property (Schemas.sys.mjs ObjectType.normalize: "Unexpected
   * property") unless the schema allows additionalProperties. Cloning the
   * rows with Object.assign carried that index into every follow-up
   * write, so the first add after a fresh install worked (the list was
   * empty) and every later one died in validation. Project every stored
   * row down to the three schema fields here.
   */
  function schemaRule(r) {
    r = r || {};
    return {
      pattern: r.pattern || '',
      iface: r.iface == null ? '' : String(r.iface),
      enabled: r.enabled !== false,
    };
  }

  function patternHint(pattern) {
    return 'Pattern: ' + (pattern || '(empty)') +
      ' — tab binding > URL rule > container > profile';
  }

  function render() {
    count.textContent = rules.length
      ? (rules.length + (rules.length === 1 ? ' rule' : ' rules'))
      : '';

    fillIfaceSelect(newIface, newIface.value || '');
    listEl.textContent = '';
    emptyEl.hidden = rules.length > 0;

    rules.forEach(function(rule, i) {
      var row = document.createElement('div');
      row.className = 'urlrules-row';

      var pattern = document.createElement('input');
      pattern.type = 'text';
      pattern.value = rule.pattern || '';
      pattern.spellcheck = false;
      pattern.title = patternHint(rule.pattern);
      pattern.addEventListener('change', function() {
        var value = pattern.value.trim();
        if (value === (rules[i].pattern || '')) {
          return;
        }
        var next = rules.map(schemaRule);
        if (!value) {
          // An empty pattern is not a rule the service can use, so the row is
          // removed instead of being saved as a no-op.
          next.splice(i, 1);
        } else {
          next[i].pattern = value;
        }
        write(next);
      });
      row.appendChild(pattern);

      var sel = document.createElement('select');
      sel.title = 'Interface for this rule; empty = force default routing';
      fillIfaceSelect(sel, rule.iface || '');
      sel.addEventListener('change', function() {
        var next = rules.map(schemaRule);
        next[i].iface = sel.value;
        write(next);
      });
      row.appendChild(sel);

      var enabled = document.createElement('input');
      enabled.type = 'checkbox';
      enabled.className = 'urlrules-enabled';
      enabled.checked = rule.enabled !== false;
      enabled.title = 'Enable this rule';
      enabled.addEventListener('change', function() {
        var next = rules.map(schemaRule);
        next[i].enabled = enabled.checked;
        write(next);
      });
      row.appendChild(enabled);

      var del = document.createElement('button');
      del.type = 'button';
      del.textContent = 'X';
      del.title = 'Delete this rule';
      del.addEventListener('click', function() {
        var next = rules.map(schemaRule);
        next.splice(i, 1);
        write(next);
      });
      row.appendChild(del);

      listEl.appendChild(row);
    });
  }

  // ── match preview ────────────────────────────────────────────────
  // Asked of the service, never computed here: the point of the line is to
  // show the winner the resolver will pick.
  function hostOf(url) {
    try {
      return new URL(url).hostname;
    } catch (e) {
      return url;
    }
  }

  var LAYER_TEXT = {
    tab: 'this tab’s own binding',
    url: null,  // built from the rule, below
    container: 'the container default',
    profile: 'the profile default',
  };

  function renderPreview() {
    preview.textContent = '';
    if (!activeUrl || !activeTab) {
      preview.textContent = 'No web page in this tab to preview.';
      return;
    }
    var host = hostOf(activeUrl);
    var b = document.createElement('b');
    var span = document.createElement('span');
    var rule = { matched: false, index: -1, pattern: '', iface: '' };

    Promise.resolve(svc.matchUrlRule(activeUrl)).then(function(r) {
      rule = r || rule;
      return Promise.resolve(svc.getEffective(activeTab.id));
    }).then(function(eff) {
      eff = eff || {};
      b.textContent = host;
      span.append(' — ' + (eff.iface || 'default routing') + ' via ');
      if (eff.layer === 'url') {
        span.append('URL rule #' + rule.index + ' (' + rule.pattern + ')');
      } else {
        span.append(LAYER_TEXT[eff.layer] || 'no binding');
      }
      if (!rule.matched) {
        span.append(' — no URL rule matches it');
      }
      preview.appendChild(b);
      preview.appendChild(span);
    }).catch(function(e) {
      log('preview failed: ' + ((e && e.message) || e));
      preview.textContent = host + ' — preview unavailable';
    });
  }

  function refreshPreview() {
    if (!expanded) {
      return;
    }
    renderPreview();
  }

  // ── add / delete ─────────────────────────────────────────────────

  function addRule(pattern) {
    var value = String(pattern || '').trim();
    if (!value) {
      showStatus('Enter a pattern first.', true);
      return;
    }
    var next = rules.map(schemaRule);
    next.push({ pattern: value, iface: newIface.value || '', enabled: true });
    newPattern.value = '';
    showStatus('');
    write(next);
  }

  addBtn.addEventListener('click', function() {
    addRule(newPattern.value);
  });
  newPattern.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      addRule(newPattern.value);
    }
  });
  addCurrentBtn.addEventListener('click', function() {
    if (!activeUrl) {
      showStatus('This tab is not a web page.', true);
      return;
    }
    var host = hostOf(activeUrl);
    if (!host || host.indexOf('.') < 0) {
      showStatus('This tab is not a web page.', true);
      return;
    }
    // Prefill with the subdomain wildcard, which is what "this site" usually
    // means, and leave it in the add row so the user can change it before
    // pressing Add rather than after.
    var parts = host.split('.');
    newPattern.value = parts.length > 2
      ? '*.' + parts.slice(-2).join('.')
      : host;
    newPattern.focus();
    newPattern.select();
  });

  master.addEventListener('change', function() {
    var wanted = master.checked;
    Promise.resolve(svc.setUrlRulesEnabled(wanted)).then(function(res) {
      master.checked = !!(res && res.enabled);
      showStatus(res && res.ok === false
        ? (res.error || 'Could not change the master switch.')
        : '');
    }).catch(function(e) {
      master.checked = !wanted;
      showStatus('Could not change the master switch: ' +
        ((e && e.message) || e), true);
    });
  });

  // ── current tab, then the section ────────────────────────────────

  Promise.resolve(browser.tabs.query({ active: true, currentWindow: true }))
    .then(function(tabs) {
      var tab = tabs && tabs[0];
      if (tab && typeof tab.url === 'string' && /^https?:/i.test(tab.url)) {
        activeTab = tab;
        activeUrl = tab.url;
      }
      return readState();
    })
    .catch(function(e) {
      log('init failed: ' + ((e && e.message) || e));
    })
    .then(function() {
      // Revealed only now: a reader who never opens the QR popup's
      // lower half still pays nothing, and a build without net-iface never
      // shows the box.
      section.hidden = false;
      return browser.storage.local.get(STORAGE_KEY);
    })
    .then(function(stored) {
      setExpanded(!!(stored && stored[STORAGE_KEY]));
    })
    .catch(function(e) {
      section.hidden = false;
      setExpanded(false);
      log('expand-state load failed: ' + ((e && e.message) || e));
    });
})();
