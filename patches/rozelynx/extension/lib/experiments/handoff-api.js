/* RozeLynx experiment API: the ext: hand-off relay bridge (parent side).
 *
 * The download hand-off ENGINE is browser code (uriloader/exthandler/
 * rozelynx-handoff/, USE=download-handoff), but the ext:<id> handler type
 * means "another extension takes this download" - and only an extension
 * can send a cross-extension runtime message. So the RozeLynx Features
 * extension carries a tiny relay module (modules/handoff-relay/) whose
 * ONLY job is to forward the download payload and report the answer.
 *
 * This side bridges the browser observer to the relay:
 *   - the engine fires the "rozelynx-handoff-ext" observer with a JSON
 *     payload and spins the main loop, bounded;
 *   - onHandoffRequest (a PERSISTED event: the MV3 event page may be
 *     suspended; a request wakes it and replays) carries the payload to
 *     the relay;
 *   - respond() calls back into the engine (nsIRozeLynxHandoff::
 *     respondExtHandler) and unblocks the spin.
 *
 * The experiment sandbox provides ExtensionAPIPersistent, ExtensionCommon,
 * Cc, Ci and ChromeUtils as globals.
 */

var rozelynxHandoffBridge = {
  // onHandoffRequest listener closures. While the MV3 event page is
  // suspended this holds the PRIMED closure whose fire wakes the
  // background and replays the request.
  fires: new Set(),
};

this.rozelynxHandoff = class extends ExtensionAPIPersistent {
  // onHandoffRequest is a PERSISTED event so an ext: handler that fires
  // while the event page is down still wakes the relay in time for the
  // engine's bounded wait.
  PERSISTENT_EVENTS = {
    onHandoffRequest({ fire }) {
      const listener = info => {
        try {
          Promise.resolve(fire.async(info)).catch(() => {});
        } catch (e) {}
      };
      rozelynxHandoffBridge.fires.add(listener);
      return {
        unregister() {
          rozelynxHandoffBridge.fires.delete(listener);
        },
        convert(newFire) {
          fire = newFire;
        },
      };
    },
  };

  onShutdown(_isAppShutdown) {
    rozelynxHandoffBridge.fires.clear();
  }

  getAPI(context) {
    // Registered lazily (the observer exists for the whole browser
    // session; keeping the callback keyed by this context means a
    // suspended event page's context teardown drops it cleanly).
    const observer = {
      observe(subject, topic, data) {
        if (topic !== "rozelynx-handoff-ext") {
          return;
        }
        let info = {};
        try {
          info = JSON.parse(String(data || "{}"));
        } catch (e) {
          return;
        }
        // Refire through every registered listener; a suspended background
        // has its primed listener queued, so the request replays on wake.
        // Requests are not parked here (unlike the sync link): the engine's
        // wait is short and a stale ext: request has no download left to
        // take - answering late would be worse than declining.
        rozelynxHandoffBridge.fires.forEach(function(listener) {
          try {
            listener(info);
          } catch (e) {}
        });
      },
      QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),
    };
    try {
      Services.obs.addObserver(observer, "rozelynx-handoff-ext");
      context.callOnClose({
        close() {
          try {
            Services.obs.removeObserver(observer, "rozelynx-handoff-ext");
          } catch (e) {}
        },
      });
    } catch (e) {}

    return {
      rozelynxHandoff: {
        async respond(requestId, accepted, error) {
          try {
            // Straight back into the engine; a stale id is a no-op there.
            Cc["@bytewheel.org/handoff;1"]
              .getService(Ci.nsIRozeLynxHandoff)
              .respondExtHandler(requestId, !!accepted, String(error || ""));
          } catch (e) {
            // A build without the engine (USE=download-handoff off) never
            // fires the observer, so this is unreachable in practice; the
            // answer is simply dropped.
          }
          return { ok: true };
        },

        onHandoffRequest: new ExtensionCommon.EventManager({
          context,
          module: "rozelynxHandoff",
          event: "onHandoffRequest",
          inputHandling: true,
          extensionApi: this,
        }).api(),
      },
    };
  }
};
