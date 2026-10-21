/* RozeLynx 2FA: background.
 *
 * Owns the vault (see lib/vault.js) and the code generation
 * (lib/totp.js), and answers every UI surface: the popup (codes, add,
 * lock), the options page (manage, passphrase, export/import), and the
 * content script (otpauth:// capture offers, code autofill for the page's
 * domain).
 *
 * The unlocked key lives ONLY here, in memory, and dies on suspend, on
 * the idle alarm, on the Lock button - and every one of those paths is a
 * feature, not a bug: these are second-factor secrets.
 *
 * Account shape:
 *   { id, type:'totp'|'hotp', issuer, account, secret, digits, period,
 *     counter, algorithm, domains:[hostname...], created }
 * `domains` is the page-host capture history: pages whose host ever saved
 * or filled the account. It is what lets the content script offer the
 * right codes without asking the vault for the whole list.
 */
(function() {
  'use strict';

  var LOG_PREFIX = '[RozeLynx:2fa]';
  var IDLE_LOCK_MINUTES = 10;
  var IDLE_ALARM = 'rozelynx2fa-idle-lock';

  function log(msg) {
    try { console.log(LOG_PREFIX, msg); } catch (e) {}
  }

  var vault = globalThis.RozeLynxVault;
  var oath = globalThis.RozeLynxOath;

  function newId() {
    return 'a' + Date.now().toString(36) +
      Math.random().toString(36).slice(2, 8);
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname;
    } catch (e) {
      return '';
    }
  }

  function accountsForHost(host) {
    var all = vault.accounts() || [];
    if (!host) {
      return all.slice(0, 5);  // the popup shows the top of the list
    }
    var forHost = all.filter(function(a) {
      return (a.domains || []).indexOf(host) >= 0;
    });
    return forHost;
  }

  function rememberDomain(accountId, host) {
    if (!host) return Promise.resolve();
    var all = vault.accounts() || [];
    var changed = false;
    all.forEach(function(a) {
      if (a.id === accountId && (a.domains || []).indexOf(host) < 0) {
        a.domains = (a.domains || []).concat([host]);
        changed = true;
      }
    });
    if (!changed) return Promise.resolve();
    return vault.save(all);
  }

  function codesFor(accounts) {
    var jobs = (accounts || []).map(function(a) {
      return oath.generateCode(a).then(function(r) {
        return {
          id: a.id,
          issuer: a.issuer || '',
          account: a.account || '',
          type: a.type,
          code: r.code,
          digits: r.digits,
          period: r.period,
          remaining: r.remaining,
        };
      }).catch(function(e) {
        return {
          id: a.id,
          issuer: a.issuer || '',
          account: a.account || '',
          type: a.type,
          error: (e && e.message) || 'generation failed',
        };
      });
    });
    return Promise.all(jobs);
  }

  /**
   * HOTP advances the counter on USE, not on generate - generating without
   * accepting would desynchronise the account against the server, so the
   * advance is an explicit 'consume' on the accept action (the popup's
   * copy / the content script's fill).
   */
  function consumeHotp(accountId) {
    var all = vault.accounts() || [];
    var found = null;
    all.forEach(function(a) {
      if (a.id === accountId) {
        if (String(a.type) === 'hotp') {
          a.counter = (parseInt(a.counter, 10) || 0) + 1;
          found = a;
        }
      }
    });
    if (!found) return Promise.resolve({ ok: true, advanced: false });
    return vault.save(all).then(function() {
      return { ok: true, advanced: true };
    });
  }

  function addAccount(spec, fromHost) {
    if (!vault.isUnlocked()) {
      return Promise.resolve({ ok: false, error: 'the vault is locked' });
    }
    var secret = oath.verifySecret(spec.secret || '');
    if (!secret) {
      return Promise.resolve({
        ok: false, error: 'the secret is not valid base32' });
    }
    var account = {
      id: newId(),
      type: spec.type === 'hotp' ? 'hotp' : 'totp',
      issuer: String(spec.issuer || '').slice(0, 128),
      account: String(spec.account || '').slice(0, 128),
      secret: secret,
      digits: Math.min(Math.max(parseInt(spec.digits, 10) || 6, 6), 8),
      period: Math.max(parseInt(spec.period, 10) || 30, 1),
      counter: parseInt(spec.counter, 10) || 0,
      algorithm: String(spec.algorithm || 'SHA1').toUpperCase(),
      domains: fromHost ? [fromHost] : [],
      created: Date.now(),
    };
    var all = vault.accounts() || [];
    all.push(account);
    return vault.save(all).then(function() {
      log('added account ' + account.id + ' (' + account.type + ')');
      return { ok: true, id: account.id };
    });
  }

  function removeAccount(id) {
    if (!vault.isUnlocked()) {
      return Promise.resolve({ ok: false, error: 'the vault is locked' });
    }
    var all = vault.accounts() || [];
    var next = all.filter(function(a) { return a.id !== id; });
    if (next.length === all.length) {
      return Promise.resolve({ ok: false, error: 'no such account' });
    }
    return vault.save(next).then(function() {
      return { ok: true };
    });
  }

  function updateAccount(id, patch) {
    if (!vault.isUnlocked()) {
      return Promise.resolve({ ok: false, error: 'the vault is locked' });
    }
    var all = vault.accounts() || [];
    var target = null;
    all.forEach(function(a) {
      if (a.id === id) target = a;
    });
    if (!target) {
      return Promise.resolve({ ok: false, error: 'no such account' });
    }
    var editable = ['issuer', 'account', 'digits', 'period', 'algorithm'];
    editable.forEach(function(field) {
      if (patch && patch[field] !== undefined) {
        target[field] = patch[field];
      }
    });
    if (patch && patch.secret !== undefined) {
      var secret = oath.verifySecret(patch.secret);
      if (!secret) {
        return Promise.resolve({
          ok: false, error: 'the secret is not valid base32' });
      }
      target.secret = secret;
    }
    return vault.save(all).then(function() {
      return { ok: true };
    });
  }

  // ── otpauth capture ─────────────────────────────────────────────────
  // The content script reports an otpauth:// URI it found on the page (a
  // setup link, a QR the user cannot scan from this machine). The vault
  // must be unlocked to add it; if it is locked, the notification says so
  // and the popup's unlock is the path in.

  function notify(title, message, onClickedId) {
    try {
      browser.notifications.create({
        type: 'basic',
        iconUrl: browser.runtime.getURL('icons/icon128.png'),
        title: title,
        message: message,
      }).then(function(id) {
        if (onClickedId) {
          var onClicked = function(notificationId) {
            if (notificationId === id) {
              browser.runtime.sendMessage({
                action: '2fa:open-popup', data: { reason: 'capture' }
              }).catch(function() {});
            }
            browser.notifications.onClicked.removeListener(onClicked);
          };
          browser.notifications.onClicked.addListener(onClicked);
        }
      }).catch(function() {});
    } catch (e) {}
  }

  function offerCapture(uri, sender) {
    var host = hostOf((sender && sender.url) || '');
    var spec;
    try {
      spec = oath.parseOtpauth(uri);
    } catch (e) {
      return Promise.resolve({ ok: false, error: (e && e.message) || String(e) });
    }
    if (!vault.isUnlocked()) {
      notify('RozeLynx 2FA: vault locked',
        'An otpauth setup link for "' + (spec.issuer || spec.account) +
        '" was found, but the vault is locked. Unlock it from the toolbar button to save it.',
        true);
      return Promise.resolve({ ok: false, error: 'the vault is locked',
                               locked: true });
    }
    // Save straight away - the notification confirms what happened, the
    // options page is where a mistake is undone. A confirmation dialog
    // from a content-script report is a second click that protects
    // nothing the vault's own owner can undo.
    return addAccount(spec, host).then(function(res) {
      if (res.ok) {
        notify('RozeLynx 2FA: account saved',
          (spec.issuer ? spec.issuer + ' \u2014 ' : '') +
          (spec.account || 'account') + ' is now in your 2FA vault.');
      }
      return res;
    });
  }

  // ── messages ─────────────────────────────────────────────────────────

  browser.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    var action = message && message.action;
    switch (action) {
      case '2fa:state':
        vault.exists().then(function(have) {
          sendResponse({
            ok: true,
            exists: have,
            unlocked: vault.isUnlocked(),
            count: vault.isUnlocked()
              ? (vault.accounts() || []).length : 0,
          });
        });
        return true;
      case '2fa:create':
        vault.create(message.passphrase, []).then(function(res) {
          sendResponse(res);
        }, function(e) {
          sendResponse({ ok: false, error: (e && e.message) || String(e) });
        });
        return true;
      case '2fa:unlock':
        vault.unlock(message.passphrase).then(function(res) {
          sendResponse(res);
        }, function(e) {
          sendResponse({ ok: false, error: (e && e.message) || String(e) });
        });
        return true;
      case '2fa:lock':
        vault.lock().then(function() {
          sendResponse({ ok: true });
        });
        return true;
      case '2fa:codes':
        if (!vault.isUnlocked()) {
          sendResponse({ ok: false, error: 'the vault is locked' });
          return true;
        }
        if (message.host) {
          codesFor(accountsForHost(message.host)).then(function(codes) {
            sendResponse({ ok: true, codes: codes });
          });
        } else {
          codesFor(vault.accounts() || []).then(function(codes) {
            sendResponse({ ok: true, codes: codes });
          });
        }
        return true;
      case '2fa:codes-for-tab':
        browser.tabs.query({ active: true, currentWindow: true })
          .then(function(tabs) {
            var host = hostOf((tabs && tabs[0] && tabs[0].url) || '');
            return codesFor(accountsForHost(host));
          })
          .then(function(codes) {
            sendResponse({ ok: true, codes: codes });
          })
          .catch(function(e) {
            sendResponse({ ok: false,
              error: (e && e.message) || String(e) });
          });
        return true;
      case '2fa:account-code':
        if (!vault.isUnlocked()) {
          sendResponse({ ok: false, error: 'the vault is locked' });
          return true;
        }
        var all = vault.accounts() || [];
        var target = null;
        all.forEach(function(a) {
          if (a.id === message.id) target = a;
        });
        if (!target) {
          sendResponse({ ok: false, error: 'no such account' });
          return true;
        }
        oath.generateCode(target).then(function(r) {
          sendResponse({ ok: true, code: r });
        }, function(e) {
          sendResponse({ ok: false,
            error: (e && e.message) || String(e) });
        });
        return true;
      case '2fa:accept-code':
        // The user acted on a code (copied it, filled it): HOTP counters
        // advance here, and the host is remembered so the account shows up
        // for this site next time.
        if (!vault.isUnlocked()) {
          sendResponse({ ok: false, error: 'the vault is locked' });
          return true;
        }
        rememberDomain(message.id, message.host || '').then(function() {
          return consumeHotp(message.id);
        }).then(function(res) {
          sendResponse(res);
        });
        return true;
      case '2fa:add':
        addAccount(message.spec || {}, message.host || '').then(sendResponse);
        return true;
      case '2fa:parse-otpauth':
        try {
          var spec = oath.parseOtpauth(message.uri || '');
          sendResponse({ ok: true, spec: spec });
        } catch (e) {
          sendResponse({ ok: false,
            error: (e && e.message) || String(e) });
        }
        return false;
      case '2fa:remove':
        removeAccount(message.id).then(sendResponse);
        return true;
      case '2fa:update':
        updateAccount(message.id, message.patch || {}).then(sendResponse);
        return true;
      case '2fa:accounts':
        if (!vault.isUnlocked()) {
          sendResponse({ ok: false, error: 'the vault is locked' });
        } else {
          sendResponse({ ok: true, accounts: vault.accounts() || [] });
        }
        return false;
      case '2fa:capture':
        offerCapture(message.uri || '', sender).then(sendResponse);
        return true;
      case '2fa:change-passphrase':
        vault.changePassphrase(message.oldPass, message.newPass)
          .then(function(res) { sendResponse(res); }, function(e) {
            sendResponse({ ok: false,
              error: (e && e.message) || String(e) });
          });
        return true;
      case '2fa:export':
        vault.exportBlob().then(function(blob) {
          sendResponse({ ok: true, blob: blob });
        });
        return true;
      case '2fa:import':
        vault.importBlob(message.blob, message.passphrase).then(sendResponse,
          function(e) {
            sendResponse({ ok: false,
              error: (e && e.message) || String(e) });
          });
        return true;
      default:
        return false;
    }
  });

  // ── idle lock ──────────────────────────────────────────────────────
  // The alarm doubles as the MV3 keepalive tick; when it fires with the
  // vault unlocked, the vault is re-locked. Ten minutes is generous for
  // reading a code, and short enough that a stray unlocked vault is not
  // tomorrow's problem.
  try {
    browser.alarms.create(IDLE_ALARM, { periodInMinutes: IDLE_LOCK_MINUTES });
    browser.alarms.onAlarm.addListener(function(alarm) {
      if (alarm.name === IDLE_ALARM && vault.isUnlocked()) {
        vault.lock().then(function() {
          log('idle lock: vault locked');
        });
      }
    });
  } catch (e) {}

  log('background ready');
})();
