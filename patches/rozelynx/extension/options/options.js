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
        // Healthy background: a sub-9 count just means the user disabled
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

  loadFeatures();
})();
