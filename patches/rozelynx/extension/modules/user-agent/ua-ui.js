/* RozeLynx: user agent switcher - popup UI.
 *
 * Owns the "User agent" section between the QR section and the PWA section
 * (the markup lives in modules/qr-code/popup.html, which loads this script
 * only after the background answered 'user-agent:present'). Two halves:
 *
 *   - the GLOBAL picker: a dropdown of the preset combinations (the ones
 *     the User Agent Switcher extension ships, see presets.js) with
 *     "Default" (no override) and a raw-string option; picking "Custom"
 *     reveals the raw input, and typing in it saves the exact string.
 *   - the per-URL rules block: the same compact shape as the netiface
 *     rules (current-page status, "Add a rule for this site", the add row
 *     with pattern input + UA dropdown + Add, and the "Manage rules"
 *     button that opens the all-rules modal). The full list lives in the
 *     modal and in the options page, never in the popup body.
 *
 * Every stored value is a full raw string; the dropdown is only a picker.
 */
(function() {
  'use strict';

  var section = document.getElementById('ua-section');
  if (!section) {
    return;
  }

  var presetSelect = document.getElementById('ua-preset');
  var rawInput = document.getElementById('ua-raw');
  var statusEl = document.getElementById('ua-rules-status');
  var addCurrentBtn = document.getElementById('ua-add-current');
  var newPattern = document.getElementById('ua-new-pattern');
  var newUa = document.getElementById('ua-new-ua');
  var addBtn = document.getElementById('ua-add-btn');
  var manageBtn = document.getElementById('ua-manage');

  // modal block (rendered by this script when the modal opens)
  var modalMaster = document.getElementById('modal-ua-enabled');
  var modalCount = document.getElementById('modal-ua-count');
  var modalList = document.getElementById('modal-ua-list');
  var modalEmpty = document.getElementById('modal-ua-empty');
  var modalStatus = document.getElementById('modal-ua-status');

  var CUSTOM_VALUE = '__custom__';
  var state = { global: '', enabled: true, rules: [] };
  var activeUrl = '';

  function ask(action, extra) {
    var msg = { action: action };
    if (extra) {
      Object.keys(extra).forEach(function(k) { msg[k] = extra[k]; });
    }
    return browser.runtime.sendMessage(msg);
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

  function hostOf(url) {
    try {
      return new URL(url).hostname;
    } catch (e) {
      return url;
    }
  }

  function presetLabel(ua) {
    return (globalThis.RozeLynxUAPresets &&
            globalThis.RozeLynxUAPresets.labelFor(ua)) || null;
  }

  // ── dropdowns ─────────────────────────────────────────────────────
  // One builder for both the global picker and the rules' value picker:
  // "Default" (""), every preset grouped by category, then "Custom" - the
  // value of a preset is its full raw string, so what a rule stores is what
  // will be sent.

  function fillUaSelect(sel, selectedUa, withDefault) {
    sel.textContent = '';
    var presets = (globalThis.RozeLynxUAPresets &&
                    globalThis.RozeLynxUAPresets.presets) || [];

    if (withDefault) {
      var d = document.createElement('option');
      d.value = '';
      d.textContent = 'Default (no override)';
      if (!selectedUa) d.selected = true;
      sel.appendChild(d);
    }

    globalThis.RozeLynxUAPresets.groups.forEach(function(group) {
      var og = document.createElement('optgroup');
      og.label = group;
      presets.forEach(function(p) {
        if (p.group !== group) return;
        var o = document.createElement('option');
        o.value = p.ua;
        o.textContent = p.label;
        o.title = p.ua;
        if (p.ua === selectedUa) o.selected = true;
        og.appendChild(o);
      });
      sel.appendChild(og);
    });

    var c = document.createElement('option');
    c.value = CUSTOM_VALUE;
    c.textContent = 'Custom\u2026 (raw string)';
    if (selectedUa && !presetLabel(selectedUa)) c.selected = true;
    sel.appendChild(c);
  }

  function selectedUaValue(sel) {
    return sel.value === CUSTOM_VALUE ? rawInput.value.trim() : sel.value;
  }

  function syncGlobalPicker() {
    fillUaSelect(presetSelect, state.global, true);
    var custom = presetSelect.value === CUSTOM_VALUE;
    rawInput.hidden = !custom;
    if (custom) {
      rawInput.value = state.global || '';
    }
  }

  presetSelect.addEventListener('change', function() {
    if (presetSelect.value === CUSTOM_VALUE) {
      rawInput.hidden = false;
      rawInput.value = state.global && !presetLabel(state.global)
        ? state.global : '';
      rawInput.focus();
      return;
    }
    rawInput.hidden = true;
    ask('user-agent:set-global', { ua: presetSelect.value })
      .then(function(res) {
        if (!res || res.ok !== true) {
          showStatus((res && res.error) || 'Could not save the user agent.',
            true);
          return;
        }
        state.global = res.global;
        syncGlobalPicker();
      })
      .catch(function(e) {
        showStatus('Could not save: ' + ((e && e.message) || e), true);
      });
  });

  rawInput.addEventListener('change', function() {
    ask('user-agent:set-global', { ua: rawInput.value.trim() })
      .then(function(res) {
        if (!res || res.ok !== true) {
          showStatus((res && res.error) || 'Could not save the user agent.',
            true);
          return;
        }
        state.global = res.global;
        syncGlobalPicker();
      })
      .catch(function(e) {
        showStatus('Could not save: ' + ((e && e.message) || e), true);
      });
  });

  // ── data ───────────────────────────────────────────────────────────

  function readState() {
    return ask('user-agent:get-state').then(function(res) {
      if (!res || res.ok !== true) {
        throw new Error((res && res.error) || 'the module did not answer');
      }
      state.global = res.global || '';
      state.enabled = res.enabled !== false;
      state.rules = Array.isArray(res.rules) ? res.rules : [];
      if (modalMaster) modalMaster.checked = state.enabled;
      syncGlobalPicker();
    });
  }

  function writeRules(next) {
    return ask('user-agent:set-rules', { rules: next })
      .then(function(res) {
        if (!res || res.ok !== true) {
          showModalStatus((res && res.error) || 'Could not save the rules.',
            true);
          return readState();
        }
        // The module answers with the RE-READ list: the modal renders what
        // is stored, not what it hoped to store.
        return readState();
      })
      .then(function() {
        renderModal();
        refreshStatus();
      })
      .catch(function(e) {
        showModalStatus('Could not save the rules: ' +
          ((e && e.message) || e), true);
      });
  }

  function schemaRule(r) {
    r = r || {};
    return {
      pattern: r.pattern || '',
      ua: r.ua == null ? '' : String(r.ua),
      enabled: r.enabled !== false,
    };
  }

  // ── current-page status ────────────────────────────────────────────

  function refreshStatus() {
    if (!activeUrl) {
      showStatus('No web page in this tab.');
      return;
    }
    var host = hostOf(activeUrl);
    ask('user-agent:resolve', { url: activeUrl }).then(function(r) {
      r = r || {};
      if (r.matched) {
        showStatus(host + ' \u2192 rule #' + r.index + ' (' + r.pattern + ')',
          false, true);
      } else if (r.ua) {
        showStatus(host + ' \u2192 global user agent (' +
          (presetLabel(r.ua) || 'raw string') + ')', false, true);
      } else {
        showStatus(host + ' uses the browser\u2019s own user agent.');
      }
    }).catch(function() {
      showStatus(host + ' \u2014 status unavailable');
    });
  }

  // ── add row ───────────────────────────────────────────────────────

  function addRule(pattern) {
    var value = String(pattern || '').trim();
    if (!value) {
      showStatus('Enter a pattern first.', true);
      return;
    }
    var ua = selectedUaValue(newUa);
    if (!ua) {
      showStatus('Pick a user agent for the rule first.', true);
      return;
    }
    var next = state.rules.map(schemaRule);
    next.push({ pattern: value, ua: ua, enabled: true });
    newPattern.value = '';
    showStatus('');
    writeRules(next);
  }

  addBtn.addEventListener('click', function() { addRule(newPattern.value); });
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
    // Prefill with the subdomain wildcard, which is what "this site" means,
    // and leave it in the add row for editing before Add.
    var parts = host.split('.');
    newPattern.value = parts.length > 2
      ? '*.' + parts.slice(-2).join('.')
      : host;
    newPattern.focus();
    newPattern.select();
  });

  // ── the modal list ─────────────────────────────────────────────────
  // Same shape as the netiface modal block; the options page renders the
  // same rows from the same calls.

  function renderModal() {
    if (!modalList) {
      return;
    }
    modalCount.textContent = state.rules.length
      ? '(' + state.rules.length +
        (state.rules.length === 1 ? ' rule' : ' rules') + ')'
      : '';
    fillUaSelect(newUa, newUa.value === CUSTOM_VALUE
      ? rawInput.value : newUa.value, false);
    modalList.textContent = '';
    modalEmpty.hidden = state.rules.length > 0;

    state.rules.forEach(function(rule, i) {
      var row = document.createElement('div');
      row.className = 'rules-row';

      var pattern = document.createElement('input');
      pattern.type = 'text';
      pattern.value = rule.pattern || '';
      pattern.spellcheck = false;
      pattern.title = 'Pattern: ' + (rule.pattern || '(empty)') +
        ' \u2014 a matching rule overrides the global user agent';
      pattern.addEventListener('change', function() {
        var value = pattern.value.trim();
        if (value === (state.rules[i].pattern || '')) return;
        var next = state.rules.map(schemaRule);
        if (!value) {
          next.splice(i, 1);
        } else {
          next[i].pattern = value;
        }
        writeRules(next);
      });
      row.appendChild(pattern);

      var sel = document.createElement('select');
      sel.title = 'User agent for this rule';
      fillUaSelect(sel, rule.ua, false);
      sel.addEventListener('change', function() {
        if (sel.value === CUSTOM_VALUE) {
          // A row cannot hold a live raw editor; the global picker's raw
          // input is the way to compose one, then re-pick it here.
          showModalStatus('Use the top raw-string box to compose a custom ' +
            'agent, then pick it from this dropdown.', false);
          return;
        }
        var next = state.rules.map(schemaRule);
        next[i].ua = sel.value;
        writeRules(next);
      });
      row.appendChild(sel);

      var enabled = document.createElement('input');
      enabled.type = 'checkbox';
      enabled.checked = rule.enabled !== false;
      enabled.title = 'Enable this rule';
      enabled.addEventListener('change', function() {
        var next = state.rules.map(schemaRule);
        next[i].enabled = enabled.checked;
        writeRules(next);
      });
      row.appendChild(enabled);

      var del = document.createElement('button');
      del.type = 'button';
      del.textContent = 'X';
      del.title = 'Delete this rule';
      del.addEventListener('click', function() {
        var next = state.rules.map(schemaRule);
        next.splice(i, 1);
        writeRules(next);
      });
      row.appendChild(del);

      modalList.appendChild(row);
    });
  }

  if (modalMaster) {
    modalMaster.addEventListener('change', function() {
      var wanted = modalMaster.checked;
      ask('user-agent:set-rules-enabled', { enabled: wanted })
        .then(function(res) {
          if (res && res.ok === true) {
            state.enabled = res.enabled !== false;
            modalMaster.checked = state.enabled;
            showModalStatus('');
          } else {
            showModalStatus((res && res.error) ||
              'Could not change the master switch.', true);
            readState();
          }
        })
        .catch(function(e) {
          showModalStatus('Could not change the master switch: ' +
            ((e && e.message) || e), true);
        });
    });
  }

  if (manageBtn && globalThis.RozeLynxRulesModal) {
    manageBtn.addEventListener('click', function() {
      globalThis.RozeLynxRulesModal.open();
    });
    globalThis.RozeLynxRulesModal.onOpen(function() {
      readState().then(renderModal).catch(function() {});
    });
  }

  // ── boot ───────────────────────────────────────────────────────────
  // presets.js must be in the page before the dropdowns can be built; the
  // script tag is created here because a static tag in popup.html would
  // 404 on a build whose XPI does not carry the user-agent module. The
  // URL resolves against the POPUP document (modules/qr-code/), not this
  // script's own directory, so it must spell the path out - 'presets.js'
  // alone pointed at modules/qr-code/presets.js, the load always failed
  // and the dropdowns shipped with the onerror fallback's EMPTY preset
  // list.

  var script = document.createElement('script');
  script.src = '../user-agent/presets.js';
  script.onload = function() {
    browser.tabs.query({ active: true, currentWindow: true })
      .then(function(tabs) {
        var tab = tabs && tabs[0];
        if (tab && typeof tab.url === 'string' && /^https?:/i.test(tab.url)) {
          activeUrl = tab.url;
        }
        return readState();
      })
      .catch(function() {})
      .then(function() {
        section.hidden = false;
        fillUaSelect(newUa, '', false);
        refreshStatus();
      });
  };
  script.onerror = function() {
    // Presets gone but the module answered: still show the section with a
    // raw-only picker rather than nothing.
    globalThis.RozeLynxUAPresets = { presets: [], groups: [], labelFor: function() { return null; } };
    script.onload();
  };
  document.head.appendChild(script);
})();
