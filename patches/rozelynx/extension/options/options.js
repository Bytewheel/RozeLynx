(function() {
  'use strict';

  var FEATURE_INFO = {
    'chrome-web-store': { name: 'Chrome Web Store', desc: 'Install extensions from Chrome Web Store' },
    'experiments': { name: 'Experiments', desc: 'A/B testing and feature flag system' },
    'external-browser': { name: 'External Browser', desc: 'Open links in other browsers' },
    'i18n': { name: 'I18n', desc: 'Language pack management' },
    'mouse-gestures': { name: 'Mouse Gestures', desc: 'RMB + draw gesture navigation' },
    'qr-code': { name: 'QR Code', desc: 'QR code generator for current URL' },
    'pwa': { name: 'PWA', desc: 'Install sites as Progressive Web Apps' },
    'lepton-skin': { name: 'Lepton Skin', desc: 'Compact purple-accented UI theme' },
    'ip-protection': { name: 'IP Protection', desc: 'Applies privacy prefs instantly, like about:config - no restart needed' },
    'net-iface': { name: 'Network Interfaces', desc: 'Per-tab / per-URL interface binding; rules below' },
    'user-agent': { name: 'User Agent', desc: 'Preset/raw user agent switcher with per-URL rules; rules below' },
    'sync': { name: 'State Sync', desc: 'Magic-link backup/restore of tabs, history, cookies, extensions and configuration' },
  };

  var statusEl = document.getElementById('status');
  var featuresEl = document.getElementById('features');


  function setStatus(msg, isError) {
    statusEl.textContent = msg;
    statusEl.className = 'status' + (isError ? ' error' : '');
  }

  // User-disabled features (options-page toggles) persist here. A disabled
  // setting is NOT an error: the status line must only complain when the
  // background actually failed to load modules.
  var FEATURE_STATE_KEY = 'rozelynx_feature_state';
  var featureStatesCache = {};

  function loadFeatureStates() {
    return browser.storage.local.get(FEATURE_STATE_KEY).then(function(stored) {
      var v = stored && stored[FEATURE_STATE_KEY];
      if (v && typeof v === 'object') featureStatesCache = v;
      return featureStatesCache;
    }).catch(function() { return featureStatesCache; });
  }

  function saveFeatureState(feature, enabled) {
    // Mutate the in-memory cache and write the whole map: read-modify-write
    // round-trips race when the user toggles several features quickly.
    featureStatesCache[feature] = enabled;
    var data = {};
    data[FEATURE_STATE_KEY] = featureStatesCache;
    return browser.storage.local.set(data).catch(function() {});
  }

  async function loadFeatures() {
    try {
      var enabledFeatures = [];
      var loadedOk = false;
      var backgroundReached = false;
      try {
        var resp = await browser.runtime.sendMessage({ action: 'getFeatures' });
        backgroundReached = true;
        enabledFeatures = resp.features || [];
        loadedOk = resp.initComplete;
      } catch (e) {
        // Background page unreachable (event-page race): fall back to
        // storage for storage-driven features.
      }
      var featureStates = await loadFeatureStates();
      var leptonEnabled = false;
      try {
        var stored = await browser.storage.local.get('rozelynx_lepton_enabled');
        leptonEnabled = !!stored.rozelynx_lepton_enabled;
      } catch (e) {}
      var ipProtectionEnabled = false;
      try {
        var ippStored = await browser.storage.local.get('rozelynx_ip_protection');
        ipProtectionEnabled = !!ippStored.rozelynx_ip_protection;
      } catch (e) {}

      featuresEl.innerHTML = '';
      var featureEntries = Object.keys(FEATURE_INFO);
      var enabledCount = 0;

      for (var i = 0; i < featureEntries.length; i++) {
        var key = featureEntries[i];
        var info = FEATURE_INFO[key];
        var enabled = enabledFeatures.indexOf(key) !== -1;
        // A stored off-state means the user simply disabled the setting.
        if (featureStates[key] === false) {
          enabled = false;
        }
        if (key === 'lepton-skin') {
          enabled = leptonEnabled;
        }
        if (key === 'ip-protection') {
          // The toggle reflects the actual protection state, not just
          // whether the module is compiled in.
          enabled = ipProtectionEnabled;
        }
        if (enabled) {
          enabledCount++;
        }

        var div = document.createElement('div');
        div.className = 'feature';

        var labelDiv = document.createElement('div');
        var nameSpan = document.createElement('div');
        nameSpan.className = 'feature-name';
        nameSpan.textContent = info.name;
        var descSpan = document.createElement('div');
        descSpan.className = 'feature-desc';
        descSpan.textContent = info.desc;
        labelDiv.appendChild(nameSpan);
        labelDiv.appendChild(descSpan);

        var toggle = document.createElement('button');
        toggle.className = 'toggle' + (enabled ? ' on' : '');
        toggle.setAttribute('role', 'switch');
        toggle.setAttribute('aria-checked', enabled ? 'true' : 'false');
        toggle.setAttribute('data-feature', key);
        toggle.addEventListener('click', function(e) {
          var feature = this.getAttribute('data-feature');
          var isOn = this.classList.toggle('on');
          this.setAttribute('aria-checked', isOn ? 'true' : 'false');

          var onCount = document.querySelectorAll('button.toggle.on').length;
          var total = document.querySelectorAll('button.toggle').length;
          setStatus(onCount + ' of ' + total + ' features enabled.', false);
          saveFeatureState(feature, isOn);

          if (feature === 'lepton-skin') {
            // Storage-driven: content scripts toggle live via onChanged
            browser.storage.local.set({
              rozelynx_lepton_enabled: isOn
            }).catch(function() {});
            // Browser chrome skin: rewrite the profile's userChrome.css via
            // the native host. Applies after a browser restart.
            browser.runtime.sendNativeMessage('rozelynx_host', {
              action: 'chrome-skin',
              enabled: isOn
            }).then(function(resp) {
              var hint = document.getElementById('lepton-hint');
              if (hint) hint.style.display = 'block';
              if (!resp || !resp.ok) {
                setStatus('Chrome skin update failed: ' +
                  ((resp && resp.error) || 'host unavailable'), true);
              }
            }).catch(function(e) {
              var hint = document.getElementById('lepton-hint');
              if (hint) hint.style.display = 'block';
              setStatus('Chrome skin update failed: ' + e.message, true);
            });
          }

          browser.runtime.sendMessage({
            module: feature,
            action: isOn ? 'enable' : 'disable'
          }).then(function(resp) {
            if (feature === 'ip-protection' && resp && !resp.error) {
              var live = resp.live;
              var ipHint = document.getElementById('ip-hint');
              if (ipHint) ipHint.style.display = 'block';
              if (live && live.available) {
                if (live.ok) {
                  setStatus('IP Protection ' + (isOn ? 'ON' : 'OFF') +
                    ' - ' + live.written + ' prefs applied live. ' +
                    'No restart needed.', false);
                } else {
                  setStatus('IP Protection prefs written to user.js, but ' +
                    'live apply failed: ' + (live.error || 'unknown error') +
                    ' - restart to apply.', true);
                }
              } else {
                setStatus('IP Protection prefs written to user.js. ' +
                  'Restart the browser to apply them.', false);
              }
            }
          }).catch(function() {});

          browser.runtime.sendMessage({
            action: 'setFeatureState',
            data: { feature: feature, enabled: isOn }
          }).catch(function() {});
        });

        div.appendChild(labelDiv);
        div.appendChild(toggle);
        featuresEl.appendChild(div);
      }

      if (loadedOk) {
        // Healthy background: a low count just means the user disabled
        // some settings - not an error.
        setStatus('All features loaded. ' + enabledCount + ' of ' +
          featureEntries.length + ' features enabled.', false);
      } else if (!backgroundReached) {
        setStatus('Background not responding - showing stored settings (' +
          enabledCount + ' of ' + featureEntries.length +
          ' features enabled). Restart the browser if this persists.', true);
      } else {
        setStatus('Partial load: ' + enabledCount + ' of ' +
          featureEntries.length +
          ' features enabled. Check Browser Console for errors.', true);
      }
    } catch (e) {
      setStatus('Failed to load feature list: ' + e.message, true);
    }
  }

  // ── the full rule lists ───────────────────────────────────────────
  // The settings page is where the LISTS live (the popup body shows only
  // the compact controls and opens the modal for the same list). Each
  // editor here talks to the same storage the modal does: the netiface
  // experiment API directly, and the user-agent module by message.

  function ask(action, extra) {
    var msg = { action: action };
    if (extra) {
      Object.keys(extra).forEach(function(k) { msg[k] = extra[k]; });
    }
    return browser.runtime.sendMessage(msg);
  }

  function optionEl(value, label, selected) {
    var o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    o.selected = !!selected;
    return o;
  }

  function showEdStatus(el, msg, isError) {
    if (el) {
      el.textContent = msg || '';
      el.classList.toggle('error', !!isError);
    }
  }

  // ── netiface rules editor ──────────────────────────────────────────

  function initNetifaceEditor() {
    var svc = (typeof browser !== 'undefined' && browser.rozelynxNetIface) || null;
    if (!svc || !svc.getUrlRules || !svc.setUrlRules) {
      return;  // a build without USE=net-iface: no section at all
    }
    var heading = document.getElementById('netiface-rules-heading');
    var card = document.getElementById('netiface-rules-card');
    var master = document.getElementById('opt-netiface-enabled');
    var list = document.getElementById('opt-netiface-list');
    var empty = document.getElementById('opt-netiface-empty');
    var newPattern = document.getElementById('opt-netiface-new-pattern');
    var newIface = document.getElementById('opt-netiface-new-iface');
    var addBtn = document.getElementById('opt-netiface-add');
    var status = document.getElementById('opt-netiface-status');

    var rules = [];
    var interfaces = [];

    heading.hidden = false;
    card.classList.remove('card-hidden');

    function loadInterfaces() {
      return Promise.resolve(svc.getInterfaces ? svc.getInterfaces() : [])
        .then(function(list) {
          interfaces = (list || []).filter(function(i) { return i && i.name; });
        })
        .catch(function() { interfaces = []; });
    }

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

    function schemaRule(r) {
      r = r || {};
      return {
        pattern: r.pattern || '',
        iface: r.iface == null ? '' : String(r.iface),
        enabled: r.enabled !== false,
      };
    }

    function write(next) {
      return Promise.resolve(svc.setUrlRules(next)).then(function(res) {
        res = res || {};
        if (Array.isArray(res.rules)) rules = res.rules;
        if (typeof res.enabled === 'boolean') master.checked = res.enabled;
        render();
        if (res.ok === false) {
          showEdStatus(status, res.error || 'Could not save the rules.', true);
        } else {
          showEdStatus(status, '');
        }
        return Promise.resolve(
          browser.runtime.sendMessage({ action: 'netiface:refresh' })
        ).catch(function() {});
      }).catch(function(e) {
        showEdStatus(status, 'Could not save the rules: ' +
          ((e && e.message) || e), true);
      });
    }

    function render() {
      fillIfaceSelect(newIface, newIface.value || '');
      list.textContent = '';
      empty.hidden = rules.length > 0;
      rules.forEach(function(rule, i) {
        var row = document.createElement('div');
        row.className = 'row';

        var pattern = document.createElement('input');
        pattern.type = 'text';
        pattern.value = rule.pattern || '';
        pattern.spellcheck = false;
        pattern.addEventListener('change', function() {
          var value = pattern.value.trim();
          if (value === (rules[i].pattern || '')) return;
          var next = rules.map(schemaRule);
          if (!value) next.splice(i, 1);
          else next[i].pattern = value;
          write(next);
        });
        row.appendChild(pattern);

        var sel = document.createElement('select');
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

        list.appendChild(row);
      });
    }

    addBtn.addEventListener('click', function() {
      var value = newPattern.value.trim();
      if (!value) {
        showEdStatus(status, 'Enter a pattern first.', true);
        return;
      }
      var next = rules.map(schemaRule);
      next.push({ pattern: value, iface: newIface.value || '', enabled: true });
      newPattern.value = '';
      write(next);
    });
    newPattern.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        addBtn.click();
      }
    });

    master.addEventListener('change', function() {
      var wanted = master.checked;
      Promise.resolve(svc.setUrlRulesEnabled(wanted)).then(function(res) {
        master.checked = !!(res && res.enabled);
        showEdStatus(status, res && res.ok === false
          ? (res.error || 'Could not change the master switch.')
          : '');
      }).catch(function(e) {
        master.checked = !wanted;
        showEdStatus(status, 'Could not change the master switch: ' +
          ((e && e.message) || e), true);
      });
    });

    Promise.resolve(svc.getUrlRules()).then(function(state) {
      state = state || {};
      rules = Array.isArray(state.rules) ? state.rules : [];
      master.checked = state.enabled !== false;
      return loadInterfaces();
    }).then(render).catch(function(e) {
      showEdStatus(status, 'Could not read the URL rules: ' +
        ((e && e.message) || e), true);
    });
  }

  // ── user agent editor ─────────────────────────────────────────────

  function initUaEditor() {
    var CUSTOM_VALUE = '__custom__';
    var heading = document.getElementById('ua-rules-heading');
    var card = document.getElementById('ua-rules-card');
    var presetSelect = document.getElementById('opt-ua-preset');
    var globalRaw = document.getElementById('opt-ua-global-raw');
    var master = document.getElementById('opt-ua-enabled');
    var list = document.getElementById('opt-ua-list');
    var empty = document.getElementById('opt-ua-empty');
    var newPattern = document.getElementById('opt-ua-new-pattern');
    var newUa = document.getElementById('opt-ua-new-ua');
    var addBtn = document.getElementById('opt-ua-add');
    var status = document.getElementById('opt-ua-status');

    var state = { global: '', enabled: true, rules: [] };

    function present() {
      return ask('user-agent:present').then(function(res) {
        return !!(res && res.ok);
      }).catch(function() { return false; });
    }

    function presetLabel(ua) {
      return (globalThis.RozeLynxUAPresets &&
              globalThis.RozeLynxUAPresets.labelFor(ua)) || null;
    }

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

    function readState() {
      return ask('user-agent:get-state').then(function(res) {
        if (!res || res.ok !== true) {
          throw new Error((res && res.error) || 'the module did not answer');
        }
        state.global = res.global || '';
        state.enabled = res.enabled !== false;
        state.rules = Array.isArray(res.rules) ? res.rules : [];
        master.checked = state.enabled;
        fillUaSelect(presetSelect, state.global, true);
        var custom = presetSelect.value === CUSTOM_VALUE;
        globalRaw.style.display = custom ? 'block' : 'none';
        if (custom) globalRaw.value = state.global;
        fillUaSelect(newUa, '', false);
        render();
      });
    }

    function writeRules(next) {
      return ask('user-agent:set-rules', { rules: next })
        .then(function(res) {
          if (res && res.ok !== true) {
            showEdStatus(status, (res && res.error) || 'Could not save the rules.', true);
          } else {
            showEdStatus(status, '');
          }
          return readState();
        })
        .catch(function(e) {
          showEdStatus(status, 'Could not save the rules: ' +
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

    function render() {
      list.textContent = '';
      empty.hidden = state.rules.length > 0;
      state.rules.forEach(function(rule, i) {
        var row = document.createElement('div');
        row.className = 'row';

        var pattern = document.createElement('input');
        pattern.type = 'text';
        pattern.value = rule.pattern || '';
        pattern.spellcheck = false;
        pattern.addEventListener('change', function() {
          var value = pattern.value.trim();
          if (value === (state.rules[i].pattern || '')) return;
          var next = state.rules.map(schemaRule);
          if (!value) next.splice(i, 1);
          else next[i].pattern = value;
          writeRules(next);
        });
        row.appendChild(pattern);

        var sel = document.createElement('select');
        fillUaSelect(sel, rule.ua, false);
        sel.addEventListener('change', function() {
          if (sel.value === CUSTOM_VALUE) {
            showEdStatus(status, 'Type the custom string in the global ' +
              'raw box, apply it, then pick "Custom" here to reuse it.', false);
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

        list.appendChild(row);
      });
    }

    presetSelect.addEventListener('change', function() {
      if (presetSelect.value === CUSTOM_VALUE) {
        globalRaw.style.display = 'block';
        globalRaw.value = state.global && !presetLabel(state.global)
          ? state.global : '';
        globalRaw.focus();
        return;
      }
      globalRaw.style.display = 'none';
      ask('user-agent:set-global', { ua: presetSelect.value })
        .then(readState)
        .catch(function(e) {
          showEdStatus(status, 'Could not save the user agent: ' +
            ((e && e.message) || e), true);
        });
    });

    globalRaw.addEventListener('change', function() {
      ask('user-agent:set-global', { ua: globalRaw.value.trim() })
        .then(readState)
        .catch(function(e) {
          showEdStatus(status, 'Could not save the user agent: ' +
            ((e && e.message) || e), true);
        });
    });

    master.addEventListener('change', function() {
      ask('user-agent:set-rules-enabled', { enabled: master.checked })
        .then(function(res) {
          if (res && res.ok === true) {
            state.enabled = res.enabled !== false;
            master.checked = state.enabled;
            showEdStatus(status, '');
          } else {
            showEdStatus(status, (res && res.error) ||
              'Could not change the master switch.', true);
          }
        })
        .catch(function(e) {
          showEdStatus(status, 'Could not change the master switch: ' +
            ((e && e.message) || e), true);
        });
    });

    addBtn.addEventListener('click', function() {
      var value = newPattern.value.trim();
      if (!value) {
        showEdStatus(status, 'Enter a pattern first.', true);
        return;
      }
      var ua = newUa.value === CUSTOM_VALUE
        ? globalRaw.value.trim() : newUa.value;
      if (!ua) {
        showEdStatus(status, 'Pick a user agent for the rule first.', true);
        return;
      }
      var next = state.rules.map(schemaRule);
      next.push({ pattern: value, ua: ua, enabled: true });
      newPattern.value = '';
      writeRules(next);
    });
    newPattern.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        addBtn.click();
      }
    });

    // presets.js first (a static tag would 404 on a build without the
    // user-agent module), then the module check, then the editor.
    var script = document.createElement('script');
    script.src = '../modules/user-agent/presets.js';
    script.onload = function() {
      present().then(function(isThere) {
        if (!isThere) return;  // a build without USE=user-agent
        heading.hidden = false;
        card.classList.remove('card-hidden');
        return readState();
      }).catch(function() {});
    };
    script.onerror = function() {
      globalThis.RozeLynxUAPresets = {
        presets: [], groups: [],
        labelFor: function() { return null; },
      };
      script.onload();
    };
    document.head.appendChild(script);
  }

  loadFeatures();
  initNetifaceEditor();
  initUaEditor();
})();
