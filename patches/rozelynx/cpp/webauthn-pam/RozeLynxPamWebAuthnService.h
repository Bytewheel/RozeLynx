/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_dom_RozeLynxPamWebAuthnService_h_
#define mozilla_dom_RozeLynxPamWebAuthnService_h_

#include <stdint.h>
#include "mozilla/Maybe.h"
#include "nsCOMPtr.h"
#include "nsIWebAuthnService.h"
#include "nsTArray.h"

#include "RozeLynxPasskeyStore.h"

namespace mozilla::dom {

// The RozeLynx PAM platform authenticator: an nsIWebAuthnService that
// serves WebAuthn passkey requests with locally stored credentials whose
// user verification runs through PAM (howdy face authentication when the
// system PAM stack provides it, the account password otherwise, with the
// browser prompting in either case). Requests that it cannot serve -
// cross-platform (USB/NFC) security keys, unsupported algorithms, requests
// arriving while the feature is disabled - are forwarded to the wrapped
// authrs_bridge service unchanged, so enabling it never removes security
// key support. All methods are main-thread only.
class RozeLynxPamWebAuthnService final : public nsIWebAuthnService {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS
  NS_DECL_NSIWEBAUTHNSERVICE

  explicit RozeLynxPamWebAuthnService(nsIWebAuthnService* aAuthrsService);

 private:
  ~RozeLynxPamWebAuthnService() = default;

  // True while a request is being served locally. The WebAuthnService
  // wrapper only ever runs one modal transaction at a time.
  struct Pending {
    enum class Phase : uint8_t {
      // Waiting for SelectionCallback to pick between the local
      // authenticator and the USB security key bridge.
      Chooser,
      // PAM user verification is running.
      Verifying,
      // Waiting for SelectionCallback to pick one of mCandidates.
      SelectAccount,
    };
    uint64_t mTransactionId = 0;
    uint64_t mBrowsingContextId = 0;
    bool mRegister = false;
    Phase mPhase = Phase::Chooser;
    // Register phase:
    nsCOMPtr<nsIWebAuthnRegisterArgs> mRegisterArgs;
    nsCOMPtr<nsIWebAuthnRegisterPromise> mRegisterPromise;
    // Sign phase:
    nsCOMPtr<nsIWebAuthnSignArgs> mSignArgs;
    nsCOMPtr<nsIWebAuthnSignPromise> mSignPromise;
    // SelectAccount phase:
    nsTArray<RozeLynxPasskeyRecord> mCandidates;
  };

  bool Enabled() const;

  // Returns true when aRequest should be served locally.
  bool ShouldHandleRegister(nsIWebAuthnRegisterArgs* aRequest) const;
  bool ShouldHandleSign(nsIWebAuthnSignArgs* aRequest) const;

  void StartChooserPrompt(uint64_t aTransactionId, uint64_t aBrowsingContextId,
                           nsIWebAuthnRegisterArgs* aArgs,
                           nsIWebAuthnRegisterPromise* aPromise);
  void StartRegisterVerification();
  void ContinueRegister(bool aVerified);
  void StartSignVerification(RozeLynxPasskeyRecord&& aRecord);
  void ContinueSign(bool aVerified);
  void SelectSignResult(uint64_t aIndex);

  void RejectPending(nsresult aError);
  void ClearPending();

  nsCOMPtr<nsIWebAuthnService> mAuthrsService;
  Maybe<Pending> mPending;
  RozeLynxPasskeyRecord mSigningRecord;  // Sign phase key material.
};

}  // namespace mozilla::dom

#endif  // mozilla_dom_RozeLynxPamWebAuthnService_h_