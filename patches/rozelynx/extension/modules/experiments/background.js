// Experiments System Module for RozeLynx
// Ported from Floorp's experiments module
// A/B testing and feature flag system with deterministic assignment

(function() {
  'use strict';

  const DEFAULT_EXPERIMENTS_URL = '';
  const PREF_NAMESPACE = 'rozelynx.experiments.';
  const STORAGE_KEY = 'rozelynx_experiments';

  class ExperimentsSystem {
    constructor() {
      this.experiments = new Map();
      this.userHash = null;
      this.configUrl = DEFAULT_EXPERIMENTS_URL;
      this.initialized = false;
    }

    async init() {
      if (this.initialized) return;

      try {
        await this.generateUserHash();
        await this.loadConfig();
        await this.evaluateExperiments();
        this.setupPrefListeners();
        this.initialized = true;
        console.log('[RozeLynx] Experiments system initialized');
      } catch (e) {
        console.error('[RozeLynx] Experiments init failed:', e);
      }
    }

    async generateUserHash() {
      // FNV-1a hash for deterministic assignment
      const storedHash = await browser.storage.local.get(STORAGE_KEY);
      if (storedHash[STORAGE_KEY]) {
        this.userHash = storedHash[STORAGE_KEY];
        return;
      }

      const entropy = [
        navigator.userAgent,
        navigator.language,
        screen.colorDepth,
        screen.width,
        screen.height,
        new Date().getTimezoneOffset(),
        Intl.DateTimeFormat().resolvedOptions().timeZone,
      ].join('|');

      this.userHash = this.fnv1aHash(entropy).toString(16);
      await browser.storage.local.set({ [STORAGE_KEY]: this.userHash });
    }

    fnv1aHash(str) {
      let hash = 2166136261;
      for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
        hash = hash >>> 0;
      }
      return hash;
    }

    getBucket(key, experimentName) {
      const combined = `${experimentName}:${key}`;
      const hash = this.fnv1aHash(combined);
      return (hash % 10000) / 10000; // 0.0 - 1.0
    }

    isInExperiment(experimentName, percentage = 50) {
      if (!this.userHash) return false;
      const bucket = this.getBucket(this.userHash, experimentName);
      return bucket < (percentage / 100);
    }

    async loadConfig() {
      // First try stored config
      const stored = await browser.storage.local.get('rozelynx_experiments_config');
      if (stored.rozelynx_experiments_config) {
        try {
          this.parseConfig(stored.rozelynx_experiments_config);
        } catch (e) {
          console.warn('[RozeLynx] Invalid stored config, using defaults');
        }
      }

      // Attempt to fetch remote config
      if (this.configUrl) {
        try {
          const response = await fetch(this.configUrl, {
            cache: 'no-store',
            headers: { 'Accept': 'application/json' },
          });
          if (response.ok) {
            const config = await response.text();
            await browser.storage.local.set({ 
              rozelynx_experiments_config: config 
            });
            this.parseConfig(config);
          }
        } catch (e) {
          console.debug('[RozeLynx] Could not fetch remote config:', e.message);
        }
      }
    }

    parseConfig(jsonConfig) {
      try {
        const config = JSON.parse(jsonConfig);
        this.experiments.clear();

        for (const [name, experiment] of Object.entries(config.experiments || {})) {
          this.experiments.set(name, {
            name,
            description: experiment.description || '',
            percentage: experiment.percentage || 50,
            variants: experiment.variants || ['control', 'treatment'],
            enabled: experiment.enabled !== false,
          });
        }
      } catch (e) {
        console.warn('[RozeLynx] Failed to parse config:', e);
      }
    }

    async evaluateExperiments() {
      for (const [name, experiment] of this.experiments) {
        if (!experiment.enabled) continue;

        const inExperiment = this.isInExperiment(name, experiment.percentage);
        const variantIndex = Math.floor(
          this.getBucket(this.userHash, `${name}:variant`) * experiment.variants.length
        );
        const variant = experiment.variants[variantIndex];

        // Set preference
        try {
          await browser.storage.local.set({
            [`experiment_${name}`]: {
              active: inExperiment,
              variant,
              assignedAt: Date.now(),
            }
          });
        } catch (e) {
          console.debug(`[RozeLynx] Could not set experiment ${name}:`, e);
        }
      }
    }

    setupPrefListeners() {
      browser.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local') return;
        if (changes.rozelynx_experiments_config) {
          this.parseConfig(changes.rozelynx_experiments_config.newValue);
          this.evaluateExperiments();
        }
      });
    }

    getExperimentStatus(name) {
      return this.experiments.get(name) || null;
    }

    getAllExperiments() {
      return Array.from(this.experiments.values());
    }

    async isFeatureEnabled(featureName) {
      const stored = await browser.storage.local.get(`experiment_${featureName}`);
      const data = stored[`experiment_${featureName}`];
      return data?.active || false;
    }

    async getFeatureVariant(featureName) {
      const stored = await browser.storage.local.get(`experiment_${featureName}`);
      const data = stored[`experiment_${featureName}`];
      return data?.variant || 'control';
    }

    async optOut() {
      await browser.storage.local.remove('rozelynx_experiments_config');
      await browser.storage.local.remove(STORAGE_KEY);
      this.experiments.clear();
      this.userHash = null;
    }
  }

  const experiments = new ExperimentsSystem();

  // Listen for messages
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.module !== 'experiments') return;

    switch (message.action) {
      case 'isEnabled':
        experiments.isFeatureEnabled(message.data.feature).then(sendResponse);
        return true;
      case 'getVariant':
        experiments.getFeatureVariant(message.data.feature).then(sendResponse);
        return true;
      case 'getAll':
        sendResponse(experiments.getAllExperiments());
        break;
      case 'getStatus':
        sendResponse(experiments.getExperimentStatus(message.data.feature));
        break;
      case 'optOut':
        experiments.optOut().then(() => sendResponse({ success: true }));
        return true;
      default:
        break;
    }
  });

  experiments.init();
  RozeLynxFeatures.loadedModules['experiments'] = true;
  console.log('[RozeLynx] Experiments module loaded');
})();
