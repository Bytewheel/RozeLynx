/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "RozeLynxPamCrypto.h"

#include <certt.h>
#include <secasn1t.h>
#include <secoidt.h>

#include <keyhi.h>
#include <pk11pub.h>
#include <prerror.h>
#include <secitem.h>
#include <secoid.h>

#include "ScopedNSSTypes.h"

namespace mozilla::dom {

using mozilla::UniquePK11SlotInfo;
using mozilla::UniqueSECItem;
using mozilla::UniqueSECKEYPrivateKey;
using mozilla::UniqueSECKEYPublicKey;

namespace {

// Minimal canonical-CBOR appenders.
void AppendHead(nsTArray<uint8_t>& aOut, uint8_t aMajor, size_t aArg) {
  if (aArg < 24) {
    aOut.AppendElement(
        static_cast<uint8_t>((aMajor << 5) | static_cast<uint8_t>(aArg)));
    return;
  }
  if (aArg <= 0xff) {
    aOut.AppendElement(static_cast<uint8_t>((aMajor << 5) | 24));
    aOut.AppendElement(static_cast<uint8_t>(aArg));
    return;
  }
  if (aArg <= 0xffff) {
    aOut.AppendElement(static_cast<uint8_t>((aMajor << 5) | 25));
    aOut.AppendElement(static_cast<uint8_t>(aArg >> 8));
    aOut.AppendElement(static_cast<uint8_t>(aArg));
    return;
  }
  aOut.AppendElement(static_cast<uint8_t>((aMajor << 5) | 26));
  aOut.AppendElement(static_cast<uint8_t>(aArg >> 24));
  aOut.AppendElement(static_cast<uint8_t>(aArg >> 16));
  aOut.AppendElement(static_cast<uint8_t>(aArg >> 8));
  aOut.AppendElement(static_cast<uint8_t>(aArg));
}

void AppendUnsigned(nsTArray<uint8_t>& aOut, uint64_t aValue) {
  AppendHead(aOut, 0, aValue);
}

void AppendNegative(nsTArray<uint8_t>& aOut, uint64_t aValue) {
  AppendHead(aOut, 1, aValue);
}

void AppendBytes(nsTArray<uint8_t>& aOut, const uint8_t* aData,
                 size_t aLength) {
  AppendHead(aOut, 2, aLength);
  aOut.AppendElements(aData, aLength);
}

void AppendText(nsTArray<uint8_t>& aOut, const char* aText, size_t aLength) {
  AppendHead(aOut, 3, aLength);
  aOut.AppendElements(reinterpret_cast<const uint8_t*>(aText), aLength);
}

}  // namespace

bool RozeLynxPamCrypto::GenerateEs256KeyPair(nsTArray<uint8_t>& aPkcs8,
                                             nsTArray<uint8_t>& aPublicSec1) {
  UniquePK11SlotInfo slot(PK11_GetInternalSlot());
  if (!slot) {
    return false;
  }

  // DER-encoded named-curve parameter block for CKM_EC_KEY_PAIR_GEN: the
  // SEC OID of secp256r1 (06 || len || content).
  unsigned char oid[16] = {0};
  oid[0] = SEC_ASN1_OBJECT_ID;
  {
    const SECOidData* oidData = SECOID_FindOIDByTag(SEC_OID_SECG_EC_SECP256R1);
    if (!oidData || oidData->oid.len == 0 ||
        oidData->oid.len > sizeof(oid) - 2) {
      return false;
    }
    oid[1] = static_cast<unsigned char>(oidData->oid.len);
    memcpy(oid + 2, oidData->oid.data, oidData->oid.len);
  }
  SECItem ecParams = {siBuffer, oid, static_cast<unsigned int>(2 + oid[1])};

  SECKEYPublicKey* pub = nullptr;
  // Session key (permanent=false, sensitive=true): never lands in an NSS
  // database; exported to PKCS#8 right away.
  UniqueSECKEYPrivateKey priv(PK11_GenerateKeyPair(
      slot.get(), CKM_EC_KEY_PAIR_GEN, &ecParams, &pub, PR_FALSE, PR_TRUE,
      nullptr));
  UniqueSECKEYPublicKey pubKey(pub);
  if (!priv || !pubKey || pubKey->keyType != ecKey ||
      pubKey->u.ec.publicValue.len != 65 ||
      pubKey->u.ec.publicValue.data[0] != 0x04) {
    return false;
  }

  UniqueSECItem pkcs8Item(PK11_ExportDERPrivateKeyInfo(priv.get(), nullptr));
  if (!pkcs8Item) {
    return false;
  }

  aPkcs8.Clear();
  aPkcs8.AppendElements(pkcs8Item->data, pkcs8Item->len);
  aPublicSec1.Clear();
  aPublicSec1.AppendElements(pubKey->u.ec.publicValue.data,
                             pubKey->u.ec.publicValue.len);
  return true;
}

bool RozeLynxPamCrypto::SignEs256Digest(const nsTArray<uint8_t>& aPkcs8,
                                        const uint8_t aDigest[32],
                                        nsTArray<uint8_t>& aSignature) {
  UniquePK11SlotInfo slot(PK11_GetInternalSlot());
  if (!slot) {
    return false;
  }

  SECItem pkcs8Item = {siBuffer, const_cast<unsigned char*>(aPkcs8.Elements()),
                       static_cast<unsigned int>(aPkcs8.Length())};
  SECKEYPrivateKey* privKey = nullptr;
  SECStatus rv = PK11_ImportDERPrivateKeyInfoAndReturnKey(
      slot.get(), &pkcs8Item, nullptr, nullptr, PR_FALSE, PR_FALSE, KU_ALL,
      &privKey, nullptr);
  UniqueSECKEYPrivateKey priv(privKey);
  if (rv != SECSuccess || !priv || priv->keyType != ecKey) {
    return false;
  }

  SECItem digestItem = {siBuffer, const_cast<unsigned char*>(aDigest), 32};
  UniqueSECItem sig(::SECITEM_AllocItem(nullptr, nullptr,
                                        PK11_SignatureLen(priv.get())));
  if (!sig) {
    return false;
  }
  // CKM_ECDSA signs the raw digest and yields the DER ECDSA-Sig-Value that
  // the WebAuthn ES256 algorithm identifier promises.
  rv = PK11_SignWithMechanism(priv.get(), CKM_ECDSA, nullptr, sig.get(),
                              &digestItem);
  if (rv != SECSuccess) {
    return false;
  }

  aSignature.Clear();
  aSignature.AppendElements(sig->data, sig->len);
  return true;
}

bool RozeLynxPamCrypto::Sha256(const uint8_t* aData, size_t aLength,
                               uint8_t aDigest[32]) {
  return PK11_HashBuf(SEC_OID_SHA256, aDigest, aData,
                      static_cast<PRInt32>(aLength)) == SECSuccess;
}

bool RozeLynxPamCrypto::GetRandomBytes(uint8_t* aOut, size_t aLength) {
  return PK11_GenerateRandom(aOut, static_cast<int>(aLength)) == SECSuccess;
}

void RozeLynxPamCrypto::BuildCoseEc2Key(const uint8_t aPublicSec1[65],
                                        nsTArray<uint8_t>& aOut) {
  AppendUnsigned(aOut, 5);  // map(5)
  AppendUnsigned(aOut, 1);  // kty: 2 (EC2)
  AppendUnsigned(aOut, 2);
  AppendUnsigned(aOut, 3);  // alg
  AppendNegative(aOut, 6);  // -7 (ES256)
  AppendNegative(aOut, 0);  // crv
  AppendUnsigned(aOut, 1);  // 1 (P-256)
  AppendNegative(aOut, 1);  // x
  AppendBytes(aOut, aPublicSec1 + 1, 32);
  AppendNegative(aOut, 2);  // y
  AppendBytes(aOut, aPublicSec1 + 33, 32);
}

void RozeLynxPamCrypto::BuildRegistrationAuthData(
    const uint8_t aRpIdHash[32], const nsTArray<uint8_t>& aCredentialId,
    const uint8_t aPublicSec1[65], nsTArray<uint8_t>& aOut) {
  aOut.Clear();
  aOut.AppendElements(aRpIdHash, 32);
  aOut.AppendElement(0x45);  // UP | UV | AT
  const uint8_t signCount[4] = {0};  // big-endian 0
  aOut.AppendElements(signCount, 4);
  // AAGUID: all zeros (fmt "none" leaves no make/model identifier).
  const uint8_t aaguid[16] = {0};
  aOut.AppendElements(aaguid, 16);
  aOut.AppendElement(
      static_cast<uint8_t>((aCredentialId.Length() >> 8) & 0xff));
  aOut.AppendElement(static_cast<uint8_t>(aCredentialId.Length() & 0xff));
  aOut.AppendElements(aCredentialId);
  BuildCoseEc2Key(aPublicSec1, aOut);
}

void RozeLynxPamCrypto::BuildAssertionAuthData(const uint8_t aRpIdHash[32],
                                               uint32_t aSignCount,
                                               nsTArray<uint8_t>& aOut) {
  aOut.Clear();
  aOut.AppendElements(aRpIdHash, 32);
  aOut.AppendElement(0x05);  // UP | UV
  aOut.AppendElement(static_cast<uint8_t>(aSignCount >> 24));
  aOut.AppendElement(static_cast<uint8_t>(aSignCount >> 16));
  aOut.AppendElement(static_cast<uint8_t>(aSignCount >> 8));
  aOut.AppendElement(static_cast<uint8_t>(aSignCount));
}

void RozeLynxPamCrypto::BuildNoneAttestationObject(
    const nsTArray<uint8_t>& aAuthData, nsTArray<uint8_t>& aOut) {
  aOut.Clear();
  AppendUnsigned(aOut, 3);  // map(3)
  AppendText(aOut, "fmt", sizeof("fmt") - 1);
  AppendText(aOut, "none", sizeof("none") - 1);
  AppendText(aOut, "attStmt", sizeof("attStmt") - 1);
  AppendUnsigned(aOut, 0);  // empty map
  AppendText(aOut, "authData", sizeof("authData") - 1);
  AppendBytes(aOut, aAuthData.Elements(), aAuthData.Length());
}

}  // namespace mozilla::dom