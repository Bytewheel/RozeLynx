/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "RozeLynxNetIface.h"

#include "DNSAdditionalInfo.h"  // RozeLynx v13: attributed AdditionalInfo
#include "TRRService.h"        // RozeLynx v13: global network.trr.uri fallback
#include "mozilla/dom/BrowsingContext.h"
#include "mozilla/Services.h"
#include "mozilla/StaticPtr.h"
#include "mozilla/net/DNS.h"
#include "mozilla/net/SocketProcessParent.h"  // RozeLynx v14: tab-map replica push
#include "nsIChannel.h"
#include "nsIDNSService.h"
#include "nsILoadInfo.h"
#include "nsIPrefBranch.h"
#include "nsIPrefService.h"
#include "nsIObserverService.h"
#include "nsIURI.h"
#include "nsNetCID.h"
#include "nsNetUtil.h"  // RozeLynx v13: NS_NewURI (provider-host guard)
#include "nsReadableUtils.h"
#include "nsServiceManagerUtils.h"
#include "nsXULAppAPI.h"

#if defined(XP_LINUX)
#  include <net/if.h>
#  include <sys/ioctl.h>
#  include <sys/socket.h>
#  include <ifaddrs.h>
#endif

#define NS_NETIFACE_PREF_BRANCH "rozelynx.netiface."

// RozeLynx: an explicit "all interfaces" binding for one tab.
//
// An empty bindIface already means "never SO_BINDTODEVICE, route normally" --
// every consumer in net-iface-necko.patch guards on !IsEmpty() -- but an empty
// *tab* value cannot express it: SetTabInterface treats empty as "remove this
// tab's binding" (mTabMap.Remove), so it is indistinguishable from unset and
// the tab layer falls through to the URL/container/profile layers. That is why
// all-interfaces was selectable for a profile but never for a single tab.
//
// "*" is stored instead. It is not a legal interface name, so if a future edit
// ever let it reach setsockopt the result is ENODEV -- a refused bind, never a
// bind to the wrong device. ResolveForChannel translates it back to empty
// while keeping the tab layer authoritative.
#define NS_NETIFACE_ALL_IFACES "*"
#define NS_NETIFACE_CHANGED_TOPIC "rozelynx-netiface-changed"

using mozilla::dom::BrowsingContext;

namespace mozilla {
namespace net {

LazyLogModule gRozeLynxNetIfaceLog("RozeLynxNetIface");
#define LOG(args) MOZ_LOG(gRozeLynxNetIfaceLog, mozilla::LogLevel::Debug, args)

Atomic<bool> RozeLynxNetIface::sEnabled(false);
Atomic<bool> RozeLynxNetIface::sSupported(false);
Atomic<bool> RozeLynxNetIface::sDnsAttribution(true);

namespace {

StaticRefPtr<RozeLynxNetIface> gNetIface;

class NetIfaceInfo final : public nsIRozeLynxNetIfaceInfo {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS
  NS_DECL_NSIROZELYNXNETIFACEINFO

  NetIfaceInfo(const nsACString& aName, bool aUp, bool aV4, bool aV6,
               bool aLoopback)
      : mName(aName), mUp(aUp), mV4(aV4), mV6(aV6), mLoopback(aLoopback) {}

 private:
  ~NetIfaceInfo() = default;
  nsCString mName;
  bool mUp;
  bool mV4;
  bool mV6;
  bool mLoopback;
};

NS_IMPL_ISUPPORTS(NetIfaceInfo, nsIRozeLynxNetIfaceInfo)

NS_IMETHODIMP
NetIfaceInfo::GetName(nsACString& aName) {
  aName = mName;
  return NS_OK;
}

NS_IMETHODIMP
NetIfaceInfo::GetUp(bool* aUp) {
  *aUp = mUp;
  return NS_OK;
}

NS_IMETHODIMP
NetIfaceInfo::GetHasIPv4(bool* aHasIPv4) {
  *aHasIPv4 = mV4;
  return NS_OK;
}

NS_IMETHODIMP
NetIfaceInfo::GetHasIPv6(bool* aHasIPv6) {
  *aHasIPv6 = mV6;
  return NS_OK;
}

NS_IMETHODIMP
NetIfaceInfo::GetLoopback(bool* aLoopback) {
  *aLoopback = mLoopback;
  return NS_OK;
}

/**
 * Loopback and LAN hosts must never be interface-bound: SO_BINDTODEVICE
 * restricts all routing for the socket, so a bound socket could not reach
 * 127.0.0.0/8, the LAN subnet, or link-local targets (they route via lo or
 * the LAN interface).  These hosts must also stay unassigned so their DNS
 * keeps the profile's normal mode: "localhost" and *.local are excluded
 * from TRR upstream, and an assigned record would be forced TRR_ONLY with
 * no native fallback, making them unresolvable.
 */
static bool IsNeverBindHost(const nsACString& aHost) {
  // Literal loopback / RFC1918 / link-local / ULA addresses.
  NetAddr addr;
  if (NS_SUCCEEDED(addr.InitFromString(aHost)) &&
      (addr.IsLoopbackAddr() || addr.IsIPAddrLocal())) {
    return true;
  }
  // RFC 6761 localhost and RFC 6762 mDNS names live on the local network.
  if (aHost.EqualsLiteral("localhost") || aHost.EqualsLiteral("localhost.") ||
      StringEndsWith(aHost, ".localhost"_ns) ||
      StringEndsWith(aHost, ".local"_ns)) {
    return true;
  }
  return false;
}

// ── Per-URL rules ─────────────────────────────────────────────────
//
// Pattern grammar, pref layout and the specificity order are documented on
// RozeLynxNetIfaceUrlRule in the header.  Everything here works on
// already-lowercased strings, so matching is plain byte comparison.

// Host specificity ranks (higher wins).
constexpr int32_t kUrlRuleHostRankGlob = 0;       // * / *cdn?.example.com
constexpr int32_t kUrlRuleHostRankSubdomain = 1;  // *.example.com
constexpr int32_t kUrlRuleHostRankExact = 2;      // example.com

/**
 * Case-insensitive glob: '*' matches any run of characters, '?' exactly one.
 * Callers lowercase both sides first, so this compares raw bytes.
 *
 * Iterative with a single backtrack point rather than recursion: the pattern
 * comes from a user pref and this runs on the channel hot path, so a
 * pathological "************a" must not be able to blow the stack or make the
 * match quadratic.
 */
static bool UrlRuleGlobMatch(const char* aPattern, const char* aText) {
  const char* p = aPattern;
  const char* t = aText;
  const char* starPattern = nullptr;  // first '*' seen, resumed from here
  const char* starText = nullptr;     // how much text it has swallowed
  while (*t) {
    if (*p == '?' || *p == *t) {
      ++p;
      ++t;
      continue;
    }
    if (*p == '*') {
      starPattern = ++p;
      starText = t;
      continue;
    }
    if (starPattern) {
      p = starPattern;
      t = ++starText;
      continue;
    }
    return false;
  }
  while (*p == '*') {
    ++p;
  }
  return *p == '\0';
}

static bool UrlRuleGlobMatch(const nsACString& aPattern, const nsACString& aText) {
  // nsACString is not guaranteed NUL-terminated; the C-string helper above is.
  return UrlRuleGlobMatch(PromiseFlatCString(aPattern).get(),
                          PromiseFlatCString(aText).get());
}

/** Every character is an ASCII digit (and there is at least one). */
static bool UrlRuleAllDigits(const nsACString& aStr) {
  if (aStr.IsEmpty()) {
    return false;
  }
  for (uint32_t i = 0; i < aStr.Length(); i++) {
    char c = aStr[i];
    if (c < '0' || c > '9') {
      return false;
    }
  }
  return true;
}

/**
 * Is rest[0..aEnd) shaped like a URI scheme name?  Only a tie-breaker in the
 * host/port vs scheme/opaque decision below; the digits do the real work.
 */
static bool UrlRuleIsSchemeShaped(const nsACString& aStr, int32_t aEnd) {
  if (aEnd <= 0) {
    return false;
  }
  for (int32_t i = 0; i < aEnd; i++) {
    char c = aStr[i];
    bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
              (c >= '0' && c <= '9') || c == '+' || c == '.' || c == '-';
    if (!ok) {
      return false;
    }
  }
  return true;
}

/**
 * Split a URL-ish string into (scheme, host, path), lowercased, with the
 * authority reduced to a bare host.
 *
 * Accepts everything the two callers can produce, because they come from
 * different places: the socket path has an nsIURI (so it already has a clean
 * host), while the extension only has a tab URL string:
 *   "example.com"                  "https://example.com/mail?x#y"
 *   "example.com:8080/mail"        "//example.com/mail"
 * A string with a scheme but no authority ("about:blank", "data:...") yields
 * an empty host, which no rule can match - correct, since it has no host.
 *
 * userinfo, port and IPv6 brackets are dropped so the host compares equal to
 * nsIURI's asciiHost regardless of which side produced it.  The path keeps
 * its query and fragment (nsIURI's pathQueryRef includes both, and the
 * extension's URL string does too, so the two sides stay symmetric).
 */
static void UrlRuleSplitTarget(const nsACString& aTarget, nsCString& aScheme,
                               nsCString& aHost, nsCString& aPath) {
  aScheme.Truncate();
  aHost.Truncate();
  aPath.Truncate();

  nsCString rest(aTarget);
  rest.Trim(" \t\r\n");
  if (rest.IsEmpty()) {
    return;
  }

  int32_t sep = rest.Find("://");
  if (sep >= 0) {
    aScheme = Substring(rest, 0, sep);
    rest = Substring(rest, sep + 3);
  } else {
    // No "://".  "host[:port][/path]" and "scheme:opaque" look alike here
    // ("example.com:8080" is a host + port, "about:blank" is not), and the
    // only reliable tell is the colon's tail: a port is all digits, a
    // scheme's body is not.  A scheme-shaped prefix with a non-numeric tail
    // therefore means there is no authority, so no host to match.
    int32_t colon = rest.FindChar(':');
    int32_t slash = rest.FindChar('/');
    if (colon > 0 && (slash < 0 || colon < slash) &&
        UrlRuleIsSchemeShaped(rest, colon)) {
      // The colon's tail, stopping at the path: "example.com:8443/x" has a
      // numeric tail and is a host + port, "about:blank" is not.
      size_t tailLen =
          (slash < 0) ? (size_t)-1 : (size_t)(slash - colon - 1);
      if (!UrlRuleAllDigits(Substring(rest, colon + 1, tailLen))) {
        aScheme = Substring(rest, 0, colon);
        return;
      }
    }
    if (slash == 0) {
      rest = Substring(rest, 2);  // protocol-relative "//host/path"
    }
  }

  int32_t slash = rest.FindChar('/');
  nsCString authority;
  if (slash < 0) {
    authority = rest;
  } else {
    authority = Substring(rest, 0, slash);
  }
  if (slash < 0) {
    aPath.Truncate();
  } else {
    aPath = Substring(rest, slash);
  }

  int32_t at = authority.RFindChar('@');
  if (at >= 0) {
    authority = Substring(authority, at + 1);
  }

  if (!authority.IsEmpty() && authority[0] == '[') {
    // IPv6 literal, optionally with a port: "[::1]" / "[::1]:8443".
    // nsIURI's asciiHost is unbracketed, so drop them.
    int32_t close = authority.FindChar(']');
    if (close < 0) {
      aHost.Truncate();
      return;
    }
    aHost = Substring(authority, 1, close - 1);
  } else {
    // Strip a trailing ":port", but only when the digits start at the FIRST
    // colon: that keeps a bare IPv6 literal ("::1") intact instead of
    // cutting it to ":", and a bracketed one went down the branch above.
    int32_t colon = authority.RFindChar(':');
    if (colon > 0 && authority.FindChar(':') == colon &&
        UrlRuleAllDigits(Substring(authority, colon + 1))) {
      authority = Substring(authority, 0, colon);
    }
    aHost = authority;
  }

  ToLowerCase(aScheme);
  ToLowerCase(aHost);
  ToLowerCase(aPath);
  if (!aHost.IsEmpty() && aHost[aHost.Length() - 1] == '.') {
    aHost.Truncate(aHost.Length() - 1);  // fully-qualified names
  }
}

/**
 * Parse one user-written pattern into a normalized rule.  Returns false for
 * anything that cannot become a rule (blank, or no host to match), which the
 * caller treats as "skip this pref entry" rather than as an error.
 */
static bool UrlRuleParsePattern(const nsACString& aPattern,
                                RozeLynxNetIfaceUrlRule& aOut) {
  aOut = RozeLynxNetIfaceUrlRule();

  nsCString scheme;
  nsCString host;
  nsCString path;
  UrlRuleSplitTarget(aPattern, scheme, host, path);
  if (host.IsEmpty()) {
    return false;
  }
  aOut.pattern.Assign(aPattern);
  aOut.pattern.Trim(" \t\r\n");
  // "*://host" is the "any scheme" spelling, not a literal scheme name.
  if (!scheme.IsEmpty() && scheme != "*") {
    aOut.scheme = scheme;
    aOut.hasScheme = true;
  }
  aOut.path = path;
  aOut.hasPath = !path.IsEmpty();
  if (aOut.hasPath && aOut.path[aOut.path.Length() - 1] != '*') {
    // A path in a rule is a PREFIX ("/mail" covers /mail/inbox), so an
    // explicit trailing '*' is implied.
    aOut.path.Append('*');
  }

  if (host == "*") {
    aOut.hostRank = kUrlRuleHostRankGlob;
    aOut.host = host;  // the literal "*", matched as a glob
  } else if (StringBeginsWith(host, nsDependentCSubstring("*.", 2))) {
    nsCString base;
    base = Substring(host, 2);
    if (base.IsEmpty() || base == "*") {
      return false;  // "*." / "*.*" name no host
    }
    aOut.hostRank = kUrlRuleHostRankSubdomain;
    aOut.subdomainHost = true;
    aOut.host = base;
  } else if (host.FindChar('*') != -1 || host.FindChar('?') != -1) {
    aOut.hostRank = kUrlRuleHostRankGlob;
    aOut.host = host;
  } else {
    aOut.hostRank = kUrlRuleHostRankExact;
    aOut.host = host;
  }
  return true;
}

/** Does one rule cover this (scheme, host, path)? */
static bool UrlRuleMatches(const RozeLynxNetIfaceUrlRule& aRule,
                           const nsACString& aScheme, const nsACString& aHost,
                           const nsACString& aPath) {
  if (!aRule.enabled) {
    return false;
  }
  if (aRule.hasScheme &&
      !aRule.scheme.Equals(aScheme, nsCaseInsensitiveCStringComparator)) {
    return false;
  }
  if (aRule.subdomainHost) {
    // "*.example.com" covers the apex too, which is what everyone means by it.
    nsAutoCString dotSuffix(".");
    dotSuffix.Append(aRule.host);
    if (!aRule.host.Equals(aHost, nsCaseInsensitiveCStringComparator) &&
        !StringEndsWith(aHost, dotSuffix)) {
      return false;
    }
  } else if (!UrlRuleGlobMatch(aRule.host, aHost)) {
    return false;
  }
  if (aRule.hasPath && !UrlRuleGlobMatch(aRule.path, aPath)) {
    return false;
  }
  return true;
}

/**
 * Specificity comparison, strictly ordered so the answer is deterministic:
 * host form, then host length, then having a path, then path length, then
 * having a scheme, then the LOWEST rule index (declaration order).
 */
static bool UrlRuleMoreSpecific(const RozeLynxNetIfaceUrlRule& aCandidate,
                                const RozeLynxNetIfaceUrlRule& aCurrent) {
  if (aCandidate.hostRank != aCurrent.hostRank) {
    return aCandidate.hostRank > aCurrent.hostRank;
  }
  if (aCandidate.host.Length() != aCurrent.host.Length()) {
    return aCandidate.host.Length() > aCurrent.host.Length();
  }
  if (aCandidate.hasPath != aCurrent.hasPath) {
    return aCandidate.hasPath;
  }
  if (aCandidate.path.Length() != aCurrent.path.Length()) {
    return aCandidate.path.Length() > aCurrent.path.Length();
  }
  if (aCandidate.hasScheme != aCurrent.hasScheme) {
    return aCandidate.hasScheme;
  }
  return aCandidate.index < aCurrent.index;
}

}  // anonymous namespace

// RozeLynx netiface
void RozeLynxNetIface::GetEffectiveTrrURI(const nsACString& aIface,
                                          nsACString& aOut) {
  aOut.Truncate();
  GetIfaceTrrURI(aIface, aOut);
  if (!aOut.IsEmpty()) {
    return;
  }
  // No per-interface override: fall back to the global network.trr.uri so a
  // bound lookup still resolves over DoH rather than being forced onto TRR with
  // no server. When that pref is unset too, aOut stays empty and the caller
  // must NOT force TRR - see the header.
  if (TRRService::Get()) {
    TRRService::Get()->GetURI(aOut);
  }
}

NS_IMPL_ISUPPORTS(RozeLynxNetIface, nsIRozeLynxNetIface, nsIObserver)

RozeLynxNetIface::RozeLynxNetIface() {
  MOZ_ASSERT(NS_IsMainThread());
#if defined(XP_LINUX) && !defined(ANDROID)
  sSupported = true;
#endif
}

// static
already_AddRefed<RozeLynxNetIface> RozeLynxNetIface::GetSingleton() {
  MOZ_ASSERT(NS_IsMainThread());
  // RozeLynx v14: the socket process runs a full singleton too (prefs are
  // synced by PSocketProcess::PreferenceUpdate, the tab map by the
  // PSocketProcess push below) so the ICE contexts it hosts can resolve
  // every layer locally, exactly as the parent resolves a channel.
  MOZ_ASSERT(XRE_IsParentProcess() || XRE_IsSocketProcess());
  if (!gNetIface) {
    gNetIface = new RozeLynxNetIface();
    gNetIface->Init();
  }
  return do_AddRef(gNetIface);
}

nsresult RozeLynxNetIface::Init() {
  MOZ_ASSERT(NS_IsMainThread());

  sEnabled = Preferences::GetBool(kPrefEnabled, true);

  nsCOMPtr<nsIPrefBranch> branch = do_GetService(NS_PREFSERVICE_CONTRACTID);
  if (branch) {
    branch->AddObserver(NS_NETIFACE_PREF_BRANCH, this, false);
  }

  nsCOMPtr<nsIObserverService> obs = services::GetObserverService();
  if (obs) {
    obs->AddObserver(this, NS_XPCOM_SHUTDOWN_OBSERVER_ID, false);
    // RozeLynx netiface: upstream flushes the DNS cache on a real TRR URI
    // change (TRRService::MaybeSetPrivateURI); observe the same topic so the
    // component stays correct independently and logs a flush signal (v12).
    obs->AddObserver(this, NS_NETWORK_TRR_URI_CHANGED_TOPIC, false);
  }

  UpdateCachedState();
  return NS_OK;
}

void RozeLynxNetIface::UpdateCachedState() {
  MOZ_ASSERT(NS_IsMainThread());
  MutexAutoLock lock(mMutex);

  // RozeLynx v13: cache the attribution master switch too (the pref-branch
  // observer fires on every rozelynx.netiface.* change, so runtime toggles
  // of rozelynx.netiface.dnsAttribution land here).
  sDnsAttribution = Preferences::GetBool(kPrefDnsAttribution, true);

  // RozeLynx: mTabMap is runtime-only state owned by SetTabInterface; it
  // must survive rozelynx.netiface.* pref changes (SetProfileInterface fires
  // this observer). Clearing it here silently dropped every per-tab binding
  // on a profile-default change. mContainerMap and the URL rules stay
  // pref-backed: rebuild them.
  mContainerMap.Clear();
  BuildUrlRulesLocked();

  mProfileIface.Truncate();
  Preferences::GetCString(kPrefProfile, mProfileIface);

  // Enumerate rozelynx.netiface.container.<userContextId> prefs.
  nsCOMPtr<nsIPrefBranch> branch = do_GetService(NS_PREFSERVICE_CONTRACTID);
  if (branch) {
    nsTArray<nsCString> childNames;
    nsresult rv =
        branch->GetChildList("rozelynx.netiface.container.", childNames);
    if (NS_SUCCEEDED(rv)) {
      static constexpr size_t kPrefixLen =
          sizeof("rozelynx.netiface.container.") - 1;
      for (const nsCString& prefName : childNames) {
        nsCString value;
        Preferences::GetCString(prefName.get(), value);
        if (value.IsEmpty()) {
          continue;
        }
        // prefName: "rozelynx.netiface.container.<id>"
        nsresult parseRv = NS_OK;
        int32_t id = Substring(prefName, kPrefixLen).ToInteger(&parseRv);
        if (NS_FAILED(parseRv) || id < 0) {
          continue;
        }
        mContainerMap.InsertOrUpdate(static_cast<uint32_t>(id),
                                     std::move(value));
      }
    }
  }

  mHasAnyAssignment = HasAnyAssignmentLocked();
}

void RozeLynxNetIface::BuildUrlRulesLocked() {
  mUrlRules.Clear();
  // The memo caches a pointer index into mUrlRules, so it cannot outlive the
  // vector it indexes.
  mUrlRuleMemoKey.Truncate();
  mUrlRuleMemoIndex = -1;
  mUrlRulesEnabled = Preferences::GetBool(kPrefUrlRulesEnabled, true);
  if (!mUrlRulesEnabled) {
    return;
  }

  nsCOMPtr<nsIPrefBranch> branch = do_GetService(NS_PREFSERVICE_CONTRACTID);
  if (!branch) {
    return;
  }
  nsTArray<nsCString> childNames;
  if (NS_FAILED(branch->GetChildList(kPrefUrlRulePrefix, childNames))) {
    return;
  }
  static constexpr size_t kPrefixLen = sizeof("rozelynx.netiface.urlrule.") - 1;

  // The prefs are read as a flat list, so group them by <n> first: a rule is
  // "<n>.pattern" + "<n>.iface" (+ optional "<n>.enabled") and the list order
  // GetChildList returns is not the declaration order.
  struct Pending {
    int32_t index = 0;
    bool haveIface = false;
    RozeLynxNetIfaceUrlRule rule;
  };
  nsTArray<Pending> pending;
  for (const nsCString& prefName : childNames) {
    // prefName: "rozelynx.netiface.urlrule.<n>.<field>"
    nsCString tail;
    tail = Substring(prefName, kPrefixLen);
    int32_t dot = tail.FindChar('.');
    if (dot <= 0) {
      continue;
    }
    nsCString key;
    key = Substring(tail, 0, dot);
    nsCString field;
    field = Substring(tail, dot + 1);
    nsresult parseRv = NS_OK;
    int32_t index = key.ToInteger(&parseRv);
    if (NS_FAILED(parseRv) || index < 0) {
      continue;
    }

    Pending* entry = nullptr;
    for (Pending& candidate : pending) {
      if (candidate.index == index) {
        entry = &candidate;
        break;
      }
    }
    if (!entry) {
      pending.AppendElement();
      entry = &pending[pending.Length() - 1];
      entry->index = index;
    }

    if (field == "pattern") {
      nsAutoCString pattern;
      if (NS_SUCCEEDED(Preferences::GetCString(prefName.get(), pattern))) {
        entry->rule.pattern.Assign(pattern);
      }
    } else if (field == "iface") {
      // An EMPTY iface is a real value ("force default routing for matches"),
      // so presence - not emptiness - decides whether the rule is complete.
      entry->rule.iface.Truncate();
      Preferences::GetCString(prefName.get(), entry->rule.iface);
      entry->haveIface = true;
    } else if (field == "enabled") {
      entry->rule.enabled = Preferences::GetBool(prefName.get(), true);
    }
  }

  for (Pending& entry : pending) {
    if (mUrlRules.Length() >= kMaxUrlRules) {
      LOG(("RozeLynx netiface: url rule cap (%u) reached, ignoring the rest\n",
           (unsigned)kMaxUrlRules));
      break;
    }
    if (!entry.haveIface || entry.rule.pattern.IsEmpty()) {
      continue;
    }
    // Parse into a fresh rule and copy the pref-read fields in: the parser
    // RESETS the struct it is given, so handing it entry.rule.pattern (whose
    // string it also reads) would clear the pattern before reading it.
    RozeLynxNetIfaceUrlRule parsed;
    if (!UrlRuleParsePattern(entry.rule.pattern, parsed)) {
      LOG(("RozeLynx netiface: url rule %u pattern unusable: %s\n",
           (unsigned)entry.index, entry.rule.pattern.get()));
      continue;
    }
    parsed.iface = entry.rule.iface;
    parsed.enabled = entry.rule.enabled;
    parsed.index = (uint32_t)entry.index;
    mUrlRules.AppendElement(std::move(parsed));
  }
  // Declaration order makes the tie-break ("lowest <n> wins") stable and the
  // log output deterministic.
  // Gecko 156's nsTArray::Sort dispatches on a comparator object that
  // exposes LessThan(), not on a bare predicate, so this is a functor.
  struct ByDeclaredIndex {
    bool LessThan(const RozeLynxNetIfaceUrlRule& a,
                  const RozeLynxNetIfaceUrlRule& b) const {
      return a.index < b.index;
    }
  };
  mUrlRules.Sort(ByDeclaredIndex());
  if (!mUrlRules.IsEmpty()) {
    LOG(("RozeLynx netiface: %u url rule(s) active\n",
         (unsigned)mUrlRules.Length()));
  }
}

RozeLynxNetIfaceUrlRule* RozeLynxNetIface::MatchUrlRuleLocked(
    const nsCString& aKey, const nsACString& aScheme, const nsACString& aHost,
    const nsACString& aPath) {
  if (!mUrlRulesEnabled || mUrlRules.IsEmpty() || aHost.IsEmpty()) {
    return nullptr;
  }
  // The empty key means "nothing memoized yet": every caller builds it from a
  // non-empty host, so an empty aKey can never be a real hit.
  if (!mUrlRuleMemoKey.IsEmpty() && aKey == mUrlRuleMemoKey) {
    return mUrlRuleMemoIndex < 0 ? nullptr
                                 : &mUrlRules[(size_t)mUrlRuleMemoIndex];
  }

  RozeLynxNetIfaceUrlRule* best = nullptr;
  for (RozeLynxNetIfaceUrlRule& rule : mUrlRules) {
    if (!UrlRuleMatches(rule, aScheme, aHost, aPath)) {
      continue;
    }
    if (!best || UrlRuleMoreSpecific(rule, *best)) {
      best = &rule;
    }
  }

  mUrlRuleMemoKey = aKey;
  mUrlRuleMemoIndex = best ? (int32_t)(best - mUrlRules.Elements()) : -1;
  return best;
}

void RozeLynxNetIface::FlushDNSCache() {
  MOZ_ASSERT(NS_IsMainThread());
  // A binding or TRR-provider change invalidates cached answers: hostnames
  // resolved under the previous binding (or under an old egress of the same
  // interface, or against the previous DoH upstream) may resolve differently
  // now.  ClearCache() drops every record, including
  // the per-interface partitions (nsHostKey::mBindIface) and TRR records;
  // it reaches the real cache in the socket process through
  // DNSServiceWrapper -> ChildDNSService -> PTRRService::ClearDNSCache IPC,
  // or runs in-process when the socket process is disabled.  Best effort:
  // during very early startup the DNS service may not exist yet.
  nsCOMPtr<nsIDNSService> dns = do_GetService(NS_DNSSERVICE_CONTRACTID);
  if (dns) {
    dns->ClearCache(true);
  }
}

void RozeLynxNetIface::NotifyChanged() {
  MOZ_ASSERT(NS_IsMainThread());
  FlushDNSCache();
  nsCOMPtr<nsIObserverService> obs = services::GetObserverService();
  if (obs) {
    obs->NotifyObservers(nullptr, NS_NETIFACE_CHANGED_TOPIC, nullptr);
    // RozeLynx netiface: a binding or TRR-provider change invalidates the
    // connection pools as much as the DNS cache - pooled h2/h3 sessions and
    // half-open connects were established (and their transports bound) under
    // the previous egress.  Fire the stock "net:prune-all-connections"
    // notification so nsHttpHandler runs DoShiftReloadConnectionCleanup() +
    // PruneDeadConnections(): idle and dead pooled connections are dropped
    // and active ones are not reused after their current transactions.  This
    // turns the binding toggle into an explicit, safe pool reset instead of
    // relying on the DNS-flush churn to break a wedged entry by accident.
    obs->NotifyObservers(nullptr, "net:prune-all-connections", nullptr);
  }
}

NS_IMETHODIMP
RozeLynxNetIface::Observe(nsISupports* aSubject, const char* aTopic,
                          const char16_t* aData) {
  MOZ_ASSERT(NS_IsMainThread());
  if (!strcmp(aTopic, "nsPref:changed")) {
    UpdateCachedState();
    NotifyChanged();
    return NS_OK;
  }
  if (!strcmp(aTopic, NS_NETWORK_TRR_URI_CHANGED_TOPIC)) {
    LOG(("RozeLynx netiface: TRR URI changed - flushing DNS cache"));
    FlushDNSCache();
    return NS_OK;
  }
  if (!strcmp(aTopic, NS_XPCOM_SHUTDOWN_OBSERVER_ID)) {
    nsCOMPtr<nsIPrefBranch> branch = do_GetService(NS_PREFSERVICE_CONTRACTID);
    if (branch) {
      branch->RemoveObserver(NS_NETIFACE_PREF_BRANCH, this);
    }
    nsCOMPtr<nsIObserverService> obs = services::GetObserverService();
    if (obs) {
      obs->RemoveObserver(this, NS_XPCOM_SHUTDOWN_OBSERVER_ID);
      obs->RemoveObserver(this, NS_NETWORK_TRR_URI_CHANGED_TOPIC);
    }
    gNetIface = nullptr;
    return NS_OK;
  }
  return NS_OK;
}

NS_IMETHODIMP
RozeLynxNetIface::GetSupported(bool* aSupported) {
  *aSupported = sSupported;
  return NS_OK;
}

NS_IMETHODIMP
RozeLynxNetIface::GetInterfaces(nsTArray<RefPtr<nsIRozeLynxNetIfaceInfo>>& aOut) {
  MOZ_ASSERT(NS_IsMainThread());
  aOut.Clear();

#if defined(XP_LINUX)
  struct ifaddrs* ifap = nullptr;
  if (getifaddrs(&ifap) != 0) {
    return NS_ERROR_FAILURE;
  }

  nsTHashMap<nsCStringHashKey, uint32_t> flags;
  for (struct ifaddrs* it = ifap; it; it = it->ifa_next) {
    if (!it->ifa_name) {
      continue;
    }
    uint32_t kind = 0;
    if (it->ifa_flags & IFF_UP) kind |= 0x1;
    if (it->ifa_flags & IFF_LOOPBACK) kind |= 0x2;
    const sockaddr* sa = it->ifa_addr;
    if (!sa) {
      continue;  // interface with no address entry of its own
    }
    if (sa->sa_family == AF_INET) kind |= 0x4;
    if (sa->sa_family == AF_INET6) kind |= 0x8;
    flags.LookupOrInsert(nsCString(it->ifa_name)) |= kind;
  }
  freeifaddrs(ifap);

  for (const auto& entry : flags) {
    const uint32_t kind = entry.GetData();
    if (kind & 0x2) {  // loopback
      continue;
    }
    if (!(kind & 0x1)) {  // down
      continue;
    }
    if (!(kind & (0x4 | 0x8))) {  // no v4/v6 address
      continue;
    }
    aOut.AppendElement(new NetIfaceInfo(entry.GetKey(), !!(kind & 0x1),
                                        !!(kind & 0x4), !!(kind & 0x8),
                                        !!(kind & 0x2)));
  }
#endif

  return NS_OK;
}

NS_IMETHODIMP
RozeLynxNetIface::SetTabInterface(uint64_t aBrowserId, const nsACString& aIface) {
  MOZ_ASSERT(NS_IsMainThread());
  {
    MutexAutoLock lock(mMutex);
    if (aIface.IsEmpty()) {
      mTabMap.Remove(aBrowserId);
    } else {
      mTabMap.InsertOrUpdate(aBrowserId, nsCString(aIface));
    }
    mHasAnyAssignment = HasAnyAssignmentLocked() || !mTabMap.IsEmpty();
  }
  // RozeLynx v14: keep the socket-process replica current.  The tab map is
  // runtime-only state (never rebuilt from prefs), so without this push the
  // socket process - where the ICE contexts live by default - would resolve
  // every PeerConnection below the tab layer, and a tab bound to wlan0
  // would egress WebRTC via the default route.  A '*' sentinel is pushed as
  // '*' and translated by the reader, exactly as ResolveForLoad does.
  PushTabIfaceToSocketProcess(aBrowserId);
  NotifyChanged();
  return NS_OK;
}

NS_IMETHODIMP
RozeLynxNetIface::ClearTabInterface(uint64_t aBrowserId) {
  MOZ_ASSERT(NS_IsMainThread());
  {
    MutexAutoLock lock(mMutex);
    mTabMap.Remove(aBrowserId);
    mHasAnyAssignment = HasAnyAssignmentLocked() || !mTabMap.IsEmpty();
  }
  PushTabIfaceToSocketProcess(aBrowserId);
  NotifyChanged();
  return NS_OK;
}

NS_IMETHODIMP
RozeLynxNetIface::GetTabInterface(uint64_t aBrowserId, nsACString& aOut) {
  MutexAutoLock lock(mMutex);
  aOut.Truncate();
  if (auto entry = mTabMap.Lookup(aBrowserId)) {
    aOut = entry.Data();
  }
  return NS_OK;
}

void RozeLynxNetIface::PushTabIfaceToSocketProcess(uint64_t aBrowserId) {
  // Parent singleton only: the push is what the replica consumes, so a
  // replica must never re-push (it has no socket child of its own anyway).
  if (!XRE_IsParentProcess()) {
    return;
  }
  nsCString iface;
  bool present = false;
  {
    MutexAutoLock lock(mMutex);
    if (auto entry = mTabMap.Lookup(aBrowserId)) {
      iface = entry.Data();
      present = true;
    }
  }
  RefPtr<SocketProcessParent> spp = SocketProcessParent::GetSingleton();
  if (!spp) {
    return;  // No socket process (network process disabled): ICE runs here.
  }
  if (present) {
    spp->SendRozeLynxSetTabIface(aBrowserId, iface);
  } else {
    spp->SendRozeLynxClearTabIface(aBrowserId);
  }
}

void RozeLynxNetIface::SetTabIfaceForSocketProcess(uint64_t aBrowserId,
                                                   const nsACString& aIface) {
  // Runs on the socket process main thread (PSocketProcess Recv); the
  // singleton there is the replica target and GetSingleton() inits it.
  RefPtr<RozeLynxNetIface> svc = GetSingleton();
  if (!svc) {
    return;
  }
  MutexAutoLock lock(svc->mMutex);
  // Mirrors SetTabInterface, including the empty-iface-is-clear rule; the
  // push side never sends an empty value, but the shape must agree.
  if (aIface.IsEmpty()) {
    svc->mTabMap.Remove(aBrowserId);
  } else {
    svc->mTabMap.InsertOrUpdate(aBrowserId, nsCString(aIface));
  }
  svc->mHasAnyAssignment =
      svc->HasAnyAssignmentLocked() || !svc->mTabMap.IsEmpty();
}

void RozeLynxNetIface::ClearTabIfaceForSocketProcess(uint64_t aBrowserId) {
  RefPtr<RozeLynxNetIface> svc = GetSingleton();
  if (!svc) {
    return;
  }
  MutexAutoLock lock(svc->mMutex);
  svc->mTabMap.Remove(aBrowserId);
  svc->mHasAnyAssignment =
      svc->HasAnyAssignmentLocked() || !svc->mTabMap.IsEmpty();
}

NS_IMETHODIMP
RozeLynxNetIface::SetContainerInterface(uint32_t aUserContextId,
                                        const nsACString& aIface) {
  MOZ_ASSERT(NS_IsMainThread());
  nsPrintfCString pref("rozelynx.netiface.container.%u", aUserContextId);
  if (aIface.IsEmpty()) {
    Preferences::ClearUser(pref.get());
  } else {
    Preferences::SetCString(pref.get(), aIface);
  }
  // Pref observer triggers UpdateCachedState + NotifyChanged.
  return NS_OK;
}

NS_IMETHODIMP
RozeLynxNetIface::GetContainerInterface(uint32_t aUserContextId,
                                        nsACString& aOut) {
  MutexAutoLock lock(mMutex);
  aOut.Truncate();
  if (auto entry = mContainerMap.Lookup(aUserContextId)) {
    aOut = entry.Data();
  }
  return NS_OK;
}

NS_IMETHODIMP
RozeLynxNetIface::SetProfileInterface(const nsACString& aIface) {
  MOZ_ASSERT(NS_IsMainThread());
  Preferences::SetCString(kPrefProfile, aIface);
  return NS_OK;
}

NS_IMETHODIMP
RozeLynxNetIface::GetProfileInterface(nsACString& aOut) {
  MutexAutoLock lock(mMutex);
  aOut = mProfileIface;
  return NS_OK;
}

NS_IMETHODIMP
RozeLynxNetIface::GetEffective(uint64_t aBrowserId, uint32_t aUserContextId,
                               const nsACString& aHost, nsACString& aLayer,
                               nsACString& aResult) {
  aLayer.Truncate();
  aResult.Truncate();

  MutexAutoLock lock(mMutex);
  if (auto entry = mTabMap.Lookup(aBrowserId)) {
    aLayer.AssignLiteral("tab");
    aResult = entry.Data();
    return NS_OK;
  }

  // RozeLynx: URL rules sit between the tab and container layers.  An empty
  // aHost skips the layer (a caller that cannot supply a host keeps the
  // pre-rule behavior), and a never-bind host is skipped here exactly as
  // ResolveForChannel's IsNeverBindHost early return does, so the provenance
  // reported here can never claim a binding the socket path would refuse.
  nsCString scheme;
  nsCString host;
  nsCString path;
  if (!aHost.IsEmpty()) {
    UrlRuleSplitTarget(aHost, scheme, host, path);
  }
  if (!host.IsEmpty() && !IsNeverBindHost(host)) {
    nsAutoCString key(scheme);
    key.AppendLiteral("://");
    key.Append(host);
    key.Append(path);
    if (RozeLynxNetIfaceUrlRule* rule =
            MatchUrlRuleLocked(key, scheme, host, path)) {
      aLayer.AssignLiteral("url");
      aResult = rule->iface;
      return NS_OK;
    }
  }

  if (auto entry = mContainerMap.Lookup(aUserContextId)) {
    aLayer.AssignLiteral("container");
    aResult = entry.Data();
    return NS_OK;
  }
  if (!mProfileIface.IsEmpty()) {
    aLayer.AssignLiteral("profile");
    aResult = mProfileIface;
    return NS_OK;
  }
  return NS_OK;
}

NS_IMETHODIMP
RozeLynxNetIface::MatchUrlRule(const nsACString& aUrl, int32_t* aIndex,
                               nsACString& aPattern, nsACString& aIface,
                               bool* aMatched) {
  aPattern.Truncate();
  aIface.Truncate();
  if (aIndex) {
    *aIndex = -1;
  }
  if (aMatched) {
    *aMatched = false;
  }
  MOZ_ASSERT(NS_IsMainThread());

  // Deliberately not gated on sEnabled/sSupported: this answers "which rule
  // would win for this URL", which the popup's match preview asks, and the
  // useful answer is the one computed from the rules the user can see in
  // about:config - even when the whole feature is off.  GetEffective is
  // equally ungated (it reports the profile layer in that case).
  nsCString scheme;
  nsCString host;
  nsCString path;
  UrlRuleSplitTarget(aUrl, scheme, host, path);
  if (host.IsEmpty() || IsNeverBindHost(host)) {
    LOG(("RozeLynx netiface: url rule lookup %s - no bindable host\n",
         aUrl.BeginReading()));
    return NS_OK;
  }

  nsAutoCString key(scheme);
  key.AppendLiteral("://");
  key.Append(host);
  key.Append(path);
  MutexAutoLock lock(mMutex);
  RozeLynxNetIfaceUrlRule* rule = MatchUrlRuleLocked(key, scheme, host, path);
  if (!rule) {
    LOG(("RozeLynx netiface: url rule lookup %s - no match\n",
         aUrl.BeginReading()));
    return NS_OK;
  }
  if (aIndex) {
    *aIndex = (int32_t)rule->index;
  }
  aPattern = rule->pattern;
  aIface = rule->iface;
  if (aMatched) {
    *aMatched = true;
  }
  LOG(("RozeLynx netiface: url rule lookup %s - rule %u %s -> %s\n",
       aUrl.BeginReading(), (unsigned)rule->index, rule->pattern.get(),
       rule->iface.IsEmpty() ? "(default routing)" : rule->iface.get()));
  return NS_OK;
}

NS_IMETHODIMP
RozeLynxNetIface::AdditionalInfoForHost(const nsACString& aHost,
                                        nsIDNSAdditionalInfo** aOut) {
  MOZ_ASSERT(NS_IsMainThread());
  *aOut = nullptr;
  if (!sEnabled || !sSupported || !sDnsAttribution) {
    return NS_OK;
  }

  // Same normalization as the recorder (key = lowercase, no trailing dot).
  nsAutoCString host(aHost);
  if (!host.IsEmpty() && host.Last() == '.') {
    host.Truncate(host.Length() - 1);
  }
  ToLowerCase(host);
  if (host.IsEmpty() || IsNeverBindHost(host)) {
    return NS_OK;
  }

  nsAutoCString iface;
  bool indexed = false;
  bool fromRule = false;
  {
    MutexAutoLock lock(mMutex);
    if (auto entry = mHostIndex.Lookup(host)) {
      iface = entry.Data().iface;
      indexed = true;
    } else {
      // RozeLynx: a host bound ONLY by a URL rule has no channel record yet
      // on the very first lookup, and would then take the default profile's
      // DNS mode - a DoH leak relative to the egress the rule forces.  Consult
      // the rules before giving up.  The scheme and path are left empty: a
      // DNS lookup knows neither, so a rule that narrows on them cannot be
      // said to apply, and a host-only rule can.
      nsAutoCString key("://");
      key.Append(host);
      if (RozeLynxNetIfaceUrlRule* rule =
              MatchUrlRuleLocked(key, nsCString(), host, nsCString())) {
        iface = rule->iface;
        fromRule = true;
      }
    }
  }
  if (!indexed && !fromRule) {
    LOG(("RozeLynx netiface: host index miss host=%s\n", host.get()));
    return NS_OK;  // never seen a channel for this host: stay unbound
  }
  if (iface.IsEmpty()) {
    // Most recent channel for this host was unassigned - or a URL rule pinned
    // it to default routing: an attributed forced-TRR record would send this
    // lookup somewhere the page itself does not go.  Return null so the caller
    // keeps unbound behavior.
    LOG(("RozeLynx netiface: host index %s host=%s iface=- info=0\n",
         indexed ? "hit" : "url rule", host.get()));
    return NS_OK;
  }

  // Mirror the HappyEyeballs attach pattern (net-iface-necko.patch): use the
  // per-interface DoH override when set, else the global network.trr.uri so
  // attributed lookups still resolve over DoH instead of failing closed.
  nsAutoCString resolverURL;
  GetIfaceTrrURI(iface, resolverURL);
  if (resolverURL.IsEmpty() && TRRService::Get()) {
    TRRService::Get()->GetURI(resolverURL);
  }
  // Mirror net-iface-provider-host-native-fix: never carry a resolver URL on
  // the DoH provider's OWN host lookups -- upstream NameLookup fails such
  // mTrrServer records instantly (NS_ERROR_UNKNOWN_HOST) and the lookup
  // would recurse into the very DoH connection it bootstraps.  An empty
  // resolver URL keeps the record on the native path (bootstrap via the
  // default route; getaddrinfo cannot bind - accepted tradeoff, same as
  // DoH-off).
  if (!resolverURL.IsEmpty()) {
    bool isProviderHost =
        (TRRService::Get() && TRRService::Get()->IsProviderHost(host));
    if (!isProviderHost) {
      nsCOMPtr<nsIURI> resolverURI;
      nsAutoCString resolverHost;
      if (NS_SUCCEEDED(NS_NewURI(getter_AddRefs(resolverURI), resolverURL)) &&
          NS_SUCCEEDED(resolverURI->GetAsciiHost(resolverHost)) &&
          !resolverHost.IsEmpty() &&
          resolverHost.Equals(host, nsCaseInsensitiveCStringComparator)) {
        isProviderHost = true;
      }
    }
    if (isProviderHost) {
      LOG(("RozeLynx netiface: host index hit host=%s iface=%s - provider "
           "host, no resolver URL\n",
           host.get(), iface.get()));
      resolverURL.Truncate();
    }
  }

  LOG(("RozeLynx netiface: host index hit host=%s iface=%s info=1\n",
       host.get(), iface.get()));
  RefPtr<DNSAdditionalInfo> info = new DNSAdditionalInfo(resolverURL, -1, iface);
  info.forget(aOut);
  return NS_OK;
}

void RozeLynxNetIface::RecordHostBinding(const nsACString& aHost,
                                         const nsACString& aIface) {
  MOZ_ASSERT(NS_IsMainThread());
  if (!sDnsAttribution) {
    return;
  }
  // Key = normalized GetAsciiHost: lowercase, no trailing dot.
  nsAutoCString key(aHost);
  if (!key.IsEmpty() && key.Last() == '.') {
    key.Truncate(key.Length() - 1);
  }
  ToLowerCase(key);
  if (key.IsEmpty() || IsNeverBindHost(key)) {
    return;
  }

  MutexAutoLock lock(mMutex);
  if (mHostIndex.Count() >= kHostIndexHardCap) {
    LOG(("RozeLynx netiface: host index hard-clear at %u entries\n",
         (unsigned)mHostIndex.Count()));
    mHostIndex.Clear();
  } else if (mHostIndex.Count() >= kHostIndexSoftCap) {
    TimeStamp cutoff =
        TimeStamp::Now() - TimeDuration::FromSeconds(kHostIndexTTLSeconds);
    for (auto iter = mHostIndex.Iter(); !iter.Done(); iter.Next()) {
      if (iter.Data().lastSeen < cutoff) {
        iter.Remove();
      }
    }
  }
  auto& entry = mHostIndex.LookupOrInsert(key);
  entry.iface.Assign(aIface);
  entry.lastSeen = TimeStamp::Now();
  nsAutoCString ifName(aIface);
  LOG(("RozeLynx netiface: host index record host=%s iface=%s\n",
       key.get(), ifName.IsEmpty() ? "-" : ifName.get()));
}

// static
bool RozeLynxNetIface::ResolveForChannel(nsIChannel* aChannel,
                                         nsACString& aOut) {
  aOut.Truncate();
  if (!aChannel || !XRE_IsParentProcess()) {
    return false;
  }
  nsCOMPtr<nsIURI> uri;
  aChannel->GetURI(getter_AddRefs(uri));
  nsCOMPtr<nsILoadInfo> loadInfo;
  aChannel->GetLoadInfo(getter_AddRefs(loadInfo));
  return ResolveForLoad(uri, loadInfo, aOut);
}

// static
bool RozeLynxNetIface::ResolveForWebSocket(nsIURI* aURI,
                                          nsILoadInfo* aLoadInfo,
                                          nsACString& aOut) {
  aOut.Truncate();
  if (!aURI || !XRE_IsParentProcess()) {
    return false;
  }
  return ResolveForLoad(aURI, aLoadInfo, aOut);
}

// static
bool RozeLynxNetIface::ResolveForLoad(nsIURI* aURI, nsILoadInfo* aLoadInfo,
                                      nsACString& aOut) {
  aOut.Truncate();
  MOZ_ASSERT(NS_IsMainThread());

  // GetSingleton() performs Init(), which is what populates the cached pref
  // state and sets sEnabled/sSupported.  It must run *before* the enable
  // check: otherwise the first (and every) lookup would short-circuit on the
  // still-false atomics and the feature would never activate unless some
  // other consumer happened to instantiate the XPCOM service first.
  RefPtr<RozeLynxNetIface> svc = GetSingleton();
  if (!svc || !sEnabled || !sSupported) {
    return false;
  }

  nsAutoCString rozelynxHost;
  bool rozelynxHaveHost = false;
  if (aURI) {
    if (NS_SUCCEEDED(aURI->GetAsciiHost(rozelynxHost)) &&
        !rozelynxHost.IsEmpty()) {
      rozelynxHaveHost = true;
      // Never-bind hosts (loopback/LAN literal IPs, localhost, *.local)
      // stay unassigned: they load via normal routing and the profile's
      // default DNS mode instead of dying on an interface-bound socket.
      // The host index skips them too (their DNS must keep the default
      // mode, so an attributed forced-TRR record would break resolution).
      if (IsNeverBindHost(rozelynxHost)) {
        aOut.Truncate();
        return true;
      }
    }
  }

  if (!aLoadInfo) {
    return false;
  }

  // Tab layer: top-level BrowsingContext of the loading document.
  uint64_t browserId = 0;
  RefPtr<BrowsingContext> bc;
  aLoadInfo->GetBrowsingContext(getter_AddRefs(bc));
  if (bc && bc->Top()) {
    browserId = bc->Top()->BrowserId();
  }

  OriginAttributes attrs = aLoadInfo->GetOriginAttributes();

  bool resolved = false;
  {
    MutexAutoLock lock(svc->mMutex);
    if (browserId) {
      if (auto entry = svc->mTabMap.Lookup(browserId)) {
        // A stored "*" is an explicit all-interfaces binding: resolve to empty
        // so nothing is bound, but keep resolved=true so the tab layer still
        // wins and a URL/container/profile default cannot override it.
        if (entry.Data().EqualsLiteral(NS_NETIFACE_ALL_IFACES)) {
          aOut.Truncate();
        } else {
          aOut = entry.Data();
        }
        resolved = true;
      }
    }
    if (!resolved && rozelynxHaveHost) {
      // RozeLynx: per-URL rules sit BETWEEN the tab and container layers, so
      // an explicit tab binding still wins while a rule beats the container
      // and profile defaults.  Evaluated after the IsNeverBindHost early
      // return above, so a rule can never bind loopback/LAN/localhost.
      //
      // The scheme and path are fetched here, inside the layer, so a build
      // with no rules (the overwhelmingly common case) never pays for two
      // extra nsIURI calls per channel.
      if (svc->mUrlRulesEnabled && !svc->mUrlRules.IsEmpty()) {
        nsAutoCString scheme;
        nsAutoCString path;
        if (aURI) {
          aURI->GetScheme(scheme);
          aURI->GetPathQueryRef(path);
        }
        nsCString ruleHost(rozelynxHost);
        nsCString ruleScheme(scheme);
        nsCString rulePath(path);
        ToLowerCase(ruleHost);
        ToLowerCase(ruleScheme);
        ToLowerCase(rulePath);
        nsAutoCString key(ruleScheme);
        key.AppendLiteral("://");
        key.Append(ruleHost);
        key.Append(rulePath);
        if (RozeLynxNetIfaceUrlRule* rule =
                svc->MatchUrlRuleLocked(key, ruleScheme, ruleHost, rulePath)) {
          aOut = rule->iface;
          resolved = true;
          LOG(("RozeLynx netiface: channel host=%s -> url rule %u %s = %s\n",
               ruleHost.get(), (unsigned)rule->index, rule->pattern.get(),
               rule->iface.IsEmpty() ? "(default routing)"
                                     : rule->iface.get()));
        }
      }
    }
    if (!resolved) {
      if (auto entry = svc->mContainerMap.Lookup(attrs.mUserContextId)) {
        aOut = entry.Data();
        resolved = true;
      }
    }
    if (!resolved && !svc->mProfileIface.IsEmpty()) {
      aOut = svc->mProfileIface;
      resolved = true;
    }
  }

  // RozeLynx v13: remember which interface this load just used for its
  // host (including "" for unassigned), so extension-driven lookups for the
  // same host can be attributed to the same egress (most-recent-wins gives
  // per-request correctness for hosts shared across bound/unbound tabs).
  // Recorded only on main thread, after the map lock is released.
  if (rozelynxHaveHost) {
    svc->RecordHostBinding(rozelynxHost, aOut);
  }
  return true;  // feature active; aOut "" = unassigned
}

// static
bool RozeLynxNetIface::ResolveForOriginAttributes(
    const OriginAttributes& aAttrs, nsACString& aOut) {
  aOut.Truncate();
  if (!XRE_IsParentProcess()) {
    return false;
  }
  MOZ_ASSERT(NS_IsMainThread());

  // See ResolveForChannel: initialize before consulting the enable flags.
  RefPtr<RozeLynxNetIface> svc = GetSingleton();
  if (!svc || !sEnabled || !sSupported) {
    return false;
  }

  // KNOWN LIMITATION, documented rather than worked around: this entry point
  // has no URL - only origin attributes - so the per-URL rule layer cannot be
  // evaluated here.  That is only reachable for a speculative or otherwise
  // early connection, started before the document's host is known; the real
  // channel resolution (ResolveForChannel) does apply the rule and binds the
  // socket, so no traffic escapes the rule's interface.  Adding a host
  // parameter to the speculative-connect call site would close the gap, at the
  // cost of a per-version necko patch hunk.
  MutexAutoLock lock(svc->mMutex);
  if (auto entry = svc->mContainerMap.Lookup(aAttrs.mUserContextId)) {
    aOut = entry.Data();
    return true;
  }
  if (!svc->mProfileIface.IsEmpty()) {
    aOut = svc->mProfileIface;
    return true;
  }
  return true;
}

// static
bool RozeLynxNetIface::ResolveForWebRTC(uint64_t aBrowserId,
                                       uint32_t aUserContextId,
                                       const nsACString& aDocUrl,
                                       nsACString& aOut) {
  aOut.Truncate();
  MOZ_ASSERT(NS_IsMainThread());
  // Called from the CreateIceCtx main-thread hop, in whichever process
  // builds the ICE context.  The content process (the non-default
  // media.peerconnection.mtransport_process=false config, where ICE runs
  // in content) is left out deliberately: it has no tab-map replica (the
  // push targets the socket process only) and no resolver state worth
  // consulting, so it resolves unbound and logs, exactly as before.
  if (!XRE_IsParentProcess() && !XRE_IsSocketProcess()) {
    return false;
  }
  RefPtr<RozeLynxNetIface> svc = GetSingleton();
  if (!svc || !sEnabled || !sSupported) {
    return false;
  }

  MutexAutoLock lock(svc->mMutex);
  bool resolved = false;
  // Tab layer: keyed by the PC's top-level BrowsingContext BrowserId, the
  // same key the popup sets.  A '*' entry is the per-tab all-interfaces
  // sentinel and resolves to unbound, still winning the layer (a profile
  // default must not override an explicit tab choice).
  if (aBrowserId) {
    if (auto entry = svc->mTabMap.Lookup(aBrowserId)) {
      if (entry.Data().EqualsLiteral(NS_NETIFACE_ALL_IFACES)) {
        aOut.Truncate();
      } else {
        aOut = entry.Data();
      }
      resolved = true;
    }
  }
  // URL-rule layer: the PC's document URL, the same grammar and the same
  // never-bind exclusion as ResolveForLoad.  An empty aDocUrl (chrome
  // windows, tests) skips the layer rather than matching rules.
  if (!resolved && !aDocUrl.IsEmpty() && svc->mUrlRulesEnabled &&
      !svc->mUrlRules.IsEmpty()) {
    nsCString scheme;
    nsCString host;
    nsCString path;
    UrlRuleSplitTarget(aDocUrl, scheme, host, path);
    if (!host.IsEmpty() && !IsNeverBindHost(host)) {
      nsAutoCString key(scheme);
      key.AppendLiteral("://");
      key.Append(host);
      key.Append(path);
      if (RozeLynxNetIfaceUrlRule* rule =
              svc->MatchUrlRuleLocked(key, scheme, host, path)) {
        aOut = rule->iface;
        resolved = true;
      }
    }
  }
  if (!resolved) {
    if (auto entry = svc->mContainerMap.Lookup(aUserContextId)) {
      aOut = entry.Data();
      resolved = true;
    }
  }
  if (!resolved && !svc->mProfileIface.IsEmpty()) {
    aOut = svc->mProfileIface;
  }
  LOG(("RozeLynx netiface: webrtc ctx browserId=%" PRIu64
       " container=%u doc=%s -> iface=%s\n",
       aBrowserId, aUserContextId,
       PromiseFlatCString(aDocUrl).get(),
       aOut.IsEmpty() ? "(default routing)" : PromiseFlatCString(aOut).get()));
  return true;  // feature active; aOut "" = unassigned
}

#undef LOG

}  // namespace net
}  // namespace mozilla
