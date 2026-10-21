# RozeLynx 2FA

The separate two-factor authentication extension for RozeLynx
(`rozelynx-2fa@bytewheel.org`), assembled and force-installed alongside the
browser under `USE=twofa`.

## What it does

- **TOTP / HOTP code generation** (RFC 6238 / 4226) with SHA-1, SHA-256 and
  SHA-512, 6-8 digit codes and custom periods - everything an
  `otpauth://` URI can carry. Pure WebCrypto; no third-party crypto.
- **Passphrase-encrypted vault.** The accounts and their secrets are stored
  as one AES-GCM blob (key derived with PBKDF2-SHA256, 310k iterations)
  in `storage.local`. The key exists only in the background page's memory
  while unlocked; the vault re-locks on browser restart, on the Lock
  button, or after ten idle minutes. There is no recovery and no
  "remember passphrase" - these are second-factor secrets.
- **otpauth:// capture.** Clicking a setup link on a page reports it to the
  background, which saves the account and confirms with a notification.
- **Page autofill.** When a page has an input that looks like a 2FA code
  field and the vault holds an account for that host, a small
  "RozeLynx 2FA" chip appears beside the field; clicking it fills the
  current code. The content script never sees the secrets - it asks the
  background for codes.
- **HOTP counters advance on use** (copy / fill), not on generation, so
  generating without accepting cannot desynchronise the account.
- **Backup.** Export writes the vault exactly as stored - still
  encrypted - and import replaces it, verifying the passphrase.

## Files

- `lib/totp.js` - OATH code generation + otpauth URI parsing
- `lib/vault.js` - the encrypted vault
- `background.js` - vault owner + message API + idle lock
- `popup/` - unlock / setup / the code list / add form
- `options/` - account management, passphrase change, export/import
- `content.js` - otpauth capture + code-field chip

The `README.md` you are reading is excluded from the assembled XPI by the
build (rozelynx-distro-build.sh / the ebuild).
