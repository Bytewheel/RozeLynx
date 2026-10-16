/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_dom_RozeLynxPamCrypto_h_
#define mozilla_dom_RozeLynxPamCrypto_h_

#include <cstddef>
#include <cstdint>
#include "nsTArray.h"

namespace mozilla::dom {

// ES256 (ECDSA P-256, SHA-256) helpers for the RozeLynx PAM platform
// authenticator. Private keys are generated as in-memory PKCS#8 objects
// (session keys, never written to an NSS database) and are persisted by
// RozeLynxPasskeyStore.
class RozeLynxPamCrypto final {
 public:
  // Generates a fresh ES256 key pair. On success aPkcs8 holds the PKCS#8
  // DER encoding of the private key and aPublicSec1 the SEC 1 uncompressed
  // EC point (0x04 || X || Y, 65 bytes).
  static bool GenerateEs256KeyPair(nsTArray<uint8_t>& aPkcs8,
                                    nsTArray<uint8_t>& aPublicSec1);

  // Signs aDigest (32 raw bytes) with the private key in aPkcs8. aSignature
  // receives the DER-encoded ECDSA-Sig-Value that WebAuthn ES256 mandates.
  static bool SignEs256Digest(const nsTArray<uint8_t>& aPkcs8,
                               const uint8_t aDigest[32],
                               nsTArray<uint8_t>& aSignature);

  // aDigest receives SHA-256(aData).
  static bool Sha256(const uint8_t* aData, size_t aLength,
                     uint8_t aDigest[32]);

  static bool GetRandomBytes(uint8_t* aOut, size_t aLength);

  // aOut receives the CBOR-encoded COSE EC2 public key
  // {1: 2, 3: -7, -1: 1, -2: x, -3: y} for aPublicSec1 (65 bytes).
  static void BuildCoseEc2Key(const uint8_t aPublicSec1[65],
                              nsTArray<uint8_t>& aOut);

  // aOut receives a WebAuthn authenticatorData byte string with the
  // attested-credential-data flag set (registration): rpIdHash || 0x45 ||
  // signCount || aaguid (zero) || credentialId || COSE key.
  static void BuildRegistrationAuthData(const uint8_t aRpIdHash[32],
                                        const nsTArray<uint8_t>& aCredentialId,
                                        const uint8_t aPublicSec1[65],
                                        nsTArray<uint8_t>& aOut);

  // aOut receives a WebAuthn authenticatorData byte string for assertions:
  // rpIdHash || 0x05 (UP | UV) || signCount.
  static void BuildAssertionAuthData(const uint8_t aRpIdHash[32],
                                     uint32_t aSignCount,
                                     nsTArray<uint8_t>& aOut);

  // aOut receives the CBOR-encoded WebAuthn attestation object
  // {"fmt": "none", "attStmt": {}, "authData": ...}.
  static void BuildNoneAttestationObject(
      const nsTArray<uint8_t>& aAuthData, nsTArray<uint8_t>& aOut);
};

}  // namespace mozilla::dom

#endif  // mozilla_dom_RozeLynxPamCrypto_h_