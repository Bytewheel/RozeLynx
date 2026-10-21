/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_net_RozeLynxSyncProtocolHandler_h_
#define mozilla_net_RozeLynxSyncProtocolHandler_h_

#include "nsCOMPtr.h"
#include "nsIProtocolHandler.h"
#include "nsIRozeLynxSyncLink.h"
#include "nsISupportsUtils.h"

#define ROZELYNX_SYNC_SCHEME "rozelynxsync"

class nsILoadInfo;
class nsIURI;

namespace mozilla {
namespace net {

// The one-slot park for a link that arrived before the extension was up
// (main thread only, like the rest of this handler).
extern nsString gRozeLynxSyncPendingLink;

/**
 * RozeLynx sync magic-link scheme (USE=sync).
 *
 * A magic link is a self-contained state transfer:
 *
 *   rozelynxsync://sync/#v=1&k=<key>&i=<iv>&d=<payload>
 *
 * The payload is the gathered browser state, gzipped and AES-GCM
 * encrypted, and the key rides in the same link - there is no server, no
 * account and no second channel. Opening the link in ANY RozeLynx
 * decrypts it and restores the state it carries (tabs, history, cookies,
 * extensions list, rozelynx.* configuration); the restore itself lives in
 * the RozeLynx Features extension's sync module, reached through the
 * "rozelynx-sync-link" observer this handler fires.
 *
 * WHY A SCHEME: the OS registers x-scheme-handler/rozelynxsync to
 * RozeLynx, so clicking a received link in another app launches this
 * browser with it on the command line; the URL bar accepts it pasted;
 * and the scheme is NOT loadable by web content (URI_DANGEROUS_TO_LOAD,
 * see components.conf), so a hostile page cannot drive a state restore -
 * the observer only fires for trusted principals (system / expanded),
 * which the URL bar, the command line and extension pages hold, and
 * never for content principals. The channel this returns is a small
 * placeholder page; the extension's restore closes it and opens the
 * restored windows.
 *
 * The scheme's flags live in components.conf's protocol_config (the
 * nsIProtocolHandler of this Firefox base carries only scheme/newChannel/
 * allowPort; flags and default port are static registration data).
 */
class RozeLynxSyncProtocolHandler final : public nsIProtocolHandler,
                                        public nsIRozeLynxSyncLink {
  NS_DECL_ISUPPORTS
  NS_DECL_NSIPROTOCOLHANDLER
  NS_DECL_NSIROZELYNXSYNCLINK

 public:
  RozeLynxSyncProtocolHandler() = default;

 private:
  ~RozeLynxSyncProtocolHandler() = default;

  // True when the navigation is one the user made directly (URL bar,
  // command line from the OS handler, a bookmark, an extension page) and
  // NOT a web page. Only these may trigger a state restore.
  static bool TriggeringPrincipalIsTrusted(nsILoadInfo* aLoadInfo);
};

}  // namespace net
}  // namespace mozilla

#endif  // mozilla_net_RozeLynxSyncProtocolHandler_h_
