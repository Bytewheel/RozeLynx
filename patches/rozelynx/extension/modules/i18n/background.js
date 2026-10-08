// I18n Utils Module for RozeLynx
// Ported from Floorp's i18n module
// Locale detection, language pack management, translation utilities

(function() {
  'use strict';

  const SUPPORTED_LOCALES = [
    'en-US', 'en-GB', 'en-CA', 'en-AU',
    'ja', 'ja-JP',
    'zh-CN', 'zh-TW', 'zh-HK',
    'ko', 'ko-KR',
    'de', 'de-DE',
    'fr', 'fr-FR',
    'es', 'es-ES', 'es-MX', 'es-AR',
    'pt', 'pt-BR', 'pt-PT',
    'it', 'it-IT',
    'ru', 'ru-RU',
    'ar', 'ar-SA',
    'pl', 'pl-PL',
    'nl', 'nl-NL',
    'tr', 'tr-TR',
    'sv', 'sv-SE',
    'nb', 'nb-NO',
    'fi', 'fi-FI',
    'da', 'da-DK',
    'cs', 'cs-CZ',
    'hu', 'hu-HU',
    'uk', 'uk-UA',
    'vi', 'vi-VN',
    'th', 'th-TH',
    'id', 'id-ID',
    'ms', 'ms-MY',
    'fa', 'fa-IR',
    'he', 'he-IL',
    'hi', 'hi-IN',
    'bn', 'bn-BD',
  ];

  const AMO_API_BASE = 'https://addons.mozilla.org/api/v5/addons/addon';

  async function getAppVersion() {
    try {
      const info = await browser.runtime.getBrowserInfo();
      if (info && info.version) return info.version;
    } catch (e) {}
    const m = (navigator.userAgent || '').match(/rv:([\d.]+)/);
    return m ? m[1] : null;
  }

  async function fetchJson(url, stage) {
    let resp;
    try {
      resp = await fetch(url);
    } catch (e) {
      throw new Error(`${stage}: fetch failed: ${e.message}`);
    }
    if (!resp.ok) {
      throw new Error(`${stage}: HTTP ${resp.status} for ${url}`);
    }
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('json')) {
      const head = (await resp.text()).slice(0, 120);
      throw new Error(`${stage}: non-JSON (${ct}) for ${url}: ${head}`);
    }
    try {
      return await resp.json();
    } catch (e) {
      const head = (await resp.clone().text()).slice(0, 120);
      throw new Error(`${stage}: JSON parse failed for ${url}: ${head}`);
    }
  }

  class I18nManager {
    constructor() {
      this.currentLocale = null;
      this.availableLocales = [];
      this.translationProviders = new Map();
    }

    async init() {
      this.currentLocale = this.detectLocale();
      this.availableLocales = await this.scanInstalledLanguagePacks();
      console.log(`[RozeLynx] I18n initialized. Current locale: ${this.currentLocale}`);
    }

    detectLocale() {
      // Priority: user-set pref > browser locale > system locale
      const userLocale = this.getUserLocalePref();
      if (userLocale && SUPPORTED_LOCALES.includes(userLocale)) {
        return userLocale;
      }

      const browserLocale = Services?.locale?.appLocaleAsBCP47 || 
                           navigator?.language || 'en-US';
      
      // Try exact match first
      if (SUPPORTED_LOCALES.includes(browserLocale)) {
        return browserLocale;
      }

      // Try language match
      const lang = browserLocale.split('-')[0];
      const matching = SUPPORTED_LOCALES.find(l => l.startsWith(lang));
      return matching || 'en-US';
    }

    getUserLocalePref() {
      try {
        if (typeof browser !== 'undefined' && browser.i18n) {
          return browser.i18n.getUILanguage();
        }
      } catch (e) {
        // Fallback
      }
      return null;
    }

    async scanInstalledLanguagePacks() {
      try {
        const addons = await browser.management.getAll();
        const langPacks = addons.filter(addon => {
          return addon.type === 'locale' || 
                 addon.id?.includes('@langpack') || 
                 addon.name?.toLowerCase().includes('language pack');
        });
        
        return langPacks.map(pack => ({
          id: pack.id,
          name: pack.name,
          locale: this.extractLocaleFromId(pack.id),
          enabled: pack.enabled,
          version: pack.version,
        }));
      } catch (e) {
        console.debug('[RozeLynx] Could not scan language packs:', e);
        return [];
      }
    }

    extractLocaleFromId(id) {
      const match = id.match(/langpack-([a-z]{2,3}(?:-[A-Z]{2})?)@/);
      return match ? match[1] : 'unknown';
    }

    async installLanguagePack(locale) {
      if (!SUPPORTED_LOCALES.includes(locale)) {
        throw new Error(`Unsupported locale: ${locale}`);
      }

      const addonId = `langpack-${locale}@firefox.mozilla.org`;
      const appVersion = await getAppVersion();
      if (!appVersion) {
        throw new Error('Cannot determine browser version');
      }
      const appMajor = parseInt(appVersion.split('.')[0], 10);

      try {
        console.log(`[RozeLynx] Installing language pack for ${locale}`);
        // AMO v5 API: resolve the langpack addon, then pick the newest
        // public version that matches this browser's major version
        // (langpacks are strictly per-major: max "153.*" for Firefox 153).
        const meta = await fetchJson(
          `${AMO_API_BASE}/${encodeURIComponent(addonId)}/`, 'AMO lookup');
        if (!meta || !meta.guid) {
          throw new Error(`No language pack found for ${locale}`);
        }

        const versionsUrl = `${AMO_API_BASE}/` +
          `${encodeURIComponent(meta.slug || addonId)}/versions/`;
        const versions = await fetchJson(`${versionsUrl}?page_size=25`,
          'AMO versions');

        let chosen = null;
        for (const v of versions.results || []) {
          const file = v.file;
          if (!file || file.status !== 'public') continue;
          const fx = v.compatibility && v.compatibility.firefox;
          if (!fx || !fx.min || !fx.max) continue;
          const minOk = parseFloat(fx.min) <= parseFloat(appVersion);
          const maxMajor = parseInt(fx.max.split('.')[0], 10);
          if (minOk && (isNaN(maxMajor) || appMajor === maxMajor)) {
            chosen = v;
            break;
          }
        }
        if (!chosen) {
          throw new Error(
            `No language pack version compatible with Firefox ${appVersion}`);
        }

        // Stage the XPI via the browser-level downloads API (no CORS
        // involved), then ask the native host to verify and install it
        // into the profile extensions directory.
        const dlId = await browser.downloads.download({
          url: chosen.file.url,
          filename: `rozelynx-langpack/langpack-${locale}-${chosen.version}.xpi`,
          saveAs: false,
          conflictAction: 'overwrite',
        });
        await new Promise((resolve, reject) => {
          browser.downloads.onChanged.addListener(function listener(delta) {
            if (delta.id !== dlId) return;
            if (delta.state && delta.state.current === 'complete') {
              browser.downloads.onChanged.removeListener(listener);
              resolve();
            } else if (delta.error && delta.error.current) {
              browser.downloads.onChanged.removeListener(listener);
              reject(new Error(delta.error.current));
            }
          });
        });
        const items = await browser.downloads.search({ id: dlId });
        if (!items || !items.length || !items[0].filename) {
          throw new Error('download path unknown');
        }

        const resp = await browser.runtime.sendNativeMessage('rozelynx_host', {
          action: 'install-langpack',
          id: addonId,
          path: items[0].filename,
          sha256: (chosen.file.hash || '').replace('sha256:', ''),
          version: chosen.version,
        });
        if (!resp || !resp.ok) {
          throw new Error(resp && resp.error ? resp.error :
            'native host install failed');
        }

        await browser.notifications.create(`langpack-install-${locale}`, {
          type: 'basic',
          iconUrl: await RozeLynxNotify.iconFor(
            'https://addons.mozilla.org/firefox/addon/' +
            (meta.slug || addonId) + '/'),
          title: 'Language Pack Installed',
          message: `${this.getLocaleDisplayName(locale)} (${locale}) language ` +
            `pack v${chosen.version} installed. Restart the browser to ` +
            'activate it.',
        });

        return { success: true, locale, version: chosen.version };
      } catch (e) {
        console.error(`[RozeLynx] Language pack install failed for ${locale}:`, e);
        throw e;
      }
    }

    async removeLanguagePack(locale) {
      try {
        const addonId = `langpack-${locale}@firefox.mozilla.org`;
        // management.uninstall is a no-op for XPI files dropped into the
        // profile extensions dir, so the host removal is authoritative.
        try {
          const packs = await this.scanInstalledLanguagePacks();
          const pack = packs.find(p => p.locale === locale || p.id === addonId);
          if (pack) {
            await browser.management.uninstall(pack.id);
            console.log(`[RozeLynx] Removed language pack: ${locale}`);
          }
        } catch (e) {
          console.debug('[RozeLynx] management.uninstall failed:', e);
        }
        const resp = await browser.runtime.sendNativeMessage('rozelynx_host', {
          action: 'uninstall-langpack',
          id: addonId,
        });
        if (!resp || !resp.ok) {
          throw new Error(resp && resp.error ? resp.error :
            'native host removal failed');
        }
        return { success: true };
      } catch (e) {
        console.error(`[RozeLynx] Failed to remove language pack ${locale}:`, e);
        throw e;
      }
    }

    registerTranslationProvider(provider) {
      this.translationProviders.set(provider.id, provider);
    }

    getTranslationProvider(providerId) {
      return this.translationProviders.get(providerId);
    }

    getAvailableTranslationProviders() {
      return Array.from(this.translationProviders.values());
    }

    getCurrentLocale() {
      return this.currentLocale;
    }

    getSupportedLocales() {
      return [...SUPPORTED_LOCALES];
    }

    getLocaleDisplayName(locale) {
      try {
        const displayNames = new Intl.DisplayNames([locale], { type: 'language' });
        return displayNames.of(locale.split('-')[0]);
      } catch (e) {
        return locale;
      }
    }

    async getInstalledLanguages() {
      const packs = await this.scanInstalledLanguagePacks();
      return packs.filter(p => p.enabled).map(p => p.locale);
    }

    compareLocales(locale1, locale2) {
      // Check if same language
      const lang1 = locale1.split('-')[0];
      const lang2 = locale2.split('-')[0];
      return lang1 === lang2;
    }
  }

  const i18n = new I18nManager();

  // Listen for messages
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.module !== 'i18n') return;

    switch (message.action) {
      case 'getLocale':
        sendResponse({ locale: i18n.getCurrentLocale() });
        break;
      case 'getSupportedLocales':
        sendResponse({ locales: i18n.getSupportedLocales() });
        break;
      case 'getLocaleDisplayName':
        sendResponse({ 
          displayName: i18n.getLocaleDisplayName(message.data.locale) 
        });
        break;
      case 'installLanguagePack':
        i18n.installLanguagePack(message.data.locale)
          .then(sendResponse)
          .catch(e => sendResponse({ error: e.message }));
        return true;
      case 'removeLanguagePack':
        i18n.removeLanguagePack(message.data.locale)
          .then(sendResponse)
          .catch(e => sendResponse({ error: e.message }));
        return true;
      case 'getInstalledLanguages':
        i18n.getInstalledLanguages().then(langs => sendResponse({ languages: langs }));
        return true;
      default:
        break;
    }
  });

  i18n.init();
  RozeLynxFeatures.loadedModules['i18n'] = true;
  console.log('[RozeLynx] I18n module loaded');
})();
