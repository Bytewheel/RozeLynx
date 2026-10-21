/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_RozeLynxHandoff_h_
#define mozilla_RozeLynxHandoff_h_

#include "nsCOMPtr.h"
#include "nsIObserver.h"
#include "nsIRozeLynxHandoff.h"
#include "nsString.h"
#include "nsTArray.h"
#include "prtime.h"
#include <sys/types.h>

class nsIChannel;
class nsIFile;
class nsIURI;

namespace mozilla {

/**
 * The handler-row object the Settings editor reads (GetHandlers). All
 * data, no behaviour; created through the
 * "@bytewheel.org/handoff/handler-info;1" contract.
 */
class RozeLynxHandoffHandlerInfo final : public nsIRozeLynxHandoffHandler {
  NS_DECL_ISUPPORTS
  NS_DECL_NSIROZELYNXHANDOFFHANDLER

 public:
  // The interface attributes are readonly (the object is handed out
  // filled); these concrete setters exist only for the service that fills
  // it, so they are declared here rather than in the IDL.
  NS_IMETHOD SetIndex(int32_t aIndex);
  NS_IMETHOD SetId(const nsACString& aId);
  NS_IMETHOD SetKind(const nsACString& aKind);
  NS_IMETHOD SetLabel(const nsACString& aLabel);
  NS_IMETHOD SetHint(const nsACString& aHint);
  NS_IMETHOD SetArgs(const nsACString& aArgs);
  NS_IMETHOD SetEnabled(bool aEnabled);
  NS_IMETHOD SetAvailable(bool aAvailable);
  NS_IMETHOD SetDetail(const nsACString& aDetail);

  int32_t mIndex = 0;
  nsCString mId;
  nsCString mKind;
  nsCString mLabel;
  nsCString mHint;
  nsCString mArgs;
  nsCString mDetail;
  bool mEnabled = true;
  bool mAvailable = false;

 private:
  ~RozeLynxHandoffHandlerInfo() = default;
};

/**
 * One handler row, parsed once per rozelynx.downloads.* pref change
 * (RebuildLocked) so the OnStartRequest hot path never parses anything.
 */
struct HandoffHandler {
  nsCString id;      // "uget" | "cmd:<program>" | "ext:<extension-id>"
  nsCString kind;    // "builtin" | "cmd" | "ext" | "unknown"
  nsCString label;
  nsCString hint;
  nsCString args;    // raw args template (cmd: only)
  bool enabled = true;
  bool available = false;
  nsCString detail;  // probe result, shown by the Settings editor

  bool IsBuiltin() const { return kind.EqualsLiteral("builtin"); }
  bool IsCmd() const { return kind.EqualsLiteral("cmd"); }
  bool IsExt() const { return kind.EqualsLiteral("ext"); }
};

/**
 * RozeLynx download hand-off service (USE=download-handoff).
 *
 * See nsIRozeLynxHandoff.idl for the contract; the class exists in the
 * parent process, main thread only, and is a pref observer so a
 * about:config edit re-reads and re-probes the handler list lazily (the
 * hot path takes the last-good copy under mMutex-free main-thread-only
 * assumptions: everything here is main thread, like the netiface
 * service's pref side).
 *
 * Execution is POSIX by design (posix_spawn + pipes): the feature is
 * Linux-targeted like the netiface component, and stdio pipes are the
 * one thing no XPCOM process API offers (nsIProcess cannot write a
 * child's stdin, and the uget-integrator protocol is stdio JSON).
 */
class RozeLynxHandoff final : public nsIRozeLynxHandoff,
                              public nsIObserver {
  NS_DECL_ISUPPORTS
  NS_DECL_NSIROZELYNXHANDOFF
  NS_DECL_NSIOBSERVER

 public:
  static already_AddRefed<RozeLynxHandoff> GetSingleton();

 public:
  RozeLynxHandoff();

 private:
  ~RozeLynxHandoff();

  // ── config (prefs) ─────────────────────────────────────────────────
  void ReadPrefs();
  bool HandlePrefChange(const nsACString& aName);
  // 'auto' | 'true' | 'false', normalised like the old extension did.
  nsCString mMode{"auto"_ns};
  int64_t mMinSize = 300 * 1024;
  nsTArray<nsCString> mExclude;
  nsTArray<HandoffHandler> mHandlers;
  // rozelynx.downloads.handoff.defer_to: an add-on ID to stand down for,
  // so another download-manager integration can own downloads instead
  // (two hooks on one download do not compose: one click becomes two
  // hand-offs). Honoured only when the named add-on is actually enabled -
  // the ext-state cache answers that.
  nsCString mDeferTo;
  bool mHavePrefs = false;
  bool mPrefsDirty = true;  // re-read + re-probe on next gate pass

  // ext: availability cache: rozelynx.downloads.handoff.extensions is a
  // JSON object {"<extension-id>": true|false} the RozeLynx extension
  // relay maintains. Parsed into a simple list of (id, enabled) pairs.
  struct ExtState {
    nsCString id;
    bool enabled;
  };
  nsTArray<ExtState> mExtStates;
  void ReadExtStates();

  bool ModeEnabled();           // resolves 'auto' against availability
  bool IsExcluded(const nsACString& aURL) const;

  // ── probing ────────────────────────────────────────────────────────
  void ProbeAll();
  void ProbeOne(HandoffHandler& aHandler);
  bool ResolveOnPath(const nsACString& aProgram, nsCString& aOutPath) const;
  // uget-integrator version handshake: {"probe": true} frame, bounded wait.
  bool ProbeUget(nsCString& aOutDetail);

  // ── execution ──────────────────────────────────────────────────────
  struct SpawnResult {
    bool ok = false;
    nsCString error;
    int stdinFd = -1;   // write end of the child's stdin pipe
    int stdoutFd = -1;  // read end of the child's stdout pipe
    pid_t pid = -1;
  };
  SpawnResult SpawnDetached(const nsACString& aPath,
                            const nsTArray<nsCString>& aArgv, bool aWantStdio);
  bool ReadFramedReply(int aFd, nsACString& aOut, nsACString& aError);
  static bool ExtractJsonStringField(const nsACString& aJson,
                                     const nsACString& aField,
                                     nsACString& aOutValue);
  bool RunUget(const nsACString& aURL, const nsACString& aFilename,
               const nsACString& aReferer, const nsACString& aCookiesText,
               const nsACString& aUserAgent, int64_t aSize, nsCString& aError);
  bool RunCmd(const HandoffHandler& aHandler, const nsACString& aURL,
              const nsACString& aFilename, const nsACString& aReferer,
              const nsACString& aCookiesText, const nsACString& aUserAgent,
              nsCString& aError, pid_t& aOutPid);
  bool RunExt(const nsACString& aExtId, const nsACString& aURL,
              const nsACString& aFilename, const nsACString& aReferer,
              nsCString& aError);

  // ext: request round-trip state (one at a time: downloads are gated one
  // per channel, sequentially on the main thread).
  uint32_t mExtRequestId = 0;
  bool mExtResponseSeen = false;
  bool mExtAccepted = false;
  nsCString mExtError;

  // ── cookies ────────────────────────────────────────────────────────
  // Netscape cookie-file text for the URL's host, same field order the
  // old extension wrote (and uget-integrator's parser reads).
  nsresult CollectCookies(nsIURI* aURI, nsIChannel* aChannel,
                          nsACString& aOutText);
  nsresult WriteCookieFile(const nsACString& aText, nsACString& aOutPath);
  void SweepStaleCookieFiles();
  nsCOMPtr<nsIFile> mCookieDir;

  // ── helpers ────────────────────────────────────────────────────────
  static bool SplitArgsTemplate(const nsACString& aTemplate,
                                nsTArray<nsCString>& aOutArgv);
  static bool SubstituteTokens(nsTArray<nsCString>& aArgv,
                               const nsACString& aURL,
                               const nsACString& aFilename,
                               const nsACString& aReferer,
                               const nsACString& aCookiePath,
                               const nsACString& aUserAgent);
  static nsCString UserAgentLike();
};

}  // namespace mozilla

#endif  // mozilla_RozeLynxHandoff_h_
