/* RozeLynx: user agent switcher - page-JavaScript half.
 *
 * Rewriting the User-Agent header is only half the spoof: page scripts read
 * navigator.userAgent (and navigator.platform, oscpu, appVersion, vendor)
 * directly, and those still tell the truth unless someone overrides them.
 * This script runs at document_start in every frame, asks the background's
 * resolver for the document's override and - only when there is one -
 * redefines the affected properties into the page.
 *
 * Firefox-specific mechanics, used deliberately: a content script sees the
 * page through Xray wrappers, so writing `navigator.userAgent = x` would
 * only change the CONTENT SCRIPT's copy. The override has to go through
 * `navigator.wrappedJSObject` with `exportFunction`d getters, which is the
 * sanctioned way to replace a page-visible property from a content script,
 * and the reason this is Firefox-only code in a Firefox-only extension.
 *
 * The resolved UA is applied once per document. A SPA that navigates by
 * pushState keeps its override (the document did not change); a real
 * navigation re-runs this script with the new URL.
 */
(function() {
  'use strict';

  if (typeof browser === 'undefined' || !browser.runtime ||
      !browser.runtime.sendMessage) {
    return;
  }

  // Platform tokens derived from the spoof string, so navigator.platform
  // and the UA cannot contradict each other (a Windows UA with
  // platform "Linux x86_64" is a louder fingerprint than no spoof at all).
  function platformFor(ua) {
    if (/Windows NT/.test(ua)) return 'Win32';
    if (/Macintosh|iPhone|iPad/.test(ua)) {
      return /iPhone|iPad/.test(ua) ? 'iPhone' : 'MacIntel';
    }
    if (/Android/.test(ua)) return 'Linux armv8l';
    return 'Linux x86_64';
  }

  function vendorFor(ua) {
    if (/Edg\//.test(ua)) return 'Microsoft';
    if (/Chrome|Chromium|CriOS/.test(ua)) return 'Google Inc.';
    if (/Safari/.test(ua)) return 'Apple Computer, Inc.';
    return '';
  }

  function applyOverride(ua) {
    var overridden = {
      userAgent: ua,
      appVersion: ua.replace(/^Mozilla\//, ''),
      vendor: vendorFor(ua),
      platform: platformFor(ua),
    };
    // oscpu exists only in Firefox-built browsers; spoofing a non-Firefox
    // UA must remove it, and spoofing a Firefox UA must keep it consistent.
    // oscpu is the parenthesised platform slice of a Firefox UA ("Windows NT
    // 10.0; Win64; x64", "Linux x86_64", "Intel Mac OS X 10.15").
    var open = ua.indexOf('(');
    var close = ua.indexOf(')');
    if (/Firefox/.test(ua) && open >= 0 && close > open) {
      try {
        overridden.oscpu = ua.slice(open + 1, close);
      } catch (e) {}
    }

    var target = navigator.wrappedJSObject || navigator;
    Object.keys(overridden).forEach(function(prop) {
      var value = overridden[prop];
      try {
        if (value === undefined) {
          // A Chrome UA must not answer navigator.oscpu at all.
          Object.defineProperty(target, prop, {
            get: exportFunction(function() { return undefined; }, window),
            configurable: true,
          });
        } else {
          Object.defineProperty(target, prop, {
            get: exportFunction(function() { return value; }, window),
            configurable: true,
          });
        }
      } catch (e) {}
    });

    // navigator.userAgentData is a Chromium-only API. Defining it away makes
    // a spoofed Chrome UA answer like a Chrome that exposes no client hints,
    // which is rarer but at least self-consistent; leaving the truth would
    // be worse (it does not exist in Firefox anyway).
    try {
      if (!('userAgentData' in target)) {
        Object.defineProperty(target, 'userAgentData', {
          get: exportFunction(function() { return undefined; }, window),
          configurable: true,
        });
      }
    } catch (e) {}
  }

  var locationHref = location.href;

  Promise.resolve(
    browser.runtime.sendMessage({
      action: 'user-agent:resolve',
      url: locationHref,
    })
  ).then(function(resp) {
    if (resp && resp.ok && resp.ua) {
      applyOverride(resp.ua);
    }
  }).catch(function() {
    // No user-agent module in this build (the content script is only
    // registered when the module is assembled, but a stale install can
    // still carry one): nothing to do, the page keeps the real UA.
  });
})();
