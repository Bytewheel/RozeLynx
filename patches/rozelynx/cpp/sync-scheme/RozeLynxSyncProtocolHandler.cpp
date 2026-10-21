/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "RozeLynxSyncProtocolHandler.h"

#include "mozilla/Services.h"
#include "nsIChannel.h"
#include "nsILoadInfo.h"
#include "nsIInputStream.h"
#include "nsIObserverService.h"
#include "nsIPrincipal.h"
#include "nsNetUtil.h"
#include "nsServiceManagerUtils.h"
#include "nsString.h"
#include "nsStringStream.h"

namespace mozilla {
namespace net {

// The one-slot park: the last trusted link that arrived while nobody was
// listening. Main thread only, cleared on consume.
nsString gRozeLynxSyncPendingLink;

NS_IMPL_ISUPPORTS(RozeLynxSyncProtocolHandler, nsIProtocolHandler,
                  nsIRozeLynxSyncLink)

// The placeholder the channel serves: the extension's restore does the
// work and closes the tab, so this only needs to say why the tab exists.
static const char kPlaceholderHtml[] =
    "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>RozeLynx "
    "sync</title><style>body{background:#1e1e2e;color:#cdd6f4;font-family:"
    "sans-serif;display:flex;align-items:center;justify-content:center;"
    "height:100vh;margin:0}p{max-width:30em;line-height:1.6;text-align:center}"
    "</style></head><body><p>RozeLynx sync link received. If the state does "
    "not restore itself, paste the link into RozeLynx\u2019s address bar "
    "from the sync panel instead. This tab can be closed.</p></body></html>";

NS_IMETHODIMP
RozeLynxSyncProtocolHandler::GetScheme(nsACString& aResult) {
  aResult.AssignLiteral(ROZELYNX_SYNC_SCHEME);
  return NS_OK;
}

// (No NewURI: this Firefox base parses URIs centrally - NS_NewURI builds a
// DefaultURI/nsSimpleURI for schemes without their own URI implementation,
// and the whole payload rides in the fragment, which both preserve.)

// static
bool RozeLynxSyncProtocolHandler::TriggeringPrincipalIsTrusted(
    nsILoadInfo* aLoadInfo) {
  if (!aLoadInfo) {
    return false;
  }
  nsCOMPtr<nsIPrincipal> principal;
  if (NS_FAILED(aLoadInfo->GetTriggeringPrincipal(
          getter_AddRefs(principal))) ||
      !principal) {
    return false;
  }
  // System: the URL bar, bookmarks, the command line (the OS handler
  // path). Expanded: extension pages (the sync panel itself). Content
  // principals - web pages - never reach the observer.
  bool isSystem = false;
  if (NS_SUCCEEDED(principal->GetIsSystemPrincipal(&isSystem)) && isSystem) {
    return true;
  }
  bool isExpanded = false;
  if (NS_SUCCEEDED(principal->GetIsExpandedPrincipal(&isExpanded)) &&
      isExpanded) {
    return true;
  }
  return false;
}

NS_IMETHODIMP
RozeLynxSyncProtocolHandler::NewChannel(nsIURI* aURI, nsILoadInfo* aLoadInfo,
                                       nsIChannel** aResult) {
  nsAutoCString spec;
  nsresult rv = aURI->GetSpec(spec);
  NS_ENSURE_SUCCESS(rv, rv);

  // Hand the link to the extension's sync module (which may need to wake
  // the MV3 event page - the experiment API parks the URL too, so a link
  // that arrives during a wakeup replays instead of being lost).
  if (TriggeringPrincipalIsTrusted(aLoadInfo)) {
    // PARK FIRST: a command-line link can arrive during startup, before
    // the extension that performs the restore has registered its
    // observer. The slot is one deep - a second link while the first is
    // still parked replaces it, because the restore the first link would
    // have driven never happened.
    gRozeLynxSyncPendingLink = NS_ConvertUTF8toUTF16(spec);
    nsCOMPtr<nsIObserverService> obs = services::GetObserverService();
    if (obs) {
      // Fire and forget: the restore is the extension's business. When a
      // listener IS up it parks the link again (its own replay slot) and
      // takes over; when nobody answers, the parked slot above still
      // holds the link for the extension's drain at startup.
      obs->NotifyObservers(nullptr, "rozelynx-sync-link",
                           gRozeLynxSyncPendingLink.get());
    }
  }

  // The channel always serves the same placeholder page: the tab exists
  // only to carry the navigation that triggered the restore, and the
  // extension closes it (tabs.query url rozelynxsync://*) once the
  // restore is under way.
  nsCOMPtr<nsIInputStream> in;
  rv = NS_NewCStringInputStream(getter_AddRefs(in),
                                nsDependentCString(kPlaceholderHtml));
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsIChannel> channel;
  rv = NS_NewInputStreamChannelInternal(getter_AddRefs(channel), aURI,
                                        in.forget(), "text/html"_ns,
                                        "utf-8"_ns, aLoadInfo);
  NS_ENSURE_SUCCESS(rv, rv);

  channel.forget(aResult);
  return NS_OK;
}

NS_IMETHODIMP
RozeLynxSyncProtocolHandler::AllowPort(int32_t aPort, const char* aScheme,
                                      bool* aResult) {
  *aResult = false;  // no ports in a magic link
  return NS_OK;
}

NS_IMETHODIMP
RozeLynxSyncProtocolHandler::ConsumePendingLink(nsACString& aResult) {
  // Called once, at the sync experiment API's load: hand over (and clear)
  // a link that arrived before anyone was listening.
  CopyUTF16toUTF8(gRozeLynxSyncPendingLink, aResult);
  gRozeLynxSyncPendingLink.Truncate();
  return NS_OK;
}

}  // namespace net
}  // namespace mozilla
