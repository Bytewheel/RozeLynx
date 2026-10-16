/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "RozeLynxPasskeyStore.h"

#include <algorithm>
#include <cstdint>
#include <cstdlib>

#include "mozilla/Base64.h"
#include "mozilla/Preferences.h"
#include "nsIPrefBranch.h"

namespace mozilla::dom {

namespace {

// security.webauthn.rozelynx_pam.cred.<b64url(credentialId)>.<field>
constexpr auto kPrefRoot = "security.webauthn.rozelynx_pam.cred."_ns;

bool B64Encode(const nsTArray<uint8_t>& aBytes, nsCString& aOut) {
  return NS_SUCCEEDED(Base64URLEncode(
             aBytes.Length(), aBytes.Elements(),
             Base64URLEncodePaddingPolicy::Omit, aOut)) &&
         !aOut.IsEmpty();
}

bool B64Decode(const nsACString& aB64, nsTArray<uint8_t>& aOut) {
  aOut.Clear();
  FallibleTArray<uint8_t> bytes;
  if (NS_FAILED(Base64URLDecode(aB64, Base64URLDecodePaddingPolicy::Ignore,
                                bytes))) {
    return false;
  }
  aOut.AppendElements(bytes.Elements(), bytes.Length());
  return true;
}

nsAutoCString PrefFor(const nsACString& aCredIdB64, const char* aField) {
  nsAutoCString pref(kPrefRoot);
  pref.Append(aCredIdB64);
  pref.Append(aField);
  return pref;
}

// Preferences getters take the pref name as a raw NUL-terminated string;
// this helper keeps the call sites readable.
nsAutoCString GetStringPref(const nsAutoCString& aPref) {
  nsAutoCString value;
  Preferences::GetCString(aPref.get(), value);
  return value;
}

bool IsStoredKey(const nsACString& aCredIdB64) {
  nsAutoCString keyPref(PrefFor(aCredIdB64, ".key"));
  return Preferences::GetType(keyPref.get()) == nsIPrefBranch::PREF_STRING &&
         !GetStringPref(keyPref).IsEmpty();
}

}  // namespace

void RozeLynxPasskeyStore::GetAll(nsTArray<RozeLynxPasskeyRecord>& aOut) {
  aOut.Clear();

  nsCOMPtr<nsIPrefBranch> root = Preferences::GetRootBranch();
  nsTArray<nsCString> children;
  if (!root || NS_FAILED(root->GetChildList(kPrefRoot.get(), children))) {
    return;
  }

  // Fixed-capacity string types (nsAutoCString) cannot live in a container;
  // nsCString elements copy the id out of the temporary.
  nsTArray<nsCString> ids;
  nsTArray<bool> hasKey;
  for (const nsCString& child : children) {
    // <root><b64url credentialId>.<field>; b64url never contains '.'.
    int32_t dot = child.RFindChar('.');
    if (dot < 0 ||
        static_cast<uint32_t>(dot) <= kPrefRoot.Length()) {
      continue;
    }
    nsAutoCString id(Substring(child, kPrefRoot.Length(),
                              dot - kPrefRoot.Length()));
    if (!ids.Contains(id)) {
      ids.AppendElement(id);
      hasKey.AppendElement(IsStoredKey(id));
    }
  }

  for (size_t i = 0; i < ids.Length(); i++) {
    const nsCString& id = ids[i];
    if (!hasKey[i]) {
      continue;
    }
    RozeLynxPasskeyRecord record;
    if (!B64Decode(id, record.mCredentialId)) {
      continue;
    }
    record.mRpId = GetStringPref(PrefFor(id, ".rpid"));
    record.mUserName =
        NS_ConvertUTF8toUTF16(GetStringPref(PrefFor(id, ".user")));
    record.mUserDisplayName =
        NS_ConvertUTF8toUTF16(GetStringPref(PrefFor(id, ".disp")));
    B64Decode(GetStringPref(PrefFor(id, ".handle")), record.mUserHandle);
    if (!B64Decode(GetStringPref(PrefFor(id, ".key")),
                   record.mPkcs8) ||
        record.mPkcs8.IsEmpty()) {
      continue;  // No usable private key.
    }
    record.mSignCount = std::clamp(
        Preferences::GetInt(PrefFor(id, ".count").get(), 0), 0, INT32_MAX);
    record.mResident = Preferences::GetBool(PrefFor(id, ".rk").get(), true);
    nsAutoCString created(GetStringPref(PrefFor(id, ".created")));
    record.mCreated = strtoll(created.get(), nullptr, 10);
    if (record.mCreated <= 0) {
      record.mCreated = 0;
    }
    aOut.AppendElement(std::move(record));
  }

  // Oldest-first: when several credentials match a request, the selection
  // prompt lists the most recently created one last.
  aOut.Sort([](const RozeLynxPasskeyRecord& a, const RozeLynxPasskeyRecord& b) {
    return a.mCreated < b.mCreated ? -1 : (a.mCreated > b.mCreated ? 1 : 0);
  });
}

void RozeLynxPasskeyStore::Put(const RozeLynxPasskeyRecord& aRecord) {
  nsAutoCString credIdB64;
  nsAutoCString keyB64;
  if (!B64Encode(aRecord.mCredentialId, credIdB64) ||
      !B64Encode(aRecord.mPkcs8, keyB64)) {
    return;
  }
  nsAutoCString handleB64;
  B64Encode(aRecord.mUserHandle, handleB64);
  nsAutoCString created;
  created.AppendInt(aRecord.mCreated);

  Preferences::SetCString(PrefFor(credIdB64, ".rpid").get(), aRecord.mRpId);
  Preferences::SetCString(
      PrefFor(credIdB64, ".user").get(),
      NS_ConvertUTF16toUTF8(aRecord.mUserName));
  Preferences::SetCString(
      PrefFor(credIdB64, ".disp").get(),
      NS_ConvertUTF16toUTF8(aRecord.mUserDisplayName));
  Preferences::SetCString(PrefFor(credIdB64, ".handle").get(), handleB64);
  Preferences::SetCString(PrefFor(credIdB64, ".key").get(), keyB64);
  Preferences::SetInt(PrefFor(credIdB64, ".count").get(),
                      static_cast<int32_t>(std::clamp(
                          static_cast<int64_t>(aRecord.mSignCount),
                          int64_t(0), int64_t(INT32_MAX))));
  Preferences::SetBool(PrefFor(credIdB64, ".rk").get(), aRecord.mResident);
  Preferences::SetCString(PrefFor(credIdB64, ".created").get(), created);
}

void RozeLynxPasskeyStore::UpdateSignCount(
    const nsTArray<uint8_t>& aCredentialId, uint32_t aSignCount) {
  nsAutoCString credIdB64;
  if (!B64Encode(aCredentialId, credIdB64)) {
    return;
  }
  if (!IsStoredKey(credIdB64)) {
    return;
  }
  Preferences::SetInt(
      PrefFor(credIdB64, ".count").get(),
      static_cast<int32_t>(std::clamp(static_cast<int64_t>(aSignCount),
                                      int64_t(0), int64_t(INT32_MAX))));
}

void RozeLynxPasskeyStore::Remove(const nsTArray<uint8_t>& aCredentialId) {
  nsAutoCString credIdB64;
  if (!B64Encode(aCredentialId, credIdB64)) {
    return;
  }
  static constexpr const char* kFields[] = {
      ".rpid", ".user", ".disp", ".handle", ".key",
      ".count", ".rk", ".created",
  };
  for (const char* field : kFields) {
    nsAutoCString pref(PrefFor(credIdB64, field));
    if (Preferences::HasUserValue(pref.get())) {
      Preferences::ClearUser(pref.get());
    }
  }
}

}  // namespace mozilla::dom