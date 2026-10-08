var RozeLynxFeatures = (function() {
  'use strict';

  var LOG_PREFIX = '[RozeLynx]';

  function log(level, msg) {
    var args = Array.prototype.slice.call(arguments, 1);
    if (level === 'error') {
      console.error.apply(console, [LOG_PREFIX].concat(args));
    } else if (level === 'warn') {
      console.warn.apply(console, [LOG_PREFIX].concat(args));
    } else if (level === 'debug') {
      console.debug.apply(console, [LOG_PREFIX].concat(args));
    } else {
      console.log.apply(console, [LOG_PREFIX].concat(args));
    }
  }

  var FEATURES = {
    //ROZELYNX_FEATURE_DISABLED: "chrome-web-store": "modules/chrome-web-store/background.js",
    //ROZELYNX_FEATURE_DISABLED: "experiments": "modules/experiments/background.js",
    //ROZELYNX_FEATURE_DISABLED: "external-browser": "modules/external-browser/background.js",
    //ROZELYNX_FEATURE_DISABLED: "external-link": "modules/external-link/background.js",
    //ROZELYNX_FEATURE_DISABLED: "i18n": "modules/i18n/background.js",
    //ROZELYNX_FEATURE_DISABLED: "mouse-gestures": "modules/mouse-gestures/background.js",
    //ROZELYNX_FEATURE_DISABLED: "qr-code": "modules/qr-code/background.js",
    //ROZELYNX_FEATURE_DISABLED: "pwa": "modules/pwa/background.js",
    //ROZELYNX_FEATURE_DISABLED: "lepton-skin": "modules/lepton-skin/background.js",
    //ROZELYNX_FEATURE_DISABLED: "ip-protection": "modules/ip-protection/background.js",
    //ROZELYNX_FEATURE_DISABLED: "net-iface": "modules/netiface/background.js",
    //ROZELYNX_FEATURE_DISABLED: "download-handoff": "modules/downloads-handoff/background.js",
  };

  var loadedModules = {};
  var loadErrors = {};
  var initialized = false;
  var loadedUrls = {};

  function getExtensionUrl(path) {
    try {
      return browser.runtime.getURL(path);
    } catch(e) {
      log('error', 'Failed to get URL for path:', path, e.message);
      return null;
    }
  }

  function loadModule(name, path) {
    try {
      var url = getExtensionUrl(path);
      if (!url) {
        loadErrors[name] = 'Invalid URL for path: ' + path;
        return false;
      }
      if (loadedUrls[url]) {
        log('debug', 'Module already loaded, skipping duplicate:', url);
        return true;
      }
      loadedUrls[url] = true;

      log('debug', 'Loading module "' + name + '" from ' + url);
      var script = document.createElement('script');
      script.src = url;
      script.async = false;
      script.onload = function() {
        log('debug', 'Module "' + name + '" script loaded successfully');
      };
      script.onerror = function(e) {
        log('error', 'Module "' + name + '" script failed to load');
        loadErrors[name] = 'Script load error';
      };
      document.head.appendChild(script);
      loadedModules[name] = true;
      return true;
    } catch(e) {
      log('error', 'Failed to load module ' + name + ':', e.message, e.stack);
      loadErrors[name] = e.message;
      return false;
    }
  }

  function init() {
    if (initialized) {
      log('debug', 'Feature loader init already ran, skipping duplicate call');
      return;
    }
    initialized = true;

    var enabled = [];
    var keys = Object.keys(FEATURES);
    log('info', 'Feature loader starting with ' + keys.length + ' features configured');

    for (var i = 0; i < keys.length; i++) {
      var name = keys[i];
      var path = FEATURES[name];
      log('debug', 'Trying to load feature:', name, 'at', path);
      if (loadModule(name, path)) {
        enabled.push(name);
      } else {
        log('warn', 'Feature ' + name + ' failed to load:', loadErrors[name]);
      }
    }

    if (enabled.length > 0) {
      log('info', 'Successfully loaded module scripts: ' + enabled.join(', '));
    } else {
      log('warn', 'No feature modules were loaded');
    }

    log('info', 'Feature loader init complete. Module count: ' + enabled.length);

    if (Object.keys(loadErrors).length > 0) {
      log('warn', 'Load errors:', JSON.stringify(loadErrors));
    }
  }

  function getDiagnostics() {
    return {
      featureCount: Object.keys(FEATURES).length,
      loadedCount: Object.keys(loadedModules).length,
      loadedModules: Object.keys(loadedModules),
      errors: loadErrors,
      extensionRoot: getExtensionUrl(''),
    };
  }

  return {
    init: init,
    loadedModules: loadedModules,
    loadErrors: loadErrors,
    FEATURES: FEATURES,
    getDiagnostics: getDiagnostics,
  };
})();

RozeLynxFeatures.init();
