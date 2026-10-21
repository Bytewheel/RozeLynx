/* RozeLynx 2FA: popup.
 *
 * Three views, one truth in the background: first-run setup, locked, and
 * the code list. The list leads with the accounts captured for THIS tab's
 * host (that is what "for this site" means here) and follows with every
 * other account, live-code. Copy advances HOTP counters; TOTP codes are
 * read-only facts about the clock.
 */
(function() {
  'use strict';

  function ask(action, extra) {
    var msg = { action: action };
    if (extra) {
      Object.keys(extra).forEach(function(k) { msg[k] = extra[k]; });
    }
    return browser.runtime.sendMessage(msg);
  }

  var views = {
    setup: document.getElementById('setup-view'),
    locked: document.getElementById('locked-view'),
    main: document.getElementById('main-view'),
  };

  function show(name) {
    Object.keys(views).forEach(function(k) {
      views[k].hidden = k !== name;
    });
  }

  function setStatus(id, msg) {
    var el = document.getElementById(id);
    if (el) el.textContent = msg || '';
  }

  // ── view routing ─────────────────────────────────────────────────────

  var tickTimer = null;

  function refreshState() {
    return ask('2fa:state').then(function(res) {
      res = res || {};
      if (!res.exists) {
        show('setup');
        return null;
      }
      if (!res.unlocked) {
        show('locked');
        return null;
      }
      show('main');
      return renderMain();
    });
  }

  // ── setup / unlock ───────────────────────────────────────────────────

  document.getElementById('setup-btn').addEventListener('click', function() {
    var p1 = document.getElementById('setup-pass').value;
    var p2 = document.getElementById('setup-pass2').value;
    if (p1 !== p2) {
      setStatus('setup-status', 'The passphrases do not match.');
      return;
    }
    if (p1.length < 8) {
      setStatus('setup-status', 'The passphrase must be at least 8 characters.');
      return;
    }
    ask('2fa:create', { passphrase: p1 }).then(function(res) {
      if (!res || res.ok !== true) {
        setStatus('setup-status', (res && res.error) || 'Could not create the vault.');
        return;
      }
      setStatus('setup-status', '');
      refreshState();
    });
  });

  document.getElementById('unlock-btn').addEventListener('click', function() {
    ask('2fa:unlock', {
      passphrase: document.getElementById('unlock-pass').value,
    }).then(function(res) {
      if (!res || res.ok !== true) {
        setStatus('unlock-status', (res && res.error) || 'Could not unlock.');
        return;
      }
      setStatus('unlock-status', '');
      document.getElementById('unlock-pass').value = '';
      refreshState();
    });
  });
  document.getElementById('unlock-pass').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      document.getElementById('unlock-btn').click();
    }
  });

  // ── the code list ────────────────────────────────────────────────────

  var codeList = document.getElementById('code-list');
  var codeEmpty = document.getElementById('code-empty');
  var allCodes = [];
  var siteLine = document.getElementById('site-line');

  function hostOf(url) {
    try {
      return new URL(url).hostname;
    } catch (e) {
      return '';
    }
  }

  function accountRow(entry, isSite) {
    var box = document.createElement('div');
    box.className = 'account';

    var name = document.createElement('div');
    name.className = 'name';
    name.textContent = (entry.issuer || 'Unnamed') +
      (entry.account ? ' \u00b7 ' + entry.account : '');
    box.appendChild(name);

    if (entry.error) {
      var err = document.createElement('div');
      err.className = 'meta';
      err.textContent = entry.error;
      err.style.color = '#DC2626';
      box.appendChild(err);
    } else {
      var code = document.createElement('div');
      code.className = 'code';
      code.textContent = (entry.code || '').slice(0, 3) + ' ' +
        (entry.code || '').slice(3);
      box.appendChild(code);

      var timer = document.createElement('div');
      timer.className = 'timer';
      timer.textContent = entry.type === 'hotp'
        ? 'HOTP \u00b7 the counter advances on copy'
        : 'valid for ' + entry.remaining + 's' +
          (isSite ? '' : ' \u00b7 any site');
      box.appendChild(timer);

      var actions = document.createElement('div');
      actions.className = 'actions';
      var copy = document.createElement('button');
      copy.textContent = 'Copy';
      copy.addEventListener('click', function() {
        navigator.clipboard.writeText(entry.code).then(function() {
          copy.textContent = 'Copied!';
          setTimeout(function() { copy.textContent = 'Copy'; }, 1200);
        }).catch(function() {});
        ask('2fa:accept-code', { id: entry.id }).catch(function() {});
      });
      actions.appendChild(copy);
      var del = document.createElement('button');
      del.textContent = 'Delete';
      del.addEventListener('click', function() {
        ask('2fa:remove', { id: entry.id }).then(function(res) {
          if (!res || res.ok !== true) {
            setStatus('add-status', (res && res.error) || 'Could not delete.');
            return;
          }
          renderMain();
        });
      });
      actions.appendChild(del);
      var opts = document.createElement('button');
      opts.textContent = 'Edit';
      opts.addEventListener('click', function() {
        browser.runtime.openOptionsPage().catch(function() {});
      });
      actions.appendChild(opts);
      box.appendChild(actions);
    }
    return box;
  }

  function renderCodes(codes, siteCodes) {
    codeList.textContent = '';
    siteCodes = siteCodes || [];
    var shown = 0;
    if (siteCodes.length) {
      var head = document.createElement('div');
      head.className = 'sub';
      head.textContent = 'This site:';
      codeList.appendChild(head);
      siteCodes.forEach(function(entry) {
        codeList.appendChild(accountRow(entry, true));
        shown++;
      });
    }
    var others = codes.filter(function(entry) {
      return !siteCodes.some(function(s) { return s.id === entry.id; });
    });
    if (others.length) {
      var head2 = document.createElement('div');
      head2.className = 'sub';
      head2.textContent = 'All accounts:';
      codeList.appendChild(head2);
      others.forEach(function(entry) {
        codeList.appendChild(accountRow(entry, false));
        shown++;
      });
    }
    codeEmpty.hidden = shown > 0;
  }

  function renderMain() {
    var host = '';
    return browser.tabs.query({ active: true, currentWindow: true })
      .then(function(tabs) {
        host = hostOf((tabs && tabs[0] && tabs[0].url) || '');
        siteLine.textContent = host
          ? 'Codes for ' + host + ' lead the list.'
          : 'All accounts.';
        return ask('2fa:codes', { host: host });
      })
      .then(function(res) {
        if (!res || res.ok !== true) {
          // The vault locked between refresh and codes (idle alarm):
          // route back to the locked view rather than showing a dead list.
          if (res && res.error && /locked/.test(res.error)) {
            return refreshState();
          }
          return;
        }
        return ask('2fa:codes').then(function(allRes) {
          var all = (allRes && allRes.ok && allRes.codes) || [];
          renderCodes(all, res.codes);
          if (tickTimer) clearInterval(tickTimer);
          tickTimer = setInterval(function() {
            if (views.main.hidden) {
              clearInterval(tickTimer);
              return;
            }
            renderMain();
          }, 5000);
        });
      });
  }

  // ── add form ─────────────────────────────────────────────────────────

  var addForm = document.getElementById('add-form');
  document.getElementById('toggle-add').addEventListener('click', function() {
    addForm.hidden = !addForm.hidden;
  });

  document.getElementById('add-btn').addEventListener('click', function() {
    var otpauth = document.getElementById('add-otpauth').value.trim();
    var host = '';
    browser.tabs.query({ active: true, currentWindow: true }).then(function(tabs) {
      host = hostOf((tabs && tabs[0] && tabs[0].url) || '');
      var spec;
      if (otpauth) {
        return ask('2fa:parse-otpauth', { uri: otpauth }).then(function(res) {
          if (!res || res.ok !== true) {
            setStatus('add-status', (res && res.error) || 'Could not parse the URI.');
            return null;
          }
          return res.spec;
        });
      }
      return {
        type: document.getElementById('add-type').value,
        issuer: document.getElementById('add-issuer').value.trim(),
        account: document.getElementById('add-account').value.trim(),
        secret: document.getElementById('add-secret').value.trim(),
        digits: parseInt(document.getElementById('add-digits').value, 10) || 6,
        period: parseInt(document.getElementById('add-period').value, 10) || 30,
        algorithm: document.getElementById('add-algo').value,
      };
    }).then(function(spec) {
      if (!spec) return;
      return ask('2fa:add', { spec: spec, host: host }).then(function(res) {
        if (!res || res.ok !== true) {
          setStatus('add-status', (res && res.error) || 'Could not save.');
          return;
        }
        ['add-issuer', 'add-account', 'add-secret', 'add-otpauth']
          .forEach(function(id) {
            var el = document.getElementById(id);
            if (el) el.value = '';
          });
        setStatus('add-status', '');
        addForm.hidden = true;
        renderMain();
      });
    });
  });

  // ── lock ─────────────────────────────────────────────────────────────

  document.getElementById('lock-btn').addEventListener('click', function() {
    ask('2fa:lock').then(refreshState);
  });

  refreshState();
})();
