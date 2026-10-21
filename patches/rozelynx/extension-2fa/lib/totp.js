/* RozeLynx 2FA: OATH code generation (TOTP / HOTP), RFC 6238 / 4226.
 *
 * Pure WebCrypto: the HMAC and the dynamic truncation are exactly what the
 * RFCs describe, no third-party crypto. SHA-1 (the overwhelmingly common
 * case), SHA-256 and SHA-512 are supported, as are 6-8 digit codes and
 * custom periods - all of which an otpauth:// URI can carry.
 *
 * globalThis.RozeLynxOath exposes:
 *   parseOtpauth(uri)     -> account object (throws on a bad URI)
 *   generateCode(account) -> {code, period, remaining, at}
 *   verifySecret(secret)   -> normalised base32 secret or null
 */
(function() {
  'use strict';

  var B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  function base32Decode(input) {
    var clean = String(input || '').toUpperCase().replace(/[\s-]/g, '')
      .replace(/=+$/, '');
    var bits = 0;
    var value = 0;
    var out = [];
    for (var i = 0; i < clean.length; i++) {
      var idx = B32.indexOf(clean[i]);
      if (idx < 0) {
        throw new Error('invalid base32 character: ' + clean[i]);
      }
      value = (value << 5) | idx;
      bits += 5;
      if (bits >= 8) {
        out.push((value >>> (bits - 8)) & 0xff);
        bits -= 8;
      }
    }
    return new Uint8Array(out);
  }

  function normalizeSecret(input) {
    try {
      var bytes = base32Decode(input);
      if (bytes.length < 5) {
        // A secret under 40 bits cannot produce meaningful codes; every
        // real issuer ships at least 80.
        return null;
      }
      return String(input || '').toUpperCase().replace(/[\s-]/g, '');
    } catch (e) {
      return null;
    }
  }

  var ALGOS = {
    'SHA1': 'SHA-1',
    'SHA256': 'SHA-256',
    'SHA512': 'SHA-512',
  };

  /**
   * account: {type:'totp'|'hotp', secret, digits, period, counter, algorithm}
   * counter is ignored for TOTP (derived from the clock).
   */
  function generateCode(account) {
    account = account || {};
    var algo = ALGOS[String(account.algorithm || 'SHA1').toUpperCase()] ||
      'SHA-1';
    var digits = Math.min(Math.max(parseInt(account.digits, 10) || 6, 6), 8);
    var period = Math.max(parseInt(account.period, 10) || 30, 1);
    var now = Math.floor(Date.now() / 1000);
    var counter;
    if (String(account.type || 'totp').toLowerCase() === 'hotp') {
      counter = parseInt(account.counter, 10) || 0;
    } else {
      counter = Math.floor(now / period);
    }

    var keyBytes;
    try {
      keyBytes = base32Decode(account.secret || '');
    } catch (e) {
      return Promise.reject(new Error('the account secret is not valid base32'));
    }

    return crypto.subtle.importKey(
      'raw', keyBytes, { name: 'HMAC', hash: { name: algo } }, false, ['sign']
    ).then(function(key) {
      var msg = new ArrayBuffer(8);
      var view = new DataView(msg);
      // 64-bit big-endian counter; >2^32 counters never happen here but the
      // high word is written anyway so the encoding is honest.
      view.setUint32(0, Math.floor(counter / 0x100000000));
      view.setUint32(4, counter >>> 0);
      return crypto.subtle.sign('HMAC', key, msg);
    }).then(function(mac) {
      var h = new Uint8Array(mac);
      var offset = h[h.length - 1] & 0x0f;
      var bin = ((h[offset] & 0x7f) << 24) |
                ((h[offset + 1] & 0xff) << 16) |
                ((h[offset + 2] & 0xff) << 8) |
                (h[offset + 3] & 0xff);
      var code = String(bin % Math.pow(10, digits));
      while (code.length < digits) code = '0' + code;
      var remaining = String(account.type || 'totp').toLowerCase() === 'hotp'
        ? 0 : (period - (now % period));
      return {
        code: code,
        digits: digits,
        period: period,
        remaining: remaining,
        at: Date.now(),
      };
    });
  }

  /**
   * otpauth://TYPE/issuer:account?secret=...&issuer=...&digits=...&period=...
   * The label's leading '/' is optional in the wild (Google ships it),
   * percent-encoding is the rule, and a missing secret is a setup link for
   * something else - both are handled explicitly rather than by accident.
   */
  function parseOtpauth(uri) {
    var u;
    try {
      u = new URL(uri);
    } catch (e) {
      throw new Error('not a valid otpauth URI');
    }
    if (u.protocol !== 'otpauth:') {
      throw new Error('not an otpauth URI');
    }
    var type = u.host.toLowerCase();
    if (type !== 'totp' && type !== 'hotp') {
      throw new Error('unsupported otpauth type: ' + u.host);
    }
    var label = decodeURIComponent(u.pathname.replace(/^\/?/, ''));
    var issuerParam = u.searchParams.get('issuer') || '';
    var accountName = label;
    var issuer = issuerParam;
    var colon = label.indexOf(':');
    if (issuer && colon > 0) {
      // "Issuer: account" form; the query issuer wins when both exist, but
      // the label's account part is what the user recognises either way.
      accountName = label.slice(colon + 1).replace(/^ /, '');
    } else if (colon > 0) {
      issuer = label.slice(0, colon);
      accountName = label.slice(colon + 1).replace(/^ /, '');
    }
    var secret = u.searchParams.get('secret') || '';
    if (!secret) {
      throw new Error('the otpauth URI carries no secret');
    }
    var normalized = normalizeSecret(secret);
    if (!normalized) {
      throw new Error('the otpauth secret is not valid base32');
    }
    var algo = String(u.searchParams.get('algorithm') || 'SHA1').toUpperCase();
    if (!ALGOS[algo]) {
      throw new Error('unsupported algorithm: ' + algo);
    }
    return {
      type: type,
      issuer: issuer || '',
      account: accountName || label,
      secret: normalized,
      digits: parseInt(u.searchParams.get('digits'), 10) || 6,
      period: parseInt(u.searchParams.get('period'), 10) || 30,
      counter: parseInt(u.searchParams.get('counter'), 10) || 0,
      algorithm: algo,
    };
  }

  globalThis.RozeLynxOath = {
    generateCode: generateCode,
    parseOtpauth: parseOtpauth,
    verifySecret: normalizeSecret,
  };
})();
