/* RozeLynx experiment API: window chrome helpers.
 * setSsbMode marks an extension window with the ssb-mode attribute so
 * ssbChrome.css renders it app-like (no tab strip, no nav bar) - the same
 * attribute the --ssb command-line handler sets. The experiment sandbox
 * already provides ExtensionAPI and Services as globals.
 *
 * setPrefersColorScheme overrides prefers-color-scheme for a window's
 * selected tab by setting prefersColorSchemeOverride on its top browsing
 * context (the same mechanism DevTools color-scheme emulation and
 * LightweightThemeConsumer use). "none" resets to follow the system.
 * "auto" resolves the chrome-level dark preference (ui.systemUsesDarkTheme).
 *
 * getProfilePath returns the absolute path of the running profile's
 * directory (ProfD). It lives here rather than in rozelynxPrefs because a
 * profile directory is not an about:config preference, and rather than in a
 * new namespace because it is the same "where is this process rooted" fact
 * the window helpers answer for the window's chrome document. The PWA
 * module needs it to write a profile-correct Exec line into the generated
 * .desktop entry: nsRemoteService identifies a remote instance by the full
 * profile PATH, not by the profile name, so a --ssb launch with no
 * --profile always resolves to the default profile.
 *
 * isTaskbarAvailable / setWindowClass / setWindowIconFromPath are the only
 * way into RozeLynxLinuxTaskbar, the C++ component that actually sets a
 * window's WM_CLASS and icon on the GTK widget. It is a parent-process
 * XPCOM contract, so an extension cannot touch it; writeIconFile exists
 * because the C++ takes a filesystem path while a PWA's manifest icon is
 * only available as a data: URL, so the parent materialises the bytes under
 * <profile>/pwa-icons/ first. The component is only built with USE=pwa on a
 * GTK widget, which is why every entry point below answers {ok:false} rather
 * than letting a missing contract throw into the extension.
 *
 * writeDesktopEntry / removeDesktopEntry put the PWA module's generated
 * .desktop entry on disk under $XDG_DATA_HOME/applications (or
 * ~/.local/share/applications). Same reason as writeIconFile and the same
 * idiom: a WebExtension has no filesystem API, so the parent writes the
 * file. Until these existed the module generated the text and handed it to a
 * caller that did not exist, which left the whole --ssb launch path
 * (--profile pin, StartupWMClass grouping, the URL marker) with no file to
 * act on. Every entry point answers {ok:false} rather than throwing when the
 * destination is unusable, so a read-only or absent home directory degrades
 * to "the PWA is installed in the browser but has no launcher entry".
 */

this.rozelynxWindows = class extends ExtensionAPI {
  getAPI(context) {
    function resolveScheme(scheme, win) {
      if (scheme === "auto" || scheme === undefined || scheme === null) {
        // Follow the chrome window's effective color scheme: the
        // LightweightThemeConsumer sets the chrome browsing context's
        // override from the toolbar theme, so this tracks the browser
        // theme (e.g. dark Lepton) and falls back to the OS otherwise.
        var dark = false;
        try {
          dark = win.matchMedia("(prefers-color-scheme: dark)").matches;
        } catch (e) {
          try {
            dark = Services.prefs.getIntPref("ui.systemUsesDarkTheme", 0) === 1;
          } catch (e2) {
            dark = false;
          }
        }
        return dark ? "dark" : "light";
      }
      return scheme;
    }

    /**
     * Resolve a chrome window from a WebExtension window ID.
     *
     * The route and the identity test are both taken from Gecko, because the
     * two this file used before were both wrong in the running browser:
     *
     *  - `Services.wm.getOuterWindowWithId(id)` is literally what the WebExtension
     *    layer itself uses (`WindowTrackerBase.getWindow`, 156.0.1
     *    toolkit/components/extensions/parent/ext-tabs-base.js:1855), so it is
     *    known to hand back the object the extension API calls a window.
     *
     *  - A WebExtension window id is `window.docShell.outerWindowID`, NOT
     *    `window.windowID` (same file, `WindowTrackerBase`'s `_windowIds`,
     *    line 1722). `windowID` is the legacy DOM property and it does not
     *    compare equal to the numeric id, so `w.windowID === windowId` in the
     *    old fallback could never match and the branch was dead code. The
     *    comparison is done on strings because the docshell attribute is not
     *    guaranteed to arrive as a JS number, which is the same correction
     *    netiface-api.js already carries in a comment.
     *
     * `context.extension.windowManager` is kept last rather than dropped: it is
     * a legitimate route and costs one call, but it is no longer the primary
     * one because it hands the object straight into this sandbox, which is
     * where the taskbar calls used to fail.
     */
    function resolveChromeWindow(windowId) {
      try {
        const outer = Services.wm.getOuterWindowWithId(windowId);
        if (outer && outer.gBrowser) {
          return outer;
        }
      } catch (e) {}

      try {
        const enumerator = Services.wm.getEnumerator("navigator:browser");
        while (enumerator.hasMoreElements()) {
          const w = enumerator.getNext();
          if (!w || !w.gBrowser) continue;
          let id = null;
          try {
            id = w.docShell && w.docShell.outerWindowID;
          } catch (e2) {
            id = null;
          }
          if (id != null && String(id) === String(windowId)) {
            return w;
          }
        }
      } catch (e) {}

      try {
        const winWrapper = context.extension.windowManager.get(windowId);
        if (winWrapper && winWrapper.window) {
          return winWrapper.window;
        }
      } catch (e) {}

      return null;
    }

    // RozeLynxLinuxTaskbar, compiled into libxul and registered as
    // @bytewheel.org/pwa/linux-taskbar;1 by components.conf when USE=pwa and
    // the GTK widget is in use. Reached the same way netiface-api.js reaches
    // its own service, so a build without the component simply has no such
    // contract and the call throws - every caller below turns that into a
    // named {ok:false} reply instead of letting it reach the extension.
    function taskbarService() {
      return Cc["@bytewheel.org/pwa/linux-taskbar;1"].getService(
        Ci.nsIRozeLynxLinuxTaskbar
      );
    }

    // Hand the component a window it can cast.
    //
    // The C++ starts with nsGlobalWindowOuter::Cast(aWindow), so it wants the
    // outer window, and nsGlobalWindowOuter does declare mozIDOMWindowProxy
    // (NS_INTERFACE_MAP_ENTRY, nsGlobalWindowOuter.cpp:1562). The previous
    // version reached for it by calling QueryInterface() on the window FROM THIS
    // SANDBOX, and that call is what failed in the running browser: the live
    // extension's own diagnostic ring recorded
    //
    //   taskbar-class window=43 class=... ok=false error=...is not a
    //   mozIDOMWindowProxy: 43
    //
    // for a launch that had otherwise succeeded - so setWindowClass, and
    // setWindowIconFromPath which shares this, never reached the C++ at all.
    // Nothing else in the overlay QIs to a window, and nothing else in the
    // overlay fails.
    //
    // So the sandbox-side QI is not the requirement; the IDL's declared
    // conversion is. XPConnect performs that conversion itself when the object
    // is handed to a privileged XPConnect method, and it is not subject to the
    // restrictions that apply to QueryInterface() called from extension code -
    // which is exactly the difference between the two paths. The window is
    // therefore passed as-is and the glue converts it.
    //
    // The manual QI is still attempted first, and kept for one reason: if it
    // works it is an explicit conversion, and if a future Gecko changes what
    // the glue does this is the branch that still returns early. It is a
    // fallback, not the mechanism, and the comment says so where it is read.
    //
    // On the primary route it is also redundant, which is worth knowing before
    // anyone treats a failure here as news about the interface. The method
    // resolveChromeWindow tries first is declared in 156.0.1 as
    //
    //   mozIDOMWindowProxy getOuterWindowWithId(in unsigned long long aId);
    //
    // (xpfe/appshell/nsIWindowMediator.idl - the window mediator, not the
    // nsIWindowEnumerator of older trees), so XPConnect already hands this
    // sandbox an object wrapped as exactly the interface being asked for, and
    // QueryInterface to the interface you already have cannot tell you anything.
    // The other two routes return something else - windowManager.get() gives a
    // DOM window, and the enumerator's getNext() is typed only as an
    // nsISimpleEnumerator - which is why the attempt is kept at all.
    //
    // The failure is reported, not swallowed. The previous version caught the
    // exception and returned its OWN sentence,
    //
    //   { error: "window is not a mozIDOMWindowProxy: " + windowId }
    //
    // discarding `e` entirely, and that sentence is the whole of what the live
    // diagnostic ring ever contained. It reads like the platform reporting that
    // the object is not a mozIDOMWindowProxy; it is not - it is this file
    // asserting that on the platform's behalf, and the reason it was asserting
    // it was never written down. Grepping the 156.0.1 sources (dom/base,
    // dom/bindings, js/src, js/xpconnect, xpcom) finds no such message anywhere,
    // which is the check that shows the string was ours. The underlying reason
    // is unrecoverable from that build; carrying it forward is what stops the
    // next occurrence from being equally unreadable.
    let qiWarned = false;
    function resolveWindowProxy(windowId) {
      const chromeWin = resolveChromeWindow(windowId);
      if (!chromeWin) {
        return { error: "window not found: " + windowId };
      }
      try {
        return {
          proxy: chromeWin.QueryInterface(Ci.mozIDOMWindowProxy),
          via: "qi",
        };
      } catch (e) {
        // The throw's own text, not a restatement of it. `String(e)` keeps an
        // XPConnect exception's class name and message; `e && e.name` is the
        // fallback for a thrown non-Error, where String() alone can be useless.
        const why = e
          ? (e.name ? e.name + ": " + (e.message || String(e)) : String(e))
          : "unknown error";
        if (!qiWarned) {
          qiWarned = true;
          // Once, not per launch: this is a permanent property of the sandbox,
          // not a per-window fault, and a PWA launch must not cost a line each.
          console.warn(
            "rozelynxWindows: sandbox QueryInterface(mozIDOMWindowProxy) " +
              "threw; using the XPConnect glue instead. Reason: " +
              why
          );
        }
        return { proxy: chromeWin, via: "glue", qiError: why };
      }
    }

    // Only image types gdk-pixbuf is asked to load, mapped to the extension
    // the file is written with. A manifest icon outside this set is refused
    // rather than written as something nothing can read.
    // nsIFile's directory-creation type, read once and checked BY NAME.
    //
    // nsIFile.create() takes `in unsigned long type`, and XPConnect coerces a
    // missing argument to 0 - which is nsIFile.NORMAL_FILE_TYPE, not an error.
    // The interface declares only NORMAL_FILE_TYPE and DIRECTORY_TYPE; there is
    // no `DIRECTORY` constant (checked against xpcom/io/nsIFile.idl in 156.0.1,
    // and Gecko's own chrome code uses DIRECTORY_TYPE everywhere - neither
    // shipped jar contains the bare form). Writing Ci.nsIFile.DIRECTORY
    // therefore evaluated to undefined, was passed as 0, and created an EMPTY
    // PLAIN FILE named after the directory instead of the directory. Every
    // write under it then failed, because its parent is a file. That is not a
    // hypothetical: a live profile was found carrying a 0-byte, 0755 regular
    // file at <profile>/pwa-icons, created by the very launch whose own
    // diagnostic ring recorded `taskbar-icon-skip ... no-icon-file` - and the
    // same line would have created a 0-byte file named `applications` on any
    // machine without ~/.local/share/applications, which is how a PWA ends up
    // installed with no launcher entry at all.
    //
    // So the constant is resolved through a name check rather than used
    // directly: if a future Gecko renames it again, the next version of this
    // bug is a named failure rather than a silently wrong filesystem.
    const DIRECTORY_TYPE =
      Ci.nsIFile && typeof Ci.nsIFile.DIRECTORY_TYPE === "number"
        ? Ci.nsIFile.DIRECTORY_TYPE
        : null;

    // Make sure `dir` is a directory, creating it if need be.
    //
    // An empty plain file sitting where the directory belongs can only be the
    // artifact described above: the path is feature-private and nothing else in
    // the tree writes it. Removing it means a profile the bug already poisoned
    // heals itself instead of needing to be told what to delete by hand, and it
    // is reported as `repaired` so the repair is visible rather than silent.
    // A file with content in it is refused by name, whatever the path is
    // called: only something provably empty is this code's own artifact.
    function ensureDirectory(dir) {
      if (DIRECTORY_TYPE === null) {
        return {
          error: "nsIFile.DIRECTORY_TYPE is unavailable in this Gecko",
        };
      }
      let exists = false;
      try {
        exists = dir.exists();
      } catch (e) {
        return { error: "stat failed: " + e };
      }
      let repaired = false;
      if (exists) {
        let isDir = false;
        try {
          isDir = dir.isDirectory();
        } catch (e) {
          return { error: "isDirectory failed: " + e };
        }
        if (isDir) {
          return { ok: true, created: false, repaired: false };
        }
        let isPlainFile = false;
        try {
          isPlainFile = dir.isFile();
        } catch (e) {
          return { error: "isFile failed: " + e };
        }
        if (!isPlainFile) {
          return { error: dir.path + " exists and is not a plain file" };
        }
        // Only an EMPTY file is this bug's artifact. Deleting something that
        // has content in it is not a decision to make on the user's behalf,
        // whatever the path is called.
        let size = -1;
        try {
          size = dir.fileSize;
        } catch (e) {
          return { error: "fileSize failed on " + dir.path + ": " + e };
        }
        if (size !== 0) {
          return {
            error:
              dir.path +
              " is a " +
              size +
              "-byte file, not an empty one: refusing to delete it",
          };
        }
        try {
          dir.remove();
        } catch (e) {
          return { error: "could not remove the stale " + dir.path + ": " + e };
        }
        repaired = true;
      }
      try {
        dir.create(DIRECTORY_TYPE, 0o755);
      } catch (e) {
        return { error: "create failed: " + e };
      }
      return { ok: true, created: true, repaired: repaired };
    }

    const ICON_MIME_EXT = {
      "image/png": ".png",
      "image/jpeg": ".jpg",
      "image/jpg": ".jpg",
      "image/gif": ".gif",
      "image/webp": ".webp",
      "image/bmp": ".bmp",
      "image/x-icon": ".ico",
      "image/vnd.microsoft.icon": ".ico",
      "image/svg+xml": ".svg",
    };

    // Parse data:[<mediatype>][;params],<payload> and return
    // {ext, bytes}, or null with a reason. Only base64 payloads are accepted:
    // a percent-encoded SVG would be handed to gdk-pixbuf un-decoded, and the
    // icon is only ever read from a data: URL the extension built itself
    // (ManifestProcessor.fetchIcon reads the manifest icon via FileReader).
    function decodeIconDataUrl(dataUrl) {
      const m = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)?((?:;[^,;]*)*),/i.exec(
        String(dataUrl || "")
      );
      if (!m) {
        return { error: "not a data: URL" };
      }
      const mime = (m[1] || "").toLowerCase();
      const ext = ICON_MIME_EXT[mime];
      if (!ext) {
        return { error: "unsupported icon type: " + (mime || "(none)") };
      }
      if (m[2].toLowerCase().indexOf(";base64") < 0) {
        return { error: "icon data: URL is not base64: " + mime };
      }
      const bytes = base64ToBinaryString(dataUrl.slice(m[0].length));
      if (bytes === null) {
        return { error: "icon data: URL payload is not base64" };
      }
      if (!bytes.length) {
        return { error: "icon data: URL payload is empty" };
      }
      return { ext, bytes };
    }

    // base64 -> one character per byte, which is exactly what the
    // [binary] string of nsIFileOutputStream.write() takes. atob is not
    // guaranteed in this sandbox and Buffer does not exist here at all, so
    // the two-line loop below stands in for both. Whitespace is skipped and
    // padding ends the stream, so wrapped and unpadded payloads both work.
    function base64ToBinaryString(b64) {
      const alphabet =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      let out = "";
      let acc = 0;
      let bits = 0;
      for (let i = 0; i < b64.length; i++) {
        const c = b64[i];
        if (c === "=") {
          break;
        }
        if (c === "\n" || c === "\r" || c === " " || c === "\t") {
          continue;
        }
        const v = alphabet.indexOf(c);
        if (v < 0) {
          return null;
        }
        acc = ((acc << 6) | v) & 0xffff;
        bits += 6;
        if (bits >= 8) {
          bits -= 8;
          out += String.fromCharCode((acc >> bits) & 0xff);
        }
      }
      return out;
    }

    // The caller supplies a site id ("pwa-1a2b3c"), never a path. Anything
    // outside [A-Za-z0-9._-] is dropped rather than escaped and leading dots
    // are stripped, so no id can climb out of <profile>/pwa-icons/.
    function iconFileName(name, ext) {
      const base =
        String(name == null ? "" : name)
          .replace(/[^A-Za-z0-9._-]/g, "")
          .replace(/^\.+/, "")
          .slice(0, 64);
      return (base || "icon") + ext;
    }

    // A desktop entry file name is a file name and nothing else: the caller
    // never chooses a directory (that comes from the XDG rule below), and the
    // .desktop suffix is forced so a bug upstream cannot leave some other kind
    // of file in the applications directory. A name that sanitises away to
    // nothing is refused rather than defaulted, because the file it would
    // name has no way back to the site that asked for it.
    function desktopFileName(name) {
      const base =
        String(name == null ? "" : name)
          .replace(/\.desktop$/i, "")
          .replace(/[^A-Za-z0-9._-]/g, "")
          .replace(/^\.+/, "")
          .slice(0, 64);
      return base ? base + ".desktop" : null;
    }

    // $XDG_DATA_HOME/applications, with the freedesktop fallback to
    // $HOME/.local/share/applications. This is deliberately the same rule
    // Gecko applies in ShellService._getLinuxDesktopEntryPath - XDG_DATA_HOME
    // when it is set AND absolute, otherwise $HOME/.local/share - rather than
    // a third opinion, and PathUtils.isAbsolute is replaced by nsIFile's own
    // isRelative because PathUtils is not a guaranteed global in this sandbox.
    function xdgApplicationsDir() {
      let home = null;
      try {
        home = Services.dirsvc.get("Home", Ci.nsIFile).clone();
      } catch (e) {
        return { error: "Home directory lookup failed: " + e };
      }
      if (!home) {
        return { error: "Home directory unavailable" };
      }
      let dataHome = null;
      try {
        dataHome = Services.env.get("XDG_DATA_HOME");
      } catch (e) {
        dataHome = null;
      }
      if (dataHome) {
        const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        try {
          file.initWithPath(dataHome);
        } catch (e) {
          // Unusable XDG_DATA_HOME: fall through to the $HOME default, which
          // is what the spec prescribes for a value that is not an absolute
          // path.
          dataHome = null;
        }
        if (dataHome && !file.isRelative) {
          file.append("applications");
          return { dir: file };
        }
      }
      home.append(".local");
      home.append("share");
      home.append("applications");
      return { dir: home };
    }

    // nsIOutputStream.write takes (string, byteCount). XPConnect encodes a
    // plain IDL string as UTF-8, but aCount is a BYTE count, so handing it a
    // JS string length truncates the file mid-character as soon as a name has
    // a character above U+00FF. Encoding here keeps the payload and the count
    // the same thing, which is why writeDesktopEntry cannot use the binary
    // string the icon path gets away with. Lone surrogates become U+FFFD so
    // the output is always valid UTF-8 rather than an invalid sequence.
    function utf8BinaryString(text) {
      let out = "";
      for (let i = 0; i < text.length; i++) {
        let cp = text.charCodeAt(i);
        if (cp >= 0xd800 && cp <= 0xdbff) {
          const lo = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
          if (lo >= 0xdc00 && lo <= 0xdfff) {
            cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
            i++;
          } else {
            cp = 0xfffd;
          }
        } else if (cp >= 0xdc00 && cp <= 0xdfff) {
          cp = 0xfffd;
        }
        if (cp < 0x80) {
          out += String.fromCharCode(cp);
        } else if (cp < 0x800) {
          out += String.fromCharCode(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
        } else if (cp < 0x10000) {
          out += String.fromCharCode(
            0xe0 | (cp >> 12),
            0x80 | ((cp >> 6) & 0x3f),
            0x80 | (cp & 0x3f)
          );
        } else {
          out += String.fromCharCode(
            0xf0 | (cp >> 18),
            0x80 | ((cp >> 12) & 0x3f),
            0x80 | ((cp >> 6) & 0x3f),
            0x80 | (cp & 0x3f)
          );
        }
      }
      return out;
    }

    // Open flags for nsIFileOutputStream, which take NSPR's PR_* values. They
    // are not in Ci, so they are spelled out here, and the values are NOT the
    // obvious ones - the first version of this passed 0x10 believing it was
    // PR_TRUNCATE, and 0x10 is PR_APPEND. Every file this writes was therefore
    // appended to rather than replaced, and the live tree carried the evidence:
    // all five .desktop entries and all four PWA icons were exactly twice their
    // own length, the second copy byte-identical to the first, and
    // desktop-file-validate rejected every entry for containing two
    // [Desktop Entry] groups.
    //
    // The values are from the NSPR this build links, nsprpub/pr/include/
    // prio.h, which is where Gecko's own xpcom/io/nsLocalFileUnix.cpp gets
    // them (it uses the names, so it is compiled against that header and cannot
    // get this wrong; a literal in an extension sandbox can):
    //
    //   PR_RDONLY 0x01  PR_WRONLY 0x02  PR_RDWR 0x04  PR_CREATE_FILE 0x08
    //   PR_APPEND 0x10  PR_TRUNCATE 0x20  PR_SYNC 0x40  PR_EXCL 0x80
    //
    // A check in tests/rozelynx-windows-api.js reads those numbers back out of
    // that header when it is present, so a divergence fails a test rather than
    // producing files that are quietly twice as long as they should be.
    const O_WRONLY = 0x02;
    const O_CREATE = 0x08;
    const O_TRUNCATE = 0x20;

    // PR_WRONLY | PR_CREATE | PR_TRUNCATE - truncate, because both callers
    // may be replacing a file of a different length. perm only applies when
    // the file is actually created; an existing file keeps its own mode.
    //
    // The size is read back afterwards and a file that came out longer than
    // what was written is a named error, not a silent success. That check is
    // the point of this rewrite: the wrong flag produced plausible-looking
    // files, and nothing in the caller could tell. A truncated write of the
    // wrong length is the one corruption this function can cause, and it is now
    // reported instead of shipped.
    function writeFileBytes(file, bytes, perm) {
      let stream = null;
      try {
        stream = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(
          Ci.nsIFileOutputStream
        );
        stream.init(file, O_WRONLY | O_CREATE | O_TRUNCATE, perm, 0);
        stream.write(bytes, bytes.length);
        stream.close();
        stream = null;
      } finally {
        // close() throws if the stream is already closed, and an unclosed
        // nsIFileOutputStream holds the file open for the whole session.
        try {
          if (stream) {
            stream.close();
          }
        } catch (e2) {}
      }
      // Read the file back. A file longer than what was just written means the
      // open did not truncate, whatever the flag said - which is precisely the
      // defect this rewrite fixes, and precisely the one that produced
      // plausible-looking doubled files in the live tree. Reported by throwing,
      // because both callers already turn a throw into a named {ok:false} and
      // neither can do anything sensible with a file it knows is corrupt.
      let onDisk = -1;
      try {
        onDisk = file.fileSize;
      } catch (e3) {
        throw new Error("fileSize failed on " + file.path + ": " + e3);
      }
      if (onDisk !== bytes.length) {
        throw new Error(
          "wrote " +
            bytes.length +
            " bytes to " +
            file.path +
            " but it is " +
            onDisk +
            " - the write did not truncate"
        );
      }
    }

    return {
      rozelynxWindows: {
        async setSsbMode(windowId, enabled) {
          const chromeWin = resolveChromeWindow(windowId);
          if (!chromeWin) {
            return { ok: false, error: "window not found: " + windowId };
          }
          const doc = chromeWin.document;
          if (!doc || !doc.documentElement) {
            return { ok: false, error: "window has no document: " + windowId };
          }
          if (enabled) {
            doc.documentElement.setAttribute("ssb-mode", "true");
          } else {
            doc.documentElement.removeAttribute("ssb-mode");
          }
          return { ok: true };
        },

         async setSsbTabs(windowId, show) {
           const chromeWin = resolveChromeWindow(windowId);
           if (!chromeWin) {
             console.error('[RozeLynx] setSsbTabs: window not found: ' + windowId);
             return { ok: false, error: "window not found: " + windowId };
           }
           const doc = chromeWin.document;
           if (!doc || !doc.documentElement) {
             console.error('[RozeLynx] setSsbTabs: no document: ' + windowId);
             return { ok: false, error: "window has no document: " + windowId };
           }
           if (show) {
             doc.documentElement.setAttribute("ssb-multi-tab", "true");
             console.info('[RozeLynx] setSsbTabs: window=' + windowId +
               ' ssb-multi-tab=true (current attrs: ' +
               doc.documentElement.getAttribute('ssb-mode') + ',' +
               doc.documentElement.getAttribute('ssb-multi-tab') + ')');
           } else {
             doc.documentElement.removeAttribute("ssb-multi-tab");
             console.info('[RozeLynx] setSsbTabs: window=' + windowId +
               ' ssb-multi-tab removed');
           }
           return { ok: true };
         },

         async setPrefersColorScheme(windowId, scheme) {
           if (["dark", "light", "none", "auto"].indexOf(scheme) < 0) {
            return { ok: false, error: "invalid scheme: " + scheme };
          }
          const chromeWin = resolveChromeWindow(windowId);
          if (!chromeWin) {
            return { ok: false, error: "window not found: " + windowId };
          }
          const tabBrowser = chromeWin.gBrowser;
          if (!tabBrowser) {
            return { ok: false, error: "window has no tabbrowser: " + windowId };
          }
          const browser = tabBrowser.selectedBrowser;
          if (!browser || !browser.browsingContext) {
            return { ok: false, error: "window has no selected browser: " + windowId };
          }
          var value = scheme === "none" ? "none" : resolveScheme(scheme, chromeWin);
          try {
            browser.browsingContext.prefersColorSchemeOverride = value;
          } catch (e) {
            return { ok: false, error: "set failed: " + e };
          }
           return { ok: true, resolved: value };
         },

        async getProfilePath() {
          // ProfD is the profile root of the *running* instance, so the value
          // is the profile that installed the calling extension - which is
          // exactly what a generated .desktop entry has to name. It is not
          // affected by private browsing (private windows share ProfD and
          // keep their state in memory), so no separate case is needed.
          let dir = null;
          try {
            dir = Services.dirsvc.get("ProfD", Ci.nsIFile);
          } catch (e) {
            return { ok: false, error: "ProfD lookup failed: " + e };
          }
          if (!dir) {
            return { ok: false, error: "ProfD unavailable" };
          }
          let path = null;
          try {
            path = dir.path;
          } catch (e) {
            return { ok: false, error: "ProfD path failed: " + e };
          }
          if (!path) {
            return { ok: false, error: "ProfD path is empty" };
          }
          return { ok: true, path: path };
        },

        async isTaskbarAvailable() {
          // Cheap and honest: asking the contract for its service is the only
          // way to know, and a build without USE=pwa (or without the GTK
          // widget) has no @bytewheel.org/pwa/linux-taskbar;1 at all.
          try {
            taskbarService();
            return { ok: true, available: true };
          } catch (e) {
            return { ok: true, available: false, error: String(e) };
          }
        },

        async setWindowClass(windowId, windowClass, windowTitle) {
          if (!windowClass) {
            return { ok: false, error: "empty window class" };
          }
          const win = resolveWindowProxy(windowId);
          if (win.error) {
            return { ok: false, error: win.error };
          }
          try {
            // The C++ prefixes the role with ':' and uses the class for both
            // the WM_CLASS name and the resource name, which is what makes a
            // launcher entry's StartupWM_CLASS=<class> group this window.
            taskbarService().setWindowClass(
              win.proxy,
              String(windowClass),
              windowTitle == null ? "" : String(windowTitle)
            );
            // `via` is reported so the extension's own log says which of the two
            // conversions in resolveWindowProxy actually carried the call. If
            // setWindowClass ever stops working again, the log names the
            // mechanism instead of leaving it to be guessed at - and when the
            // mechanism is `glue`, `qiError` is the QI's own reason, so the
            // question the old log could not answer ("what actually refused
            // it?") is answered by the log instead of by another session.
            return {
              ok: true,
              class: String(windowClass),
              via: win.via,
              ...(win.qiError ? { qiError: win.qiError } : {}),
            };
          } catch (e) {
            return { ok: false, error: "setWindowClass failed: " + e };
          }
        },

        async setWindowIconFromPath(windowId, iconPath) {
          if (!iconPath) {
            return { ok: false, error: "empty icon path" };
          }
          const win = resolveWindowProxy(windowId);
          if (win.error) {
            return { ok: false, error: win.error };
          }
          try {
            // The C++ loads the file with gdk_pixbuf_new_from_file and answers
            // NS_ERROR_FILE_NOT_FOUND if it is not there, so a stale cached
            // path surfaces as a failure here rather than as a silent no-icon.
            taskbarService().setWindowIconFromPath(win.proxy, String(iconPath));
            return {
              ok: true,
              path: String(iconPath),
              via: win.via,
              ...(win.qiError ? { qiError: win.qiError } : {}),
            };
          } catch (e) {
            return { ok: false, error: "setWindowIconFromPath failed: " + e };
          }
        },

        async writeIconFile(dataUrl, fileName) {
          const decoded = decodeIconDataUrl(dataUrl);
          if (decoded.error) {
            return { ok: false, error: decoded.error };
          }
          const name = iconFileName(fileName, decoded.ext);
          let dir = null;
          try {
            // ProfD is the profile root of the running instance, so the icon
            // lands in the profile that owns the PWA, and a secondary profile
            // gets its own copy instead of racing the default one.
            dir = Services.dirsvc.get("ProfD", Ci.nsIFile).clone();
          } catch (e) {
            return { ok: false, error: "ProfD lookup failed: " + e };
          }
          dir.append("pwa-icons");
          const file = dir.clone();
          file.append(name);
          const made = ensureDirectory(dir);
          if (made.error) {
            return { ok: false, error: "pwa-icons: " + made.error };
          }
          try {
            writeFileBytes(file, decoded.bytes, 0o644);
          } catch (e) {
            return { ok: false, error: "icon write failed: " + e };
          }
          return {
            ok: true,
            path: file.path,
            bytes: decoded.bytes.length,
            repaired: made.repaired,
          };
        },

        async writeDesktopEntry(fileName, content) {
          // Refuse anything that is not a desktop entry. This writes into the
          // user's applications directory, where a half-formed file is worse
          // than no file: a launcher that reads it has to be able to trust the
          // shape, so an extension bug has to arrive as a named failure.
          const text = content == null ? "" : String(content);
          if (!/^\s*\[Desktop Entry\]/.test(text)) {
            return { ok: false, error: "content is not a [Desktop Entry] file" };
          }
          const name = desktopFileName(fileName);
          if (!name) {
            return { ok: false, error: "unusable desktop entry file name" };
          }
          const loc = xdgApplicationsDir();
          if (loc.error) {
            return { ok: false, error: loc.error };
          }
          const made = ensureDirectory(loc.dir);
          if (made.error) {
            return { ok: false, error: "applications dir: " + made.error };
          }
          const file = loc.dir.clone();
          file.append(name);
          const bytes = utf8BinaryString(text);
          try {
            // 0644, not 0755: a launcher entry is data, and an executable
            // file in a file manager's view of the applications directory
            // invites a "run this?" action that has nothing to do with the
            // desktop environment. The .desktop specification allows an
            // absolute path for Icon and the majority of shipped entries are
            // 0644.
            writeFileBytes(file, bytes, 0o644);
          } catch (e) {
            return { ok: false, error: "desktop entry write failed: " + e };
          }
          return { ok: true, path: file.path, name: name, bytes: bytes.length };
        },

        async hasDesktopEntry(fileName) {
          // "Is the entry there?" is the question a reconcile pass has to ask
          // before it decides to write one, and it was unanswerable: write
          // always rewrites, remove always removes. Without it the only way to
          // get an entry for an app installed before the writer existed was to
          // uninstall and reinstall it.
          const name = desktopFileName(fileName);
          if (!name) {
            return { ok: false, error: "unusable desktop entry file name" };
          }
          const loc = xdgApplicationsDir();
          if (loc.error) {
            return { ok: false, error: loc.error };
          }
          const file = loc.dir.clone();
          file.append(name);
          let exists = false;
          try {
            exists = file.exists();
          } catch (e) {
            return { ok: false, error: "desktop entry stat failed: " + e };
          }
          return { ok: true, path: file.path, name: name, exists: exists };
        },

        async removeDesktopEntry(fileName) {
          const name = desktopFileName(fileName);
          if (!name) {
            return { ok: false, error: "unusable desktop entry file name" };
          }
          const loc = xdgApplicationsDir();
          if (loc.error) {
            return { ok: false, error: loc.error };
          }
          const file = loc.dir.clone();
          file.append(name);
          let exists = false;
          try {
            exists = file.exists();
          } catch (e) {
            return { ok: false, error: "desktop entry stat failed: " + e };
          }
          if (!exists) {
            // Removing an entry that is not there is the state the caller
            // asked for, not a failure: uninstall twice, or uninstall on a
            // profile whose entry was never written, both land here.
            return { ok: true, path: file.path, name: name, removed: false };
          }
          try {
            file.remove();
          } catch (e) {
            return { ok: false, error: "desktop entry remove failed: " + e };
          }
          return { ok: true, path: file.path, name: name, removed: true };
        },

        // Is the --ssb command-line handler actually reachable?
        //
        // Appended after everything else, per the invariant every part of this
        // plan re-asserts for this file.
        //
        // Why it exists: clicking a generated .desktop entry does nothing, and
        // the browser opens one tab per leftover bare argument instead
        // (https://github.com/ from --ssb's value, http://rozelynx-github/ from
        // --ssb-class's). That is precisely what happens when NO
        // nsICommandLineHandler claims the line - and Gecko's dispatch
        // (toolkit/components/commandlines/nsCommandLine.cpp:422-432) fetches
        // each registered contract with do_GetService and, on failure, logs
        // "Contract ID '%s' ... could not be created" and CONTINUES. So the
        // handler being skipped is silent by design, which is how the two
        // defects in SsbCommandLineHandler.sys.mjs (an assignment where a call
        // was meant, and an array where an nsISupportsString was required) went
        // unnoticed for a whole session, and how a THIRD, separate cause can go
        // unnoticed here.
        //
        // Asking the contract for its service is the same probe as
        // isTaskbarAvailable, and it reports the exception rather than
        // discarding it, because the whole point is to be told the reason.
        async ssbHandlerStatus() {
          const contract = "@mozilla.org/browser/ssb/clh;1";
          try {
            const svc = Cc[contract].getService(Ci.nsICommandLineHandler);
            // If the service comes back, the handler exists; ask it to describe
            // itself so a registration that resolved to the wrong class is
            // visible rather than merely "present".
            let described = "";
            try {
              described = String(svc.classDescription || "");
            } catch (e2) {
              described = "(classDescription threw: " + e2 + ")";
            }
            return {
              ok: true,
              available: true,
              contract: contract,
              classDescription: described,
            };
          } catch (e) {
            return {
              ok: true,
              available: false,
              contract: contract,
              error: String(e),
            };
          }
        },
      },
    };
  }
};
