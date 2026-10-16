/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "RozeLynxPamWebAuthnService.h"

#include <stddef.h>

#include "mozilla/JSONStringWriteFuncs.h"
#include "WebAuthnAutoFillEntry.h"
#include "WebAuthnEnumStrings.h"
#include "WebAuthnResult.h"
#include "prtime.h"

#include "RozeLynxPamAuth.h"
#include "RozeLynxPamCrypto.h"
#include "mozilla/JSONWriter.h"
#include "mozilla/Services.h"
#include "mozilla/StaticPrefs_security.h"
#include "nsCOMPtr.h"
#include "nsIWebAuthnArgs.h"
#include "nsIObserverService.h"
#include "nsLiteralString.h"
#include "nsThreadUtils.h"

namespace mozilla::dom {

namespace {

// COSE ES256 (ECDSA w/ SHA-256, P-256), the one algorithm the local
// authenticator creates credentials with.
constexpr int32_t kCoseEs256 = -7;

bool RpIdMatches(const nsACString& aRecordRpId, const nsAString& aRpId) {
  NS_ConvertUTF8toUTF16 wide(aRecordRpId);
  return wide.Equals(aRpId);
}

void SendWebAuthnPrompt(const char* aType, uint64_t aTransactionId,
                        const nsAString& aOrigin, uint64_t aBrowsingContextId,
                        const nsTArray<nsString>* aEntityNames) {
  nsAutoCString json;
  JSONStringRefWriteFunc f(json);
  JSONWriter w(f, JSONWriter::CollectionStyle::SingleLineStyle);
  w.Start();
  w.StartObjectProperty("prompt");
  w.StringProperty("type", aType);
  if (aEntityNames) {
    w.StartArrayProperty("entities");
    for (const nsString& name : *aEntityNames) {
      nsAutoCString nameUtf8(NS_ConvertUTF16toUTF8(name));
      w.StartObjectElement();
      w.StringProperty("name", nameUtf8.get());
      w.EndObject();
    }
    w.EndArray();
  }
  w.EndObject();
  nsAutoCString originUtf8(NS_ConvertUTF16toUTF8(aOrigin));
  w.StringProperty("origin", originUtf8.get());
  w.IntProperty("tid", static_cast<int64_t>(aTransactionId));
  w.IntProperty("browsingContextId",
                static_cast<int64_t>(aBrowsingContextId));
  w.End();

  nsString wide(NS_ConvertUTF8toUTF16(json));
  nsCOMPtr<nsIObserverService> os = services::GetObserverService();
  if (os) {
    MOZ_ALWAYS_SUCCEEDS(
        os->NotifyObservers(nullptr, "webauthn-prompt", wide.get()));
  }
}

}  // namespace

NS_IMPL_ISUPPORTS(RozeLynxPamWebAuthnService, nsIWebAuthnService)

RozeLynxPamWebAuthnService::RozeLynxPamWebAuthnService(
    nsIWebAuthnService* aAuthrsService)
    : mAuthrsService(aAuthrsService) {
  MOZ_ASSERT(NS_IsMainThread());
  MOZ_ASSERT(mAuthrsService);
}

bool RozeLynxPamWebAuthnService::Enabled() const {
  return StaticPrefs::security_webauthn_rozelynx_pam_enabled() &&
         RozeLynxPamAuth::ServiceAvailable();
}

bool RozeLynxPamWebAuthnService::ShouldHandleRegister(
    nsIWebAuthnRegisterArgs* aRequest) const {
  nsString attachment;
  if (NS_SUCCEEDED(aRequest->GetAuthenticatorAttachment(attachment)) &&
      attachment.EqualsLiteral(
          MOZ_WEBAUTHN_AUTHENTICATOR_ATTACHMENT_CROSS_PLATFORM)) {
    return false;
  }
  nsTArray<int32_t> coseAlgs;
  if (NS_SUCCEEDED(aRequest->GetCoseAlgs(coseAlgs)) && !coseAlgs.IsEmpty()) {
    bool es256 = false;
    for (const int32_t alg : coseAlgs) {
      if (alg == kCoseEs256) {
        es256 = true;
      }
    }
    if (!es256) {
      return false;
    }
  }
  return true;
}

bool RozeLynxPamWebAuthnService::ShouldHandleSign(
    nsIWebAuthnSignArgs* aRequest) const {
  nsString appId;
  if (NS_SUCCEEDED(aRequest->GetAppId(appId)) && !appId.IsEmpty()) {
    // Legacy U2F AppID: the domain of security keys.
    return false;
  }
  return true;
}

void RozeLynxPamWebAuthnService::StartChooserPrompt(
    uint64_t aTransactionId, uint64_t aBrowsingContextId,
    nsIWebAuthnRegisterArgs* aArgs, nsIWebAuthnRegisterPromise* aPromise) {
  MOZ_ASSERT(mPending.isSome());
  auto& pending = mPending.ref();
  pending.mTransactionId = aTransactionId;
  pending.mBrowsingContextId = aBrowsingContextId;
  pending.mRegister = true;
  pending.mPhase = Pending::Phase::Chooser;
  pending.mRegisterArgs = aArgs;
  pending.mRegisterPromise = aPromise;

  nsAutoString origin;
  (void)pending.mRegisterArgs->GetOrigin(origin);
  SendWebAuthnPrompt("rozelynx-pam-select-authenticator", aTransactionId,
                     origin, aBrowsingContextId, nullptr);
}

void RozeLynxPamWebAuthnService::StartRegisterVerification() {
  MOZ_ASSERT(mPending.isSome());
  auto& pending = mPending.ref();
  pending.mPhase = Pending::Phase::Verifying;
  nsAutoString origin;
  (void)pending.mRegisterArgs->GetOrigin(origin);
  RefPtr<RozeLynxPamWebAuthnService> self = this;
  uint64_t tid = pending.mTransactionId;
  RozeLynxPamAuth::Verify(
      tid, origin, pending.mBrowsingContextId, true,
      [self](bool aVerified) { self->ContinueRegister(aVerified); });
}

void RozeLynxPamWebAuthnService::ContinueRegister(bool aVerified) {
  MOZ_ASSERT(NS_IsMainThread());
  if (mPending.isNothing() || !mPending.ref().mRegister) {
    return;
  }
  if (!aVerified) {
    RejectPending(NS_ERROR_DOM_NOT_ALLOWED_ERR);
    return;
  }
  auto& pending = mPending.ref();

  nsAutoString rpId;
  if (NS_FAILED(pending.mRegisterArgs->GetRpId(rpId))) {
    RejectPending(NS_ERROR_DOM_NOT_ALLOWED_ERR);
    return;
  }
  nsTArray<uint8_t> userHandle;
  (void)pending.mRegisterArgs->GetUserId(userHandle);
  nsAutoString userName;
  (void)pending.mRegisterArgs->GetUserName(userName);
  nsAutoString displayName;
  (void)pending.mRegisterArgs->GetUserDisplayName(displayName);
  nsAutoString residentKey;
  (void)pending.mRegisterArgs->GetResidentKey(residentKey);
  bool privateBrowsing = false;
  (void)pending.mRegisterArgs->GetPrivateBrowsing(&privateBrowsing);

  uint8_t credentialId[32];
  nsTArray<uint8_t> pkcs8;
  nsTArray<uint8_t> publicSec1;
  if (!RozeLynxPamCrypto::GetRandomBytes(credentialId, sizeof(credentialId)) ||
      !RozeLynxPamCrypto::GenerateEs256KeyPair(pkcs8, publicSec1)) {
    RejectPending(NS_ERROR_DOM_OPERATION_ERR);
    return;
  }

  nsAutoCString rpIdUtf8(NS_ConvertUTF16toUTF8(rpId));
  uint8_t rpIdHash[32];
  if (!RozeLynxPamCrypto::Sha256(
          reinterpret_cast<const uint8_t*>(rpIdUtf8.get()), rpIdUtf8.Length(),
          rpIdHash)) {
    RejectPending(NS_ERROR_DOM_OPERATION_ERR);
    return;
  }

  nsTArray<uint8_t> credentialIdArray;
  credentialIdArray.AppendElements(credentialId, sizeof(credentialId));
  nsTArray<uint8_t> authData;
  RozeLynxPamCrypto::BuildRegistrationAuthData(
      rpIdHash, credentialIdArray, publicSec1.Elements(), authData);
  nsTArray<uint8_t> attestationObject;
  RozeLynxPamCrypto::BuildNoneAttestationObject(
      authData, attestationObject);

  bool resident = !residentKey.EqualsLiteral(
      MOZ_WEBAUTHN_RESIDENT_KEY_REQUIREMENT_DISCOURAGED);

  RozeLynxPasskeyRecord record;
  record.mCredentialId = credentialIdArray;
  record.mRpId = rpIdUtf8;
  record.mUserName = userName;
  record.mUserDisplayName = displayName;
  record.mUserHandle = userHandle;
  record.mPkcs8 = pkcs8;
  record.mSignCount = 0;
  record.mResident = resident;
  record.mCreated = PR_Now() / PR_USEC_PER_SEC;
  if (!privateBrowsing) {
    RozeLynxPasskeyStore::Put(record);
  }

  nsTArray<nsString> transports;
  transports.AppendElement(u"internal"_ns);
  nsCOMPtr<nsIWebAuthnRegisterResult> result = new WebAuthnRegisterResult(
      attestationObject, Nothing(), credentialIdArray, transports,
      Some(u"platform"_ns), Nothing(), Nothing(), Nothing(), Nothing());
  (void)result->SetCredPropsRk(resident);
  pending.mRegisterPromise->Resolve(result);
  ClearPending();
}

void RozeLynxPamWebAuthnService::StartSignVerification(
    RozeLynxPasskeyRecord&& aRecord) {
  MOZ_ASSERT(mPending.isSome());
  auto& pending = mPending.ref();
  pending.mPhase = Pending::Phase::Verifying;
  mSigningRecord = std::move(aRecord);
  nsAutoString origin;
  (void)pending.mSignArgs->GetOrigin(origin);
  RefPtr<RozeLynxPamWebAuthnService> self = this;
  uint64_t tid = pending.mTransactionId;
  RozeLynxPamAuth::Verify(
      tid, origin, pending.mBrowsingContextId, true,
      [self](bool aVerified) { self->ContinueSign(aVerified); });
}

void RozeLynxPamWebAuthnService::ContinueSign(bool aVerified) {
  MOZ_ASSERT(NS_IsMainThread());
  if (mPending.isNothing() || mPending.ref().mRegister) {
    return;
  }
  if (!aVerified) {
    RejectPending(NS_ERROR_DOM_NOT_ALLOWED_ERR);
    return;
  }
  auto& pending = mPending.ref();

  nsTArray<uint8_t> clientDataHash;
  if (NS_FAILED(pending.mSignArgs->GetClientDataHash(clientDataHash))) {
    RejectPending(NS_ERROR_DOM_OPERATION_ERR);
    return;
  }
  bool privateBrowsing = false;
  (void)pending.mSignArgs->GetPrivateBrowsing(&privateBrowsing);

  nsAutoCString rpIdUtf8(mSigningRecord.mRpId);
  uint8_t rpIdHash[32];
  if (!RozeLynxPamCrypto::Sha256(
          reinterpret_cast<const uint8_t*>(rpIdUtf8.get()), rpIdUtf8.Length(),
          rpIdHash)) {
    RejectPending(NS_ERROR_DOM_OPERATION_ERR);
    return;
  }

  uint32_t signCount = mSigningRecord.mSignCount + 1;
  nsTArray<uint8_t> authenticatorData;
  RozeLynxPamCrypto::BuildAssertionAuthData(rpIdHash, signCount,
                                            authenticatorData);

  nsTArray<uint8_t> digestInput(authenticatorData.Clone());
  digestInput.AppendElements(clientDataHash);
  uint8_t digest[32];
  if (!RozeLynxPamCrypto::Sha256(digestInput.Elements(), digestInput.Length(),
                                 digest)) {
    RejectPending(NS_ERROR_DOM_OPERATION_ERR);
    return;
  }

  nsTArray<uint8_t> signature;
  if (!RozeLynxPamCrypto::SignEs256Digest(mSigningRecord.mPkcs8, digest,
                                          signature)) {
    RejectPending(NS_ERROR_DOM_OPERATION_ERR);
    return;
  }

  if (!privateBrowsing) {
    RozeLynxPasskeyStore::UpdateSignCount(mSigningRecord.mCredentialId,
                                           signCount);
  }

  nsCOMPtr<nsIWebAuthnSignResult> result = new WebAuthnSignResult(
      authenticatorData, Nothing(), mSigningRecord.mCredentialId, signature,
      mSigningRecord.mUserHandle, Some(u"platform"_ns), Nothing(), Nothing(),
      Nothing(), Nothing(), Nothing());
  pending.mSignPromise->Resolve(result);
  ClearPending();
}

void RozeLynxPamWebAuthnService::SelectSignResult(uint64_t aIndex) {
  auto& pending = mPending.ref();
  MOZ_ASSERT(pending.mPhase == Pending::Phase::SelectAccount);
  if (aIndex >= pending.mCandidates.Length()) {
    RejectPending(NS_ERROR_DOM_NOT_ALLOWED_ERR);
    return;
  }
  RozeLynxPasskeyRecord record = std::move(pending.mCandidates[aIndex]);
  StartSignVerification(std::move(record));
}

void RozeLynxPamWebAuthnService::RejectPending(nsresult aError) {
  if (mPending.isNothing()) {
    return;
  }
  uint64_t tid = mPending.ref().mTransactionId;
  uint64_t bcid = mPending.ref().mBrowsingContextId;
  nsAutoString origin;
  if (mPending.ref().mRegister) {
    (void)mPending.ref().mRegisterArgs->GetOrigin(origin);
  } else {
    (void)mPending.ref().mSignArgs->GetOrigin(origin);
  }
  if (mPending.ref().mRegister) {
    if (mPending.ref().mRegisterPromise) {
      mPending.ref().mRegisterPromise->Reject(aError);
    }
  } else if (mPending.ref().mSignPromise) {
    mPending.ref().mSignPromise->Reject(aError);
  }
  ClearPending();
  // Drop any prompt of ours that is still up for this transaction.
  SendWebAuthnPrompt("cancel", tid, origin, bcid, nullptr);
}

void RozeLynxPamWebAuthnService::ClearPending() { mPending.reset(); }

// nsIWebAuthnService

NS_IMETHODIMP
RozeLynxPamWebAuthnService::GetIsUVPAA(bool* aAvailable) {
  MOZ_ASSERT(NS_IsMainThread());
  *aAvailable = Enabled();
  return NS_OK;
}

NS_IMETHODIMP
RozeLynxPamWebAuthnService::MakeCredential(
    uint64_t aTransactionId, uint64_t aBrowsingContextId,
    nsIWebAuthnRegisterArgs* aArgs, nsIWebAuthnRegisterPromise* aPromise) {
  MOZ_ASSERT(NS_IsMainThread());
  MOZ_ASSERT(aArgs);
  MOZ_ASSERT(aPromise);

  if (!Enabled() || !ShouldHandleRegister(aArgs)) {
    return mAuthrsService->MakeCredential(aTransactionId, aBrowsingContextId,
                                           aArgs, aPromise);
  }

  ClearPending();
  mPending.emplace();

  nsString attachment;
  bool haveAttachment =
      NS_SUCCEEDED(aArgs->GetAuthenticatorAttachment(attachment));
  if (!haveAttachment ||
      !attachment.EqualsLiteral(
          MOZ_WEBAUTHN_AUTHENTICATOR_ATTACHMENT_PLATFORM)) {
    // RP left the attachment open: let the user pick between the local
    // authenticator and a USB/NFC security key before doing anything.
    StartChooserPrompt(aTransactionId, aBrowsingContextId, aArgs, aPromise);
    return NS_OK;
  }

  auto& pending = mPending.ref();
  pending.mTransactionId = aTransactionId;
  pending.mBrowsingContextId = aBrowsingContextId;
  pending.mRegister = true;
  pending.mRegisterArgs = aArgs;
  pending.mRegisterPromise = aPromise;
  StartRegisterVerification();
  return NS_OK;
}

NS_IMETHODIMP
RozeLynxPamWebAuthnService::GetAssertion(
    uint64_t aTransactionId, uint64_t aBrowsingContextId,
    nsIWebAuthnSignArgs* aArgs, nsIWebAuthnSignPromise* aPromise) {
  MOZ_ASSERT(NS_IsMainThread());
  MOZ_ASSERT(aArgs);
  MOZ_ASSERT(aPromise);

  if (!Enabled() || !ShouldHandleSign(aArgs)) {
    return mAuthrsService->GetAssertion(aTransactionId, aBrowsingContextId,
                                        aArgs, aPromise);
  }

  nsAutoString rpId;
  if (NS_FAILED(aArgs->GetRpId(rpId))) {
    return mAuthrsService->GetAssertion(aTransactionId, aBrowsingContextId,
                                        aArgs, aPromise);
  }
  nsTArray<nsTArray<uint8_t>> allowList;
  (void)aArgs->GetAllowList(allowList);

  nsTArray<RozeLynxPasskeyRecord> records;
  RozeLynxPasskeyStore::GetAll(records);

  nsTArray<RozeLynxPasskeyRecord> candidates;
  for (RozeLynxPasskeyRecord& record : records) {
    if (!RpIdMatches(record.mRpId, rpId)) {
      continue;
    }
    if (allowList.IsEmpty()) {
      // Discoverable credentials only: conditional mediation and
      // resident-key requests cannot name server-side credentials.
      if (!record.mResident) {
        continue;
      }
    } else {
      bool listed = false;
      for (const nsTArray<uint8_t>& allowed : allowList) {
        if (allowed == record.mCredentialId) {
          listed = true;
          break;
        }
      }
      if (!listed) {
        continue;
      }
    }
    candidates.AppendElement(std::move(record));
  }

  if (candidates.IsEmpty()) {
    // Nothing local matches; let the security key bridge try (the allow
    // list may hold credentials that live on a USB token).
    return mAuthrsService->GetAssertion(aTransactionId, aBrowsingContextId,
                                        aArgs, aPromise);
  }

  ClearPending();
  mPending.emplace();
  auto& pending = mPending.ref();
  pending.mTransactionId = aTransactionId;
  pending.mBrowsingContextId = aBrowsingContextId;
  pending.mRegister = false;
  pending.mSignArgs = aArgs;
  pending.mSignPromise = aPromise;

  nsAutoString origin;
  (void)aArgs->GetOrigin(origin);

  if (candidates.Length() == 1) {
    StartSignVerification(std::move(candidates[0]));
    return NS_OK;
  }

  // Several local passkeys match: ask which account to use.
  pending.mPhase = Pending::Phase::SelectAccount;
  pending.mCandidates = std::move(candidates);
  nsTArray<nsString> entityNames;
  for (const RozeLynxPasskeyRecord& record : pending.mCandidates) {
    entityNames.AppendElement(record.mUserName.IsEmpty()
                                  ? record.mUserDisplayName
                                  : record.mUserName);
  }
  SendWebAuthnPrompt("select-sign-result", aTransactionId, origin,
                     aBrowsingContextId, &entityNames);
  return NS_OK;
}

NS_IMETHODIMP
RozeLynxPamWebAuthnService::Reset() {
  MOZ_ASSERT(NS_IsMainThread());
  if (mPending.isSome()) {
    // Do not reject the pending promise (reset contract): the caller has
    // already aborted it. Cancel the PAM side and any shown prompts.
    uint64_t tid = mPending.ref().mTransactionId;
    uint64_t bcid = mPending.ref().mBrowsingContextId;
    nsAutoString origin;
    if (mPending.ref().mRegisterArgs) {
      (void)mPending.ref().mRegisterArgs->GetOrigin(origin);
    } else if (mPending.ref().mSignArgs) {
      (void)mPending.ref().mSignArgs->GetOrigin(origin);
    }
    ClearPending();
    RozeLynxPamAuth::Cancel(tid);
    SendWebAuthnPrompt("cancel", tid, origin, bcid, nullptr);
  }
  return mAuthrsService->Reset();
}

NS_IMETHODIMP
RozeLynxPamWebAuthnService::Cancel(uint64_t aTransactionId) {
  MOZ_ASSERT(NS_IsMainThread());
  if (mPending.isSome() &&
      mPending.ref().mTransactionId == aTransactionId) {
    uint64_t tid = aTransactionId;
    uint64_t bcid = mPending.ref().mBrowsingContextId;
    nsAutoString origin;
    if (mPending.ref().mRegisterArgs) {
      (void)mPending.ref().mRegisterArgs->GetOrigin(origin);
    } else if (mPending.ref().mSignArgs) {
      (void)mPending.ref().mSignArgs->GetOrigin(origin);
    }
    bool registerTxn = mPending.ref().mRegister;
    // Register promises are rejected by the WebAuthnService wrapper; sign
    // promises are ours.
    if (!registerTxn && mPending.ref().mSignPromise) {
      mPending.ref().mSignPromise->Reject(NS_ERROR_DOM_NOT_ALLOWED_ERR);
    }
    ClearPending();
    RozeLynxPamAuth::Cancel(tid);
    SendWebAuthnPrompt("cancel", tid, origin, bcid, nullptr);
    return NS_OK;
  }
  return mAuthrsService->Cancel(aTransactionId);
}

NS_IMETHODIMP
RozeLynxPamWebAuthnService::HasPendingConditionalGet(
    uint64_t aBrowsingContextId, const nsAString& aOrigin, uint64_t* aRv) {
  // Conditional requests are tracked by the WebAuthnService wrapper.
  *aRv = 0;
  return NS_OK;
}

NS_IMETHODIMP
RozeLynxPamWebAuthnService::GetAutoFillEntries(
    uint64_t aTransactionId, nsIWebAuthnAutoFillEntriesCallback* aCallback) {
  aCallback->Reject(NS_ERROR_NOT_AVAILABLE);
  return NS_OK;
}

NS_IMETHODIMP
RozeLynxPamWebAuthnService::GetAutoFillEntriesForRpId(
    const nsAString& aRpId, const nsTArray<nsTArray<uint8_t>>& aAllowList,
    nsIWebAuthnAutoFillEntriesCallback* aCallback) {
  MOZ_ASSERT(NS_IsMainThread());

  nsTArray<RefPtr<nsIWebAuthnAutoFillEntry>> entries;
  if (Enabled()) {
    nsTArray<RozeLynxPasskeyRecord> records;
    RozeLynxPasskeyStore::GetAll(records);
    for (RozeLynxPasskeyRecord& record : records) {
      if (!record.mResident || !RpIdMatches(record.mRpId, aRpId)) {
        continue;
      }
      if (!aAllowList.IsEmpty()) {
        bool listed = false;
        for (const nsTArray<uint8_t>& allowed : aAllowList) {
          if (allowed == record.mCredentialId) {
            listed = true;
            break;
          }
        }
        if (!listed) {
          continue;
        }
      }
      entries.AppendElement(new WebAuthnAutoFillEntry(
          nsIWebAuthnAutoFillEntry::PROVIDER_PLATFORM_ROZELYNX_PAM,
          record.mUserName, aRpId, record.mCredentialId));
    }
  }
  aCallback->Resolve(entries);
  return NS_OK;
}

NS_IMETHODIMP
RozeLynxPamWebAuthnService::SelectAutoFillEntry(
    uint64_t aTransactionId, const nsTArray<uint8_t>& aCredentialId) {
  // Handled by the WebAuthnService wrapper (it re-dispatches the
  // transaction through GetAssertion).
  return NS_ERROR_NOT_AVAILABLE;
}

NS_IMETHODIMP
RozeLynxPamWebAuthnService::ResumeConditionalGet(uint64_t aTransactionId) {
  return NS_ERROR_NOT_AVAILABLE;
}

NS_IMETHODIMP
RozeLynxPamWebAuthnService::PinCallback(uint64_t aTransactionId,
                                        const nsACString& aPin) {
  MOZ_ASSERT(NS_IsMainThread());
  if (mPending.isSome() &&
      mPending.ref().mTransactionId == aTransactionId) {
    RozeLynxPamAuth::ProvidePassword(aTransactionId, aPin);
    return NS_OK;
  }
  return mAuthrsService->PinCallback(aTransactionId, aPin);
}

NS_IMETHODIMP
RozeLynxPamWebAuthnService::SetHasAttestationConsent(
    uint64_t aTransactionId, bool aHasConsent) {
  // The wrapper owns attestation consent handling.
  return NS_OK;
}

NS_IMETHODIMP
RozeLynxPamWebAuthnService::SelectionCallback(uint64_t aTransactionId,
                                              uint64_t aIndex) {
  MOZ_ASSERT(NS_IsMainThread());
  if (mPending.isSome() &&
      mPending.ref().mTransactionId == aTransactionId) {
    auto& pending = mPending.ref();
    switch (pending.mPhase) {
      case Pending::Phase::Chooser:
        if (aIndex == 0) {
          StartRegisterVerification();
          return NS_OK;
        }
        // Hand the registration to the USB security key bridge.
        if (aIndex == 1) {
          nsCOMPtr<nsIWebAuthnRegisterArgs> args = pending.mRegisterArgs;
          nsCOMPtr<nsIWebAuthnRegisterPromise> promise =
              pending.mRegisterPromise;
          uint64_t bcid = pending.mBrowsingContextId;
          ClearPending();
          return mAuthrsService->MakeCredential(aTransactionId, bcid, args,
                                                 promise);
        }
        RejectPending(NS_ERROR_DOM_NOT_ALLOWED_ERR);
        return NS_OK;
      case Pending::Phase::SelectAccount:
        SelectSignResult(aIndex);
        return NS_OK;
      case Pending::Phase::Verifying:
        break;
    }
    return NS_OK;
  }
  return mAuthrsService->SelectionCallback(aTransactionId, aIndex);
}

NS_IMETHODIMP
RozeLynxPamWebAuthnService::AddVirtualAuthenticator(
    const nsACString& aProtocol, const nsACString& aTransport,
    bool aHasResidentKey, bool aHasUserVerification, bool aIsUserConsenting,
    bool aIsUserVerified, nsACString& aRetval) {
  return mAuthrsService->AddVirtualAuthenticator(
      aProtocol, aTransport, aHasResidentKey, aHasUserVerification,
      aIsUserConsenting, aIsUserVerified, aRetval);
}

NS_IMETHODIMP
RozeLynxPamWebAuthnService::HasVirtualAuthenticator(
    const nsACString& aAuthenticatorId, bool* aRetval) {
  return mAuthrsService->HasVirtualAuthenticator(aAuthenticatorId, aRetval);
}

NS_IMETHODIMP
RozeLynxPamWebAuthnService::RemoveVirtualAuthenticator(
    const nsACString& aAuthenticatorId) {
  return mAuthrsService->RemoveVirtualAuthenticator(aAuthenticatorId);
}

NS_IMETHODIMP
RozeLynxPamWebAuthnService::AddCredential(
    const nsACString& aAuthenticatorId, const nsACString& aCredentialId,
    bool aIsResidentCredential, const nsACString& aRpId,
    const nsACString& aPrivateKey, const nsACString& aUserHandle,
    uint32_t aSignCount) {
  return mAuthrsService->AddCredential(aAuthenticatorId, aCredentialId,
                                       aIsResidentCredential, aRpId,
                                       aPrivateKey, aUserHandle, aSignCount);
}

NS_IMETHODIMP
RozeLynxPamWebAuthnService::GetCredentials(
    const nsACString& aAuthenticatorId,
    nsTArray<RefPtr<nsICredentialParameters>>& aRetval) {
  return mAuthrsService->GetCredentials(aAuthenticatorId, aRetval);
}

NS_IMETHODIMP
RozeLynxPamWebAuthnService::RemoveCredential(const nsACString& aAuthenticatorId,
                                             const nsACString& aCredentialId) {
  return mAuthrsService->RemoveCredential(aAuthenticatorId, aCredentialId);
}

NS_IMETHODIMP
RozeLynxPamWebAuthnService::RemoveAllCredentials(
    const nsACString& aAuthenticatorId) {
  return mAuthrsService->RemoveAllCredentials(aAuthenticatorId);
}

NS_IMETHODIMP
RozeLynxPamWebAuthnService::SetUserVerified(const nsACString& aAuthenticatorId,
                                           bool aIsUserVerified) {
  return mAuthrsService->SetUserVerified(aAuthenticatorId, aIsUserVerified);
}

NS_IMETHODIMP
RozeLynxPamWebAuthnService::Listen() { return mAuthrsService->Listen(); }

NS_IMETHODIMP
RozeLynxPamWebAuthnService::RunCommand(const nsACString& aCmd) {
  return mAuthrsService->RunCommand(aCmd);
}

}  // namespace mozilla::dom