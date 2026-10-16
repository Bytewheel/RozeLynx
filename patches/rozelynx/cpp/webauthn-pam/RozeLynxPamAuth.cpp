/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "RozeLynxPamAuth.h"

#include <pwd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <unistd.h>

#include <security/pam_appl.h>

#include "mozilla/JSONStringWriteFuncs.h"
#include "mozilla/JSONWriter.h"
#include "mozilla/Monitor.h"
#include "mozilla/ScopeExit.h"
#include "mozilla/Services.h"
#include "nsCOMPtr.h"
#include "nsIObserverService.h"
#include "nsIThread.h"
#include "nsLiteralString.h"
#include "nsString.h"
#include "nsThreadUtils.h"

namespace mozilla::dom {

namespace {

// The PAM services RozeLynx authenticates against, in order of preference:
// /etc/pam.d/rozelynx (packaged as an example) first, then the distro
// common chains (howdy and the password fallback normally already live
// there; on Gentoo /etc/pam.d/system-auth starts with pam_howdy.so).
constexpr const char* kPamServiceCandidates[] = {"rozelynx", "system-auth",
                                                 "common-auth"};

bool PamServiceFileExists(const char* aService) {
  for (const char* dir : {"/etc/pam.d", "/usr/etc/pam.d"}) {
    nsAutoCString path;
    path.Append(dir);
    path.Append('/');
    path.Append(aService);
    FILE* f = fopen(path.get(), "r");
    if (f) {
      fclose(f);
      return true;
    }
  }
  return false;
}

class RozeLynxPamVerifier final {
  friend class RozeLynxPamAuth;

 public:
  NS_INLINE_DECL_THREADSAFE_REFCOUNTING

  // Main thread. Returns false when the thread could not be created; the
  // callback is invoked (with aVerified = false) either way exactly once.
  void Start(uint64_t aTransactionId, const nsAString& aOrigin,
             uint64_t aBrowsingContextId, bool aShowVerifyPrompt,
             RozeLynxPamAuth::VerifyCallback&& aCallback) {
    mTransactionId = aTransactionId;
    mOrigin.Assign(aOrigin);
    mBrowsingContextId = aBrowsingContextId;
    mCallback = std::move(aCallback);

    nsresult rv = NS_NewNamedThread(
        "RozeLynxPAM", getter_AddRefs(mThread),
        NS_NewRunnableFunction(
            "RozeLynxPamVerifier::RunPam",
            [self = RefPtr(this)]() { self->RunPam(); }));
    if (NS_FAILED(rv)) {
      mThread = nullptr;
      nsCOMPtr<nsIRunnable> failed(NS_NewRunnableFunction(
          "RozeLynxPamVerifier::StartFailed",
          [self = RefPtr(this)]() { self->Complete(false); }));
      MOZ_ALWAYS_SUCCEEDS(NS_DispatchToMainThread(failed.forget()));
      return;
    }
    if (aShowVerifyPrompt) {
      SendPrompt("rozelynx-pam-verify");
    }
  }

  // Main thread.
  void OnPassword(const nsACString& aPassword) {
    MonitorAutoLock lock(mMonitor);
    if (mCancelled || !mWaitingForPassword) {
      return;
    }
    mPassword.Assign(aPassword);
    mPasswordReady = true;
    mWaitingForPassword = false;
    lock.NotifyAll();
  }

  // Main thread.
  void Cancel() {
    {
      MonitorAutoLock lock(mMonitor);
      mCancelled = true;
      mWaitingForPassword = false;
      mPasswordReady = false;
      mPassword.Truncate();
      lock.NotifyAll();
    }
    SendPrompt("cancel");
  }

 private:
  ~RozeLynxPamVerifier() = default;

  // PAM thread.
  void RunPam() {
    bool verified = false;
    do {
      uid_t euid = geteuid();
      struct passwd pwd;
      struct passwd* result = nullptr;
      char buf[4096];
      if (getpwuid_r(euid, &pwd, buf, sizeof(buf), &result) != 0 ||
          !result || !pwd.pw_name) {
        break;
      }

      const char* service = mService.get();
      struct pam_conv conv = {ConvThunk, this};
      pam_handle_t* handle = nullptr;
      int rv = pam_start(service, pwd.pw_name, &conv, &handle);
      if (rv != PAM_SUCCESS) {
        break;
      }
      (void)pam_set_item(handle, PAM_RHOST, "localhost");
      rv = pam_authenticate(handle, 0);
      int endRv = pam_end(handle, rv);
      verified = rv == PAM_SUCCESS && endRv == PAM_SUCCESS;
    } while (false);

    {
      MonitorAutoLock lock(mMonitor);
      if (mCancelled) {
        verified = false;
      }
    }

    nsCOMPtr<nsIRunnable> done(NS_NewRunnableFunction(
        "RozeLynxPamVerifier::Complete",
        [self = RefPtr(this), verified]() { self->Complete(verified); }));
    MOZ_ALWAYS_SUCCEEDS(NS_DispatchToMainThread(done.forget()));
  }

  // PAM thread.
  static int ConvThunk(int aNumMsg, const struct pam_message** aMsg,
                       struct pam_response** aResp, void* aAppDataPtr) {
    return static_cast<RozeLynxPamVerifier*>(aAppDataPtr)
        ->OnConversation(aNumMsg, aMsg, aResp);
  }

  // PAM thread.
  int OnConversation(int aNumMsg, const struct pam_message** aMsg,
                     struct pam_response** aResp) {
    struct pam_response* resp = static_cast<struct pam_response*>(
        calloc(aNumMsg, sizeof(struct pam_response)));
    if (!resp) {
      return PAM_CONV_ERR;
    }
    auto freeResp = MakeScopeExit([&resp, aNumMsg]() {
      for (int i = 0; i < aNumMsg; i++) {
        free(resp[i].resp);
      }
      free(resp);
    });
    for (int i = 0; i < aNumMsg; i++) {
      int style = aMsg[i]->msg_style;
      switch (style) {
        case PAM_ERROR_MSG:
        case PAM_TEXT_INFO:
          // Informational text from the PAM stack (howdy frame reports);
          // the browser doorhanger covers the user-facing side.
          resp[i].resp = nullptr;
          resp[i].resp_retcode = 0;
          continue;
        case PAM_PROMPT_ECHO_OFF:
        case PAM_PROMPT_ECHO_ON:
          break;
        default:
          return PAM_CONV_ERR;
      }
      if (!aMsg[i]->msg) {
        return PAM_CONV_ERR;
      }
      {
        MonitorAutoLock lock(mMonitor);
        if (mCancelled) {
          return PAM_CONV_ERR;
        }
        mPasswordReady = false;
        mWaitingForPassword = true;
      }
      nsCOMPtr<nsIRunnable> prompt(NS_NewRunnableFunction(
          "RozeLynxPamVerifier::AskPassword",
          [self = RefPtr(this)]() { self->SendPrompt("rozelynx-pam-password"); }));
      MOZ_ALWAYS_SUCCEEDS(NS_DispatchToMainThread(prompt.forget()));

      MonitorAutoLock lock(mMonitor);
      while (!mPasswordReady && !mCancelled) {
        lock.Wait();
      }
      if (mCancelled || !mPasswordReady) {
        return PAM_CONV_ERR;
      }
      resp[i].resp = strdup(mPassword.get());
      resp[i].resp_retcode = 0;
      mPassword.Truncate();
      mPasswordReady = false;
      mWaitingForPassword = false;
    }
    freeResp.release();
    *aResp = resp;
    return PAM_SUCCESS;
  }

  // Main thread.
  void Complete(bool aVerified) {
    // Clear whatever prompt is still up for this transaction (the
    // "look at the camera" doorhanger or a lingering password notice).
    SendPrompt("cancel");
    // The PAM thread has finished its runnable; joining is quick.
    if (mThread) {
      mThread->Shutdown();
      mThread = nullptr;
    }
    RozeLynxPamAuth::VerifyCallback callback = std::move(mCallback);
    mCallback = nullptr;
    if (gActive == this) {
      gActive = nullptr;
    }
    if (callback) {
      callback(aVerified);
    }
  }

  // Main thread. Fires the JSON "webauthn-prompt" observer notification
  // consumed by toolkit/modules/WebAuthnPromptHelper.sys.mjs.
  void SendPrompt(const char* aType) {
    nsAutoCString json;
    JSONStringRefWriteFunc f(json);
    JSONWriter w(f, JSONWriter::CollectionStyle::SingleLineStyle);
    w.Start();
    w.StartObjectProperty("prompt");
    w.StringProperty("type", aType);
    w.EndObject();
    nsAutoCString originUtf8(NS_ConvertUTF16toUTF8(mOrigin));
    w.StringProperty("origin", originUtf8.get());
    w.IntProperty("tid", static_cast<int64_t>(mTransactionId));
    w.IntProperty("browsingContextId",
                  static_cast<int64_t>(mBrowsingContextId));
    w.End();

    nsString wide(NS_ConvertUTF8toUTF16(json));
    nsCOMPtr<nsIObserverService> os = services::GetObserverService();
    if (os) {
      MOZ_ALWAYS_SUCCEEDS(
          os->NotifyObservers(nullptr, "webauthn-prompt", wide.get()));
    }
  }

  // Main-thread state:
  uint64_t mTransactionId = 0;
  nsString mOrigin;
  uint64_t mBrowsingContextId = 0;
  nsCString mService;
  RozeLynxPamAuth::VerifyCallback mCallback;
  nsCOMPtr<nsIThread> mThread;

  // Shared with the PAM thread:
  Monitor mMonitor{"RozeLynxPamAuth"};
  nsCString mPassword;
  bool mPasswordReady = false;
  bool mWaitingForPassword = false;
  bool mCancelled = false;
};

// The WebAuthn service drives at most one PAM transaction at a time.
RozeLynxPamVerifier* gActive = nullptr;

}  // namespace

bool RozeLynxPamAuth::ServiceAvailable() {
  static bool sChecked = false;
  static bool sAvailable = false;
  if (!sChecked) {
    for (const char* service : kPamServiceCandidates) {
      if (PamServiceFileExists(service)) {
        sAvailable = true;
        break;
      }
    }
    sChecked = true;
  }
  return sAvailable;
}

void RozeLynxPamAuth::Verify(uint64_t aTransactionId, const nsAString& aOrigin,
                             uint64_t aBrowsingContextId,
                             bool aShowVerifyPrompt,
                             VerifyCallback&& aCallback) {
  if (!ServiceAvailable() || gActive) {
    aCallback(false);
    return;
  }

  RefPtr<RozeLynxPamVerifier> verifier = new RozeLynxPamVerifier();
  // Service choice is re-resolved per run: administrators may add
  // /etc/pam.d/rozelynx while the browser is running.
  for (const char* service : kPamServiceCandidates) {
    if (PamServiceFileExists(service)) {
      verifier->mService.Assign(service);
      break;
    }
  }
  if (verifier->mService.IsEmpty()) {
    aCallback(false);
    return;
  }

  gActive = verifier;
  verifier->Start(aTransactionId, aOrigin, aBrowsingContextId,
                  aShowVerifyPrompt, std::move(aCallback));
}

void RozeLynxPamAuth::ProvidePassword(uint64_t aTransactionId,
                                      const nsACString& aPassword) {
  RozeLynxPamVerifier* active = gActive;
  if (!active || active->mTransactionId != aTransactionId) {
    return;
  }
  RefPtr<RozeLynxPamVerifier> verifier = active;
  verifier->OnPassword(aPassword);
}

void RozeLynxPamAuth::Cancel(uint64_t aTransactionId) {
  RozeLynxPamVerifier* active = gActive;
  if (!active || active->mTransactionId != aTransactionId) {
    return;
  }
  RefPtr<RozeLynxPamVerifier> verifier = active;
  verifier->Cancel();
}

}  // namespace mozilla::dom