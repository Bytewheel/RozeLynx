/* RozeLynx 2FA: content script.
 *
 * Two jobs, both best-effort and both silent unless they have something:
 *
 *   1. otpauth:// CAPTURE. Clicks on otpauth:// links are reported to the
 *      background (which saves the account and says so via notification).
 *      The link's own navigation goes nowhere either way - no browser has
 *      an otpauth handler - so the capture IS the handling.
 *
 *   2. CODE AUTOFILL. When a page has an input that looks like a 2FA code
 *      field (6-8 digits, or a name/id/label mentioning code/otp/2fa) and
 *      the vault holds an account for this host, a small "RozeLynx 2FA"
 *      chip appears beside the field; clicking it fills the current code
 *      and (for TOTP) restarts no timers - the code simply is what it is.
 *
 * The script never sees the secrets: it asks the background for CODES for
 * this host, and only when the vault is unlocked.
 */
(function() {
  'use strict';

  if (typeof browser === 'undefined' || !browser.runtime ||
      !browser.runtime.sendMessage) {
    return;
  }

  var host = '';
  try {
    host = location.hostname;
  } catch (e) {}
  if (!host) {
    return;
  }

  // ── otpauth capture ─────────────────────────────────────────────────

  document.addEventListener('click', function(e) {
    var a = e.target && e.target.closest
      ? e.target.closest('a[href^="otpauth://"]')
      : null;
    if (!a) {
      return;
    }
    e.preventDefault();
    browser.runtime.sendMessage({
      action: '2fa:capture',
      uri: a.href,
    }).catch(function() {});
  }, true);

  // ── code-field detection + fill chip ────────────────────────────────

  var CODE_RE = /^[0-9]{6,8}$/;

  function looksLikeCodeField(input) {
    if (!input || input.type === 'hidden' || input.disabled ||
        input.readOnly) {
      return false;
    }
    var t = input.type || '';
    if (t !== 'text' && t !== 'number' && t !== 'tel' && t !== '' &&
        t !== 'one-time-code' && t !== 'otp') {
      return false;
    }
    var maxlength = parseInt(input.getAttribute('maxlength'), 10);
    if (maxlength >= 6 && maxlength <= 8) {
      return true;
    }
    if (t === 'otp' || t === 'one-time-code') {
      return true;
    }
    var hints = ((input.name || '') + ' ' + (input.id || '') + ' ' +
      (input.getAttribute('autocomplete') || '') + ' ' +
      (input.placeholder || '')).toLowerCase();
    return /(otp|2fa|twofactor|two-factor|one.?time|verification.?code|auth(?:enticator)?.?code|passcode)/
      .test(hints);
  }

  var chipForInput = new WeakMap();

  function fillCode(input, accountId) {
    browser.runtime.sendMessage({
      action: '2fa:account-code',
      id: accountId,
    }).then(function(res) {
      if (!res || res.ok !== true || !res.code) {
        return;
      }
      var value = res.code.code;
      input.focus();
      // A "setter through the prototype" is the only way the page's own
      // frameworks (React, Vue, ...) register the change.
      var setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      browser.runtime.sendMessage({
        action: '2fa:accept-code',
        id: accountId,
        host: host,
      }).catch(function() {});
    }).catch(function() {});
  }

  function chipFor(input, accountId) {
    var existing = chipForInput.get(input);
    if (existing) {
      return existing;
    }
    var chip = document.createElement('button');
    chip.type = 'button';
    chip.textContent = 'RozeLynx 2FA';
    chip.title = 'Fill the current 2FA code';
    Object.assign(chip.style, {
      position: 'absolute',
      margin: '0',
      padding: '2px 8px',
      fontSize: '11px',
      lineHeight: '16px',
      borderRadius: '99px',
      border: '1px solid #8B5CF6',
      background: '#8B5CF6',
      color: '#fff',
      cursor: 'pointer',
      zIndex: '2147483647',
      fontFamily: 'sans-serif',
    });
    chip.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      fillCode(input, accountId);
    });
    chipForInput.set(input, chip);
    return chip;
  }

  var placed = new WeakSet();

  function placeChip(input, accountId) {
    if (placed.has(input)) {
      return;
    }
    var rect = input.getBoundingClientRect();
    if (!rect.width || rect.height < 12) {
      return;  // a hidden or collapsed field is not worth a chip
    }
    var chip = chipFor(input, accountId);
    // The chip rides the field's own offset inside its offset parent, so
    // it tracks the page's layout without any observer; 2FA fields are
    // static in practice and the popup holds the rest.
    var parent = input.offsetParent || document.body;
    parent.appendChild(chip);
    chip.style.left = (input.offsetLeft + input.offsetWidth -
      chip.offsetWidth - 4) + 'px';
    chip.style.top = (input.offsetTop +
      Math.max(0, (input.offsetHeight - 16) / 2)) + 'px';
    placed.add(input);
  }

  function scan() {
    if (document.readyState !== 'complete' &&
        document.readyState !== 'interactive') {
      return;
    }
    browser.runtime.sendMessage({
      action: '2fa:codes',
      host: host,
    }).then(function(res) {
      if (!res || res.ok !== true || !res.codes || !res.codes.length) {
        return;  // locked, or nothing for this host: stay invisible
      }
      var accountId = res.codes[0].id;
      var inputs = document.querySelectorAll('input');
      for (var i = 0; i < inputs.length; i++) {
        if (looksLikeCodeField(inputs[i])) {
          placeChip(inputs[i], accountId);
          return;  // one chip per page is enough; the popup has the rest
        }
      }
    }).catch(function() {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      setTimeout(scan, 300);
    });
  } else {
    setTimeout(scan, 300);
  }
  // Late-loaded forms (SPAs render after everything) get one more chance a
  // couple of seconds in; a MutationObserver would chase every framework's
  // DOM churn for a feature that needs to appear once.
  setTimeout(scan, 2500);
})();
