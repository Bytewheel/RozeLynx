/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "RozeLynxHandoff.h"

#include "mozilla/Printf.h"
#include "mozilla/Services.h"
#include "mozilla/SpinEventLoopUntil.h"
#include "nsCOMPtr.h"
#include "nsDependentString.h"
#include "nsDirectoryServiceDefs.h"
#include "nsIChannel.h"
#include "nsICookieManager.h"
#include "nsIFile.h"
#include "nsIHttpProtocolHandler.h"
#include "nsIObserverService.h"
#include "nsIPrefBranch.h"
#include "nsIPrefService.h"
#include "nsIURI.h"
#include "nsNetCID.h"
#include "nsNetUtil.h"
#include "nsPrintfCString.h"
#include "nsServiceManagerUtils.h"
#include "nsString.h"
#include "nsXPCOMCID.h"

#include <fcntl.h>
#include <poll.h>
#include <spawn.h>
#include <sys/stat.h>
#include <unistd.h>
#include <cstring>

extern char** environ;

#define LOG(level, ...)                                          \
  do {                                                           \
    if (level <= 1) {                                            \
      printf_stderr("[RozeLynx:handoff] " __VA_ARGS__);          \
      printf_stderr("\n");                                        \
    }                                                             \
  } while (0)

namespace mozilla {

static StaticRefPtr<RozeLynxHandoff> gRozeLynxHandoff;

// Bounds, shared values with the old extension implementation where they
// existed there: 16 handler rows, 1.5s per handler, 16MiB frame cap.
static constexpr size_t kMaxHandlers = 16;
static constexpr uint32_t kHandoffTimeoutMs = 1500;
static constexpr size_t kMaxFrame = 16u * 1024u * 1024u;
static constexpr const char* kPrefMode = "rozelynx.downloads.handoff.enabled";
static constexpr const char* kPrefMinSize =
    "rozelynx.downloads.handoff.min_size";
static constexpr const char* kPrefExclude =
    "rozelynx.downloads.handoff.exclude";
static constexpr const char* kPrefExtStates =
    "rozelynx.downloads.handoff.extensions";
static constexpr const char* kPrefDeferTo =
    "rozelynx.downloads.handoff.defer_to";
static constexpr const char* kPrefHandlerId = "rozelynx.downloads.handler.";
static constexpr const char* kExtObserverTopic = "rozelynx-handoff-ext";

// ── RozeLynxHandoffHandlerInfo (the handler-row object for the Settings
// editor) ──────────────────────────────────────────────────────────────

NS_IMPL_ISUPPORTS(RozeLynxHandoffHandlerInfo, nsIRozeLynxHandoffHandler)

NS_IMETHODIMP
RozeLynxHandoffHandlerInfo::GetIndex(int32_t* aIndex) {
  *aIndex = mIndex;
  return NS_OK;
}
NS_IMETHODIMP
RozeLynxHandoffHandlerInfo::SetIndex(int32_t aIndex) {
  mIndex = aIndex;
  return NS_OK;
}
NS_IMETHODIMP
RozeLynxHandoffHandlerInfo::GetId(nsACString& aId) {
  aId = mId;
  return NS_OK;
}
NS_IMETHODIMP
RozeLynxHandoffHandlerInfo::SetId(const nsACString& aId) {
  mId = aId;
  return NS_OK;
}
NS_IMETHODIMP
RozeLynxHandoffHandlerInfo::GetKind(nsACString& aKind) {
  aKind = mKind;
  return NS_OK;
}
NS_IMETHODIMP
RozeLynxHandoffHandlerInfo::SetKind(const nsACString& aKind) {
  mKind = aKind;
  return NS_OK;
}
NS_IMETHODIMP
RozeLynxHandoffHandlerInfo::GetLabel(nsACString& aLabel) {
  aLabel = mLabel;
  return NS_OK;
}
NS_IMETHODIMP
RozeLynxHandoffHandlerInfo::SetLabel(const nsACString& aLabel) {
  mLabel = aLabel;
  return NS_OK;
}
NS_IMETHODIMP
RozeLynxHandoffHandlerInfo::GetHint(nsACString& aHint) {
  aHint = mHint;
  return NS_OK;
}
NS_IMETHODIMP
RozeLynxHandoffHandlerInfo::SetHint(const nsACString& aHint) {
  mHint = aHint;
  return NS_OK;
}
NS_IMETHODIMP
RozeLynxHandoffHandlerInfo::GetArgs(nsACString& aArgs) {
  aArgs = mArgs;
  return NS_OK;
}
NS_IMETHODIMP
RozeLynxHandoffHandlerInfo::SetArgs(const nsACString& aArgs) {
  mArgs = aArgs;
  return NS_OK;
}
NS_IMETHODIMP
RozeLynxHandoffHandlerInfo::GetEnabled(bool* aEnabled) {
  *aEnabled = mEnabled;
  return NS_OK;
}
NS_IMETHODIMP
RozeLynxHandoffHandlerInfo::SetEnabled(bool aEnabled) {
  mEnabled = aEnabled;
  return NS_OK;
}
NS_IMETHODIMP
RozeLynxHandoffHandlerInfo::GetAvailable(bool* aAvailable) {
  *aAvailable = mAvailable;
  return NS_OK;
}
NS_IMETHODIMP
RozeLynxHandoffHandlerInfo::SetAvailable(bool aAvailable) {
  mAvailable = aAvailable;
  return NS_OK;
}
NS_IMETHODIMP
RozeLynxHandoffHandlerInfo::GetDetail(nsACString& aDetail) {
  aDetail = mDetail;
  return NS_OK;
}
NS_IMETHODIMP
RozeLynxHandoffHandlerInfo::SetDetail(const nsACString& aDetail) {
  mDetail = aDetail;
  return NS_OK;
}

// File-local: JSON string escaping for the two hand-built payloads (the
// uget-integrator message, the ext: relay request). No JSON engine needed.
static void AppendJsonString(nsACString& aOut, const nsACString& aStr) {
  aOut.Append('"');
  const char* p = aStr.BeginReading();
  const uint32_t len = aStr.Length();
  for (uint32_t i = 0; i < len; i++) {
    const char ch = p[i];
    switch (ch) {
      case '"': aOut.AppendLiteral("\\\""); break;
      case '\\': aOut.AppendLiteral("\\\\"); break;
      case '\n': aOut.AppendLiteral("\\n"); break;
      case '\r': aOut.AppendLiteral("\\r"); break;
      case '\t': aOut.AppendLiteral("\\t"); break;
      default:
        if ((unsigned char)ch < 0x20) {
          aOut.AppendPrintf("\\u%04x", ch);
        } else {
          aOut.Append(ch);
        }
    }
  }
  aOut.Append('"');
}

NS_IMPL_ISUPPORTS(RozeLynxHandoff, nsIRozeLynxHandoff, nsIObserver)

// static
already_AddRefed<RozeLynxHandoff> RozeLynxHandoff::GetSingleton() {
  if (gRozeLynxHandoff) {
    return do_AddRef(gRozeLynxHandoff);
  }
  auto svc = MakeRefPtr<RozeLynxHandoff>();
  gRozeLynxHandoff = svc;
  return svc.forget();
}

RozeLynxHandoff::RozeLynxHandoff() {
  nsCOMPtr<nsIPrefBranch> branch = do_GetService(NS_PREFSERVICE_CONTRACTID);
  if (branch) {
    // Observe the whole subtree: the handler rows are indexed prefs and
    // any row edit must invalidate the cached parse.
    branch->AddObserver("rozelynx.downloads.", this, false);
  }
}

RozeLynxHandoff::~RozeLynxHandoff() = default;

// ── nsIObserver ───────────────────────────────────────────────────────

NS_IMETHODIMP
RozeLynxHandoff::Observe(nsISupports* aSubject, const char* aTopic,
                         const char16_t* aData) {
  if (!strcmp(aTopic, NS_PREFBRANCH_PREFCHANGE_TOPIC_ID)) {
    mPrefsDirty = true;  // re-read + re-probe on the next gate pass
  }
  return NS_OK;
}

// ── prefs / config ────────────────────────────────────────────────────

void RozeLynxHandoff::ReadPrefs() {
  mHavePrefs = true;
  mPrefsDirty = false;

  nsCOMPtr<nsIPrefBranch> branch = do_GetService(NS_PREFSERVICE_CONTRACTID);

  // mode: a STRING with three states ('auto' default, 'true', 'false') -
  // the old pref, kept verbatim so existing about:config edits survive.
  nsCString mode("auto"_ns);
  if (branch) {
    nsAutoCString value;
    if (NS_SUCCEEDED(branch->GetCharPref(kPrefMode, value))) {
      value.Trim(" \t");
      ToLowerCase(value);
      if (value.EqualsLiteral("true") || value.EqualsLiteral("on") ||
          value.EqualsLiteral("yes") || value.EqualsLiteral("1")) {
        mode = "true"_ns;
      } else if (value.EqualsLiteral("false") ||
                 value.EqualsLiteral("off") ||
                 value.EqualsLiteral("no") || value.EqualsLiteral("0")) {
        mode = "false"_ns;
      }
    }
  }
  mMode = mode;

  mMinSize = 300 * 1024;
  if (branch) {
    int32_t v = 0;
    if (NS_SUCCEEDED(branch->GetIntPref(kPrefMinSize, &v)) && v >= 0) {
      mMinSize = v;
    }
  }

  mDeferTo.Truncate();
  if (branch) {
    nsAutoCString deferTo;
    if (NS_SUCCEEDED(branch->GetCharPref(kPrefDeferTo, deferTo))) {
      deferTo.Trim(" \t");
      if (!deferTo.IsEmpty()) {
        mDeferTo = deferTo;
      }
    }
  }

  mExclude.Clear();
  if (branch) {
    nsAutoCString exclude;
    if (NS_SUCCEEDED(branch->GetCharPref(kPrefExclude, exclude))) {
      // space or comma separated substrings, like the old reader
      int32_t start = 0;
      while (start < (int32_t)exclude.Length()) {
        int32_t end = exclude.FindCharInSet(" \t,", start);
        if (end < 0) end = exclude.Length();
        if (end > start) {
          mExclude.AppendElement(Substring(exclude, start, end - start));
        }
        start = end + 1;
      }
    }
  }

  // The handler rows: 0..15, first missing .id ends the list (a gap is a
  // hole, exactly like the old reader - a row after a hole would be
  // invisible in the editor while still being a live pref).
  mHandlers.Clear();
  for (size_t i = 0; i < kMaxHandlers; i++) {
    nsPrintfCString idName("%s%zu.id", kPrefHandlerId, i);
    nsAutoCString id;
    if (!branch ||
        NS_FAILED(branch->GetCharPref(idName.get(), id)) || id.IsEmpty()) {
      break;
    }
    id.Trim(" \t");
    HandoffHandler h;
    h.id = id;
    if (id.EqualsLiteral("uget")) {
      h.kind = "builtin"_ns;
      h.label = "uGet (uget-gtk)"_ns;
      h.hint = "built in: speaks uget-integrator's own stdio protocol, "
               "with cookies"_ns;
    } else if (StringBeginsWith(id, "cmd:"_ns)) {
      h.kind = "cmd"_ns;
      h.label = Substring(id, 4);
      h.hint = "a program on PATH"_ns;
    } else if (StringBeginsWith(id, "ext:"_ns)) {
      h.kind = "ext"_ns;
      h.label = Substring(id, 4);
      h.hint = "an extension that answers download messages"_ns;
    } else {
      // A bare word is NOT silently promoted to cmd: - that would run
      // whatever the user typed the moment they saved a half-finished
      // row. An unknown id is shown, never run.
      h.kind = "unknown"_ns;
      h.label = id;
      h.hint = "not a known handler: use uget, ext:<id> or cmd:<program>"_ns;
    }
    nsPrintfCString argsName("%s%zu.args", kPrefHandlerId, i);
    if (branch) {
      nsAutoCString args;
      if (NS_SUCCEEDED(branch->GetCharPref(argsName.get(), args))) {
        h.args = args;
      }
    }
    bool enabled = true;
    nsPrintfCString enabledName("%s%zu.enabled", kPrefHandlerId, i);
    if (branch) {
      // Absent means enabled: a hand-written .id pref with no .enabled
      // beside it is a working handler, not a dead one.
      branch->GetBoolPref(enabledName.get(), &enabled);
    }
    h.enabled = enabled;
    mHandlers.AppendElement(std::move(h));
  }

  ReadExtStates();
}

void RozeLynxHandoff::ReadExtStates() {
  mExtStates.Clear();
  nsCOMPtr<nsIPrefBranch> branch = do_GetService(NS_PREFSERVICE_CONTRACTID);
  if (!branch) {
    return;
  }
  nsAutoCString json;
  if (NS_FAILED(branch->GetCharPref(kPrefExtStates, json))) {
    return;
  }
  // The relay writes {"<id>": true, "<id2>": false}. Extension ids are
  // [a-z0-9@._-] by construction, so the scanner can treat every quoted
  // run as an id; a tiny scanner beats a JSON engine dependency for two
  // booleans per entry.
  int32_t i = 0;
  const int32_t len = json.Length();
  while (i < len) {
    int32_t q1 = json.FindChar('"', i);
    if (q1 < 0) break;
    int32_t q2 = json.FindChar('"', q1 + 1);
    if (q2 < 0) break;
    int32_t colon = json.FindChar(':', q2 + 1);
    if (colon < 0) break;
    int32_t comma = json.FindChar(',', colon + 1);
    int32_t end = comma < 0 ? len : comma;
    int32_t truePos = json.Find("true", colon + 1);
    int32_t falsePos = json.Find("false", colon + 1);
    bool enabled;
    if (truePos >= 0 && truePos < end &&
        (falsePos < 0 || truePos < falsePos)) {
      enabled = true;
    } else if (falsePos >= 0 && falsePos < end) {
      enabled = false;
    } else {
      i = q2 + 1;
      continue;
    }
    if (q2 > q1 + 1) {
      ExtState st;
      st.id.Assign(Substring(json, q1 + 1, q2 - q1 - 1));
      st.enabled = enabled;
      mExtStates.AppendElement(std::move(st));
    }
    i = end + 1;
  }
}

bool RozeLynxHandoff::ModeEnabled() {
  // 'auto' keys off the one signal that is both observable and meaningful:
  // at least one enabled handler can actually take a download right now.
  if (mMode.EqualsLiteral("true")) return true;
  if (mMode.EqualsLiteral("false")) return false;
  for (const auto& h : mHandlers) {
    if (h.enabled && h.available) {
      return true;
    }
  }
  return false;
}

bool RozeLynxHandoff::IsExcluded(const nsACString& aURL) const {
  for (const auto& substr : mExclude) {
    if (!substr.IsEmpty() && aURL.Find(substr) >= 0) {
      return true;
    }
  }
  return false;
}

// ── probing ─────────────────────────────────────────────────────────────

bool RozeLynxHandoff::ResolveOnPath(const nsACString& aProgram,
                                    nsCString& aOutPath) const {
  // A bare program name only: a path, a glob or an empty string is
  // refused by the same rule the native host applied, so "cmd:../evil"
  // can never exist.
  if (aProgram.IsEmpty() || aProgram.Length() > 255) {
    return false;
  }
  const char* p = aProgram.BeginReading();
  const uint32_t len = aProgram.Length();
  for (uint32_t i = 0; i < len; i++) {
    const char ch = p[i];
    if (!((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
          (ch >= '0' && ch <= '9') || ch == '.' || ch == '_' || ch == '-' ||
          ch == '+')) {
      return false;
    }
  }
  const char* pathEnv = getenv("PATH");
  if (!pathEnv) {
    return false;
  }
  for (const auto& dir : nsDependentCString(pathEnv).Split(':')) {
    if (dir.IsEmpty()) {
      continue;
    }
    aOutPath.Assign(dir);
    aOutPath.Append('/');
    aOutPath.Append(aProgram);
    if (access(PromiseFlatCString(aOutPath).get(), X_OK) == 0) {
      struct stat st;
      if (stat(PromiseFlatCString(aOutPath).get(), &st) == 0 &&
          S_ISREG(st.st_mode)) {
        return true;
      }
    }
  }
  aOutPath.Truncate();
  return false;
}

bool RozeLynxHandoff::ReadFramedReply(int aFd, nsACString& aOut,
                                      nsACString& aError) {
  // 4-byte native-order length prefix, like Firefox's own native messaging
  // and uget-integrator's reader, with a bounded wait for the handshake.
  struct pollfd pfd = {aFd, POLLIN, 0};
  char head[4];
  size_t have = 0;
  PRTime deadline = PR_Now() + (PRTime)kHandoffTimeoutMs * PR_USEC_PER_MSEC;
  auto waitFor = [&](size_t remaining) {
    PRTime now = PR_Now();
    if (now >= deadline) return false;
    return poll(&pfd, 1, (int)((deadline - now) / PR_USEC_PER_MSEC) + 1) > 0;
  };
  while (have < 4) {
    if (!waitFor(4 - have)) {
      aError = "no reply within the timeout"_ns;
      return false;
    }
    ssize_t n = read(aFd, head + have, 4 - have);
    if (n <= 0) {
      aError = "the reply ended early"_ns;
      return false;
    }
    have += n;
  }
  uint32_t len = (unsigned char)head[0] | ((unsigned char)head[1] << 8) |
                 ((unsigned char)head[2] << 16) |
                 ((unsigned char)head[3] << 24);
  if (len > kMaxFrame) {
    aError = "the reply is too large to be a handshake"_ns;
    return false;
  }
  aOut.SetLength(len);
  char* body = aOut.BeginWriting();
  have = 0;
  while (have < len) {
    if (!waitFor(len - have)) {
      aError = "the reply ended early"_ns;
      return false;
    }
    ssize_t n = read(aFd, body + have, len - have);
    if (n <= 0) {
      aError = "the reply ended early"_ns;
      return false;
    }
    have += n;
  }
  return true;
}

bool RozeLynxHandoff::ExtractJsonStringField(const nsACString& aJson,
                                             const nsACString& aField,
                                             nsACString& aOutValue) {
  // A one-string-field reader for the uget-integrator reply
  // ({"Status": "Available", ...}). Frames are tiny; correctness over
  // generality, and no JS engine dependency for one field.
  nsPrintfCString needle("\"%s\"", PromiseFlatCString(aField).get());
  int32_t at = aJson.Find(PromiseFlatCString(needle));
  if (at < 0) {
    return false;
  }
  int32_t q1 = aJson.FindChar('"', at + needle.Length());
  if (q1 < 0) return false;
  int32_t q2 = aJson.FindChar('"', q1 + 1);
  if (q2 < 0) return false;
  aOutValue = Substring(aJson, q1 + 1, q2 - q1 - 1);
  return true;
}

bool RozeLynxHandoff::ProbeUget(nsCString& aOutDetail) {
  // The probe is uget-integrator's own version handshake: a frame with no
  // "URL" key makes it answer {"Status","Version","Uget"} and download
  // nothing - the same handshake uGet's own extension uses to decide
  // whether it may interrupt downloads at all.
  nsTArray<nsCString> noArgs;
  SpawnResult sp = SpawnDetached("uget-integrator"_ns, noArgs, true);
  if (!sp.ok) {
    aOutDetail = sp.error;
    return false;
  }
  static const char kFrame[] = "{\"probe\":true}";
  uint32_t len = strlen(kFrame);
  char head[4] = {(char)(len & 0xff), (char)((len >> 8) & 0xff),
                  (char)((len >> 16) & 0xff), (char)((len >> 24) & 0xff)};
  if (write(sp.stdinFd, head, 4) != 4 ||
      write(sp.stdinFd, kFrame, len) != (ssize_t)len) {
    close(sp.stdinFd);
    close(sp.stdoutFd);
    aOutDetail = "write to uget-integrator failed"_ns;
    return false;
  }
  close(sp.stdinFd);

  nsAutoCString reply;
  nsAutoCString err;
  bool ok = ReadFramedReply(sp.stdoutFd, reply, err);
  close(sp.stdoutFd);
  if (!ok) {
    aOutDetail = err;
    return false;
  }
  nsAutoCString status;
  if (!ExtractJsonStringField(reply, "Status"_ns, status)) {
    aOutDetail = "unreadable reply from uget-integrator"_ns;
    return false;
  }
  if (!status.LowerCaseEqualsLiteral("available")) {
    aOutDetail = "uget-integrator answered: "_ns + status;
    return false;
  }
  aOutDetail = "uget-integrator answered"_ns;
  return true;
}

void RozeLynxHandoff::ProbeOne(HandoffHandler& aHandler) {
  if (!aHandler.enabled) {
    aHandler.available = false;
    aHandler.detail = "disabled";
    return;
  }
  if (aHandler.IsBuiltin()) {
    aHandler.available = ProbeUget(aHandler.detail);
    return;
  }
  if (aHandler.IsCmd()) {
    nsAutoCString path;
    nsAutoCString program(Substring(aHandler.id, 4));
    if (ResolveOnPath(program, path)) {
      aHandler.available = true;
      aHandler.detail = path;
    } else {
      aHandler.available = false;
      aHandler.detail = program + " not found on PATH"_ns;
    }
    return;
  }
  if (aHandler.IsExt()) {
    // The RozeLynx extension relay maintains the enabled-extension cache
    // in rozelynx.downloads.handoff.extensions; without the relay nobody
    // can deliver a message to the target extension, so "unavailable" is
    // the honest probe.
    nsAutoCString extId(Substring(aHandler.id, 4));
    for (const auto& st : mExtStates) {
      if (st.id == extId) {
        aHandler.available = st.enabled;
        aHandler.detail =
            st.enabled ? "installed and enabled"_ns : "installed, disabled"_ns;
        return;
      }
    }
    aHandler.available = false;
    aHandler.detail = "not installed, or the relay is"_ns;
    return;
  }
  aHandler.available = false;
  aHandler.detail = "not a handler this build knows"_ns;
}

void RozeLynxHandoff::ProbeAll() {
  for (auto& h : mHandlers) {
    ProbeOne(h);
  }
}

// ── nsIRozeLynxHandoff ─────────────────────────────────────────────────

NS_IMETHODIMP
RozeLynxHandoff::GetHandlers(
    nsTArray<RefPtr<nsIRozeLynxHandoffHandler>>& aOut) {
  if (mPrefsDirty || !mHavePrefs) {
    ReadPrefs();
    ProbeAll();
  }
  aOut.Clear();
  for (size_t i = 0; i < mHandlers.Length(); i++) {
    const auto& h = mHandlers[i];
    auto* info = new RozeLynxHandoffHandlerInfo();
    info->mIndex = (int32_t)i;
    info->mId = h.id;
    info->mKind = h.kind;
    info->mLabel = h.label;
    info->mHint = h.hint;
    info->mArgs = h.args;
    info->mEnabled = h.enabled;
    info->mAvailable = h.available;
    info->mDetail = h.detail;
    aOut.AppendElement(do_AddRef(static_cast<nsIRozeLynxHandoffHandler*>(info)));
  }
  return NS_OK;
}

NS_IMETHODIMP
RozeLynxHandoff::RefreshProbes() {
  if (mPrefsDirty || !mHavePrefs) {
    ReadPrefs();
  }
  ProbeAll();
  return NS_OK;
}

NS_IMETHODIMP
RozeLynxHandoff::ShouldTakeDownload(const nsACString& aURL, int64_t aSize,
                                    nsACString& aHandlerId, bool* aTook) {
  *aTook = false;
  aHandlerId.Truncate();
  if (aURL.IsEmpty()) {
    return NS_OK;
  }
  if (!StringBeginsWith(aURL, "http://"_ns) &&
      !StringBeginsWith(aURL, "https://"_ns)) {
    return NS_OK;  // non-http scheme: not ours
  }
  if (mPrefsDirty || !mHavePrefs) {
    ReadPrefs();
    ProbeAll();
  }
  // Stand down for another download-manager integration when one is named
  // AND actually enabled: deferring blindly would leave every download to
  // the browser while the pref reads "on", the exact failure the pref
  // exists to avoid.
  if (!mDeferTo.IsEmpty()) {
    for (const auto& st : mExtStates) {
      if (st.id == mDeferTo && st.enabled) {
        return NS_OK;
      }
    }
  }
  if (!ModeEnabled()) {
    return NS_OK;
  }
  if (IsExcluded(aURL)) {
    return NS_OK;
  }
  // -1 = unknown size, which is NOT evidence of a small file (a missing
  // Content-Length must not silently keep the download in the browser).
  if (mMinSize > 0 && aSize >= 0 && aSize < mMinSize) {
    return NS_OK;
  }
  for (const auto& h : mHandlers) {
    if (h.enabled && h.available) {
      aHandlerId = h.id;
      *aTook = true;
      return NS_OK;
    }
  }
  return NS_OK;
}

NS_IMETHODIMP
RozeLynxHandoff::TakeDownload(const nsACString& aURL, const nsACString& aFilename,
                              const nsACString& aReferer, int64_t aSize,
                              nsIURI* aChannelURI, nsIChannel* aChannel,
                              nsACString& aTookVia) {
  aTookVia.Truncate();
  if (mPrefsDirty || !mHavePrefs) {
    ReadPrefs();
    ProbeAll();
  }
  if (!ModeEnabled()) {
    return NS_OK;
  }

  nsAutoCString cookiesText;
  if (aChannelURI) {
    CollectCookies(aChannelURI, aChannel, cookiesText);
  }
  nsCString ua = UserAgentLike();

  // Ordered and SEQUENTIAL on purpose: parallel attempts would hand the
  // same download to two managers, and the order is the user's stated
  // priority. A handler that is merely present but has not answered yet is
  // not skipped - the timeout bound inside each Run* is the bound on being
  // that slow.
  for (auto& h : mHandlers) {
    if (!h.enabled || !h.available) {
      continue;
    }
    nsCString error;
    bool took = false;
    if (h.IsBuiltin()) {
      took = RunUget(aURL, aFilename, aReferer, cookiesText, ua, aSize, error);
    } else if (h.IsCmd()) {
      pid_t pid = -1;
      took = RunCmd(h, aURL, aFilename, aReferer, cookiesText, ua, error, pid);
    } else if (h.IsExt()) {
      nsAutoCString extId(Substring(h.id, 4));
      took = RunExt(extId, aURL, aFilename, aReferer, error);
    } else {
      continue;
    }
    if (took) {
      aTookVia = h.id;
      return NS_OK;
    }
    LOG(1, "handler %s declined or failed: %s; trying the next",
        h.id.get(), error.get());
  }
  return NS_OK;
}

NS_IMETHODIMP
RozeLynxHandoff::RespondExtHandler(uint32_t aRequestId, bool aAccepted,
                                   const nsACString& aError) {
  if (aRequestId != mExtRequestId) {
    return NS_OK;  // a stale answer to an already-finished wait
  }
  mExtAccepted = aAccepted;
  mExtError = aError;
  mExtResponseSeen = true;
  return NS_OK;
}

// ── execution helpers ───────────────────────────────────────────────────

// static
nsCString RozeLynxHandoff::UserAgentLike() {
  // The browser's own UA, the same string the old extension sent as
  // navigator.userAgent. The user-agent override module is deliberately
  // not consulted: the manager wants to know what FETCHED the download.
  nsCOMPtr<nsIHttpProtocolHandler> http(
      do_GetService(NS_NETWORK_PROTOCOL_CONTRACTID_PREFIX "http"));
  nsAutoCString ua;
  if (http) {
    http->GetUserAgent(ua);
  }
  return std::move(ua);
}

RozeLynxHandoff::SpawnResult RozeLynxHandoff::SpawnDetached(
    const nsACString& aPath, const nsTArray<nsCString>& aArgv,
    bool aWantStdio) {
  SpawnResult out;

  // Bare program name or absolute path; PATH resolution for cmd: handlers
  // happened before here, and uget-integrator is resolved here.
  nsCString resolved(aPath);
  if (aPath.FindChar('/') < 0) {
    if (!ResolveOnPath(aPath, resolved)) {
      out.error = aPath + " not found on PATH"_ns;
      return out;
    }
  }

  // argv (posix_spawn wants a mutable pointer array; the strings
  // themselves are never written to)
  nsTArray<char*> argv;
  argv.AppendElement(const_cast<char*>(resolved.get()));
  for (const auto& a : aArgv) {
    argv.AppendElement(const_cast<char*>(a.get()));
  }
  argv.AppendElement(nullptr);

  int inPipe[2] = {-1, -1};   // parent writes -> child stdin
  int outPipe[2] = {-1, -1};  // child stdout -> parent reads
  int devnull = -1;
  posix_spawn_file_actions_t actions;

  auto fail = [&](const char* what) {
    if (inPipe[0] >= 0) close(inPipe[0]);
    if (inPipe[1] >= 0) close(inPipe[1]);
    if (outPipe[0] >= 0) close(outPipe[0]);
    if (outPipe[1] >= 0) close(outPipe[1]);
    if (devnull >= 0) close(devnull);
    out.error = nsPrintfCString("spawn %s: %s", resolved.get(), what);
    return out;
  };

  if (posix_spawn_file_actions_init(&actions) != 0) {
    return fail("posix_spawn_file_actions_init failed");
  }

  if (aWantStdio) {
    if (pipe2(inPipe, O_CLOEXEC) != 0) {
      posix_spawn_file_actions_destroy(&actions);
      return fail("pipe failed");
    }
    if (pipe2(outPipe, O_CLOEXEC) != 0) {
      posix_spawn_file_actions_destroy(&actions);
      return fail("pipe failed");
    }
    if (posix_spawn_file_actions_adddup2(&actions, inPipe[0], 0) != 0 ||
        posix_spawn_file_actions_adddup2(&actions, outPipe[1], 1) != 0) {
      posix_spawn_file_actions_destroy(&actions);
      return fail("dup2 failed");
    }
  } else {
    devnull = open("/dev/null", O_WRONLY | O_CLOEXEC);
    if (devnull < 0) {
      posix_spawn_file_actions_destroy(&actions);
      return fail("open(/dev/null) failed");
    }
    if (posix_spawn_file_actions_addclose(&actions, 0) != 0 ||
        posix_spawn_file_actions_adddup2(&actions, devnull, 1) != 0 ||
        posix_spawn_file_actions_adddup2(&actions, devnull, 2) != 0) {
      posix_spawn_file_actions_destroy(&actions);
      return fail("stdio redirect failed");
    }
  }

  // DETACHED, the same way the native host detached (start_new_session):
  // the manager's window outlives the browser, and a reaped or killed
  // child would take the download queue with it. POSIX_SPAWN_SETSID is in
  // glibc since 2.24; without it the child shares the browser's session,
  // which changes nothing but terminal-group semantics.
  posix_spawnattr_t attr;
  short flags = 0;
#ifdef POSIX_SPAWN_SETSID
  flags |= POSIX_SPAWN_SETSID;
#endif
  if (posix_spawnattr_init(&attr) == 0) {
    (void)posix_spawnattr_setflags(&attr, flags);
    posix_spawnattr_destroy(&attr);
  }

  pid_t pid = -1;
  int rc = posix_spawn(&pid, resolved.get(), &actions, nullptr,
                       argv.Elements(), environ);
  if (rc != 0) {
    posix_spawn_file_actions_destroy(&actions);
    return fail(strerror(rc));
  }
  posix_spawn_file_actions_destroy(&actions);

  // Close the child's ends in the parent.
  if (inPipe[0] >= 0) close(inPipe[0]);
  if (outPipe[1] >= 0) close(outPipe[1]);
  if (devnull >= 0) close(devnull);

  out.ok = true;
  out.pid = pid;
  out.stdinFd = aWantStdio ? inPipe[1] : -1;
  out.stdoutFd = aWantStdio ? outPipe[0] : -1;
  return out;
}

bool RozeLynxHandoff::RunUget(const nsACString& aURL, const nsACString& aFilename,
                              const nsACString& aReferer,
                              const nsACString& aCookiesText,
                              const nsACString& aUserAgent, int64_t aSize,
                              nsCString& aError) {
  // The message is the one uget Integration's own extension sends,
  // including the capitalised key names, because uget-integrator indexes
  // them literally and a missing key is a KeyError - every one has to be
  // present even when empty.
  nsAutoCString msg;
  msg.SetCapacity(256 + aURL.Length() + aFilename.Length() +
                  aCookiesText.Length());
  msg.AppendLiteral("{\"URL\":");
  AppendJsonString(msg, aURL);
  msg.AppendLiteral(",\"Cookies\":");
  AppendJsonString(msg, aCookiesText);
  msg.AppendLiteral(",\"UserAgent\":");
  AppendJsonString(msg, aUserAgent);
  msg.AppendLiteral(",\"FileName\":");
  AppendJsonString(msg, aFilename);
  msg.AppendLiteral(",\"FileSize\":\"");
  if (aSize >= 0) {
    msg.AppendInt(aSize);
  }
  msg.AppendLiteral("\",\"Referer\":");
  AppendJsonString(msg, aReferer);
  msg.AppendLiteral(",\"PostData\":\"\",\"Batch\":false,\"Version\":\"RozeLynx\"}");

  nsTArray<nsCString> noArgs;
  SpawnResult sp = SpawnDetached("uget-integrator"_ns, noArgs, true);
  if (!sp.ok) {
    aError = sp.error;
    return false;
  }
  uint32_t len = msg.Length();
  char head[4] = {(char)(len & 0xff), (char)((len >> 8) & 0xff),
                  (char)((len >> 16) & 0xff), (char)((len >> 24) & 0xff)};
  if (write(sp.stdinFd, head, 4) != 4 ||
      write(sp.stdinFd, msg.get(), len) != (ssize_t)len) {
    close(sp.stdinFd);
    close(sp.stdoutFd);
    aError = "write to uget-integrator failed"_ns;
    return false;
  }
  close(sp.stdinFd);

  nsAutoCString reply;
  if (!ReadFramedReply(sp.stdoutFd, reply, aError)) {
    close(sp.stdoutFd);
    return false;
  }
  close(sp.stdoutFd);

  nsAutoCString status;
  if (!ExtractJsonStringField(reply, "Status"_ns, status)) {
    aError = "unreadable reply from uget-integrator"_ns;
    return false;
  }
  if (!status.LowerCaseEqualsLiteral("available")) {
    aError = "uget-integrator refused the download: "_ns + status;
    return false;
  }
  return true;
}

// static
bool RozeLynxHandoff::SplitArgsTemplate(const nsACString& aTemplate,
                                        nsTArray<nsCString>& aOutArgv) {
  // A POSIX-ish split (single/double quotes, backslash escapes in
  // unquoted and double-quoted runs) - shlex.split's practical subset. The
  // ORDER MATTERS rule from the native host is kept whole: tokenise FIRST,
  // substitute per token SECOND, so a URL is always exactly one argument
  // however much whitespace or punctuation it carries.
  if (aTemplate.Length() > 1024) {
    return false;
  }
  nsAutoCString token;
  bool have = false;
  for (size_t i = 0; i < aTemplate.Length(); i++) {
    char ch = aTemplate[i];
    if (ch == '\'') {
      have = true;
      i++;
      while (i < aTemplate.Length() && aTemplate[i] != '\'') {
        token.Append(aTemplate[i]);
        i++;
      }
    } else if (ch == '"') {
      have = true;
      i++;
      while (i < aTemplate.Length() && aTemplate[i] != '"') {
        if (aTemplate[i] == '\\' && i + 1 < aTemplate.Length()) {
          i++;
        }
        token.Append(aTemplate[i]);
        i++;
      }
    } else if (ch == '\\' && i + 1 < aTemplate.Length()) {
      have = true;
      token.Append(aTemplate[i + 1]);
      i++;
    } else if (ch == ' ' || ch == '\t') {
      if (have) {
        aOutArgv.AppendElement(token);
        token.Truncate();
        have = false;
      }
    } else {
      have = true;
      token.Append(ch);
    }
  }
  if (have) {
    aOutArgv.AppendElement(token);
  }
  return !aOutArgv.IsEmpty() && aOutArgv.Length() <= 64;
}

// static
bool RozeLynxHandoff::SubstituteTokens(nsTArray<nsCString>& aArgv,
                                       const nsACString& aURL,
                                       const nsACString& aFilename,
                                       const nsACString& aReferer,
                                       const nsACString& aCookiePath,
                                       const nsACString& aUserAgent) {
  // A CLOSED placeholder set: an unknown one is an error rather than a
  // literal, because a template that silently does not expand is a handler
  // that silently downloads nothing. A token that expands to nothing is
  // DROPPED rather than passed empty, so `-o {filename} {url}` does what it
  // looks like when there is no filename to suggest.
  nsTArray<nsCString> out;
  for (auto& tok : aArgv) {
    nsAutoCString next;
    for (size_t i = 0; i < tok.Length(); i++) {
      if (tok[i] == '{' && i + 1 < tok.Length()) {
        int32_t close = tok.FindChar('}', i + 1);
        if (close < 0) {
          return false;
        }
        nsAutoCString placeholder(Substring(tok, i + 1, close - i - 1));
        if (placeholder.EqualsLiteral("url")) {
          next.Append(aURL);
        } else if (placeholder.EqualsLiteral("filename")) {
          next.Append(aFilename);
        } else if (placeholder.EqualsLiteral("referer")) {
          next.Append(aReferer);
        } else if (placeholder.EqualsLiteral("cookies")) {
          next.Append(aCookiePath);
        } else if (placeholder.EqualsLiteral("ua")) {
          next.Append(aUserAgent);
        } else {
          return false;  // unknown placeholder
        }
        i = close;
      } else {
        next.Append(tok[i]);
      }
    }
    if (!next.IsEmpty()) {
      out.AppendElement(next);
    }
  }
  aArgv = std::move(out);
  return !aArgv.IsEmpty();
}

bool RozeLynxHandoff::RunCmd(const HandoffHandler& aHandler,
                             const nsACString& aURL, const nsACString& aFilename,
                             const nsACString& aReferer,
                             const nsACString& aCookiesText,
                             const nsACString& aUserAgent, nsCString& aError,
                             pid_t& aOutPid) {
  nsAutoCString program(Substring(aHandler.id, 4));
  nsAutoCString path;
  if (!ResolveOnPath(program, path)) {
    aError = program + " not found on PATH"_ns;
    return false;
  }
  SweepStaleCookieFiles();
  nsAutoCString cookiePath;
  if (!aCookiesText.IsEmpty()) {
    // The manager wants a FILE of cookies (aria2 --load-cookies, wget
    // --load-cookies, curl -b all take one); the file is 0600 in a private
    // dir and swept an hour later, the same lifecycle the native host
    // gave it.
    nsresult rv = WriteCookieFile(aCookiesText, cookiePath);
    if (NS_FAILED(rv)) {
      aError = "could not write the cookie file"_ns;
      return false;
    }
  }
  nsTArray<nsCString> argv;
  nsAutoCString tmpl("{url}"_ns);
  if (!aHandler.args.IsEmpty()) {
    tmpl = aHandler.args;
  }
  if (!SplitArgsTemplate(tmpl, argv) ||
      !SubstituteTokens(argv, aURL, aFilename, aReferer, cookiePath,
                        aUserAgent)) {
    aError = "the args template does not parse"_ns;
    return false;
  }
  SpawnResult sp = SpawnDetached(path, argv, false);
  if (!sp.ok) {
    aError = sp.error;
    return false;
  }
  aOutPid = sp.pid;
  return true;
}

bool RozeLynxHandoff::RunExt(const nsACString& aExtId, const nsACString& aURL,
                             const nsACString& aFilename,
                             const nsACString& aReferer, nsCString& aError) {
  // Deliver the download to another EXTENSION. Only an extension can do
  // cross-extension messaging, so the RozeLynx Features extension carries a
  // tiny relay module: this fires the observer it listens on and spins the
  // main event loop - bounded - until the relay answers via
  // respondExtHandler(). The relay exists ONLY to forward this message;
  // the engine, the gate, the prefs and the Settings UI are all browser
  // code.
  nsCOMPtr<nsIObserverService> obs = mozilla::services::GetObserverService();
  if (!obs) {
    aError = "no observer service"_ns;
    return false;
  }
  mExtRequestId++;
  mExtResponseSeen = false;
  mExtAccepted = false;
  mExtError.Truncate();

  nsAutoCString payload;
  payload.AppendLiteral("{\"requestId\":");
  payload.AppendInt(mExtRequestId);
  payload.AppendLiteral(",\"extId\":");
  AppendJsonString(payload, aExtId);
  payload.AppendLiteral(",\"url\":");
  AppendJsonString(payload, aURL);
  payload.AppendLiteral(",\"filename\":");
  AppendJsonString(payload, aFilename);
  payload.AppendLiteral(",\"referer\":");
  AppendJsonString(payload, aReferer);
  payload.AppendLiteral("}");

  nsresult rv = obs->NotifyObservers(nullptr, kExtObserverTopic,
                                      NS_ConvertUTF8toUTF16(payload).get());
  if (NS_FAILED(rv)) {
    aError = "the relay did not answer"_ns;
    return false;
  }

  PRTime deadline = PR_Now() + (PRTime)kHandoffTimeoutMs * PR_USEC_PER_MSEC;
  SpinEventLoopUntil("RozeLynx: hand-off ext reply"_ns, [&]() {
    return mExtResponseSeen || PR_Now() >= deadline;
  });
  if (!mExtResponseSeen) {
    aError = "the extension did not answer within the timeout"_ns;
    return false;
  }
  if (!mExtAccepted) {
    aError = mExtError.IsEmpty() ? "the extension did not acknowledge"_ns
                                 : mExtError;
    return false;
  }
  return true;
}

// ── cookies ─────────────────────────────────────────────────────────────

nsresult RozeLynxHandoff::CollectCookies(nsIURI* aURI, nsIChannel* aChannel,
                                         nsACString& aOutText) {
  // Netscape cookie-file format, the field order uget-integrator's parser
  // reads (and the old extension wrote).  Only cookies that would be sent
  // to this URL's host belong in the file: host cookies for the exact host
  // and domain cookies whose base matches.
  nsCOMPtr<nsICookieManager> manager =
      do_GetService(NS_COOKIEMANAGER_CONTRACTID);
  if (!manager) {
    return NS_ERROR_UNEXPECTED;
  }
  nsAutoCString host;
  if (NS_FAILED(aURI->GetHost(host)) || host.IsEmpty()) {
    return NS_OK;
  }
  host.Trim(".", false, true);  // a trailing dot is acceptable
  nsAutoCString lcHost(host);
  ToLowerCase(lcHost);

  nsTArray<RefPtr<nsICookie>> cookies;
  if (NS_FAILED(manager->GetCookies(cookies))) {
    return NS_OK;
  }
  for (const auto& c : cookies) {
    nsAutoCString cHost;
    c->GetHost(cHost);
    nsAutoCString lc(cHost);
    ToLowerCase(lc);
    bool isDomain = false;
    c->GetIsDomain(&isDomain);
    bool match = false;
    if (isDomain) {
      nsAutoCString base = lc;
      if (StringBeginsWith(base, "."_ns)) {
        base.Cut(0, 1);
      }
      match = lcHost == base || StringEndsWith(lcHost, "."_ns + base);
    } else {
      match = lcHost == lc;
    }
    if (!match) {
      continue;
    }
    // Netscape columns: domain, include-subdomains(FALSE), path, secure,
    // expiry, name, value.  httpOnly sits in the include-subdomains slot
    // where uGet puts it - the quirk the old collector documented.
    bool httpOnly = false;
    c->GetIsHttpOnly(&httpOnly);
    bool secure = false;
    c->GetIsSecure(&secure);
    nsAutoCString path;
    c->GetPath(path);
    bool isSession = false;
    c->GetIsSession(&isSession);
    int64_t expiry = 0;
    if (!isSession) {
      c->GetExpiry(&expiry);
    }
    nsAutoCString name;
    c->GetName(name);
    nsAutoCString value;
    c->GetValue(value);
    aOutText.AppendPrintf("%s\t%s\t%s\t%s\t%" PRId64 "\t%s\t%s\n", cHost.get(),
                          httpOnly ? "FALSE" : "TRUE", path.get(),
                          secure ? "TRUE" : "FALSE", expiry, name.get(),
                          value.get());
  }
  return NS_OK;
}

nsresult RozeLynxHandoff::WriteCookieFile(const nsACString& aText,
                                          nsACString& aOutPath) {
  nsresult rv;
  if (!mCookieDir) {
    // 0700 dir under the temp dir; the files in it are 0600 and swept an
    // hour later - "how long a file of live cookies lies around on disk"
    // stays this code's business, exactly as it was the host's.
    rv = NS_GetSpecialDirectory(NS_OS_TEMP_DIR, getter_AddRefs(mCookieDir));
    NS_ENSURE_SUCCESS(rv, rv);
    mCookieDir->AppendNative("rozelynx-handoff-cookies"_ns);
    rv = mCookieDir->Create(nsIFile::DIRECTORY_TYPE, 0700);
    if (NS_FAILED(rv) && rv != NS_ERROR_FILE_ALREADY_EXISTS) {
      return rv;
    }
  }
  nsCOMPtr<nsIFile> file;
  rv = mCookieDir->Clone(getter_AddRefs(file));
  NS_ENSURE_SUCCESS(rv, rv);
  file->AppendNative(nsPrintfCString("cookies-%lld", (long long)PR_Now()));
  rv = file->CreateUnique(nsIFile::NORMAL_FILE_TYPE, 0600);
  NS_ENSURE_SUCCESS(rv, rv);
  nsAutoCString path;
  rv = file->GetNativePath(path);
  NS_ENSURE_SUCCESS(rv, rv);

  FILE* f = fopen(path.get(), "w");
  if (!f) {
    return NS_ERROR_FAILURE;
  }
  size_t written = fwrite(aText.BeginReading(), 1, aText.Length(), f);
  fclose(f);
  if (written != aText.Length()) {
    return NS_ERROR_FAILURE;
  }
  aOutPath = path;
  return NS_OK;
}

void RozeLynxHandoff::SweepStaleCookieFiles() {
  // A crash between write and sweep leaves files behind; sweep on the next
  // hand-off, bounded by one hour, the same policy as the host.
  if (!mCookieDir) {
    nsresult rv = NS_GetSpecialDirectory(NS_OS_TEMP_DIR, getter_AddRefs(mCookieDir));
    if (NS_FAILED(rv)) {
      return;
    }
    mCookieDir->AppendNative("rozelynx-handoff-cookies"_ns);
  }
  PRTime cutoff = PR_Now() - (PRTime)3600 * PR_USEC_PER_SEC;
  nsCOMPtr<nsIDirectoryEnumerator> entries;
  if (NS_FAILED(mCookieDir->GetDirectoryEntries(getter_AddRefs(entries)))) {
    return;
  }
  nsCOMPtr<nsIFile> entry;
  while (NS_SUCCEEDED(entries->GetNextFile(getter_AddRefs(entry))) && entry) {
    PRTime mtime = 0;
    if (NS_SUCCEEDED(entry->GetLastModifiedTime(&mtime)) && mtime < cutoff) {
      entry->Remove(false);
    }
  }
}

}  // namespace mozilla
