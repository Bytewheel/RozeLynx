// QR Code Generator Module for RozeLynx
// Ported from Floorp's qr-code-generator
// Generates QR codes for current URL, adds toolbar button

(function() {
  'use strict';

  try {
    var libScript = document.createElement('script');
    libScript.src = browser.runtime.getURL('modules/qr-code/lib/qrcode.js');
    document.head.appendChild(libScript);
  } catch (e) {}

  class QRCodeGenerator {
    constructor() {
      this._init();
    }

    _init() {
      this.initializeQRCode();
    }

    initializeQRCode() {
      this._qrcode = null;
    }

    generateQRCode(data, options = {}) {
      const canvas = document.createElement('canvas');
      const size = options.size || 256;
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');

      if (typeof qrcode === 'undefined') {
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, size, size);
        ctx.fillStyle = '#DC2626';
        ctx.font = '12px sans-serif';
        ctx.fillText('QR library unavailable', 10, size / 2);
        return canvas;
      }

      try {
        qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
      } catch (e) {}

      let qr;
      try {
        qr = qrcode(0, 'H');
        qr.addData(data);
        qr.make();
      } catch (e) {
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, size, size);
        ctx.fillStyle = '#DC2626';
        ctx.font = '12px sans-serif';
        ctx.fillText('QR encoding failed', 10, size / 2);
        return canvas;
      }

      const count = qr.getModuleCount();
      const quiet = 4;
      const scale = Math.max(1, Math.floor(size / (count + quiet * 2)));
      const offset = Math.floor((size - count * scale) / 2);

      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, size, size);

      ctx.fillStyle = '#000000';
      for (let row = 0; row < count; row++) {
        for (let col = 0; col < count; col++) {
          if (qr.isDark(row, col)) {
            ctx.fillRect(offset + col * scale, offset + row * scale, scale, scale);
          }
        }
      }

      // Small centered brand mark; EC level H leaves ample correction capacity.
      const center = size / 2;
      const r = Math.floor(scale * 1.6);
      ctx.fillStyle = '#8B5CF6';
      ctx.beginPath();
      ctx.arc(center, center, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.arc(center, center, r * 0.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1A1A2E';
      ctx.beginPath();
      ctx.arc(center, center, r * 0.25, 0, Math.PI * 2);
      ctx.fill();

      return canvas;
    }

    toDataURL(canvas) {
      return canvas.toDataURL('image/png');
    }
  }

  const generator = new QRCodeGenerator();

  // Create panel HTML for QR code popup
  function createQRPanel(url) {
    const canvas = generator.generateQRCode(url, { size: 256, moduleSize: 8 });
    const dataURL = generator.toDataURL(canvas);

    const panel = `
      <div style="
        padding: 16px;
        text-align: center;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        background: #fff;
        border-radius: 8px;
        min-width: 280px;
      ">
        <h3 style="margin: 0 0 12px 0; color: #333; font-size: 14px;">
          QR Code - Share this page
        </h3>
        <img src="${dataURL}" alt="QR Code" style="
          width: 200px;
          height: 200px;
          border: 1px solid #e5e7eb;
          border-radius: 8px;
          padding: 8px;
          background: white;
        "/>
        <div style="
          margin-top: 12px;
          padding: 8px 12px;
          background: #f3f4f6;
          border-radius: 6px;
          font-size: 11px;
          color: #6b7280;
          word-break: break-all;
          max-width: 260px;
          line-height: 1.4;
        ">${url.substring(0, 60)}${url.length > 60 ? '...' : ''}</div>
        <div style="
          margin-top: 8px;
          display: flex;
          gap: 8px;
          justify-content: center;
        ">
          <button id="rozelynx-qr-copy" style="
            padding: 6px 12px;
            background: #8B5CF6;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
          ">Copy URL</button>
          <button id="rozelynx-qr-download" style="
            padding: 6px 12px;
            background: #6B7280;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
          ">Download QR</button>
        </div>
      </div>
    `;

    return { panel, dataURL };
  }

  // Listen for toolbar button click
  browser.browserAction?.onClicked?.addListener(async (tab) => {
    const url = tab.url || 'about:blank';
    const { panel, dataURL } = createQRPanel(url);

    // Create and show popup
    const popupUrl = `data:text/html,${encodeURIComponent(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { font-family: sans-serif; }
        </style>
      </head>
      <body>${panel}
        <script>
          document.getElementById('rozelynx-qr-copy').onclick = function() {
            navigator.clipboard.writeText('${url.replace(/'/g, "\\'")}');
            this.textContent = 'Copied!';
          };
          document.getElementById('rozelynx-qr-download').onclick = function() {
            const a = document.createElement('a');
            a.href = '${dataURL}';
            a.download = 'rozelynx-qr-code.png';
            a.click();
          };
        </script>
      </body>
      </html>
    `)}`;

    browser.windows.create({
      url: popupUrl,
      type: 'popup',
      width: 320,
      height: 430,
      titlePreface: 'QR Code - ',
    });
  });

  // Listen for messages
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.module !== 'qr-code') return;

    switch (message.action) {
      case 'generate':
        const canvas = generator.generateQRCode(message.data.url, message.data.options);
        sendResponse({ dataURL: generator.toDataURL(canvas) });
        break;
      case 'generateForTab':
        browser.tabs.query({ active: true, currentWindow: true }).then(tabs => {
          if (tabs[0]) {
            const c = generator.generateQRCode(tabs[0].url);
            sendResponse({ dataURL: generator.toDataURL(c) });
          }
        });
        return true;
      default:
        break;
    }
  });

  RozeLynxFeatures.loadedModules['qr-code'] = true;
  console.log('[RozeLynx] QR Code module loaded');
})();
