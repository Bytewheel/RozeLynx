/* RozeLynx: per-URL interface rules UI.
 *
 * The popup section is COMPACT by design: whether the current page has a
 * rule, the "Add a rule for this site" button, and the add row (pattern
 * input, interface dropdown, Add). THE LIST ITSELF IS NOT HERE. It lives in
 * the all-rules modal (lib/rules-modal.js opens it from the "Manage
 * interface rules" button) and in the extension's options page, which
 * renders the same rows from the same storage.
 *
 * Storage model, deliberately not its own: a rule is two prefs
 * (rozelynx.netiface.urlrule.<n>.pattern / .iface, plus an optional .enabled)
 * and the whole list is replaced through browser.rozelynxNetIface.setUrlRules().
 * The prefs stay the single source of truth - about:config shows exactly what
 * the modal shows - and the native service picks the change up through its
 * own rozelynx.netiface.* pref observer. This file never resolves which rule
 * wins: it asks the service (matchUrlRule), so the status line cannot
 * disagree with the socket path.
 */
(function() {
  'use strict';

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

  var statusEl = document.getElementById('urlrules-status');
  var addCurrentBtn = document.getElementById('urlrules-add-current');
  var newPattern = document.getElementById('urlrules-new-pattern');
  var newIface = document.getElementById('urlrules-new-iface');
  var addBtn = document.getElementById('urlrules-add-btn');
  var manageBtn = document.getElementById('urlrules-manage');

  // modal block (rendered by this script when the modal opens)
  var modalMaster = document.getElementById('modal-netiface-enabled');
  var modalCount = document.getElementById('modal-netiface-count');
  var modalList = document.getElementById('modal-netiface-list');
  var modalEmpty = document.getElementById('modal-netiface-empty');
  var modalStatus = document.getElementById('modal-netiface-status');

  var rules = [];
  var interfaces = [];
  var activeTab = null;
  var activeUrl = '';

  function log(msg) {
    try {
      console.log(LOG_PREFIX, msg);
    } catch (e) {}
  }

  function showStatus(msg, isError, isMatch) {
    if (statusEl) {
      statusEl.textContent = msg || '';
      statusEl.classList.toggle('error', !!isError);
      statusEl.classList.toggle('matched', !!isMatch);
    }
  }

  function showModalStatus(msg, isError) {
    if (modalStatus) {
      modalStatus.textContent = msg || '';
      modalStatus.classList.toggle('error', !!isError);
    }
  }

  // ── data ─────────────────────────────────────────────────────────

  function readState() {
    return Promise.resolve(svc.getUrlRules()).then(function(state) {
      state = state || {};
      rules = Array.isArray(state.rules) ? state.rules : [];
      if (modalMaster) modalMaster.checked = state.enabled !== false;
      return loadInterfaces();
    }).catch(function(e) {
      showStatus('Could not read the URL rules: ' + ((e && e.message) || e),
        true);
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
      if (typeof res.enabled === 'boolean' && modalMaster) {
        modalMaster.checked = res.enabled;
      }
      renderModal();
      refreshStatus();
      if (res.ok === false) {
        showModalStatus(res.error || 'Could not save the rules.', true);
      } else {
        showModalStatus('');
      }
      // The service already re-resolves on the next channel; this only makes
      // every window's chip show the new binding now instead of at the next
      // tab switch. A suspended event page is not worth an error here.
      return Promise.resolve(browser.runtime.sendMessage({
        action: 'netiface:refresh',
      })).catch(function() {});
    }).catch(function(e) {
      showModalStatus('Could not save the rules: ' + ((e && e.message) || e),
        true);
    });
  }

  // ── dropdown plumbing ────────────────────────────────────────────

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
   * A rule as the setUrlRules schema declares it. The rows rendered in the
   * modal come from getUrlRules(), whose records carry an extra `index`
   * field - and Firefox's schema layer rejects a whole call over a single
   * unknown object property unless the schema allows additionalProperties.
   * Project every stored row down to the three schema fields here.
   */
  function schemaRule(r) {
    r = r || {};
    return {
      pattern: r.pattern || '',
      iface: r.iface == null ? '' : String(r.iface),
      enabled: r.enabled !== false,
    };
  }

  // ── current-page status (the popup body's one piece of truth) ────
  // Asked of the service, never computed here: the point of the line is to
  // show the winner the resolver will pick for the page the user is looking
  // at, which is exactly the question matchUrlRule answers.

  function hostOf(url) {
    try {
      return new URL(url).hostname;
    } catch (e) {
      return url;
    }
  }

  var LAYER_TEXT = {
    tab: 'this tab\u2019s own binding',
    url: null,  // built from the rule, below
    container: 'the container default',
    profile: 'the profile default',
  };

  function refreshStatus() {
    if (!activeUrl || !activeTab) {
      showStatus('No web page in this tab.');
      return;
    }
    var host = hostOf(activeUrl);
    Promise.resolve(svc.matchUrlRule(activeUrl)).then(function(rule) {
      rule = rule || { matched: false, index: -1, pattern: '', iface: '' };
      if (rule.matched) {
        showStatus(host + ' \u2192 ' + (rule.iface || 'default routing') +
          ' (rule #' + rule.index + ', ' + rule.pattern + ')', false, true);
      } else {
        showStatus(host + ' has no interface rule.');
      }
      return Promise.resolve(svc.getEffective(activeTab.id));
    }).then(function(eff) {
      eff = eff || {};
      if (eff.layer && eff.layer !== 'url') {
        showStatus(statusEl.textContent +
          ' \u2014 effective: ' + (eff.iface || 'default routing') +
          ' via ' + (LAYER_TEXT[eff.layer] || eff.layer));
      }
    }).catch(function(e) {
      log('status failed: ' + ((e && e.message) || e));
      showStatus(host + ' \u2014 status unavailable');
    });
  }

  // ── add (popup body row) ─────────────────────────────────────────

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

  // ── the modal list ───────────────────────────────────────────────
  // The full rules list, the master switch and the per-row editors. The
  // options page renders the same shape from the same calls, so there are
  // two views of one store, not two stores.

  function renderModal() {
    if (!modalList) {
      return;
    }
    modalCount.textContent = rules.length
      ? '(' + rules.length + (rules.length === 1 ? ' rule' : ' rules') + ')'
      : '';
    fillIfaceSelect(newIface, newIface.value || '');
    modalList.textContent = '';
    modalEmpty.hidden = rules.length > 0;

    rules.forEach(function(rule, i) {
      var row = document.createElement('div');
      row.className = 'rules-row';

      var pattern = document.createElement('input');
      pattern.type = 'text';
      pattern.value = rule.pattern || '';
      pattern.spellcheck = false;
      pattern.title = 'Pattern: ' + (rule.pattern || '(empty)') +
        ' \u2014 tab binding > URL rule > container > profile';
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

      modalList.appendChild(row);
    });
  }

  if (modalMaster) {
    modalMaster.addEventListener('change', function() {
      var wanted = modalMaster.checked;
      Promise.resolve(svc.setUrlRulesEnabled(wanted)).then(function(res) {
        modalMaster.checked = !!(res && res.enabled);
        showModalStatus(res && res.ok === false
          ? (res.error || 'Could not change the master switch.')
          : '');
      }).catch(function(e) {
        modalMaster.checked = !wanted;
        showModalStatus('Could not change the master switch: ' +
          ((e && e.message) || e), true);
      });
    });
  }

  if (manageBtn && globalThis.RozeLynxRulesModal) {
    manageBtn.addEventListener('click', function() {
      globalThis.RozeLynxRulesModal.open();
    });
    // Refill the modal block from storage each time the modal opens, so it
    // never shows a stale copy of the list.
    globalThis.RozeLynxRulesModal.onOpen(function() {
      readState().then(renderModal);
    });
  }

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
      // The add row lives on the popup body, not in the modal, so its
      // dropdown is filled HERE: renderModal() (the only other caller of
      // fillIfaceSelect) runs when the modal opens or a rule is written,
      // and until then the <select> would be empty - no interface to pick.
      fillIfaceSelect(newIface, newIface.value || '');
      refreshStatus();
    });
})();
