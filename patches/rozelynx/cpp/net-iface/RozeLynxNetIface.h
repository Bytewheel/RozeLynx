/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_net_RozeLynxNetIface_h_
#define mozilla_net_RozeLynxNetIface_h_

#include "mozilla/Assertions.h"
#include "mozilla/Atomics.h"
#include "mozilla/BasePrincipal.h"
#include "mozilla/Mutex.h"
#include "mozilla/Preferences.h"
#include "mozilla/TimeStamp.h"
#include "nsCOMPtr.h"
#include "nsIObserver.h"
#include "nsIRozeLynxNetIface.h"
#include "nsPrintfCString.h"
#include "nsString.h"
#include "nsTArray.h"
#include "nsTHashMap.h"

class nsILoadInfo;
class nsIChannel;
class nsIURI;

namespace mozilla {
namespace net {

/**
 * RozeLynx: one normalized per-URL interface rule.
 *
 * Rules are authored as "<pattern> -> <iface>" and stored in prefs (the
 * source of truth, so they are editable in about:config):
 *
 *   rozelynx.netiface.urlrules.enabled            master switch (default on)
 *   rozelynx.netiface.urlrule.<n>.pattern         the pattern
 *   rozelynx.netiface.urlrule.<n>.iface           the interface ("" = force
 *                                                 default routing for matches)
 *   rozelynx.netiface.urlrule.<n>.enabled         optional, default true
 *
 * The pattern is parsed ONCE per pref change (BuildUrlRulesLocked) into this
 * struct, so the channel hot path never parses anything: a rule with a
 * scheme, a host and a path collapses to three glob comparisons.
 *
 * Pattern grammar (case-insensitive, all of it lowercased at parse time):
 *   *.example.com          host + all subdomains      (rank 1)
 *   example.com            that host only             (rank 2)
 *   *foo?.example.com      any glob inside the host   (rank 0)
 *   *                      any host
 *   *://host/path          optional scheme; "*" or absent = any
 *   /mail                  path prefix ("/mail*" is implied, matching the
 *                          whole pathQueryRef incl. query + fragment)
 *   * and ?                any run of characters / exactly one character
 *
 * When several rules match, the winner is decided in this order (higher is
 * more specific, ties go to the LOWEST <n> so the answer is deterministic
 * and explainable in the popup's match preview):
 *   1. host rank: exact (2) > "*.suffix" (1) > any other glob (0)
 *   2. host length
 *   3. a path beats no path
 *   4. path length
 *   5. a scheme beats no scheme
 *   6. lowest rule index
 */
struct RozeLynxNetIfaceUrlRule {
  nsCString pattern;  // as written, for provenance (matchUrlRule / logs)
  nsCString iface;    // "" = force default routing
  nsCString scheme;   // "" = any scheme
  nsCString host;     // lowercased, no trailing dot; for "*.x" the base "x"
  nsCString path;     // "" = any; otherwise a glob with an implied trailing '*'
  int32_t hostRank = 0;
  uint32_t index = 0;  // the <n> in rozelynx.netiface.urlrule.<n>
  bool hasScheme = false;
  bool hasPath = false;
  bool subdomainHost = false;  // "*.example.com" form
  bool enabled = true;
};

/**
 * RozeLynx per-profile / per-container / per-URL / per-tab network
 * interface assignment service (parent process, main thread).
 *
 * The hot path used by necko is the static ResolveForChannel(), which
 * short-circuits on two atomics and never touches XPCOM when the feature
 * is unused.
 */
class RozeLynxNetIface final : public nsIRozeLynxNetIface,
                               public nsIObserver {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS
  NS_DECL_NSIROZELYNXNETIFACE
  NS_DECL_NSIOBSERVER

  static already_AddRefed<RozeLynxNetIface> GetSingleton();

  // Pref roots.
  static constexpr const char* kPrefEnabled = "rozelynx.netiface.enabled";
  static constexpr const char* kPrefProfile = "rozelynx.netiface.profile";
  static constexpr const char* kPrefContainerPrefix =
      "rozelynx.netiface.container.";
  // RozeLynx v13: master switch for the host->binding activity index that
  // attributes extension-driven DNS lookups (browser.dns.resolve) to the
  // interface most recently used by a channel for the same host.
  static constexpr const char* kPrefDnsAttribution =
      "rozelynx.netiface.dnsAttribution";
  // Per-URL rules: master switch + the indexed rule list itself.  See
  // RozeLynxNetIfaceUrlRule for the pattern grammar.
  static constexpr const char* kPrefUrlRulesEnabled =
      "rozelynx.netiface.urlrules.enabled";
  static constexpr const char* kPrefUrlRulePrefix =
      "rozelynx.netiface.urlrule.";
  // Bound on the resolved rule list. The lookup is a linear scan over
  // normalized rules, and the list is user-authored, so a generous cap is
  // enough to keep a pathological pref set from costing anything on the
  // channel path.
  static constexpr uint32_t kMaxUrlRules = 256;
  // Per-interface DoH override: rozelynx.netiface.trr.uri.<ifname>.
  // Readable from any process (plain pref lookup, no service needed).
  static void GetIfaceTrrURI(const nsACString& aIface, nsACString& aOut) {
    aOut.Truncate();
    if (aIface.IsEmpty()) {
      return;
    }
    nsPrintfCString pref("rozelynx.netiface.trr.uri.%s",
                         PromiseFlatCString(aIface).get());
    Preferences::GetCString(pref.get(), aOut);
  }

  /**
   * The resolver an interface-bound lookup should actually use: the
   * per-interface override when set, else the global network.trr.uri.
   *
   * This exists because the fallback was open-coded at each of five call
   * sites, and the channel path's copy diverged from the extension path's in a
   * way that broke the feature: nsHttpChannel::BeginConnect forced
   * TRR_ONLY_MODE for any bound channel WITHOUT checking that a resolver
   * existed, so a profile that binds an interface while leaving both
   * rozelynx.netiface.trr.uri.<ifname> and network.trr.uri unset produced
   * forced-TRR lookups with an empty trrServer. Those fail closed - TRR_ONLY
   * has no native fallback - so every hostname needing a fresh resolution was
   * simply unresolvable, while hosts already in the cache kept working. One
   * helper, one rule, and the question "is there a resolver at all?" has a
   * single answer.
   *
   * An empty aOut is a real, meaningful answer: it means "no DoH configured for
   * this interface", and callers must then leave DNS on the stock path rather
   * than force TRR. The socket bind is unaffected either way - it is the half
   * that constrains egress, and it does not need a resolver.
   */
  static void GetEffectiveTrrURI(const nsACString& aIface, nsACString& aOut);

  /**
   * Resolve the layered assignment for a channel (parent process only).
   * Returns false when the feature is disabled/unsupported or the channel
   * has no load info.  aOut is "" when unassigned.
   * Safe to call from any necko main-thread call site; asserts main thread.
   */
  static bool ResolveForChannel(nsIChannel* aChannel, nsACString& aOut);
  /**
   * Same layered resolution for a WebSocket's admission DNS lookup
   * (WebSocketChannel::DoAdmissionDNS), which runs BEFORE the internal
   * HTTP handshake channel is opened and so cannot read the assignment
   * off a connection info.  The handshake channel itself - and therefore
   * the socket the websocket data flows on - is already bound through
   * ResolveForChannel in nsHttpChannel::BeginConnect; this entry point
   * only exists so the admission lookup does not egress the ambient
   * DNS path and leak the bound tab's hostname and resolver choice.
   */
  static bool ResolveForWebSocket(nsIURI* aURI, nsILoadInfo* aLoadInfo,
                                  nsACString& aOut);
  /** Container+profile layers only (no BrowsingContext available). */
  static bool ResolveForOriginAttributes(const OriginAttributes& aAttrs,
                                         nsACString& aOut);

 private:
  RozeLynxNetIface();
  ~RozeLynxNetIface() = default;

  nsresult Init();
  void UpdateCachedState();
  void NotifyChanged();
  void FlushDNSCache();

  // Shared body of ResolveForChannel/ResolveForWebSocket: the layered
  // lookup (tab > url rule > container > profile) plus the host-index
  // recording, given the URI and load info the caller extracted.
  static bool ResolveForLoad(nsIURI* aURI, nsILoadInfo* aLoadInfo,
                             nsACString& aOut);

  /**
   * RozeLynx v13: host->binding activity index entry.  Maps a normalized
   * request hostname to the interface a channel most recently used for it
   * ("" = most recent channel was unassigned).  most-recent-wins gives
   * per-request correctness for hosts shared across bound/unbound tabs.
   */
  struct HostBinding {
    nsCString iface;
    TimeStamp lastSeen;
  };

  // Bounded: prune entries older than kHostIndexTTLSeconds when at the soft
  // cap; hard-clear the whole index at the hard cap (memory guard only, the
  // index is a heuristic attribution aid, never authoritative state).
  static constexpr uint32_t kHostIndexSoftCap = 8192;
  static constexpr uint32_t kHostIndexHardCap = 16384;
  static constexpr double kHostIndexTTLSeconds = 600.0;

  void RecordHostBinding(const nsACString& aHost, const nsACString& aIface);

  // Re-parse the pref-backed URL rules.  Called (with mMutex held) from
  // UpdateCachedState, so a rule edit reaches the resolver through the same
  // pref observer that already rebuilds the container map.
  void BuildUrlRulesLocked();
  // Resolve the URL layer for one (scheme, host, path).  mMutex must be
  // held.  Returns nullptr when nothing matched; a matched rule may carry an
  // EMPTY iface, which is a real answer ("force default routing").
  //
  // aKey must be the memo key for those three parts (see the callers); the
  // lookup is memoized because a single page load runs this per channel and
  // a page's subresources all hit the same (scheme, host, path).
  RozeLynxNetIfaceUrlRule* MatchUrlRuleLocked(const nsCString& aKey,
                                               const nsACString& aScheme,
                                               const nsACString& aHost,
                                               const nsACString& aPath);
  bool HasAnyAssignmentLocked() const {
    return !mProfileIface.IsEmpty() || !mContainerMap.IsEmpty() ||
           (mUrlRulesEnabled && !mUrlRules.IsEmpty());
  }

  // Cached state, guarded by mMutex; rebuilt on pref-branch changes.
  Mutex mMutex{"RozeLynxNetIface"};
  nsTHashMap<uint64_t, nsCString> mTabMap MOZ_GUARDED_BY(mMutex);
  nsTHashMap<uint32_t, nsCString> mContainerMap MOZ_GUARDED_BY(mMutex);
  nsTHashMap<nsCStringHashKey, HostBinding> mHostIndex MOZ_GUARDED_BY(mMutex);
  nsCString mProfileIface MOZ_GUARDED_BY(mMutex);
  // Per-URL rules, between the tab and container layers.  mTabMap stays
  // runtime-only (never rebuilt here), both of these are pref-backed.
  nsTArray<RozeLynxNetIfaceUrlRule> mUrlRules MOZ_GUARDED_BY(mMutex);
  bool mUrlRulesEnabled MOZ_GUARDED_BY(mMutex) = true;
  nsCString mUrlRuleMemoKey MOZ_GUARDED_BY(mMutex);
  int32_t mUrlRuleMemoIndex MOZ_GUARDED_BY(mMutex) = -1;
  bool mHasAnyAssignment MOZ_GUARDED_BY(mMutex) = false;

  static Atomic<bool> sEnabled;
  static Atomic<bool> sSupported;
  static Atomic<bool> sDnsAttribution;
};

}  // namespace net
}  // namespace mozilla

#endif  // mozilla_net_RozeLynxNetIface_h_
