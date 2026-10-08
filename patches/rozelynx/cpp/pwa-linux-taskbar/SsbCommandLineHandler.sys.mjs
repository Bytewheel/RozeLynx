/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// RozeLynx SSB command-line handler.
//
// Handles `rozelynx --ssb <url>` (used by the generated .desktop entries of
// installed PWAs): opens <url> in a dedicated browser window and marks the
// window's chrome with the `ssb-mode="true"` attribute so that userChrome
// rules (ssbChrome.css) hide the tab strip and navigation toolbar, giving
// the window an app-like (Site-Specific Browser) look.
//
// The generated entry also carries --ssb-class and --ssb-icon (see
// ManifestProcessor.generateDesktopEntry in
// extension/modules/pwa/background.js). A desktop entry cannot make a window
// group under it: StartupWMClass only tells the launcher which class to
// match, and the class itself is set by the compiled taskbar component, which
// nothing in a .desktop file can reach. So this handler applies the two
// directly, and a launcher-launched app window ends up with the same
// WM_CLASS and icon an extension-launched one gets.
//
// Registered via the pwa-linux-taskbar components.conf as
// @mozilla.org/browser/ssb/clh;1 in the command-line-handler category under
// the entry name "e-ssb" (an early handler, so it runs before the default
// one).

import { BrowserWindowTracker } from "resource:///modules/BrowserWindowTracker.sys.mjs";
// Imported rather than used as a global: about:logins' parent module and
// RefreshBlockerChild both import it from here, and a bare setTimeout in a
// module scope is exactly the kind of thing that changes under the JS module
// global reductions.
import { setTimeout } from "resource://gre/modules/Timer.sys.mjs";

// Must stay in sync with PWA_MARKER in the extension module
// (extension/modules/pwa/background.js) and with the hasPwaMarker /
// stripPwaMarker tests in extension/modules/pwa/content.js: the extension
// side recognises an app window by this exact substring in the tab URL.
//
// A window opened through --ssb is not in the extension's PWAWindows
// registry (that lives in storage.local and is owned by the extension, which
// is not running yet when a command-line handler fires), so without the
// marker the extension treats the window as an ordinary one: the content
// script offers "Install App" inside the app window, and refreshSsbTabs
// never runs for it, so the tab-strip state diverges from an extension-launched
// PWA. The marker is what makes both launch paths look the same to the
// extension. The window is deliberately NOT registered in PWAWindows here.
const PWA_MARKER = "rozelynx-pwa=1";

// Append the marker, mirroring appendMarker() in the extension: merge into an
// existing fragment, tolerate a trailing "#", and never stamp twice.
function appendMarker(url) {
  if (url.includes(PWA_MARKER)) {
    return url;
  }
  let sep = url.includes("#") ? "&" : "#";
  if (url.endsWith("#")) {
    sep = "";
  }
  return url + sep + PWA_MARKER;
}

// Set the window's WM_CLASS and icon through the compiled taskbar component
// (@bytewheel.org/pwa/linux-taskbar;1, RozeLynxLinuxTaskbar). This is the same
// component the extension reaches through rozelynxWindows.setWindowClass /
// setWindowIconFromPath; being chrome-side JS, this handler can call it
// directly instead of going through the extension, which may not even be
// running yet.
//
// Returns true when every requested change was applied. It returns false when
// the component is absent (a build without USE=pwa) or when it refused - the
// C++ needs a real main widget and throws NS_ERROR_FAILURE while the window is
// still being built, which is exactly the state BrowserWindowTracker hands
// back. An empty class or path is a no-op in the C++ (it returns NS_OK
// without doing anything), so those are skipped here rather than being
// counted as success.
function applyTaskbar(win, windowClass, iconPath) {
  if (!windowClass && !iconPath) {
    return true;
  }
  let taskbar = null;
  try {
    taskbar = Cc["@bytewheel.org/pwa/linux-taskbar;1"].getService(
      Ci.nsIRozeLynxLinuxTaskbar
    );
  } catch (e) {
    console.warn(
      "[RozeLynx SSB] taskbar component unavailable: " + e + "; window keeps its default class and icon"
    );
    return false;
  }
  let ok = true;
  if (windowClass) {
    try {
      // The C++ prefixes the role itself and uses the class for both the
      // WM_CLASS name and the resource name; the title argument is ignored by
      // the implementation, so the class is passed for both.
      taskbar.setWindowClass(win, windowClass, windowClass);
    } catch (e) {
      console.warn("[RozeLynx SSB] setWindowClass failed: " + e);
      ok = false;
    }
  }
  if (iconPath) {
    try {
      // gdk_pixbuf_new_from_file: a path that is not there is
      // NS_ERROR_FILE_NOT_FOUND, so a stale icon is a named failure rather
      // than a silently iconless window.
      taskbar.setWindowIconFromPath(win, iconPath);
    } catch (e) {
      console.warn("[RozeLynx SSB] setWindowIconFromPath failed: " + e);
      ok = false;
    }
  }
  return ok;
}

export function SSBCommandLineHandler() {}

SSBCommandLineHandler.prototype = {
  classDescription: "RozeLynx SSB Command Line Handler",

  QueryInterface: ChromeUtils.generateQI(["nsICommandLineHandler"]),

  helpInfo:
    "  --ssb <url>        Open <url> in a RozeLynx standalone app window.\n" +
    "  --ssb-class <c>    WM_CLASS for the window opened by --ssb.\n" +
    "  --ssb-icon <path>  Icon file for the window opened by --ssb.\n",

  handle(cmdLine) {
    // cmdLine here is an nsICommandLineHandlerParams, NOT an nsICommandLine.
    // It has exactly three members: handle(), handleFlag() and
    // handleFlagWithParam(). It does NOT have preventDefault(), length or
    // getArgument() - those belong to nsICommandLine, and calling one on this
    // object throws.
    //
    // That is the whole bug this handler shipped with, and it explains the
    // live symptom precisely. The first version called
    // `cmdLine.preventDefault = true` (an assignment, a silent no-op on an
    // XPCOM wrapper), and the second called `cmdLine.preventDefault()` - which
    // throws, because the method is not on this interface at all. Neither is in
    // a try/catch, so handle() aborted on the first statement after the claim:
    // the line was never claimed, --ssb and its value were left in argv, and
    // Gecko's default handler then opened a normal window with the leftovers.
    // That is why a click produced TWO ordinary tabs - https://github.com/
    // (the unconsumed --ssb value) and http://rozelynx-github/ (the unconsumed
    // --ssb-class value, read as a bare hostname) - and why no window ever had
    // the ssb-mode attribute. Nothing about the contract, the category
    // registration, or the component was wrong: the service was reachable the
    // whole time, and the probe reporting "available" is what proved the
    // failure had moved here.
    //
    // Claiming the line is handle()'s job, and it is what stops the default
    // handler. handleFlagWithParam("ssb") returns the URL in one step, so there
    // is no reason to walk argv - which is fortunate, because walking argv is
    // exactly what needed the unavailable nsICommandLine API.
    let url = "";
    let windowClass = "";
    let iconPath = "";
    try {
      const pickedUrl = cmdLine.handleFlagWithParam("ssb", false);
      if (pickedUrl === null) {
        return;
      }
      url = pickedUrl.trim();
    } catch (e) {
      console.warn("[RozeLynx SSB] could not read --ssb: " + e);
      return;
    }

    if (!url) {
      return;
    }

    // Claim the line. This is the method that exists on this interface, and
    // calling it is what suppresses Gecko's default window.
    try {
      cmdLine.handle();
    } catch (e) {
      console.warn("[RozeLynx SSB] handle() failed: " + e);
      return;
    }

    try {
      const picked = cmdLine.handleFlagWithParam("ssb-class", false);
      if (picked !== null) {
        windowClass = picked.trim();
      }
    } catch (e) {}

    try {
      const picked = cmdLine.handleFlagWithParam("ssb-icon", false);
      if (picked !== null) {
        iconPath = picked.trim();
      }
    } catch (e) {}

    // Stamp the marker once, here, and use the marked URL for BOTH paths
    // below. Doing it in one place keeps the reuse path and the new-window
    // path from drifting apart.
    const markedUrl = appendMarker(url);

    // Single-instance guard: if an SSB window already exists,
    // focus it and navigate to the URL instead of spawning a new window.
    try {
      const enumerator = Services.wm.getEnumerator("navigator:browser");
      while (enumerator.hasMoreElements()) {
        const win = enumerator.getNext();
        try {
          const docEl = win.document.documentElement;
          if (docEl && docEl.getAttribute("ssb-mode") === "true") {
            win.focus();
            win.gBrowser.selectedBrowser.loadURI(markedUrl);
            // The window is being re-pointed at this entry's app, so it is
            // relabelled with this entry's class and icon: the same window
            // would otherwise keep the class of whichever app it was opened
            // for, and a taskbar would group it under the wrong launcher.
            applyTaskbar(win, windowClass, iconPath);
            return;
          }
        } catch (e) {
          // skip windows that aren't fully initialised
        }
      }
    } catch (e) {
      console.error("[RozeLynx SSB] single-instance check failed:", e);
    }

    let string = Cc["@mozilla.org/supports-string;1"].createInstance(
      Ci.nsISupportsString
    );
    string.data = markedUrl;

    // `args` is the command-line argument string for the new window - it is how
    // browser.xhtml learns what to load. nsIWindowWatcher.openWindow declares
    // that parameter [in] nsISupportsString, and upstream's own
    // BrowserWindowTracker.openWindow builds ONE nsISupportsString (it defaults
    // to BrowserHandler.defaultArgs) rather than an array; the JSDoc there says
    // "nsIArray | nsISupportsString", which is the trap, because an array
    // satisfies the type and then fails the XPCOM conversion at the call into
    // Services.ww.openWindow. That threw, the throw was caught below, and the
    // window was never opened - the other half of "opens a new browser window
    // but does no navigation".
    //
    // `features` is deliberately absent. Upstream's openWindow already builds
    // "chrome,dialog=no" and appends ",all" itself, so naming them here only
    // duplicated each one in the window features string.
    let win = null;
    try {
      win = BrowserWindowTracker.openWindow({ args: string });
    } catch (e) {
      console.error("[RozeLynx SSB] Failed to open SSB window:", e);
    }

    if (!win) {
      return;
    }

    const markWindow = () => {
      try {
        win.document.documentElement.setAttribute("ssb-mode", "true");
      } catch (e) {}
    };

    try {
      if (win.document && win.document.readyState === "complete") {
        markWindow();
      } else {
        win.addEventListener("DOMContentLoaded", markWindow, { once: true });
      }
    } catch (e) {}

    // WM_CLASS and icon. Tried immediately, then once at DOMContentLoaded and
    // once more after the settle the extension path uses: the C++ needs the
    // window's main widget, which does not exist while BrowserWindowTracker is
    // still building it, and a class applied too late (or not at all) is the
    // difference between the window grouping under its launcher entry and
    // appearing as a bare RozeLynx window.
    if (windowClass || iconPath) {
      if (applyTaskbar(win, windowClass, iconPath)) {
        console.debug(
          "[RozeLynx SSB] taskbar applied class=" + windowClass + " icon=" + iconPath
        );
      } else {
        const retry = () => {
          if (!applyTaskbar(win, windowClass, iconPath)) {
            console.warn(
              "[RozeLynx SSB] taskbar class/icon still not applied for class=" +
                windowClass
            );
          }
        };
        try {
          if (win.document && win.document.readyState !== "complete") {
            win.addEventListener("DOMContentLoaded", retry, { once: true });
          }
        } catch (e) {}
        // 1500ms is the settle PWAManager.launch waits before it applies the
        // same two calls, so both launch paths get the same window of
        // opportunity.
        setTimeout(retry, 1500);
      }
    }
  },
};
