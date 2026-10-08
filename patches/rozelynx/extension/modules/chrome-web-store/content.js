// Chrome Web Store - Content Script
// Self-contained: adds "Install in RozeLynx" button, downloads CRX,
// strips the header, and saves a converted XPI locally via an <a download>.

(function() {
  'use strict';

  var BUTTON_ID = 'rozelynx-cws-btn';

  function isDetailPage() {
    var path = window.location.pathname;
    return path.indexOf('/detail/') !== -1;
  }

  function getExtensionId() {
    var path = window.location.pathname;
    var parts = path.split('/');
    return parts[parts.length - 1] || '';
  }

  function getExtensionName() {
    var h1 = document.querySelector('h1');
    if (h1) return h1.textContent.trim();
    var title = document.querySelector('title');
    if (title) {
      var t = title.textContent.replace(' - Chrome Web Store', '').trim();
      if (t) return t;
    }
    return 'Extension';
  }

  function getDownloadUrl(extId) {
    return 'https://clients2.google.com/service/update2/crx?' +
      'response=redirect&os=linux&arch=x64&os_arch=x86_64&nacl_arch=x86-64' +
      '&prod=chromiumcrx&prodchannel=unknown&prodversion=132.0.0.0' +
      '&acceptformat=crx2,crx3&x=id%3D' + extId + '%26installsource%3Dondemand%26uc';
  }

  // Parse CRX container header and return { version, headerSize }
  function parseCRXHeader(buffer) {
    var view = new DataView(buffer);
    var magic = view.getUint32(0, true);
    if (magic !== 0x34327243) {
      throw new Error('Invalid CRX: bad magic number');
    }
    var version = view.getUint32(4, true);
    var headerSize;

    if (version === 2) {
      var pkLen = view.getUint32(8, true);
      var sigLen = view.getUint32(12, true);
      headerSize = 16 + pkLen + sigLen;
    } else if (version === 3) {
      headerSize = 12 + view.getUint32(8, true);
    } else {
      throw new Error('Unsupported CRX version: ' + version);
    }

    return { version: version, headerSize: headerSize };
  }

  // Store the conversion task and open the converter extension page.
  // The converter page runs with the extension principal, so its fetch
  // bypasses CORS via the extension's host permissions.
  async function startConversion(extId, name) {
    var converterUrl = browser.runtime.getURL('modules/chrome-web-store/converter.html');

    try {
      await browser.storage.local.set({
        rozelynx_cws_task: {
          extId: extId,
          name: name,
          url: getDownloadUrl(extId),
          createdAt: Date.now(),
        }
      });
    } catch (e) {
      console.debug('[RozeLynx CWS] Could not store task:', e.message);
    }

    var win = window.open(converterUrl, '_blank');
    if (!win) {
      window.location.href = converterUrl;
    }
  }

  function createInstallButton() {
    if (document.getElementById(BUTTON_ID)) return;
    if (!isDetailPage()) return;

    var extId = getExtensionId();
    if (!extId || extId.length < 10) return;

    var name = getExtensionName();

    var btn = document.createElement('div');
    btn.id = BUTTON_ID;
    btn.style.cssText =
      'position:fixed;bottom:20px;right:20px;z-index:2147483646;' +
      'background:#8B5CF6;color:white;padding:12px 20px;' +
      'border-radius:8px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;' +
      'font-size:14px;font-weight:500;cursor:pointer;' +
      'box-shadow:0 4px 12px rgba(139,92,246,0.5);' +
      'transition:background 0.2s,opacity 0.2s;user-select:none;' +
      'display:flex;align-items:center;gap:8px;';
    var icon = document.createElement('img');
    icon.src = browser.runtime.getURL('icons/icon16.png');
    icon.style.cssText = 'width:16px;height:16px;flex:0 0 auto;';
    var label = document.createElement('span');
    label.textContent = 'Install in RozeLynx';
    btn.appendChild(icon);
    btn.appendChild(label);

    btn.addEventListener('mouseover', function() {
      btn.style.background = '#7C3AED';
    });
    btn.addEventListener('mouseout', function() {
      btn.style.background = '#8B5CF6';
    });

    btn.addEventListener('click', async function() {
      label.textContent = 'Opening converter...';
      btn.style.opacity = '0.7';
      btn.style.pointerEvents = 'none';
      btn.style.background = '#6D28D9';

      try {
        await startConversion(extId, name);
        label.textContent = 'Converter opened';
        btn.style.background = '#059669';
        btn.style.pointerEvents = 'auto';
        setTimeout(function() {
          label.textContent = 'Install in RozeLynx';
          btn.style.background = '#8B5CF6';
          btn.style.opacity = '1';
        }, 5000);
      } catch (e) {
        console.error('[RozeLynx CWS] Install failed:', e);
        label.textContent = 'Failed: ' + (e.message || 'unknown error');
        btn.style.background = '#DC2626';
        btn.style.pointerEvents = 'auto';
        setTimeout(function() {
          label.textContent = 'Install in RozeLynx';
          btn.style.background = '#8B5CF6';
          btn.style.opacity = '1';
        }, 4000);
      }
    });

    document.body.appendChild(btn);
  }

  function observe() {
    var lastPath = window.location.pathname;
    createInstallButton();

    new MutationObserver(function() {
      if (window.location.pathname !== lastPath) {
        lastPath = window.location.pathname;
        var existing = document.getElementById(BUTTON_ID);
        if (existing) existing.remove();
        createInstallButton();
      }
    }).observe(document.body || document.documentElement, { childList: true, subtree: true });

    window.addEventListener('popstate', function() {
      lastPath = window.location.pathname;
      var existing = document.getElementById(BUTTON_ID);
      if (existing) existing.remove();
      createInstallButton();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      setTimeout(observe, 1000);
    });
  } else {
    setTimeout(observe, 1000);
  }
})();
