// IP Protection Module for RozeLynx
// Privacy overrides applied in two layers on every toggle:
//   1. LIVE: the privileged rozelynxPrefs experiment API flips the prefs
//      in the running browser exactly like about:config - no restart.
//   2. PERSISTENT: the native host writes the same map to the profile's
//      user.js (imported by the browser into prefs.js at every start), so
//      the values survive a restart.
// The toggle owns these prefs.

(function() {
  'use strict';

  const STORAGE_KEY = 'rozelynx_ip_protection';

  // The protective set applied when ip-protection is ON. Keeps the
  // hardened RozeLynx build defaults (e.g. resistFingerprinting=true,
  // which the module must NOT regress) and hardens where the build is
  // lenient (sensors, webmidi, battery, clipboard events, debug renderer
  // info, ICE address leaks, font visibility, ...).
  const PROTECTED_PREFS = {
    'privacy.fingerprintingProtection': true,
    'privacy.fingerprintingProtection.pbmode': true,
    'privacy.resistFingerprinting': true,
    'privacy.resistFingerprinting.autoDeclineNoUserInputCanvasPrompts': true,
    'privacy.resistFingerprinting.exemptedDomains': '*.example.invalid',
    'privacy.fingerprintingProtection.overrides':
      '+AllTargets,-CanvasImageExtractionPrompt',
    'canvas.capturestream.enabled': false,
    'webgl.disabled': false,
    'webgl.enable-webgl2': true,
    'webgl.enable-debug-renderer-info': false,
    'webgl.enable-privileged-extensions': false,
    'webgl.disable-extensions': true,
    'webgl.min_capability_mode': true,
    'privacy.trackingprotection.enabled': true,
    'privacy.trackingprotection.fingerprinting.enabled': true,
    'privacy.trackingprotection.cryptomining.enabled': true,
    'privacy.trackingprotection.socialtracking.enabled': true,
    'privacy.firstparty.isolate': false,
    'privacy.partition.network_state': true,
    'privacy.partition.bloburl_per_partition': true,
    'dom.webaudio.enabled': true,
    'media.peerconnection.enabled': true,
    'media.peerconnection.ice.default_address_only': true,
    'media.peerconnection.ice.no_host': false,
    'media.peerconnection.ice.proxy_only_if_behind_proxy': true,
    'media.peerconnection.ice.relay_only': false,
    'layout.css.font-visibility.level': 1,
    'layout.css.font-visibility.private': 1,
    'font.system.whitelist': '',
    'privacy.resistFingerprinting.block_mozAddonManager': true,
    'geo.enabled': true,
    'geo.wifi.uri': '',
    'browser.search.geoip.url': '',
    'browser.search.region': 'US',
    'browser.search.countryCode': 'US',
    'intl.accept_languages': 'en-US,en',
    'javascript.use_us_english_locale': true,
    'dom.battery.enabled': false,
    'dom.gamepad.enabled': true,
    'dom.gamepad.extensions.enabled': false,
    'device.sensors.enabled': false,
    'device.sensors.ambientLight.enabled': false,
    'device.sensors.motion.enabled': false,
    'device.sensors.orientation.enabled': false,
    'device.sensors.proximity.enabled': false,
    'media.webspeech.recognition.enable': false,
    'media.webspeech.synth.enabled': false,
    'dom.webmidi.enabled': false,
    'mathml.disabled': false,
    'dom.event.clipboardevents.enabled': false,
    'dom.allow_cut_copy': true,
    'dom.disable_beforeunload': true,
    'dom.disable_open_during_load': true,
    'dom.popup_allowed_events':
      'change click dblclick auxclick mousedown mouseup pointerdown ' +
      'pointerup notificationclick reset submit touchend contextmenu',
    'dom.disable_window_flip': true,
    'dom.disable_window_move_resize': true,
    'dom.disable_open_click_delay': 1000,
    'dom.event.contextmenu.enabled': true,
    'dom.vibrator.enabled': false,
    'dom.w3c_touch_events.enabled': 1,
  };

  // The exact shipped-build defaults (default branch values of this
  // RozeLynx build), applied when ip-protection is OFF so the toggle is
  // fully reversible. NOTE: librewolf.cfg sets
  // browser.contentblocking.category=strict at every start, which FORCES
  // the tracking-protection/fingerprinting-protection legacy prefs true
  // regardless of user.js - those are mirrored here as their real
  // OFF-state values.
  const BUILD_DEFAULTS = {
    'privacy.fingerprintingProtection': true, // forced by contentblocking strict
    'privacy.fingerprintingProtection.pbmode': true,
    'privacy.resistFingerprinting': true,
    'privacy.resistFingerprinting.autoDeclineNoUserInputCanvasPrompts': true,
    'privacy.resistFingerprinting.exemptedDomains': '*.example.invalid',
    'privacy.fingerprintingProtection.overrides': '',
    'canvas.capturestream.enabled': true,
    'webgl.disabled': false,
    'webgl.enable-webgl2': true,
    'webgl.enable-debug-renderer-info': true,
    'webgl.enable-privileged-extensions': false,
    'webgl.disable-extensions': false,
    'webgl.min_capability_mode': false,
    'privacy.trackingprotection.enabled': true, // forced by contentblocking strict
    'privacy.trackingprotection.fingerprinting.enabled': true,
    'privacy.trackingprotection.cryptomining.enabled': true,
    'privacy.trackingprotection.socialtracking.enabled': true, // forced by strict
    'privacy.firstparty.isolate': false,
    'privacy.partition.network_state': true,
    'privacy.partition.bloburl_per_partition': true,
    'dom.webaudio.enabled': true,
    'media.peerconnection.enabled': true,
    'media.peerconnection.ice.default_address_only': false,
    'media.peerconnection.ice.no_host': false,
    'media.peerconnection.ice.proxy_only_if_behind_proxy': true,
    'media.peerconnection.ice.relay_only': false,
    'layout.css.font-visibility.level': 1,
    'layout.css.font-visibility.private': 1,
    'font.system.whitelist': '',
    'privacy.resistFingerprinting.block_mozAddonManager': true,
    'geo.enabled': true,
    'geo.wifi.uri': '',
    'browser.search.geoip.url': '',
    'browser.search.region': '',
    'browser.search.countryCode': '',
    'intl.accept_languages': 'und',
    'javascript.use_us_english_locale': false,
    'dom.battery.enabled': true,
    'dom.gamepad.enabled': true,
    'dom.gamepad.extensions.enabled': true,
    'device.sensors.enabled': true,
    'device.sensors.ambientLight.enabled': false,
    'device.sensors.motion.enabled': true,
    'device.sensors.orientation.enabled': true,
    'device.sensors.proximity.enabled': false,
    'media.webspeech.recognition.enable': false,
    'media.webspeech.synth.enabled': true,
    'dom.webmidi.enabled': true,
    'mathml.disabled': false,
    'dom.event.clipboardevents.enabled': true,
    'dom.allow_cut_copy': true,
    'dom.disable_beforeunload': false,
    'dom.disable_open_during_load': true,
    'dom.popup_allowed_events':
      'change click dblclick auxclick mousedown mouseup pointerdown ' +
      'pointerup notificationclick reset submit touchend contextmenu',
    'dom.disable_window_flip': true,
    'dom.disable_window_move_resize': true,
    'dom.disable_open_click_delay': 1000,
    'dom.event.contextmenu.enabled': true,
    'dom.vibrator.enabled': false,
    'dom.w3c_touch_events.enabled': 2,
  };

  class IPProtection {
    constructor() {
      this.enabled = false;
    }

    async init() {
      try {
        const stored = await browser.storage.local.get(STORAGE_KEY);
        this.enabled = !!stored[STORAGE_KEY];
      } catch (e) {
        this.enabled = false;
      }
    }

    async savePrefs() {
      try {
        await browser.storage.local.set({
          [STORAGE_KEY]: this.enabled,
        });
      } catch (e) {
        console.error('[RozeLynx IPP] Failed to save prefs:', e);
      }
    }

    async applyToProfile(prefs) {
      // Persistence layer: write user.js via the native host so the values
      // survive a browser restart (imported into prefs.js at every start).
      const resp = await browser.runtime.sendNativeMessage('rozelynx_host', {
        action: 'set-prefs',
        prefs,
      });
      if (!resp || !resp.ok) {
        throw new Error(resp && resp.error ? resp.error :
          'native host set-prefs failed');
      }
      return resp;
    }

    async applyLive(prefs) {
      // Live layer: flip the prefs in the running browser exactly like
      // about:config does, via the privileged rozelynxPrefs experiment API.
      // No restart needed. Falls back silently if the API is unavailable
      // (e.g. extensions.experiments.enabled turned off in the build).
      if (!browser.rozelynxPrefs || !browser.rozelynxPrefs.setPrefs) {
        return { available: false };
      }
      const r = await browser.rozelynxPrefs.setPrefs(prefs);
      return Object.assign({ available: true }, r);
    }

    async notify(enabled) {
      try {
        await browser.notifications.create('ip-protection-state', {
          type: 'basic',
          iconUrl: browser.runtime.getURL('icons/icon128.png'),
          title: 'IP Protection ' + (enabled ? 'enabled' : 'disabled'),
          message: enabled
            ? 'Privacy prefs applied to this profile. No restart needed.'
            : 'Privacy prefs reverted to RozeLynx defaults. No restart ' +
              'needed.',
        });
      } catch (e) {}
    }

    async setEnabled(enabled) {
      this.enabled = enabled;
      await this.savePrefs();
      const prefs = enabled ? PROTECTED_PREFS : BUILD_DEFAULTS;
      await this.applyToProfile(prefs);
      let live;
      try {
        live = await this.applyLive(prefs);
      } catch (e) {
        live = {
          available: true,
          ok: false,
          error: (e && (e.message || String(e)) || 'unknown') +
            (e && e.stack ? ' | ' + String(e.stack).split('\n').slice(0, 3).join(' ') : ''),
        };
      }
      await this.notify(enabled);
      return { enabled: this.enabled, live };
    }

    async toggle() {
      return this.setEnabled(!this.enabled);
    }

    updateUI() {
      browser.runtime.sendMessage({
        module: 'ip-protection',
        action: 'stateChanged',
        data: { enabled: this.enabled },
      }).catch(() => {});
    }

    getRecommendedPrefs() {
      return { ...PROTECTED_PREFS };
    }

    async applyRecommendedPrefs() {
      const resp = await this.applyToProfile(PROTECTED_PREFS);
      return {
        success: true,
        written: resp.written || Object.keys(PROTECTED_PREFS).length,
        message: 'Privacy prefs applied to this profile. No restart needed.',
      };
    }

    isProtected() {
      return this.enabled;
    }
  }

  const ipProtection = new IPProtection();

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.module !== 'ip-protection') return;

    switch (message.action) {
      case 'toggle':
        ipProtection.toggle().then(result => {
          ipProtection.updateUI();
          sendResponse(result);
        }).catch(e => sendResponse({ error: e.message }));
        return true;
      case 'enable':
      case 'disable':
        ipProtection.setEnabled(message.action === 'enable').then(result => {
          ipProtection.updateUI();
          sendResponse(result);
        }).catch(e => sendResponse({ error: e.message }));
        return true;
      case 'getStatus':
        sendResponse({
          enabled: ipProtection.isProtected(),
          liveCapable: !!(browser.rozelynxPrefs &&
            browser.rozelynxPrefs.setPrefs),
        });
        break;
      case 'getRecommendedPrefs':
        sendResponse({ prefs: ipProtection.getRecommendedPrefs() });
        break;
      case 'applyRecommended':
        ipProtection.applyRecommendedPrefs().then(sendResponse)
          .catch(e => sendResponse({ error: e.message }));
        return true;
      default:
        break;
    }
  });

  ipProtection.init();
  RozeLynxFeatures.loadedModules['ip-protection'] = true;
  console.log('[RozeLynx] IP Protection module loaded');
})();
