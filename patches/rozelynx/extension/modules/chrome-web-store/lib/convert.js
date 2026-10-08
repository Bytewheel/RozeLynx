// RozeLynx CWS conversion core - shared between the converter page and the
// background update checker. Requires JSZip to be loaded beforehand.
//
// Exposes window.RozeLynxCWSConvert:
//   parseCRXHeader(buffer)
//   verifyCrx3Attestation(crxBuffer, header, task) -> {ok,id,detail}
//   convertCrxToXpi(crxBuffer, task) -> { xpiArray, manifest, attest, version }
//   sha256Hex(bytes)
(function() {
  'use strict';

  // "CRX3 SignedData\0" - signature context prefix (crx_file.h).
  var SIG_CTX = new Uint8Array([67, 82, 88, 51, 32, 83, 105, 103, 110, 101,
    100, 68, 97, 116, 97, 0]);

  // SHA-256 hashes of Google's pinned CRX3 publisher SPKI keys.
  var PINNED_KEY_HASHES = {
    ecdsa: ['61f7f2a6bfcf74cd0bc1fe2497cc9b04254c658f79f2145392867ea8366367cf'],
    rsa: ['b5e4096227b83f82101fc2aa49f2a251accde3d98471464dd17d1819b43786b0'],
  };

  function readVarint(bytes, pos) {
    var shift = 0, value = 0;
    while (true) {
      var b = bytes[pos++];
      value |= (b & 0x7F) << shift;
      if (!(b & 0x80)) return { value: value, pos: pos };
      shift += 7;
    }
  }

  function parseCRXHeader(buffer) {
    var view = new DataView(buffer);
    var magic = view.getUint32(0, true);
    if (magic !== 0x34327243) {
      throw new Error('Invalid CRX: bad magic number');
    }
    var version = view.getUint32(4, true);
    var headerSize;

    if (version === 2) {
      var pkLen = view.getUint32(8, true);
      var sigLen = view.getUint32(12, true);
      headerSize = 16 + pkLen + sigLen;
    } else if (version === 3) {
      headerSize = 12 + view.getUint32(8, true);
    } else {
      throw new Error('Unsupported CRX version: ' + version);
    }

    return { version: version, headerSize: headerSize };
  }

  function parseCrx3Header(headerBytes) {
    var proofs = [];
    var signedHeaderData = null;
    var pos = 0;
    while (pos < headerBytes.length) {
      var t = readVarint(headerBytes, pos);
      pos = t.pos;
      var field = t.value >>> 3;
      var wire = t.value & 7;
      if (wire !== 2) {
        if (wire === 0) { pos = readVarint(headerBytes, pos).pos; }
        else if (wire === 1) { pos += 8; }
        else if (wire === 5) { pos += 4; }
        continue;
      }
      var l = readVarint(headerBytes, pos);
      pos = l.pos;
      var payload = headerBytes.subarray(pos, pos + l.value);
      pos += l.value;
      if (field === 2 || field === 3) {
        var pub = null, sig = null, p = 0;
        while (p < payload.length) {
          var t2 = readVarint(payload, p);
          p = t2.pos;
          var f2 = t2.value >>> 3, w2 = t2.value & 7;
          var l2 = readVarint(payload, p);
          p = l2.pos;
          var chunk = payload.subarray(p, p + l2.value);
          p += l2.value;
          if (w2 === 2 && f2 === 1) pub = chunk;
          else if (w2 === 2 && f2 === 2) sig = chunk;
        }
        proofs.push({ type: field === 2 ? 'rsa' : 'ecdsa', pub: pub, sig: sig });
      } else if (field === 10000) {
        signedHeaderData = payload;
      }
    }
    return { proofs: proofs, signedHeaderData: signedHeaderData };
  }

  // SignedData { bytes crx_id = 1; } -> the 16 raw ID bytes
  function parseSignedData(sdh) {
    var pos = 0, crxId = null;
    while (pos < sdh.length) {
      var t = readVarint(sdh, pos);
      pos = t.pos;
      var field = t.value >>> 3;
      var wire = t.value & 7;
      var l = readVarint(sdh, pos);
      pos = l.pos;
      var chunk = sdh.subarray(pos, pos + l.value);
      pos += l.value;
      if (wire === 2 && field === 1) crxId = chunk;
    }
    return crxId;
  }

  // a-p base16 of the first 16 bytes
  function idFromBytes(raw16) {
    var chars = 'abcdefghijklmnop';
    var out = '';
    for (var i = 0; i < raw16.length; i++) {
      out += chars[raw16[i] >> 4] + chars[raw16[i] & 15];
    }
    return out;
  }

  function sha256Hex(bytes) {
    return crypto.subtle.digest('SHA-256', bytes).then(function (buf) {
      return Array.from(new Uint8Array(buf))
        .map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    });
  }

  function concatBytes(parts) {
    var total = 0;
    parts.forEach(function (p) { total += p.length; });
    var out = new Uint8Array(total);
    var off = 0;
    parts.forEach(function (p) {
      out.set(p, off);
      off += p.length;
    });
    return out;
  }

  // DER ECDSA signature -> raw r||s (WebCrypto expects raw)
  function derToRaw(der) {
    if (der[0] !== 0x30) return null;
    var i = 2;
    if (der[i] !== 0x02) return null;
    var rlen = der[i + 1];
    var r = Array.prototype.slice.call(der, i + 2, i + 2 + rlen);
    i += 2 + rlen;
    if (der[i] !== 0x02) return null;
    var slen = der[i + 1];
    var s = Array.prototype.slice.call(der, i + 2, i + 2 + slen);
    while (r.length > 0 && r[0] === 0) r.shift();
    while (s.length > 0 && s[0] === 0) s.shift();
    while (r.length < 32) r.unshift(0);
    while (s.length < 32) s.unshift(0);
    return new Uint8Array(r.concat(s));
  }

  function verifyProof(proof, message) {
    if (!proof.pub || !proof.sig) return Promise.resolve(false);
    var alg = proof.type === 'rsa'
      ? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
      : { name: 'ECDSA', hash: 'SHA-256' };
    var importAlg = proof.type === 'rsa'
      ? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
      : { name: 'ECDSA', namedCurve: 'P-256' };
    var sig = proof.type === 'ecdsa' ? derToRaw(proof.sig) : proof.sig;
    if (!sig) return Promise.resolve(false);
    return crypto.subtle.importKey('spki', proof.pub, importAlg, false, ['verify'])
      .then(function (key) {
        return crypto.subtle.verify(alg, key, sig, message);
      })
      .catch(function () { return false; });
  }

  // Returns { ok, id, detail } - ok=true only when a Google-pinned key
  // signed the CRX AND the declared CRX id matches the store id.
  async function verifyCrx3Attestation(crxBuffer, header, task) {
    if (header.version !== 3) {
      return { ok: false, id: null, detail: 'not-crx3' };
    }
    var headerBytes = new Uint8Array(crxBuffer, 12, header.headerSize - 12);
    var zipBytes = new Uint8Array(crxBuffer, header.headerSize);
    var parsed;
    try {
      parsed = parseCrx3Header(headerBytes);
    } catch (e) {
      return { ok: false, id: null, detail: 'header-parse: ' + (e.message || e) };
    }
    if (!parsed.signedHeaderData) {
      return { ok: false, id: null, detail: 'no-signed-header-data' };
    }
    var sdh = parsed.signedHeaderData;
    var sizeOctets = new Uint8Array(4);
    new DataView(sizeOctets.buffer).setUint32(0, sdh.length, true);
    var message = concatBytes([SIG_CTX, sizeOctets, sdh, zipBytes]);

    var pinnedProofOk = false;
    var verifiedTypes = [];
    for (var i = 0; i < parsed.proofs.length; i++) {
      var proof = parsed.proofs[i];
      var valid = await verifyProof(proof, message);
      if (!valid) continue;
      verifiedTypes.push(proof.type);
      var hash = await sha256Hex(proof.pub);
      var pinned = (PINNED_KEY_HASHES[proof.type] || []);
      if (pinned.indexOf(hash) >= 0) pinnedProofOk = true;
    }

    var crxId = parseSignedData(sdh);
    var declaredId = crxId ? idFromBytes(crxId) : null;
    var idMatch = declaredId && (!task.extId || declaredId === task.extId);

    if (!pinnedProofOk) {
      return { ok: false, id: declaredId,
        detail: 'no-pinned-google-proof (verified: ' +
          (verifiedTypes.join(',') || 'none') + ')' };
    }
    if (!idMatch) {
      return { ok: false, id: declaredId,
        detail: 'id mismatch: declared ' + declaredId +
          ', store ' + (task.extId || '?') };
    }
    return { ok: true, id: declaredId, detail: 'verified: ' + verifiedTypes.join(',') };
  }

  // CRX buffer -> installable XPI (clean zip + manifest patch).
  // Returns { xpiArray, manifest, attest, version }.
  async function convertCrxToXpi(crxBuffer, task) {
    if (typeof JSZip === 'undefined') {
      throw new Error('JSZip not loaded');
    }
    var header = parseCRXHeader(crxBuffer);
    var zipBuffer = crxBuffer.slice(header.headerSize);
    var attest = await verifyCrx3Attestation(crxBuffer, header, task);

    var zip = await JSZip.loadAsync(zipBuffer);
    var manifestStr = await zip.file('manifest.json').async('string');
    if (!manifestStr) {
      throw new Error('No manifest.json in CRX');
    }
    var manifest = JSON.parse(manifestStr);

    manifest.browser_specific_settings = manifest.browser_specific_settings || {};
    manifest.browser_specific_settings.gecko = manifest.browser_specific_settings.gecko || {};
    if (!manifest.browser_specific_settings.gecko.id) {
      manifest.browser_specific_settings.gecko.id =
        task.extId + '@rozelynx-converted';
    }
    // Chrome's update URL points at Google's update server, which serves
    // Chrome-format update manifests - useless (and wrong) for Firefox.
    delete manifest.update_url;

    // Firefox hard-rejects Chrome MV3's background.service_worker
    // (install fails: "appears to be corrupt"). Rewrite it to an
    // event-page style background.scripts reference: the extension then
    // installs and its content scripts run, even if the worker code
    // itself cannot fully execute in Firefox.
    if (manifest.background && manifest.background.service_worker &&
        !manifest.background.scripts && !manifest.background.page) {
      var sw = manifest.background.service_worker;
      delete manifest.background.service_worker;
      manifest.background.scripts = [sw];
    }
    // If a referenced background script is missing from the archive,
    // drop background entirely (missing file would fail the install).
    if (manifest.background && manifest.background.scripts &&
        Array.isArray(manifest.background.scripts)) {
      var allPresent = manifest.background.scripts.every(function (p) {
        return !!zip.file(p);
      });
      if (!allPresent) {
        delete manifest.background;
      }
    }

    var out = new JSZip();
    var entries = [];
    zip.forEach(function (path, entry) {
      if (!entry.dir) entries.push({ path: path, entry: entry });
    });
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.path === 'manifest.json') {
        out.file('manifest.json', JSON.stringify(manifest, null, 2));
      } else {
        out.file(e.path, await e.entry.async('uint8array'));
      }
    }
    var xpiArray = await out.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    return {
      xpiArray: xpiArray,
      manifest: manifest,
      attest: attest,
      version: manifest.version || null,
    };
  }

  window.RozeLynxCWSConvert = {
    parseCRXHeader: parseCRXHeader,
    verifyCrx3Attestation: verifyCrx3Attestation,
    convertCrxToXpi: convertCrxToXpi,
    sha256Hex: sha256Hex,
  };
})();
