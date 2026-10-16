/* This Source Code Form is subject to the terms of Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_dom_RozeLynxPamAuth_h_
#define mozilla_dom_RozeLynxPamAuth_h_

#include <stdint.h>
#include <functional>
#include "nsStringFwd.h"

namespace mozilla::dom {

// Runs a PAM authentication transaction for the RozeLynx passkey platform
// authenticator. The PAM conversation is executed on a dedicated thread;
// prompts (face-verification notice, password entry) are surfaced through
// the regular "webauthn-prompt" observer notifications and answered through
// nsIWebAuthnService callbacks on the main thread. The service stack is
// resolved from the user's PAM configuration: /etc/pam.d/rozelynx first
// (see files/rozelynx/cpp/webauthn-pam/rozelynx.pam), then the distro
// common chain (system-auth / common-auth), so the face-recognition
// module (pam_howdy) and the password fallback come from the system PAM
// configuration. All entry points are main-thread only.
class RozeLynxPamAuth final {
 public:
  using VerifyCallback = std::function<void(bool aVerified)>;

  // Returns true when a usable PAM service configuration was found. This
  // backs nsIWebAuthnService::isUVPAA.
  static bool ServiceAvailable();

  // Starts PAM user verification for the transaction. aCallback is invoked
  // on the main thread with the outcome. When aShowVerifyPrompt is true a
  // "look at the camera" doorhanger is shown while the PAM stack runs
  // (howdy does its own camera handling; the password prompt appears only
  // if the PAM conversation asks for one).
  static void Verify(uint64_t aTransactionId, const nsAString& aOrigin,
                     uint64_t aBrowsingContextId, bool aShowVerifyPrompt,
                     VerifyCallback&& aCallback);

  // Answers a pending password request from the PAM conversation.
  static void ProvidePassword(uint64_t aTransactionId, const nsACString& aPassword);

  // Cancels the PAM transaction for aTransactionId (no-op otherwise).
  static void Cancel(uint64_t aTransactionId);
};

}  // namespace mozilla::dom

#endif  // mozilla_dom_RozeLynxPamAuth_h_