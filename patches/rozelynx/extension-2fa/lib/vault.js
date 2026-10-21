/* RozeLynx 2FA: the passphrase-encrypted vault.
 *
 * The accounts (issuers, names, and the TOTP/HOTP SECRETS) are stored in
 * storage.local as ONE encrypted blob:
 *
 *   rozelynx2fa_vault = {
 *     v: 1,
 *     kdf: 'PBKDF2-SHA256',
 *     iterations: 310000,          // OWASP 2023 guidance for PBKDF2-HMAC-SHA256
 *     salt: '<base64>',           // 16 random bytes, per-vault
 *     iv: '<base64>',              // 12 random bytes, per write
 *     ct: '<base64>',              // AES-GCM ciphertext of the JSON below
 *   }
 *
 * plaintext JSON: { accounts: [ {id, type, issuer, account, secret,
 *   digits, period, counter, algorithm, domains: [hostnames], created} ] }
 *
 * The key exists ONLY in the background page's memory while unlocked, and
 * the vault re-locks on browser restart, on the Lock button, or after the
 * idle alarm fires - there is no "remember passphrase" on purpose: these
 * are second-factor secrets, the one place where convenience loses.
 *
 * globalThis.RozeLynxVault exposes async: create(passphrase, accounts),
 * unlock(passphrase), lock(), isUnlocked(), accounts(), save(accounts),
 * changePassphrase(old, new), exportBlob(), importBlob(json, passphrase).
 */
(function() {
  'use strict';

  var KEY = 'rozelynx2fa_vault';
  var ITER = 310000;

  function bytesToB64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) {
      s += String.fromCharCode(bytes[i]);
    }
    return btoa(s);
  }

  function b64ToBytes(str) {
    var bin = atob(String(str || ''));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  }

  function deriveKey(passphrase, saltBytes) {
    var enc = new TextEncoder();
    return crypto.subtle.importKey(
      'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']
    ).then(function(base) {
      return crypto.subtle.deriveKey(
        {
          name: 'PBKDF2',
          salt: saltBytes,
          iterations: ITER,
          hash: 'SHA-256',
        },
        base,
        { name: 'AES-GCM', length: 256 },
        false,          // not extractable: the key never leaves memory
        ['encrypt', 'decrypt']
      );
    });
  }

  var state = {
    key: null,          // the derived AES-GCM key, null while locked
    accounts: null,     // the decrypted account list, null while locked
  };

  function readBlob() {
    return browser.storage.local.get(KEY).then(function(stored) {
      return stored && stored[KEY] || null;
    });
  }

  function writeBlob(blob) {
    var data = {};
    data[KEY] = blob;
    return browser.storage.local.set(data);
  }

  function encryptAccounts(key, accounts) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var json = JSON.stringify({ accounts: accounts });
    var enc = new TextEncoder();
    return crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv }, key, enc.encode(json)
    ).then(function(ct) {
      return writeBlob({
        v: 1,
        kdf: 'PBKDF2-SHA256',
        iterations: ITER,
        salt: state.salt ? bytesToB64(state.salt) : '',
        iv: bytesToB64(iv),
        ct: bytesToB64(new Uint8Array(ct)),
      });
    });
  }

  var api = {
    /**
     * Whether a vault exists at all (an unlocked-but-empty vault and a
     * locked one both answer true once created).
     */
    exists: function() {
      return readBlob().then(function(blob) { return !!blob; });
    },

    isUnlocked: function() {
      return !!state.key;
    },

    /** The decrypted accounts, or null while locked. */
    accounts: function() {
      return state.accounts;
    },

    /** Create the vault (first run) or refuse if one exists. */
    create: function(passphrase, accounts) {
      if (!passphrase || passphrase.length < 8) {
        return Promise.reject(
          new Error('the passphrase must be at least 8 characters'));
      }
      return api.exists().then(function(have) {
        if (have) {
          throw new Error('a vault already exists');
        }
        var salt = crypto.getRandomValues(new Uint8Array(16));
        state.salt = salt;
        return deriveKey(passphrase, salt);
      }).then(function(key) {
        state.key = key;
        state.accounts = accounts || [];
        return encryptAccounts(key, state.accounts);
      }).then(function() {
        return { ok: true, accounts: state.accounts };
      });
    },

    /** Decrypt the vault; the key and accounts stay in memory. */
    unlock: function(passphrase) {
      return readBlob().then(function(blob) {
        if (!blob) {
          throw new Error('no vault exists yet');
        }
        state.salt = b64ToBytes(blob.salt);
        return deriveKey(passphrase, state.salt);
      }).then(function(key) {
        return readBlob().then(function(blob) {
          var iv = b64ToBytes(blob.iv);
          var ct = b64ToBytes(blob.ct);
          return crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: iv }, key, ct);
        }).then(function(plain) {
          var json = JSON.parse(new TextDecoder().decode(plain));
          state.key = key;
          state.accounts = Array.isArray(json.accounts) ? json.accounts : [];
          return { ok: true, accounts: state.accounts };
        }).catch(function() {
          // A wrong passphrase is the common case and must read as one.
          throw new Error('the passphrase did not unlock the vault');
        });
      });
    },

    lock: function() {
      state.key = null;
      state.accounts = null;
      return Promise.resolve({ ok: true });
    },

    /** Persist a new account list (must be unlocked). */
    save: function(accounts) {
      if (!state.key) {
        return Promise.reject(new Error('the vault is locked'));
      }
      state.accounts = accounts;
      return encryptAccounts(state.key, accounts).then(function() {
        return { ok: true, accounts: state.accounts };
      });
    },

    changePassphrase: function(oldPass, newPass) {
      if (!state.key) {
        return Promise.reject(new Error('the vault is locked'));
      }
      if (!newPass || newPass.length < 8) {
        return Promise.reject(
          new Error('the new passphrase must be at least 8 characters'));
      }
      // Re-verify the old passphrase against the stored blob before
      // rotating: a locked-out user changing the passphrase without the old
      // one would be a bypass, not a recovery.
      var salt = crypto.getRandomValues(new Uint8Array(16));
      return deriveKey(oldPass, state.salt).then(function(check) {
        return readBlob().then(function(blob) {
          return crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: b64ToBytes(blob.iv) },
            check, b64ToBytes(blob.ct));
        }).then(function() {
          return deriveKey(newPass, salt);
        }).catch(function() {
          throw new Error('the current passphrase did not unlock the vault');
        });
      }).then(function(newKey) {
        state.salt = salt;
        state.key = newKey;
        return encryptAccounts(newKey, state.accounts);
      }).then(function() {
        return { ok: true };
      });
    },

    /** The raw encrypted blob (for the options page's export button). */
    exportBlob: function() {
      return readBlob();
    },

    /** Replace the vault from an exported blob, verifying the passphrase. */
    importBlob: function(blob, passphrase) {
      if (!blob || blob.v !== 1 || !blob.salt || !blob.iv || !blob.ct) {
        return Promise.reject(new Error('not a RozeLynx 2FA vault export'));
      }
      var salt = b64ToBytes(blob.salt);
      return deriveKey(passphrase, salt).then(function(key) {
        return crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: b64ToBytes(blob.iv) },
          key, b64ToBytes(blob.ct));
      }).then(function(plain) {
        var json = JSON.parse(new TextDecoder().decode(plain));
        return writeBlob(blob);
      }).then(function() {
        // Importing does not keep the vault unlocked; the user just proved
        // they know the passphrase, so unlocking is one click away and the
        // secrets stay sealed unless asked for.
        return api.lock();
      }).then(function() {
        return { ok: true };
      });
    },
  };

  globalThis.RozeLynxVault = api;
})();
