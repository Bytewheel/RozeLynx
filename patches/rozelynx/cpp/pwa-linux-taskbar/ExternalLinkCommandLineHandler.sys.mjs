/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AddonManager } from "resource://gre/modules/AddonManager.sys.mjs";
import { BrowserWindowTracker } from "resource:///modules/BrowserWindowTracker.sys.mjs";

const TRACE_FILE = "/tmp/rozelynx-handler-trace.log";
function trace(msg) {
  try {
    const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    f.initWithPath(TRACE_FILE);
    const os = Cc["@mozilla.org/network/file-output-stream;1"]
      .createInstance(Ci.nsIFileOutputStream);
    const line = "PID" + Services.appinfo.processID + " " + msg;
    os.init(f, 0x02 | 0x08 | 0x10, 0o666, 0);
    os.write(line + "\n", line.length + 1);
    os.close();
  } catch (e) {
    dump("TRACE FAIL: " + e + "\n");
  }
}

export function ExternalLinkCommandLineHandler() {}

ExternalLinkCommandLineHandler.prototype = {
  classDescription: "RozeLynx External-Link Command Line Handler",

  QueryInterface: ChromeUtils.generateQI(["nsICommandLineHandler"]),

  helpInfo:
    "  --external-link <url>        Open the RozeLynx profile/netiface chooser.\n" +
    "  --external-link-open <url>   Open <url> as a new tab in this instance.\n" +
    "  --external-link-iface <name> Bind the preceding tab to interface <name>.\n",

  handle(cmdLine) {
    trace("handle() CALLED args=" + cmdLine.length);
    let url = null;
    let iface = "";
    let chooser = false;

    try {
      const picked = cmdLine.handleFlagWithParam("external-link", false);
      if (picked !== null) {
        chooser = true;
        url = picked;
      }
    } catch (e) {}

    if (!chooser) {
      try {
        const opened = cmdLine.handleFlagWithParam("external-link-open", false);
        if (opened !== null) {
          url = opened;
        }
      } catch (e) {}
    }

    try {
      const bound = cmdLine.handleFlagWithParam("external-link-iface", false);
      if (bound !== null) {
        iface = bound.trim();
      }
    } catch (e) {}

    trace("url=" + url + " iface=" + iface + " chooser=" + chooser);

    if (!url) {
      return;
    }
    url = url.trim();
    if (!url) {
      return;
    }

    cmdLine.preventDefault = true;

    if (chooser && /^https?:\/\//i.test(url)) {
      this._openChooser(url);
    } else {
      this._openTab(url, iface);
    }
  },

  _openTab(url, iface) {
    trace("_openTab url=" + url + " iface=" + iface);
    const win = BrowserWindowTracker.getTopWindow({ private: false });
    if (!win) {
      this._openTabNewWindow(url, iface);
      return;
    }
    this._loadInWindow(win, url, iface);
  },

  _openTabNewWindow(url, iface) {
    trace("_openTabNewWindow url=" + url + " iface=" + iface);
    try {
      const string = Cc["@mozilla.org/supports-string;1"].createInstance(
        Ci.nsISupportsString
      );
      string.data = "about:blank";
      BrowserWindowTracker.openWindow({
        args: [string],
        features: "chrome,all,dialog=no",
      });
    } catch (e) {
      trace("openWindow failed: " + e);
    }
    this._loadInWindowSoon(url, iface, 0);
  },

  _loadInWindow(win, url, iface) {
    let tab = null;
    try {
      tab = win.gBrowser.addTab(url, {
        relatedToCurrent: true,
        triggeringPrincipal:
          Services.scriptSecurityManager.getSystemPrincipal(),
      });
      win.gBrowser.selectedTab = tab;
    } catch (e) {
      trace("_loadInWindow addTab failed: " + e);
      return;
    }
    try {
      if (iface) {
        this._bindTabInterface(tab, iface);
      }
      trace("_loadInWindow ok");
    } catch (e) {
      trace("_loadInWindow bind failed: " + e);
    }
  },

  _loadInWindowSoon(url, iface, attempt) {
    if (attempt > 60) {
      trace("_loadInWindowSoon timeout");
      return;
    }
    let win = null;
    try {
      win = BrowserWindowTracker.getTopWindow({ private: false });
    } catch (e) {}
    if (!win) {
      const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
      const self = this;
      timer.initWithCallback(
        {
          notify() {
            self._loadInWindowSoon(url, iface, attempt + 1);
          },
        },
        250,
        Ci.nsITimer.TYPE_ONE_SHOT
      );
      return;
    }
    this._loadInWindow(win, url, iface);
  },

  _bindTabInterface(tab, iface) {
    try {
      const bc = tab.linkedBrowser && tab.linkedBrowser.browsingContext;
      if (bc && bc.top) {
        Cc["@bytewheel.org/netiface;1"]
          .getService(Ci.nsIRozeLynxNetIface)
          .setTabInterface(bc.top.browserId, iface);
        trace("setTabInterface(" + bc.top.browserId + ", " + iface + ") ok");
      }
    } catch (e) {
      trace("netiface binding failed: " + e);
    }
  },

  _getTopWindowSoon(attempt) {
    return new Promise(resolve => {
      const step = () => {
        let win = null;
        try {
          win = BrowserWindowTracker.getTopWindow({ private: false });
        } catch (e) {}
        if (win || attempt > 60) {
          resolve(win);
          return;
        }
        const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
        timer.initWithCallback(step, 250, Ci.nsITimer.TYPE_ONE_SHOT);
      };
      step();
    });
  },

  async _openChooser(url) {
    trace("_openChooser url=" + url);
    let current = "";
    try {
      current = Services.dirsvc.get("ProfD", Ci.nsIFile).leafName;
    } catch (e) {}

    // Fresh instance: the first browser window (and the extensions, so the
    // rozelynx-features policy is registered) appear asynchronously after the
    // command-line handler runs. Open a blank window and poll for it, then
    // resolve the chooser page — policy=NULL/win=null otherwise.
    let win = BrowserWindowTracker.getTopWindow({ private: false });
    if (!win) {
      trace("chooser opening blank window");
      try {
        const string = Cc["@mozilla.org/supports-string;1"].createInstance(
          Ci.nsISupportsString
        );
        string.data = "about:blank";
        BrowserWindowTracker.openWindow({
          args: [string],
          features: "chrome,all,dialog=no",
        });
      } catch (e) {
        trace("chooser openWindow failed: " + e);
      }
      win = await this._getTopWindowSoon(0);
      trace("chooser win after poll=" + (win ? "yes" : "null"));
    }

    let page = null;
    try {
      const addon = await AddonManager.getAddonByID(
        "rozelynx-features@bytewheel.org"
      );
      // A jar:/file: resource URI is NOT an extension page: choosing it makes
      // the tab load static HTML where browser.runtime is undefined and the
      // chooser script cannot run (empty dropdowns). Open the real extension
      // page (moz-extension://<uuid>/...) so choose.js has full API access.
      try {
        const policy = WebExtensionPolicy.getByID(addon.id);
        page = policy ? policy.getURL("modules/external-link/choose.html") : null;
        trace("chooser policy=" + (policy ? policy.id : "NULL") +
              " page=" + page);
      } catch (e) {
        page = null;
        trace("chooser policy error: " + e);
      }
      if (!page) {
        page = addon.getResourceURI("modules/external-link/choose.html").spec;
        trace("chooser fallback jar page=" + page);
      }
    } catch (e) {
      trace("extension not found, opening URL directly: " + e);
      this._openTab(url, "");
      return;
    }

    page +=
      "?url=" +
      encodeURIComponent(url) +
      "&current=" +
      encodeURIComponent(current);

    if (!win) {
      try {
        const string = Cc["@mozilla.org/supports-string;1"].createInstance(
          Ci.nsISupportsString
        );
        string.data = page;
        BrowserWindowTracker.openWindow({
          args: [string],
          features: "chrome,all,dialog=no",
        });
      } catch (e) {
        trace("failed to open chooser window: " + e);
      }
      return;
    }

    try {
      const tab = win.gBrowser.addTab(page, {
        relatedToCurrent: true,
        triggeringPrincipal:
          Services.scriptSecurityManager.getSystemPrincipal(),
      });
      win.gBrowser.selectedTab = tab;
      trace("chooser tab opened: " + page);
      const probe = () => {
        try {
          const b = tab.linkedBrowser;
          const bc = b && b.browsingContext;
          const uri = bc ? bc.currentURI.spec : "(no bc)";
          const doc = bc && bc.currentWindowGlobal && bc.currentWindowGlobal.documentPrincipal;
          const prin = doc ? doc.origin : "(no doc)";
          dump("[RozeLynx] chooser probe uri=" + uri + " principal=" + prin + "\n");
          trace("chooser probe uri=" + uri + " principal=" + prin);
        } catch (e) {
          dump("[RozeLynx] chooser probe err: " + e + "\n");
          trace("chooser probe err: " + e);
        }
      };
      try {
        const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
        timer.initWithCallback(
          { notify: probe },
          5000,
          Ci.nsITimer.TYPE_ONE_SHOT
        );
      } catch (e) {
        dump("[RozeLynx] timer setup err: " + e + "\n");
      }
    } catch (e) {
      trace("failed to open chooser tab: " + e);
    }
  },
};
