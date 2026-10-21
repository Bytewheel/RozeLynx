/* RozeLynx 2FA: options page.
 *
 * Account management (rename, retype, delete), the passphrase rotation,
 * and the encrypted export/import. The page works on the DECRYPTED list
 * through the background's message API, so the secrets it edits are the
 * same secrets the popup reads - one vault, one owner (the background),
 * and every write re-encrypts the whole blob.
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

  function status(id, msg) {
    var el = document.getElementById(id);
    if (el) el.textContent = msg || '';
  }

  var accountList = document.getElementById('account-list');
  var accountsEmpty = document.getElementById('accounts-empty');
  var lockedNote = document.getElementById('accounts-locked-note');

  function renderAccounts() {
    return ask('2fa:accounts').then(function(res) {
      if (!res || res.ok !== true) {
        lockedNote.hidden = false;
        accountsEmpty.hidden = true;
        accountList.textContent = '';
        return;
      }
      lockedNote.hidden = true;
      var accounts = res.accounts || [];
      accountList.textContent = '';
      accountsEmpty.hidden = accounts.length > 0;

      accounts.forEach(function(a) {
        var box = document.createElement('div');
        box.className = 'account';

        var name = document.createElement('div');
        name.className = 'name';
        name.textContent = (a.issuer || 'Unnamed') +
          (a.account ? ' \u00b7 ' + a.account : '');
        box.appendChild(name);

        var detail = document.createElement('div');
        detail.className = 'detail';
        detail.textContent = String(a.type || 'totp').toUpperCase() +
          ' \u00b7 ' + (a.digits || 6) + ' digits \u00b7 ' +
          (a.period || 30) + 's \u00b7 ' + String(a.algorithm || 'SHA1') +
          (a.type === 'hotp' ? ' \u00b7 counter ' + (a.counter || 0) : '') +
          ((a.domains && a.domains.length)
            ? ' \u00b7 sites: ' + a.domains.join(', ') : '');
        box.appendChild(detail);

        var row = document.createElement('div');
        row.className = 'row';

        var issuer = document.createElement('input');
        issuer.type = 'text';
        issuer.value = a.issuer || '';
        issuer.placeholder = 'Issuer';
        row.appendChild(issuer);

        var account = document.createElement('input');
        account.type = 'text';
        account.value = a.account || '';
        account.placeholder = 'Account name';
        row.appendChild(account);

        var save = document.createElement('button');
        save.textContent = 'Save';
        save.addEventListener('click', function() {
          ask('2fa:update', {
            id: a.id,
            patch: { issuer: issuer.value.trim(), account: account.value.trim() },
          }).then(function(res2) {
            status('main-status', res2 && res2.ok
              ? '' : ((res2 && res2.error) || 'Could not save.'));
            if (res2 && res2.ok) renderAccounts();
          });
        });
        row.appendChild(save);

        var del = document.createElement('button');
        del.textContent = 'Delete';
        del.className = 'danger';
        del.addEventListener('click', function() {
          ask('2fa:remove', { id: a.id }).then(function(res2) {
            if (res2 && res2.ok) renderAccounts();
            else status('main-status', (res2 && res2.error) || 'Could not delete.');
          });
        });
        row.appendChild(del);

        box.appendChild(row);
        accountList.appendChild(box);
      });
    });
  }

  document.getElementById('change-pass-btn').addEventListener('click', function() {
    var oldPass = document.getElementById('old-pass').value;
    var newPass = document.getElementById('new-pass').value;
    if (!newPass || newPass.length < 8) {
      status('pass-status', 'The new passphrase must be at least 8 characters.');
      return;
    }
    ask('2fa:change-passphrase', { oldPass: oldPass, newPass: newPass })
      .then(function(res) {
        if (res && res.ok) {
          status('pass-status', 'The passphrase was changed.');
          document.getElementById('old-pass').value = '';
          document.getElementById('new-pass').value = '';
        } else {
          status('pass-status', (res && res.error) || 'Could not change it.');
        }
      });
  });

  document.getElementById('export-btn').addEventListener('click', function() {
    ask('2fa:export').then(function(res) {
      if (!res || res.ok !== true || !res.blob) {
        status('backup-status', (res && res.error) || 'No vault to export.');
        return;
      }
      var blob = new Blob([JSON.stringify(res.blob, null, 2)],
        { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'rozelynx-2fa-vault-' +
        new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      URL.revokeObjectURL(url);
      status('backup-status', 'Exported. The file is still encrypted; it ' +
        'needs this vault\u2019s passphrase to be read.');
    });
  });

  document.getElementById('import-file').addEventListener('change', function(e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    file.text().then(function(text) {
      document.getElementById('import-text').value = text;
      document.getElementById('import-confirm').hidden = false;
    });
  });
  document.getElementById('import-btn').addEventListener('click', function() {
    document.getElementById('import-file').click();
  });
  document.getElementById('import-apply').addEventListener('click', function() {
    var text = document.getElementById('import-text').value.trim();
    if (!text) return;
    var blob;
    try {
      blob = JSON.parse(text);
    } catch (err) {
      status('backup-status', 'The file is not valid JSON.');
      return;
    }
    ask('2fa:import', {
      blob: blob,
      passphrase: document.getElementById('import-pass').value,
    }).then(function(res) {
      if (res && res.ok) {
        status('backup-status', 'The vault was replaced. Unlock it from the ' +
          'toolbar button to use it.');
        document.getElementById('import-confirm').hidden = true;
        renderAccounts();
      } else {
        status('backup-status', (res && res.error) || 'Could not import.');
      }
    });
  });

  // The import button starts hidden because the file input's label is the
  // export row's "Choose a vault file..." companion - revealed when a vault
  // exists.
  ask('2fa:state').then(function(res) {
    if (res && res.exists) {
      document.getElementById('import-btn').hidden = false;
    }
    if (res && res.unlocked) {
      document.getElementById('import-btn').hidden = false;
      renderAccounts();
    } else {
      lockedNote.hidden = false;
      renderAccounts();
    }
  });
})();
