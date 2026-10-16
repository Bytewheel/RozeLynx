/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_dom_RozeLynxPasskeyStore_h_
#define mozilla_dom_RozeLynxPasskeyStore_h_

#include <cstdint>
#include "nsCString.h"
#include "nsString.h"
#include "nsTArray.h"

namespace mozilla::dom {

struct RozeLynxPasskeyRecord {
  // The WebAuthn credential ID (also the key to the stored preference
  // branch).
  nsTArray<uint8_t> mCredentialId;
  nsCString mRpId;
  nsString mUserName;
  nsString mUserDisplayName;
  nsTArray<uint8_t> mUserHandle;
  // Private key, PKCS#8 DER.
  nsTArray<uint8_t> mPkcs8;
  uint32_t mSignCount = 0;
  bool mResident = true;
  // Seconds since epoch; orders records when several match a request.
  int64_t mCreated = 0;
};

// Per-profile storage of the RozeLynx PAM passkey records, backed by the
// preference system (profile-local, permissions of prefs.js apply: 0600 by
// default). All methods are main-thread only. Private-key material lives
// here unencrypted at rest, like the profile's own login data; the browser
// user must treat the profile directory as a secret store.
class RozeLynxPasskeyStore final {
 public:
  // All stored records, ordered oldest-first (by creation time).
  static void GetAll(nsTArray<RozeLynxPasskeyRecord>& aOut);

  static void Put(const RozeLynxPasskeyRecord& aRecord);

  static void UpdateSignCount(const nsTArray<uint8_t>& aCredentialId,
                              uint32_t aSignCount);

  static void Remove(const nsTArray<uint8_t>& aCredentialId);
};

}  // namespace mozilla::dom

#endif  // mozilla_dom_RozeLynxPasskeyStore_h_