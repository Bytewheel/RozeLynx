/* RozeLynx experiment API: open the NATIVE docked DevTools toolbox for a
 * given tab (same-tab, like Ctrl+Shift+I / the native context menu's Inspect
 * Element) and select the element the synthetic menu was invoked on.
 *
 * The toolbox is hosted BOTTOM in the target tab via gDevTools.showToolboxForTab,
 * and the marked node is selected through the inspector walker (attribute
 * selector instead of a ContentDOMReference, which only the content process
 * can create).
 *
 * The experiment sandbox already provides ExtensionAPI, Services, Cc, Ci and
 * ChromeUtils as globals - do not import them here.
 *
 * Do NOT reach for win.gDevTools: nothing in Gecko puts the DevTools
 * singleton on a chrome window (checked in the 155 and 156 devtools trees,
 * where the only assignment is devtools.js's own `exports.gDevTools`).
 * See the comment at the initDevTools call for the supported route.
 */

this.rozelynxDevtools = class extends ExtensionAPI {
  getAPI(context) {
    return {
      rozelynxDevtools: {
        async inspect(options) {
          const url = options && options.url;
          const mark = (options && options.mark) || "";
          const tool =
            options && options.tool === "accessibility"
              ? "accessibility"
              : "inspector";
          if (!url) {
            throw new Error("rozelynxDevtools.inspect: url is required");
          }

          // Find the tab containing the given URL.  Search ALL browser
          // windows (not just the most-recent one) so Inspect works even
          // when the target is in a PWA window or a secondary monitor.
          let tab = null;
          const enumerator = Services.wm.getEnumerator("navigator:browser");
          while (enumerator.hasMoreElements()) {
            const w = enumerator.getNext();
            if (!w || !w.gBrowser) continue;
            for (const t of w.gBrowser.tabs) {
              const browser = t.linkedBrowser;
              try {
                if (browser.currentURI && browser.currentURI.spec === url) {
                  tab = t;
                  break;
                }
              } catch (e) {
                // Ignore tabs whose currentURI cannot be inspected.
              }
            }
            if (tab) break;
          }
          if (!tab) {
            throw new Error(
              "rozelynxDevtools.inspect: source tab not found: " + url
            );
          }

          // Get the DevTools singleton the way the browser's own entry points
          // do: DevToolsStartup.initDevTools() loads the DevTools modules and
          // RETURNS the DevTools loader's require(), so
          // require("devtools/client/framework/devtools").gDevTools is the very
          // instance devtools-browser.js drives.  That is the sequence upstream
          // uses in DevToolsStartup.sys.mjs (handleDevToolsFlag /
          // checkForDebuggerLink), and it deliberately avoids a DevToolsShim
          // import, which can fail in a 155+ experiment sandbox.
          //
          // There is intentionally no "already initialized" gate: the DevTools
          // loader caches what it hands back, so a repeat call is cheap, and
          // the returned require() is the only supported way to reach gDevTools
          // from outside the DevTools loader.
          const DevToolsStartup = Cc[
            "@mozilla.org/devtools/startup-clh;1"
          ].getService(Ci.nsICommandLineHandler).wrappedJSObject;
          const require = DevToolsStartup.initDevTools("ContextMenu");
          const { gDevTools } = require("devtools/client/framework/devtools");
          if (!gDevTools) {
            throw new Error("rozelynxDevtools.inspect: gDevTools not available");
          }

          const toolbox = await gDevTools.showToolboxForTab(tab, {
            toolId: tool,
            reason: "inspect_dom",
          });
          if (!toolbox) {
            return { opened: false, selected: false };
          }
          if (!mark) {
            return { opened: true, selected: false };
          }

          // Select the marked node. Mirrors gDevTools.inspectNode's explicit
          // selection branch (used when the toolbox was already open), but
          // resolves the node by attribute selector.
          try {
            const inspectorFront = await toolbox.target.getFront("inspector");
            const walker = inspectorFront.walker;
            let rootNode = walker.rootNode;
            if (!rootNode) {
              rootNode = await walker.getRootNode();
            }
            const nodeFront = await walker.querySelector(
              rootNode,
              '[data-rozelynx-inspect="' + mark + '"]'
            );
            if (!nodeFront) {
              return { opened: true, selected: false };
            }

            if (tool === "accessibility") {
              const a11yPanel = toolbox.getCurrentPanel();
              const onSelected = a11yPanel.once(
                "new-accessible-front-selected"
              );
              a11yPanel.selectAccessibleForNode(
                nodeFront,
                "browser-context-menu"
              );
              await onSelected;
            } else {
              const inspector = toolbox.getCurrentPanel();
              const onNewNode = inspector.selection.once("new-node-front");
              inspector.selection.setNodeFront(nodeFront, {
                reason: "browser-context-menu",
              });
              await onNewNode;
              await inspector.once("inspector-updated");
            }
            return { opened: true, selected: true };
          } catch (e) {
            // The toolbox is open either way; report the selection failure.
            console.error("rozelynx: failed to select marked node", e);
            return { opened: true, selected: false };
          }
        },
      },
    };
  }
};
