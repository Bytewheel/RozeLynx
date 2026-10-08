// Lepton Skin - Content Script
// Storage-driven: injects leptonContent.css as a <style> only when
// rozelynx_lepton_enabled is set in storage.local (the background page is
// dead in this build, so everything is driven from storage).
// Live toggles from the options page are picked up via storage.onChanged.

(function() {
  'use strict';

  var STORAGE_KEY = 'rozelynx_lepton_enabled';
  var STYLE_ID = 'rozelynx-lepton-content';
  var styleEl = null;

  function removeLeptonCSS() {
    var existing = document.getElementById(STYLE_ID);
    if (existing) existing.remove();
    styleEl = null;
  }

  function injectLeptonCSS(cssText) {
    if (!cssText) return;
    removeLeptonCSS();
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.setAttribute('data-lepton', 'active');
    style.textContent = cssText;
    (document.head || document.documentElement).appendChild(style);
    styleEl = style;
  }

  function applyState(enabled) {
    if (!enabled) {
      removeLeptonCSS();
      return;
    }
    if (styleEl) return;
    fetch(browser.runtime.getURL('modules/lepton-skin/leptonContent.css'))
      .then(function(resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.text();
      })
      .then(function(cssText) {
        if (styleEl) return; // toggled off while fetching
        injectLeptonCSS(cssText);
      })
      .catch(function() {});
  }

  browser.storage.local.get(STORAGE_KEY).then(function(stored) {
    applyState(!!(stored && stored[STORAGE_KEY]));
  }).catch(function() {});

  browser.storage.onChanged.addListener(function(changes, area) {
    if (area !== 'local' || !changes[STORAGE_KEY]) return;
    applyState(!!changes[STORAGE_KEY].newValue);
  });
})();
