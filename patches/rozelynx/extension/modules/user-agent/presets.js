/* RozeLynx: user agent preset combos.
 *
 * The dropdown combinations the User Agent Switcher browser extension ships:
 * the browser families (Chrome, Firefox, Safari, Edge, Opera) crossed with
 * the operating systems people actually spoof (Windows, macOS, Linux, iOS,
 * Android), plus the crawler and tool strings sites treat specially. Each
 * preset carries the RAW user agent string as its value, so a rule always
 * stores a full string and about:config shows exactly what will be sent -
 * the preset is only a convenience for picking one.
 *
 * Keep the strings whole: sites fingerprint on mismatches between the UA
 * and its platform tokens, so a preset must stay internally consistent
 * (Chrome UAs carry both "Chrome/x" and the platform they claim).
 *APP_VERSIONS*: the preset versions are pinned, not floating - a preset
 * that silently changed between rule edits would rewrite rules under the
 * user. Bump them deliberately when refreshing this file.
 */
(function() {
  'use strict';

  var PRESETS = [
    // ── Chrome ──────────────────────────────────────────────────────
    {
      group: 'Chrome',
      label: 'Chrome 138 \u00b7 Windows 10/11',
      ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    },
    {
      group: 'Chrome',
      label: 'Chrome 138 \u00b7 macOS',
      ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    },
    {
      group: 'Chrome',
      label: 'Chrome 138 \u00b7 Linux',
      ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    },
    {
      group: 'Chrome',
      label: 'Chrome 138 \u00b7 Android 15 (mobile)',
      ua: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36',
    },
    // ── Firefox ─────────────────────────────────────────────────────
    {
      group: 'Firefox',
      label: 'Firefox 139 \u00b7 Windows 10/11',
      ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:139.0) Gecko/20100101 Firefox/139.0',
    },
    {
      group: 'Firefox',
      label: 'Firefox 139 \u00b7 macOS',
      ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:139.0) Gecko/20100101 Firefox/139.0',
    },
    {
      group: 'Firefox',
      label: 'Firefox 139 \u00b7 Linux',
      ua: 'Mozilla/5.0 (X11; Linux x86_64; rv:139.0) Gecko/20100101 Firefox/139.0',
    },
    {
      group: 'Firefox',
      label: 'Firefox 139 \u00b7 Android 15 (mobile)',
      ua: 'Mozilla/5.0 (Android 15; Mobile; rv:139.0) Gecko/139.0 Firefox/139.0',
    },
    // ── Safari ──────────────────────────────────────────────────────
    {
      group: 'Safari',
      label: 'Safari 18.5 \u00b7 macOS Sequoia',
      ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
    },
    {
      group: 'Safari',
      label: 'Safari \u00b7 iPhone (iOS 18.5)',
      ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
    },
    {
      group: 'Safari',
      label: 'Safari \u00b7 iPad (iPadOS 18.5)',
      ua: 'Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
    },
    // ── Edge ────────────────────────────────────────────────────────
    {
      group: 'Edge',
      label: 'Edge 138 \u00b7 Windows 10/11',
      ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0',
    },
    {
      group: 'Edge',
      label: 'Edge 138 \u00b7 macOS',
      ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0',
    },
    // ── Opera ───────────────────────────────────────────────────────
    {
      group: 'Opera',
      label: 'Opera 119 \u00b7 Windows 10/11',
      ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 OPR/119.0.0.0',
    },
    {
      group: 'Opera',
      label: 'Opera 119 \u00b7 macOS',
      ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 OPR/119.0.0.0',
    },
    // ── legacy ──────────────────────────────────────────────────────
    {
      group: 'Legacy',
      label: 'Internet Explorer 11 \u00b7 Windows 8.1',
      ua: 'Mozilla/5.0 (Windows NT 6.3; Trident/7.0; rv:11.0) like Gecko',
    },
    // ── crawlers and tools ───────────────────────────────────────────
    {
      group: 'Crawlers & tools',
      label: 'Googlebot (desktop)',
      ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    },
    {
      group: 'Crawlers & tools',
      label: 'Googlebot Smartphone',
      ua: 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    },
    {
      group: 'Crawlers & tools',
      label: 'Bingbot',
      ua: 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    },
    {
      group: 'Crawlers & tools',
      label: 'curl 8.13',
      ua: 'curl/8.13.0',
    },
    {
      group: 'Crawlers & tools',
      label: 'Wget 1.25',
      ua: 'Wget/1.25.0 (linux-gnu)',
    },
  ];

  // Labels the global dropdown shows. "Default" and "Custom" are handled by
  // the UI itself; everything here is a full raw string.
  globalThis.RozeLynxUAPresets = {
    presets: PRESETS,
    groups: PRESETS.map(function(p) { return p.group; })
      .filter(function(g, i, all) { return all.indexOf(g) === i; }),
    // Map a raw string back to its preset label, so a stored value the
    // dropdown knows about shows the friendly name instead of "Custom".
    labelFor: function(ua) {
      for (var i = 0; i < PRESETS.length; i++) {
        if (PRESETS[i].ua === ua) return PRESETS[i].label;
      }
      return null;
    },
  };
})();
