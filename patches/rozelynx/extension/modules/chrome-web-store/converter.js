// RozeLynx Extension Converter - Extension Page
// Thin UI wrapper: downloads the CRX, runs the shared conversion core
// (lib/convert.js), saves the XPI and records the conversion in the
// installed-extensions registry (rozelynx_cws_installed) so the background
// update checker can find updates.

(function() {
  'use strict';

  var TASK_KEY = 'rozelynx_cws_task';
  var REGISTRY_KEY = 'rozelynx_cws_installed';
  var statusEl = document.getElementById('status');
  var errorEl = document.getElementById('error');
  var spinner = document.getElementById('spinner');
  var closeBtn = document.getElementById('close-btn');

  function setStatus(msg) {
    statusEl.textContent = msg;
  }

  function setError(msg) {
    errorEl.style.display = 'block';
    errorEl.textContent = msg;
    spinner.style.display = 'none';
    closeBtn.style.display = 'inline';
  }

  async function recordInstalled(task, converted) {
    // Registry entry so the background alarm can check for updates.
    try {
      var stored = await browser.storage.local.get(REGISTRY_KEY);
      var reg = [];
      try {
        reg = stored[REGISTRY_KEY] ? JSON.parse(stored[REGISTRY_KEY]) : [];
      } catch (e) { reg = []; }
      if (!Array.isArray(reg)) reg = [];

      var entry = {
        extId: task.extId || '',
        name: task.name || task.extId || 'extension',
        version: converted.version || null,
        sha256: converted.sha256 || null,
        installedAt: Date.now(),
      };
      var existing = reg.findIndex(function(r) { return r.extId === entry.extId; });
      if (existing >= 0) {
        reg[existing] = Object.assign({}, reg[existing], entry);
      } else {
        reg.push(entry);
      }
      var out = {};
      out[REGISTRY_KEY] = JSON.stringify(reg);
      await browser.storage.local.set(out);
    } catch (e) {
      console.warn('[RozeLynx CWS] Failed to update registry:', e);
    }
  }

  async function convert() {
    try {
      var stored = await browser.storage.local.get(TASK_KEY);
      var task = stored[TASK_KEY];
      if (!task || !task.url) {
        setError('No pending extension to convert. Click "Install in RozeLynx" on the Chrome Web Store first.');
        return;
      }

      if (typeof RozeLynxCWSConvert === 'undefined') {
        throw new Error('Conversion core (lib/convert.js) not loaded');
      }

      var name = task.name || task.extId || 'extension';
      setStatus('Fetching ' + name + ' ...');

      // Follow redirects automatically: clients2.google.com 302s to
      // clients2.googleusercontent.com (covered by *://*/* host perms).
      var response = await fetch(task.url);
      if (!response.ok) {
        throw new Error('Download failed: HTTP ' + response.status);
      }

      setStatus('Converting CRX to XPI ...');

      var crxBuffer = await response.arrayBuffer();
      if (crxBuffer.byteLength < 16) {
        throw new Error('Response too small: ' + crxBuffer.byteLength + ' bytes (URL: ' + response.url + ')');
      }

      var converted = await RozeLynxCWSConvert.convertCrxToXpi(crxBuffer, task);
      var attest = converted.attest;
      var xpiArray = converted.xpiArray;
      var manifest = converted.manifest;

      var xpiBlob = new Blob([xpiArray], { type: 'application/x-xpinstall' });

      var safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
      var filename = 'rozelynx-cws/' + safeName + '.xpi';

      // Record attested conversions for a future build-side warning bypass.
      var sha256 = null;
      if (attest.ok) {
        try {
          sha256 = await RozeLynxCWSConvert.sha256Hex(xpiArray);
          await browser.runtime.sendNativeMessage('rozelynx_host', {
            action: 'verify-record',
            sha256: sha256,
            id: attest.id || (task.extId || ''),
            name: name,
          });
        } catch (e) {
          console.warn('[RozeLynx CWS] verify-record failed:', e);
        }
      }

      // Registry entry (feeds the update checker) - only when attested,
      // so unattested conversions never enter the auto-update path.
      if (attest.ok) {
        await recordInstalled(task, {
          version: converted.version,
          sha256: sha256,
        });
      }

      setStatus('Saving ' + filename + ' ...' +
        (attest.ok
          ? ' [Google signature verified: ' + attest.detail + ']'
          : ' [CRX3 attestation: ' + (attest.detail || 'none') +
            ' - proceeding unverified]'));

      await browser.downloads.download({
        url: URL.createObjectURL(xpiBlob),
        filename: filename,
        conflictAction: 'uniquify',
      });

      setStatus('Saved! Install it via about:addons -> Install Add-on From File.');
      spinner.style.display = 'none';
      closeBtn.style.display = 'inline';

      await browser.storage.local.remove(TASK_KEY);
    } catch (e) {
      console.error('[RozeLynx CWS] Conversion failed:', e);
      setError('Conversion failed: ' + (e.message || e));
    }
  }

  convert();
})();
