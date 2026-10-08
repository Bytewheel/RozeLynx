// Lepton Skin Module for RozeLynx
// Compact UI theme CSS - injected as content script for web pages
// Browser chrome theming requires userChrome.css, which the native host writes.

(function() {
  'use strict';

  var STORAGE_KEY = 'rozelynx_lepton_enabled';
  var enabled = false;

  // The SSB (PWA window) rules live in the same userChrome.css, and a PWA
  // window can be opened from any profile. Seeding therefore has to happen for
  // every profile, and it cannot wait for the user to flip the skin toggle:
  // profiles that predate the seeding would otherwise show undecorated PWA
  // windows indefinitely. The host writes all profiles and is idempotent, so
  // doing it on every startup is cheap and self-heals a profile that was
  // created (or restored) after the browser was installed.
  async function seedChromeSkin() {
    try {
      var resp = await browser.runtime.sendNativeMessage('rozelynx_host', {
        action: 'chrome-skin',
        enabled: enabled
      });
      if (resp && resp.ok) {
        console.log('[RozeLynx] chrome/skin seeded for ' +
          ((resp.seeded && resp.seeded.length) || 0) + ' profile(s)');
      } else {
        console.warn('[RozeLynx] chrome-skin seeding failed: ' +
          ((resp && resp.error) || 'no response from host'));
      }
    } catch (e) {
      // Host missing or busy is not fatal: the skin still works via the
      // content-script half, and the next startup retries.
      console.warn('[RozeLynx] chrome-skin seeding skipped: ' + e.message);
    }
  }

  async function init() {
    try {
      var stored = await browser.storage.local.get(STORAGE_KEY);
      if (stored[STORAGE_KEY]) {
        enabled = true;
      }
    } catch (e) {
      enabled = false;
    }
    console.log('[RozeLynx] Lepton Skin initialized, enabled:', enabled);
    await seedChromeSkin();
  }

  async function toggle() {
    enabled = !enabled;
    try {
      await browser.storage.local.set(JSON.parse('{"' + STORAGE_KEY + '":' + enabled + '}'));
    } catch (e) {}
    applyToAllTabs();
    return enabled;
  }

  async function enable() {
    if (!enabled) return toggle();
    return true;
  }

  async function disable() {
    if (enabled) return toggle();
    return false;
  }

  async function getStatus() {
    return { enabled: enabled };
  }

  function applyToAllTabs() {
    browser.tabs.query({}).then(function(tabs) {
      tabs.forEach(function(tab) {
        if (tab.url && (tab.url.startsWith('http://') || tab.url.startsWith('https://'))) {
          browser.tabs.sendMessage(tab.id, {
            module: 'lepton-skin',
            action: 'stateChanged',
            data: { enabled: enabled },
          }).catch(function() {});
        }
      });
    });
  }

  browser.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    if (message.module !== 'lepton-skin') return;

    switch (message.action) {
      case 'toggle':
        toggle().then(function(enabled) { sendResponse({ enabled: enabled }); });
        return true;
      case 'enable':
        enable().then(function(enabled) { sendResponse({ enabled: enabled }); });
        return true;
      case 'disable':
        disable().then(function(enabled) { sendResponse({ enabled: enabled }); });
        return true;
      case 'getStatus':
        getStatus().then(sendResponse);
        return true;
      case 'getContentCSS':
        sendResponse({ css: getContentCSS() });
        break;
      default:
        break;
    }
  });

  // The content CSS for web pages (browser chrome styling is done via userChrome.css)
  function getContentCSS() {
    return [
      ':root {',
      '  --lepton-accent: #8B5CF6;',
      '  --lepton-accent-hover: #7C3AED;',
      '  --lepton-accent-active: #6D28D9;',
      '  --lepton-radius-sm: 4px;',
      '  --lepton-radius-md: 6px;',
      '  --lepton-radius-lg: 8px;',
      '  --lepton-radius-full: 999px;',
      '  --lepton-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
      '  font-family: var(--lepton-font) !important;',
      '  font-size: 14px;',
      '  line-height: 1.5;',
      '}',
      '',
      '@media (prefers-color-scheme: dark) {',
      '  :root {',
      '    --lepton-accent: #A78BFA;',
      '    --lepton-accent-hover: #8B5CF6;',
      '    --lepton-accent-active: #7C3AED;',
      '  }',
      '}',
    ].join('\n');
  }

  init();
  RozeLynxFeatures.loadedModules['lepton-skin'] = true;
  console.log('[RozeLynx] Lepton Skin module loaded');
})();
