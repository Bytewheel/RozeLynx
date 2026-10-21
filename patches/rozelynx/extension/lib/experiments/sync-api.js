/* RozeLynx experiment API: sync magic-link handoff (parent side).
 *
 * The browser side of the magic link is a protocol handler patched into
 * netwerk (see patches/rozelynx/cpp/sync-scheme/): any navigation to a
 * rozelynxsync:// URL - typed in the URL bar, clicked from a page, or passed
 * on the command line when the OS scheme handler launches RozeLynx - lands in
 * RozeLynxSyncProtocolHandler::NewChannel, which parks the URL here and
 * cancels the navigation.
 *
 * This side bridges the URL to the extension:
 *   - as an observer of the "rozelynx-sync-link" notification the C++
 *     handler fires, re-emitted as the rozelynxSync.onSyncLink event (a
 *     PERSISTED event: a click while the MV3 event page is suspended wakes
 *     it and replays the link, exactly like the netiface chip click);
 *   - through getPendingLink(), because a persisted-event replay can also
 *     arrive as "wake, then re-register listener" with no second
 *     notification - the parked slot is what the background reads on
 *     startup to catch a link that arrived while it was down.
 *
 * The experiment sandbox provides ExtensionAPIPersistent, ExtensionCommon,
 * Services, Cc, Ci and ChromeUtils as globals.
 */

var rozelynxSyncPendingLink = {
  url: '',
  // onSyncLink listener closures. While the MV3 event page is suspended
  // this holds the PRIMED closure, whose fire queues the link and wakes the
  // background.
  fires: new Set(),
};

function rozelynxSyncDispatch(info) {
  rozelynxSyncPendingLink.fires.forEach(function(listener) {
    try {
      Promise.resolve(listener(info)).catch(function() {});
    } catch (e) {}
  });
}

var rozelynxSyncObserver = {
  observe(subject, topic, data) {
    if (topic !== "rozelynx-sync-link") {
      return;
    }
    const url = String(data || "");
    if (!url.startsWith("rozelynxsync:")) {
      return;
    }
    // Park it: a persisted-event wakeup replays through the primed fire, but
    // a background that starts fresh (browser just launched) reads the slot
    // once it registers, so a link cannot be lost to the wakeup race.
    rozelynxSyncPendingLink.url = url;
    // The live listener takes over: clear the browser-side park (the same
    // URL) so a browser restart cannot replay a link that was already
    // delivered.
    try {
      Cc["@mozilla.org/network/protocol;1?name=rozelynxsync"]
        .getService(Ci.nsIRozeLynxSyncLink)
        .consumePendingLink();
    } catch (e) {}
    rozelynxSyncDispatch({ url });
  },
  QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),
};

try {
  Services.obs.addObserver(rozelynxSyncObserver, "rozelynx-sync-link");
} catch (e) {}

// DRAIN THE BROWSER-SIDE PARK: a command-line link (another app asked the
// OS to open it) can reach the handler during startup, before this API
// loaded - the handler parks it in a one-slot buffer instead. Consuming
// it here moves it into the replay slot above, so the background's
// onSyncLink registration replays it exactly like a live link.
try {
  let pending = "";
  try {
    pending = Cc["@mozilla.org/network/protocol;1?name=rozelynxsync"]
      .getService(Ci.nsIRozeLynxSyncLink)
      .consumePendingLink();
  } catch (e) {
    // Older build without the park slot: nothing to drain.
  }
  if (pending && pending.startsWith("rozelynxsync:")) {
    rozelynxSyncPendingLink.url = pending;
  }
} catch (e) {}

this.rozelynxSync = class extends ExtensionAPIPersistent {
  // onSyncLink is a PERSISTED event so the link wakes a suspended event
  // page and is replayed to the freshly-registered listener.
  PERSISTENT_EVENTS = {
    onSyncLink({ fire }) {
      const listener = info => {
        try {
          Promise.resolve(fire.async(info)).catch(function() {});
        } catch (e) {}
      };
      rozelynxSyncPendingLink.fires.add(listener);
      // A link that arrived while nobody was listening is replayed on
      // registration, which is the whole point of the parked slot.
      const pending = rozelynxSyncPendingLink.url;
      if (pending) {
        rozelynxSyncPendingLink.url = "";
        listener({ url: pending });
      }
      return {
        unregister() {
          rozelynxSyncPendingLink.fires.delete(listener);
        },
        convert(newFire) {
          fire = newFire;
        },
      };
    },
  };

  onShutdown(_isAppShutdown) {
    rozelynxSyncPendingLink.fires.clear();
  }

  getAPI(context) {
    return {
      rozelynxSync: {
        getPendingLink() {
          const url = rozelynxSyncPendingLink.url;
          rozelynxSyncPendingLink.url = "";
          return url;
        },

        onSyncLink: new ExtensionCommon.EventManager({
          context,
          module: "rozelynxSync",
          event: "onSyncLink",
          inputHandling: true,
          extensionApi: this,
        }).api(),
      },
    };
  }
};
