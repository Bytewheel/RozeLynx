// downloads-handoff module for RozeLynx Features extension
//
// Hands a download off to whatever the user has configured to take it, so that
// program owns the queue, the GUI, the resume data and the retry logic, and the
// browser's own save UI never appears.
//
// NOTHING HERE IS SPECIFIC TO ONE DOWNLOAD MANAGER. A "handler" is data, and
// there are three shapes of it:
//
//   uget          a BUILTIN: the uget-integrator stdio protocol (see below).
//                 Kept as code because it is a real integration - a framed
//                 protocol with a queue behind it - not "run a program".
//   ext:<id>      any WebExtension that answers a cross-extension message.
//                 The message is {target: 'download', url, filename, referer}
//                 and an accepting extension answers {ok: true}.
//   cmd:<program> any program on PATH, with an args template.
//
// The handlers are an ORDERED LIST in indexed prefs, and the order is the
// priority: the first one that accepts the download gets it, and the rest are
// not tried. The list is empty-able, re-orderable and extensible from
// about:config or from the extension popup, and adding a download manager the
// project has never heard of is a pref edit rather than a code change.
//
// WHY uGET IS STILL A BUILTIN
//
// uget-integrator's protocol is not a command line. It is a length-prefixed
// JSON conversation whose keys are capitalised and indexed literally
// (`data['URL']`, `data['FileName']`, ...), where a missing key is a KeyError
// rather than a default, and where the reply arrives BEFORE the integrator
// launches uget-gtk and then .wait()s on it. That last part is why the builtin
// exists at all: the host has to detach from the child rather than block on it
// for as long as the user keeps the uGet window open. See do_handoff() in
// host/rozelynx-host, which is the generic counterpart and does the same
// detaching for any cmd: handler.
//
// WHY TWO INTERCEPTION POINTS
//
// The obvious one is browser.downloads.onCreated. It is also too late to
// satisfy "the save UI must not appear", and that is a property of the
// browser, not of this module:
//
//   nsExternalAppHandler::OnStartRequest        (uriloader/exthandler/
//     nsExternalHelperAppService.cpp:1657) is called synchronously when the
//     channel starts, i.e. BEFORE any response header exists, and from the
//     not-always-ask branch it calls PromptForSaveDestination() (line 2005)
//     -> RequestSaveDestination() -> the nsIFilePicker in
//     nsUnknownContentTypeDialog.promptForSaveToFileAsync
//     (toolkit/mozapps/downloads/HelperAppDlg.sys.mjs:248), or the "what
//     should RozeLynx do with this file?" dialog when the type has a
//     registered external handler (line 1979).
//   The download object itself is not created until the destination is
//     known: ContinueSave() -> CreateTransfer() (line 2392) ->
//     Downloads.createDownload() + list.add() in DownloadLegacy.sys.mjs:427,
//     and list.add() is what fires onDownloadAdded, which is what
//     downloads.onCreated is driven from
//     (toolkit/components/extensions/parent/ext-downloads.js:353).
//
// So with "Always ask where to save" on, the picker is already on screen
// before onCreated fires, and no WebExtension API runs earlier than
// onCreated for a download. Verified against the 156.0.1 source; the same
// ordering holds in 155 (ext-downloads.js and DownloadLegacy.sys.mjs are
// byte-identical between the two).
//
//   A. content.js intercepts the CLICK on a file link, at document_start,
//      in the capture phase, and prevents the default. The navigation never
//      starts, so there is no channel, no download object, no dialog and no
//      picker at all. This is the only way to actually deliver "clicking a
//      file link opens no file picker", and it is what Part D's acceptance
//      criterion describes.
//   B. downloads.onCreated is cancelled for everything the click hook cannot
//      see: downloads started by page script, form posts, iframes, the
//      download shelf, "Save link as", and downloads another extension
//      started. Nothing is written to disk and nothing reaches the downloads
//      panel, because the item is cancelled and erased.
//
// Both layers share one eligibility gate, one ordered hand-off and one loop
// guard, and a download that no handler accepts is put back in the browser.

(function() {
  'use strict';

  var HOST = 'rozelynx_host';
  var LOG_PREFIX = '[RozeLynx:downloads-handoff]';

  // 'auto' (the default) | 'true' | 'false'. A string because the default has
  // to be a third state: see resolveEnabled() for what 'auto' keys off.
  var PREF_ENABLED = 'rozelynx.downloads.handoff.enabled';
  // Anything smaller stays with the browser.
  var PREF_MIN_SIZE = 'rozelynx.downloads.handoff.min_size';
  // Space or comma separated URL substrings that are never intercepted.
  var PREF_EXCLUDE = 'rozelynx.downloads.handoff.exclude';
  // An add-on ID to stand down for, so another download-manager integration can
  // own downloads instead. See deferralTarget() for why this is an ID and not a
  // boolean.
  var PREF_DEFER_TO = 'rozelynx.downloads.handoff.defer_to';
  // Layer A on/off, and the file extensions Layer A treats as downloads.
  var PREF_LINK_INTERCEPT = 'rozelynx.downloads.handoff.link_intercept';
  var PREF_LINK_EXTENSIONS = 'rozelynx.downloads.handoff.link_extensions';

  // The handler list, as indexed prefs. n is 0..MAX_HANDLERS-1 and the ORDER
  // IS THE PRIORITY: the first handler that accepts the download gets it.
  var PREF_HANDLER_ID = 'rozelynx.downloads.handler.';
  var PREF_HANDLER_ID_SUFFIX = '.id';
  var PREF_HANDLER_ARGS_SUFFIX = '.args';
  var PREF_HANDLER_ENABLED_SUFFIX = '.enabled';

  // Same bound the editor refuses to write past. It has to be the same
  // constant, or a row would look saved in the editor while the reader below
  // silently dropped it.
  var MAX_HANDLERS = 16;

  var PREF_NAMES = [PREF_ENABLED, PREF_MIN_SIZE, PREF_EXCLUDE,
                    PREF_LINK_INTERCEPT, PREF_LINK_EXTENSIONS, PREF_DEFER_TO];

  var DEFAULT_MIN_SIZE = 300 * 1024;
  // Types Firefox does not render in a tab, so a link to one is a download
  // by any reasonable reading. Anything a browser displays inline (html,
  // txt, images, audio, video, pdf via the built-in viewer) is deliberately
  // absent: hijacking those would break the page. Overridable wholesale
  // through PREF_LINK_EXTENSIONS.
  var DEFAULT_LINK_EXTENSIONS = (
    // archives
    'zip tar gz bz2 xz lz lzma zst 7z rar tgz txz tbz2 cab jar ' +
    // packages, installers, binaries
    'deb rpm apk appimage snap msix msi exe dll so bin run pkg dmg ' +
    // disk images
    'iso img vhd vmdk wim ' +
    // documents the browser cannot show
    'doc docx xls xlsx ppt pptx odt ods odp rtf epub mobi azw3 cbz cbr ' +
    // subtitles
    'srt sub ass ssa ' +
    // fonts
    'ttf otf woff woff2 eot ' +
    // data, and the two types whose own install prompt nobody wants
    'torrent crx xpi apkg sqlite'
  ).split(' ');

  // Budget for one handler before the next is tried.
  var HANDOFF_TIMEOUT_MS = 1500;
  // How long a "download this in the browser instead" decision holds.
  var BYPASS_TTL_MS = 10 * 60 * 1000;
  var CONFIG_TTL_MS = 1000;
  var HISTORY_MAX = 50;
  var STORAGE_KEY = 'rozelynx_downloads_handoff_bypass';
  var ESCAPE_MENU_ID = 'rozelynx-download-in-browser';

  // The handler ids the module understands as BUILTINS, with the label the
  // editor shows for them. Everything else is either ext: or cmd:.
  var BUILTINS = {
    uget: {
      label: 'uGet (uget-gtk)',
      // Why this one is not just a cmd: handler, in one line: its transport is
      // a protocol, and its child outlives the call.
      hint: 'built in: speaks uget-integrator\'s own stdio protocol, with cookies',
    },
  };

  function log(level, msg) {
    var args = Array.prototype.slice.call(arguments, 1);
    if (level === 'error') {
      console.error.apply(console, [LOG_PREFIX].concat(args));
    } else if (level === 'warn') {
      console.warn.apply(console, [LOG_PREFIX].concat(args));
    } else if (level === 'debug') {
      console.debug.apply(console, [LOG_PREFIX].concat(args));
    } else {
      console.log.apply(console, [LOG_PREFIX].concat(args));
    }
  }

  var state = {
    // id -> {ok: bool, detail: string}. Refreshed on start, on demand, and on
    // the management events that can change it.
    available: {},
    // url -> expiry ms. The loop guard: an entry means "this URL was already
    // handed off, or the user already forced it into the browser".
    bypass: new Map(),
    // Bounded ring of what was handed off, to which handler, and by which
    // path, because the plan asks for the path taken to be visible after the
    // fact. There is no RozeLynx downloads panel to render this in; it is read
    // back with the 'downloads-handoff:status' message.
    history: [],
    config: null,
    configAt: 0,
    bypassPromise: null,
    warnedNoPrefs: false,
  };

  // ---------------------------------------------------------------- prefs

  function prefsApi() {
    return (typeof browser.rozelynxPrefs !== 'undefined' &&
            browser.rozelynxPrefs.getPrefs) ? browser.rozelynxPrefs : null;
  }

  function defaultConfig() {
    return {
      enabled: 'auto',
      minSize: DEFAULT_MIN_SIZE,
      exclude: [],
      linkIntercept: true,
      linkExtensions: DEFAULT_LINK_EXTENSIONS.slice(),
      deferTo: '',
      handlers: [],
    };
  }

  function splitList(value) {
    return String(value || '').split(/[\s,]+/).filter(function(s) {
      return s.length > 0;
    });
  }

  function normalizeEnabled(value) {
    var v = String(value == null ? '' : value).trim().toLowerCase();
    if (v === 'true' || v === 'on' || v === 'yes' || v === '1') return 'true';
    if (v === 'false' || v === 'off' || v === 'no' || v === '0') {
      return 'false';
    }
    return 'auto';
  }

  // What kind of handler is this id? Kept in one place because the reader, the
  // prober, the dispatcher and the editor all have to agree, and a disagreement
  // between any two of them is a handler that is offered but never called.
  function describeHandler(id) {
    var raw = String(id == null ? '' : id).trim();
    if (!raw) return null;
    if (BUILTINS[raw]) {
      return { kind: 'builtin', builtin: raw, id: raw,
               label: BUILTINS[raw].label, hint: BUILTINS[raw].hint };
    }
    if (raw.indexOf('ext:') === 0) {
      var extId = raw.slice(4).trim();
      if (!extId) return null;
      return { kind: 'ext', extId: extId, id: raw, label: extId,
               hint: 'another extension, by cross-extension message' };
    }
    if (raw.indexOf('cmd:') === 0) {
      var program = raw.slice(4).trim();
      if (!program) return null;
      return { kind: 'cmd', program: program, id: raw, label: program,
               hint: 'a program on PATH' };
    }
    // A bare word is not silently promoted to cmd: - that would run whatever
    // the user typed the moment they saved an id they had not finished
    // typing. An unknown id is reported, not guessed at.
    return { kind: 'unknown', id: raw, label: raw,
             hint: 'not a known handler: use uget, ext:<id> or cmd:<program>' };
  }

  function handlerPrefNames(index) {
    return [
      PREF_HANDLER_ID + index + PREF_HANDLER_ID_SUFFIX,
      PREF_HANDLER_ID + index + PREF_HANDLER_ARGS_SUFFIX,
      PREF_HANDLER_ID + index + PREF_HANDLER_ENABLED_SUFFIX,
    ];
  }

  // The whole candidate name list for the bounded scan. Three names per index,
  // so this is a fixed-size array rather than a dynamic getChildList - the
  // prefs experiment API reads a list of names, and the list is knowable.
  function allHandlerPrefNames() {
    var out = [];
    for (var i = 0; i < MAX_HANDLERS; i++) {
      var names = handlerPrefNames(i);
      for (var j = 0; j < names.length; j++) out.push(names[j]);
    }
    return out;
  }

  // Build the handler list from a flat getPrefs() answer. The scan stops at
  // the first index with no id: a gap is a hole, and a handler after a hole
  // would be invisible in the editor while still being a live pref.
  function handlersFromPrefs(list) {
    var by = {};
    (list || []).forEach(function(p) { by[p.name] = p; });
    var handlers = [];
    for (var i = 0; i < MAX_HANDLERS; i++) {
      var idName = PREF_HANDLER_ID + i + PREF_HANDLER_ID_SUFFIX;
      var idPref = by[idName];
      if (!idPref || idPref.type === 'missing' ||
          idPref.type === 'unknown' || !idPref.value) {
        break;
      }
      var desc = describeHandler(idPref.value);
      if (!desc) break;               // an unusable id ends the list
      var argsName = PREF_HANDLER_ID + i + PREF_HANDLER_ARGS_SUFFIX;
      var argsPref = by[argsName];
      var enName = PREF_HANDLER_ID + i + PREF_HANDLER_ENABLED_SUFFIX;
      var enPref = by[enName];
      handlers.push({
        index: i,
        id: desc.id,
        kind: desc.kind,
        label: desc.label,
        hint: desc.hint,
        builtin: desc.builtin || null,
        extId: desc.extId || null,
        program: desc.program || null,
        args: (argsPref && argsPref.type === 'string') ? argsPref.value : '',
        // Absent means enabled, so a hand-written .id pref with no .enabled
        // beside it is a working handler rather than a dead one.
        enabled: enPref ? enPref.type === 'boolean'
          ? enPref.value !== false
          : true : true,
      });
    }
    return handlers;
  }

  function configFromPrefs(list, handlerList) {
    var by = {};
    (list || []).forEach(function(p) { by[p.name] = p; });
    var cfg = defaultConfig();
    var enabled = by[PREF_ENABLED];
    if (enabled && enabled.type !== 'missing' && enabled.value != null) {
      cfg.enabled = normalizeEnabled(enabled.value);
    }
    var minSize = by[PREF_MIN_SIZE];
    if (minSize && minSize.type === 'integer' && minSize.value >= 0) {
      cfg.minSize = minSize.value;
    }
    var exclude = by[PREF_EXCLUDE];
    if (exclude && exclude.type === 'string') {
      cfg.exclude = splitList(exclude.value);
    }
    var linkIntercept = by[PREF_LINK_INTERCEPT];
    if (linkIntercept && linkIntercept.type === 'boolean') {
      cfg.linkIntercept = linkIntercept.value;
    }
    var linkExt = by[PREF_LINK_EXTENSIONS];
    if (linkExt && linkExt.type === 'string') {
      // An explicitly empty list is a valid choice: it leaves only anchors
      // carrying a `download` attribute to the link hook.
      cfg.linkExtensions = splitList(linkExt.value);
    }
    var deferTo = by[PREF_DEFER_TO];
    if (deferTo && deferTo.type === 'string') {
      cfg.deferTo = deferTo.value.trim();
    }
    cfg.handlers = handlerList || [];
    return cfg;
  }

  function config(force) {
    var now = Date.now();
    if (!force && state.config && now - state.configAt < CONFIG_TTL_MS) {
      return Promise.resolve(state.config);
    }
    var api = prefsApi();
    if (!api) {
      if (!state.warnedNoPrefs) {
        state.warnedNoPrefs = true;
        log('warn', 'rozelynxPrefs unavailable; download hand-off is ' +
            'running on built-in defaults and cannot see about:config');
      }
      state.config = defaultConfig();
      state.configAt = now;
      return Promise.resolve(state.config);
    }
    var names = PREF_NAMES.concat(allHandlerPrefNames());
    return Promise.resolve(api.getPrefs(names)).then(function(list) {
      state.config = configFromPrefs(list, handlersFromPrefs(list));
      state.configAt = Date.now();
      return state.config;
    }, function(err) {
      log('warn', 'pref read failed, using defaults:', err && err.message);
      state.config = defaultConfig();
      state.configAt = now;
      return state.config;
    });
  }

  // 'auto' keys off the ONE signal that is both observable and meaningful: at
  // least one enabled handler in the list can actually take a download right
  // now. "The user configured a handler and it resolves" is a much better
  // proxy for "the user wants downloads handed off" than Part D's pair of
  // signals was, and it is the honest answer to the plan's original question:
  // the "is it configured to interrupt" signal still lives in each manager's
  // own storage and is unreadable from here, but a configured-and-available
  // handler is the user's own statement of intent, which is stronger.
  function availableHandlers(cfg) {
    return (cfg.handlers || []).filter(function(h) {
      return h.enabled && state.available[h.id] && state.available[h.id].ok;
    });
  }

  function resolveEnabled(cfg) {
    if (cfg.enabled === 'false') return false;
    if (cfg.enabled === 'true') return true;
    return availableHandlers(cfg).length > 0;
  }

  // ------------------------------------------------------------- deferral
  //
  // Stand down for another download-manager integration.
  //
  // Two integrations that both hook downloads.onCreated do not compose. One
  // click becomes two hand-offs and two uget windows, and the two race over
  // downloads.cancel(), which is how the browser's own copy and the manager's
  // copy ended up on screen together. So this module can be told to keep its
  // hands off and let another add-on own downloads.
  //
  // The pref is an add-on ID rather than a boolean, and the reason is the
  // failure mode: a boolean cannot say WHO takes over, so on a profile with no
  // other integration it would leave every download to the browser while
  // reading as "on". Naming the target also means the deferral applies to any
  // other manager, not just the one that prompted this
  // (uget-integration@slgobinath).
  //
  // It stands down only if the named add-on is actually enabled, which a boolean
  // cannot express. Honouring the request blindly is the worse failure:
  // downloads would fall through with nothing managing them and nothing to
  // explain why. An unavailable management API is treated the same way - not
  // deferring - because deferring on a guess is that same failure.
  //
  // Cached briefly: interceptGate is on the per-download path and this is a
  // promise, and the answer only changes when an add-on is enabled or disabled,
  // which onAddonChanged already reacts to.
  var deferState = { at: 0, value: null, id: null };
  var DEFER_TTL_MS = 2000;

  function managementAvailable() {
    return typeof browser.management !== 'undefined' &&
           typeof browser.management.get === 'function';
  }

  // Resolves to the add-on ID being stood down for, or '' to keep handling.
  function deferralTarget(cfg) {
    var id = (cfg && cfg.deferTo) ? String(cfg.deferTo).trim() : '';
    if (!id || !managementAvailable()) return Promise.resolve('');
    var now = Date.now();
    if (deferState.value !== null && deferState.id === id &&
        now - deferState.at < DEFER_TTL_MS) {
      return Promise.resolve(deferState.value);
    }
    return Promise.resolve(browser.management.get(id)).then(function(info) {
      var on = !!(info && info.enabled);
      deferState = { at: Date.now(), value: on ? id : '', id: id };
      if (!on) {
        log('debug', 'defer_to names ' + id + ' but it is not enabled, so ' +
            'this module keeps handling downloads');
      }
      return deferState.value;
    }, function(err) {
      deferState = { at: Date.now(), value: '', id: id };
      log('warn', 'defer_to names ' + id + ' but it could not be read (' +
          ((err && err.message) || err) + '); keeping downloads');
      return '';
    });
  }

  // The gate both layers use. shouldIntercept() stays synchronous; the
  // deferral check is a promise, so it is layered here and the callers await
  // this instead. Deferral is checked FIRST so a module standing down reports
  // that, rather than the more interesting but misleading "no handler is
  // available".
  function interceptGate(cfg, url) {
    return deferralTarget(cfg).then(function(target) {
      if (target) {
        return { ok: false, reason: 'deferring to ' + target, deferred: true };
      }
      return shouldIntercept(cfg, url);
    });
  }

  function native(action, extra) {
    var message = extra || {};
    message.action = action;
    return Promise.resolve(
      browser.runtime.sendNativeMessage(HOST, message)
    ).then(function(r) {
      if (r && r.ok) return r;
      throw new Error(r && r.error ? r.error : 'no native host response');
    }, function(err) {
      throw new Error(err && err.message ? err.message : String(err));
    });
  }

  // ------------------------------------------------------- detection

  function probeOne(h) {
    if (h.kind === 'builtin' && h.builtin === 'uget') {
      return native('uget-probe', {}).then(function(r) {
        return { ok: true, detail: 'uget-integrator ' + (r.uget || r.version || '?') };
      }, function(err) {
        return { ok: false, detail: err.message };
      });
    }
    if (h.kind === 'cmd') {
      return native('handoff-probe', { program: h.program }).then(function(r) {
        return { ok: true, detail: r.path || h.program };
      }, function(err) {
        return { ok: false, detail: err.message };
      });
    }
    if (h.kind === 'ext') {
      if (typeof browser.management === 'undefined' ||
          typeof browser.management.get !== 'function') {
        return Promise.resolve({ ok: false, detail: 'management API unavailable' });
      }
      return Promise.resolve(browser.management.get(h.extId)).then(function(info) {
        return info && info.enabled
          ? { ok: true, detail: 'installed and enabled' }
          : { ok: false, detail: 'not installed or not enabled' };
      }, function() {
        return { ok: false, detail: 'not installed' };
      });
    }
    return Promise.resolve({ ok: false, detail: 'not a handler this build knows' });
  }

  function detect() {
    return config(true).then(function(cfg) {
      var probes = (cfg.handlers || []).map(function(h) {
        return probeOne(h).then(function(res) {
          state.available[h.id] = res;
          return { handler: h, res: res };
        });
      });
      return Promise.all(probes).then(function(results) {
        var live = availableHandlers(cfg);
        results.forEach(function(r) {
          log(r.res.ok ? 'info' : 'debug',
              'handler ' + r.handler.id + ' (' + r.handler.kind + '): ' +
              r.res.detail);
        });
        var on = resolveEnabled(cfg);
        return deferralTarget(cfg).then(function(target) {
          if (target) {
            // Said out loud on purpose. A module standing down looks exactly
            // like a broken one from the outside - same single window, same
            // silence - and the difference is invisible unless it is reported.
            log('info', 'standing down for ' + target +
                ' (pref ' + PREF_DEFER_TO + '); it owns downloads');
            return false;
          }
          if (cfg.deferTo) {
            log('info', PREF_DEFER_TO + '=' + cfg.deferTo + ' but that add-on ' +
                'is not enabled, so this module still owns downloads');
          }
          log('info', (cfg.handlers || []).length + ' handler(s) configured, ' +
              live.length + ' available; hand-off ' + (on ? 'ON' : 'off') +
              ' (pref ' + PREF_ENABLED + '=' + cfg.enabled + ')');
          return on;
        });
      });
    });
  }

  // ------------------------------------------------------------ loop guard

  function isBypassed(url) {
    var expiry = state.bypass.get(url);
    if (expiry === undefined) return false;
    if (expiry <= Date.now()) {
      state.bypass.delete(url);
      return false;
    }
    return true;
  }

  function bypass(url, why) {
    if (!url) return;
    state.bypass.set(url, Date.now() + BYPASS_TTL_MS);
    if (typeof browser.storage !== 'undefined' && browser.storage.local) {
      // The background page is an event page, so this map does not survive an
      // unload; without the write a restored download could be re-intercepted
      // after a suspend.
      var payload = {};
      state.bypass.forEach(function(expiry, key) {
        payload[key] = expiry;
      });
      Promise.resolve(browser.storage.local.set(
        { [STORAGE_KEY]: payload }
      )).catch(function(err) {
        log('warn', 'could not persist the bypass set:', err && err.message);
      });
    }
    log('info', 'bypassing hand-off for ' + url + ' (' + why + ')');
  }

  // The background page is an event page, so this map does not survive an
  // unload. The read is memoised as a promise rather than behind a boolean:
  // a download can arrive before the first read has resolved, and a boolean
  // would let it past the guard it was just written for.
  function loadBypass() {
    if (state.bypassPromise) return state.bypassPromise;
    state.bypassPromise = (typeof browser.storage === 'undefined' ||
                           !browser.storage.local)
      ? Promise.resolve()
      : Promise.resolve(browser.storage.local.get(STORAGE_KEY))
        .then(function(stored) {
          var payload = stored && stored[STORAGE_KEY];
          if (!payload || typeof payload !== 'object') return;
          var now = Date.now();
          Object.keys(payload).forEach(function(url) {
            if (typeof payload[url] === 'number' && payload[url] > now) {
              state.bypass.set(url, payload[url]);
            }
          });
        }, function(err) {
          log('warn', 'could not read the bypass set:', err && err.message);
        });
    return state.bypassPromise;
  }

  // ------------------------------------------------------------------ gate

  function shouldIntercept(cfg, url) {
    if (!url) return { ok: false, reason: 'no url' };
    if (!/^https?:/i.test(url)) return { ok: false, reason: 'non-http scheme' };
    if (isBypassed(url)) return { ok: false, reason: 'already handled' };
    for (var i = 0; i < cfg.exclude.length; i++) {
      if (url.indexOf(cfg.exclude[i]) >= 0) {
        return { ok: false, reason: 'excluded by ' + PREF_EXCLUDE };
      }
    }
    if (!resolveEnabled(cfg)) {
      return { ok: false, reason: 'no handler is available' };
    }
    return { ok: true };
  }

  // -------------------------------------------------------------- hand-off

  function withTimeout(promise, ms, what) {
    return new Promise(function(resolve, reject) {
      var done = false;
      var timer = setTimeout(function() {
        if (done) return;
        done = true;
        reject(new Error(what + ' did not answer within ' + ms + 'ms'));
      }, ms);
      Promise.resolve(promise).then(function(value) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      }, function(err) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  // Netscape cookie-file format. The field order is uGet Integration's own
  // parseCookies(), byte for byte, including httpOnly sitting in the
  // include-subdomains slot where uGet puts it: the consumer is uget-gtk, and a
  // file this writes has to be one it reads the same way as the file uGet's
  // own host writes. One deliberate difference - a session cookie has no
  // expirationDate and uGet writes "NaN" there, so this writes 0, which is
  // what every other cookie-file writer means by "until the session ends".
  //
  // The uget-gtk consumer takes the file's CONTENT, so the builtin passes the
  // text straight through. A cmd: handler is handed a PATH, because a program
  // that wants cookies wants to open a file (aria2's --load-cookies, wget's
  // --load-cookies, curl's -b all take one) and a file is the only form they
  // all agree on.
  //
  // The path is written by the HOST, not here, and that is a decision rather
  // than a limitation: an extension page has no filesystem API, the host
  // already writes files (set-prefs, install-xpi) and is the only process here
  // whose business it is to decide how long a file of live cookies lies around
  // on disk. So this hands over the text and {cookies} becomes that path on
  // the far side - see do_handoff() in host/rozelynx-host.
  //
  // Memoised per download: one cookie read for the whole hand-off, not one per
  // handler tried.
  function collectCookies(url) {
    if (typeof browser.cookies === 'undefined' ||
        typeof browser.cookies.getAll !== 'function') {
      return Promise.resolve('');
    }
    var m = /^(https?:\/\/[^/?#]+)/i.exec(url);
    var root = m ? m[1] + '/' : url;
    return Promise.resolve(browser.cookies.getAll({ url: root })).then(
      function(list) {
        return (list || []).map(function(c) {
          return [c.domain, c.httpOnly ? 'FALSE' : 'TRUE', c.path,
                  c.secure ? 'TRUE' : 'FALSE',
                  c.expirationDate != null ? Math.round(c.expirationDate) : 0,
                  c.name, c.value].join('\t');
        }).join('\n');
      },
      function() { return ''; }
    );
  }

  // One lazily-computed cookie payload per hand-off, shared by every handler
  // that gets tried. Both accessors are the same read on purpose: the two
  // transports want the same bytes, and only the receiving side differs.
  function cookieProvider(url) {
    var pending = null;
    function read() {
      if (!pending) pending = collectCookies(url);
      return pending;
    }
    return { text: read, path: read };
  }

  function handOffBuiltinUget(url, meta, cookies) {
    return cookies.text().then(function(text) {
      return native('uget', {
        url: url,
        filename: meta.filename || '',
        referer: meta.referer || '',
        fileSize: meta.size != null && meta.size >= 0 ? meta.size : '',
        userAgent: (typeof navigator !== 'undefined' && navigator.userAgent)
          ? navigator.userAgent : '',
        clientVersion: browser.runtime.getManifest().version,
        cookies: text,
      });
    }).then(function(r) {
      return { via: 'uget-integrator' };
    });
  }

  function handOffCmd(h, url, meta, cookies) {
    return cookies.path().then(function(cookiePath) {
      return native('handoff', {
        program: h.program,
        args: h.args || '{url}',
        url: url,
        filename: meta.filename || '',
        referer: meta.referer || '',
        cookies: cookiePath,
        userAgent: (typeof navigator !== 'undefined' && navigator.userAgent)
          ? navigator.userAgent : '',
      });
    }).then(function(r) {
      return { via: 'cmd:' + h.program, pid: r.pid };
    });
  }

  function handOffExt(h, url, meta) {
    // No cookies are sent: an extension that wants them has its own cookie
    // access, and shipping a Netscape file over a cross-extension message
    // would be a downgrade of it.
    return withTimeout(
      browser.runtime.sendMessage(h.extId, {
        target: 'download',
        url: url,
        filename: meta.filename || '',
        referer: meta.referer || '',
      }),
      HANDOFF_TIMEOUT_MS, 'extension ' + h.extId
    ).then(function(reply) {
      if (!reply || reply.ok !== true) {
        throw new Error('the extension did not acknowledge');
      }
      return { via: 'ext:' + h.extId };
    });
  }

  function record(url, via, meta, handlerId) {
    var entry = {
      at: Date.now(),
      url: url,
      via: via,
      handler: handlerId,
      filename: meta.filename || '',
      size: (meta.size != null && meta.size >= 0) ? meta.size : null,
      layer: meta.layer || 'downloads.onCreated',
    };
    state.history.push(entry);
    while (state.history.length > HISTORY_MAX) state.history.shift();
    log('info', 'handed off to ' + handlerId + ' via ' + via + ' (' +
        entry.layer + '): ' + url +
        (entry.filename ? ' -> ' + entry.filename : '') +
        (entry.size != null ? ' [' + entry.size + ' B]' : ''));
    return entry;
  }

  // Ordered, and SEQUENTIAL on purpose. Parallel attempts would hand the same
  // download to two managers, and the order is the user's stated priority.
  // A handler that is merely present but has not answered yet is not skipped -
  // HANDOFF_TIMEOUT_MS is the bound on being that slow.
  function handOff(url, meta) {
    return config().then(function(cfg) {
      var list = availableHandlers(cfg);
      if (!list.length) {
        return Promise.reject(new Error('no handler is available'));
      }
      var cookies = cookieProvider(url);
      var tried = [];
      var attempt = function(i) {
        if (i >= list.length) {
          return Promise.reject(new Error(
            'no handler accepted the download (tried ' +
            (tried.length ? tried.join(', ') : 'none') + ')'));
        }
        var h = list[i];
        var p;
        if (h.kind === 'builtin') p = handOffBuiltinUget(url, meta, cookies);
        else if (h.kind === 'cmd') p = handOffCmd(h, url, meta, cookies);
        else if (h.kind === 'ext') p = handOffExt(h, url, meta);
        else p = Promise.reject(new Error('not a handler this build knows'));
        return p.then(function(res) {
          record(url, res.via, meta, h.id);
          return { handler: h.id, via: res.via, tried: tried };
        }, function(err) {
          tried.push(h.id + ' (' + err.message + ')');
          log('warn', 'handler ' + h.id + ' declined or failed: ' +
              err.message + (i + 1 < list.length ? '; trying the next' : ''));
          return attempt(i + 1);
        });
      };
      return attempt(0);
    });
  }

  // ------------------------------------------------------- layer A: a link

  function interceptLink(data) {
    data = data || {};
    return Promise.all([config(), loadBypass()]).then(function(res) {
      var cfg = res[0];
      if (!cfg.linkIntercept) {
        return { ok: false, reason: 'link interception disabled' };
      }
      return interceptGate(cfg, data.url).then(function(gate) {
        if (!gate.ok) return gate;
        return handOff(data.url, {
          filename: data.filename || '',
          referer: data.referrer || '',
          size: -1,
          layer: 'link',
        }).then(function(r) {
          // Claim the URL. record() is history, not a claim, so until this
          // nothing stopped downloads.onCreated from handing the SAME url off a
          // second time - one click, two uget windows, whenever the browser
          // started a download despite the content script's preventDefault
          // (a page's own handler, a redirect that turns a navigation into an
          // attachment, a second frame). The failure path below already used
          // bypass() for the same reason; the success path did not.
          bypass(data.url, 'handed off from the link layer');
          return { ok: true, via: r.via, handler: r.handler };
        }, function(err) {
          // Nothing was cancelled: the content script has only eaten the
          // click, so letting it through restores exactly the browser's own
          // behaviour, picker included.
          log('warn', 'hand-off failed for ' + data.url + ' (' +
              err.message + '); letting the browser handle it');
          return { ok: false, reason: err.message, handoffFailed: true };
        });
      });
    });
  }

  // The content script needs the extension list to recognise a candidate
  // synchronously, but cannot read prefs, so it gets the authoritative list
  // back with the first reply and caches it for the rest of the document. It
  // travels in the reply rather than in a broadcast because the reply reaches
  // the exact frame that asked, and because a declined candidate is answered
  // on the same message that carries the list.
  function withLinkConfig(reply, cfg) {
    if (reply && typeof reply === 'object') {
      reply.config = {
        linkIntercept: cfg.linkIntercept,
        linkExtensions: cfg.linkExtensions,
      };
    }
    return reply;
  }

  // ------------------------------------------- layer B: downloads.onCreated

  // Firefox reports fileSize -1 on a download that has only just been
  // created, which is why download managers' own extensions issue a HEAD
  // request; this is the asynchronous equivalent. An unreachable HEAD, or a
  // response with no Content-Length, yields -1, and -1 is treated as
  // "unknown" and NOT as "small": a missing Content-Length is not evidence of
  // a small file, and refusing to hand those off would be a silent hole.
  function resolveSize(item) {
    var url = item.finalUrl || item.url;
    if (item.fileSize > 0) return Promise.resolve(item.fileSize);
    return fetch(url, { method: 'HEAD', credentials: 'include' })
      .then(function(res) {
        var len = parseInt(res.headers.get('content-length') || '', 10);
        return (isNaN(len) || len < 0) ? -1 : len;
      })
      .catch(function() { return -1; });
  }

  function basename(path) {
    if (!path) return '';
    var cleaned = String(path).split(/[?#]/)[0];
    var parts = cleaned.split('/');
    return parts[parts.length - 1] || '';
  }

  // Start a download that stays in THIS browser rather than going to the
  // manager: the content script's release path (a declined
  // download-attribute candidate whose anchor the page removed mid-flight -
  // see modules/downloads-handoff/content.js), Layer B's give-it-back
  // restore, and the context-menu escape item. This is not a bypass: the
  // download the API starts fires downloads.onCreated, so it runs the same
  // gate again, and every reason a caller was declined here (no handler,
  // excluded, bypassed, deferred, non-http) is a reason Layer B declines
  // too - a restored download proceeds, a handed-off one does not loop.
  //
  // The filename is a suggestion (the download attribute is a name the page
  // chose, not a path we chose), so a suggestion the API refuses - illegal
  // characters, an absolute path, back-references - is retried without it
  // rather than losing the download.
  function startBrowserDownload(url, filename) {
    var opts = { url: url, conflictAction: 'uniquify' };
    if (filename) opts.filename = filename;
    return browser.downloads.download(opts).catch(function(err) {
      if (!opts.filename) throw err;
      return browser.downloads.download({ url: url, conflictAction: 'uniquify' });
    });
  }

  function cancelAndHandOff(item, url, size) {
    var meta = {
      filename: basename(item.filename),
      referer: item.referrer || '',
      size: size,
      layer: 'downloads.onCreated',
    };
    // browser.downloads.cancel resolves with a BOOLEAN, and false is a real
    // answer, not a failure: the item is already complete, already
    // interrupted, or was never on the list. The previous version ignored the
    // resolved value and only caught rejections, so a false cancel still went
    // on to erase and hand off - and the browser, which still owned the file,
    // kept downloading it. The user then got the download twice: Firefox's own
    // progress AND uget fetching the same URL, side by side.
    //
    // That is the whole of "I see both the normal download window and the
    // uget window", and it needs no second extension to happen - a download
    // that cannot be cancelled is enough. Once cancel has NOT happened there
    // is nothing to hand off: the browser is already doing the job, and
    // handing off on top of it is a duplicate, not a hand-off.
    var cancelled = false;
    return Promise.resolve(browser.downloads.cancel(item.id))
      .then(function(wasCancelled) {
        cancelled = wasCancelled === true;
        if (!cancelled) {
          log('debug', 'cancel returned false for download ' + item.id +
              '; the browser still owns it, so not handing off');
          return null;
        }
        return browser.downloads.erase({ id: item.id });
      })
      .catch(function() {
        // A rejected cancel is the same situation for our purposes: we do not
        // hold the file, so the hand-off is not ours to make.
        log('debug', 'cancel failed for download ' + item.id +
            '; the browser still owns it, so not handing off');
      })
      .then(function() {
        if (!cancelled) return { notCancelled: true };
        return handOff(url, meta);
      })
      .catch(function(err) {
        // The cancel cannot be undone, so a failed hand-off has to give the
        // download back rather than lose it. The bypass entry is what stops
        // this module from re-intercepting the retry below.
        log('error', 'hand-off failed for ' + url + ' (' + err.message +
            '); restoring the browser download');
        bypass(url, 'hand-off failed');
        return startBrowserDownload(url).then(function(id) {
          return { restored: id };
        }, function(restoreErr) {
          log('error', 'could not restore the browser download for ' + url +
              ': ' + (restoreErr && restoreErr.message));
          return { restoreFailed: true };
        });
      });
  }

  function handleCreated(item) {
    if (item.incognito) {
      // The extension is not enabled in private windows by default, so this
      // only fires if the user allowed it - and handing a private download to
      // another program would write it to disk outside the private session.
      log('debug', 'leaving private download ' + item.id + ' to the browser');
      return Promise.resolve();
    }
    var url = item.finalUrl || item.url;
    return Promise.all([config(), loadBypass()]).then(function(res) {
      var cfg = res[0];
      return interceptGate(cfg, url).then(function(gate) {
        if (!gate.ok) {
          log('debug', 'not intercepting ' + url + ' (' + gate.reason + ')');
          return null;
        }
        return resolveSize(item).then(function(size) {
          if (cfg.minSize > 0 && size >= 0 && size < cfg.minSize) {
            log('debug', 'keeping ' + url + ' in the browser: ' + size +
                ' B is under ' + cfg.minSize + ' B');
            return null;
          }
          return cancelAndHandOff(item, url, size);
        });
      });
    });
  }

  // ----------------------------------------------------------------- menus

  function createEscapeMenu() {
    if (typeof browser.contextMenus === 'undefined' ||
        typeof browser.contextMenus.create !== 'function') {
      return;
    }
    var ready = browser.contextMenus.removeAll ?
      Promise.resolve(browser.contextMenus.removeAll()).catch(function() {}) :
      Promise.resolve();
    ready.then(function() {
      browser.contextMenus.create({
        id: ESCAPE_MENU_ID,
        // Not named after any one manager: the point of the item is to keep
        // this download in the browser whatever the handler list says.
        title: 'Download in RozeLynx (skip hand-off)',
        contexts: ['link'],
      }, function() { void browser.runtime.lastError; });
    });
    browser.contextMenus.onClicked.addListener(function(info) {
      if (!info || info.menuItemId !== ESCAPE_MENU_ID || !info.linkUrl) {
        return;
      }
      // The per-download escape the plan asks for. There is no RozeLynx
      // downloads panel to hang an "open in browser" action off, so the
      // escape is a context menu item on the link, which is reachable from
      // exactly the place the download was started.
      bypass(info.linkUrl, 'context menu');
      startBrowserDownload(info.linkUrl).then(function(id) {
        log('info', 'forced a browser download for ' + info.linkUrl +
            ' (id ' + id + ')');
      }, function(err) {
        log('error', 'forced browser download failed: ' +
            ((err && err.message) || err));
      });
    });
  }

  // -------------------------------------------------------------- messages

  // The editor's view of the list: the stored handlers plus, for each, whether
  // it can take a download right now. Probing has to happen HERE because an
  // extension page has no sendNativeMessage - only the background does - so
  // the popup asks rather than guessing.
  function handlerState(cfg) {
    return (cfg.handlers || []).map(function(h) {
      var a = state.available[h.id];
      return {
        index: h.index,
        id: h.id,
        kind: h.kind,
        label: h.label,
        hint: h.hint,
        builtin: h.builtin,
        extId: h.extId,
        program: h.program,
        args: h.args,
        enabled: h.enabled,
        available: !!(a && a.ok),
        detail: a ? a.detail : 'not probed yet',
      };
    });
  }

  // Async because deferral is: a module standing down for another integration
  // reports enabled:false, and saying otherwise is how a deliberate stand-down
  // becomes indistinguishable from a broken hand-off. Every caller already sits
  // inside a promise, so this costs nothing at the call sites.
  function statusPayload(cfg) {
    return deferralTarget(cfg).then(function(target) {
    var on = target ? false : resolveEnabled(cfg);
    return {
      ok: true,
      enabled: on,
      deferringTo: target || '',
      mode: cfg.enabled,
      minSize: cfg.minSize,
      maxHandlers: MAX_HANDLERS,
      handlers: handlerState(cfg),
      availableCount: on ? availableHandlers(cfg).length : 0,
      bypassed: Array.from(state.bypass.keys()),
      history: state.history.slice(),
    };
    });
  }

  // Write the whole list: indices 0..n-1 are set, and EVERY index >= n has its
  // three prefs CLEARED. Writing an empty value instead would leave a live
  // pref in about:config that the reader above skips only by accident of the
  // gap rule - and an editor that says "deleted" while the pref is still there
  // is the bug Part F recorded for URL rules.
  function setHandlers(handlers) {
    var api = prefsApi();
    if (!api) {
      return Promise.resolve({ ok: false, error: 'the prefs API is unavailable' });
    }
    if (!Array.isArray(handlers)) {
      return Promise.resolve({ ok: false, error: 'handlers must be a list' });
    }
    if (handlers.length > MAX_HANDLERS) {
      return Promise.resolve({
        ok: false,
        error: 'at most ' + MAX_HANDLERS + ' handlers, got ' + handlers.length,
      });
    }
    var set = {};
    var clear = [];
    for (var i = 0; i < MAX_HANDLERS; i++) {
      var names = handlerPrefNames(i);
      if (i >= handlers.length) {
        for (var c = 0; c < names.length; c++) clear.push(names[c]);
        continue;
      }
      var h = handlers[i] || {};
      var desc = describeHandler(h.id);
      // An UNKNOWN id is refused here even though the reader above reports it
      // as a row. The reader's job is to show the user what is in about:config,
      // and a hand-written `handler.0.id = "wget"` is worth showing with an
      // explanation. The writer's job is different: saving a row the module
      // cannot call is a row that looks saved and does nothing, which is the
      // "the editor says it worked and nothing happened" bug Part F recorded
      // for URL rules. So: shown, never written.
      if (!desc || desc.kind === 'unknown') {
        return Promise.resolve({
          ok: false,
          error: 'row ' + i + ': "' + (h.id == null ? '' : h.id) +
            '" is not a handler; use uget, ext:<id> or cmd:<program>',
        });
      }
      set[names[0]] = desc.id;
      // An empty args string is a real, recorded value (a cmd: handler with no
      // template), so it is written rather than skipped.
      set[names[1]] = typeof h.args === 'string' ? h.args : '';
      set[names[2]] = h.enabled === false ? false : true;
    }
    // Clear first, then set: a shrink followed by a grow within the same save
    // must not leave a cleared index that the same save is about to write.
    return Promise.resolve(api.clearPrefs ? api.clearPrefs(clear) : null)
      .then(function(res) {
        if (res && res.ok === false) {
          throw new Error('could not clear stale handlers: ' + res.error);
        }
        return api.setPrefs(set);
      }).then(function(res) {
        if (!res || res.ok === false) {
          throw new Error((res && res.error) || 'could not write the handlers');
        }
        return detect();
      }).then(function() {
        // Re-read rather than echo: the editor must render what is stored, not
        // what it hoped to store. Part F's invariant, same reason.
        return config(true);
      }).then(function(cfg) {
        return { ok: true, enabled: cfg.enabled, handlers: handlerState(cfg),
                 maxHandlers: MAX_HANDLERS };
      })
      .catch(function(err) {
        return { ok: false, error: err && err.message ? err.message : String(err) };
      });
  }

  // The pref is a three-state string, so the editor's master control writes
  // the string rather than a boolean. Normalising here means a hand-typed
  // about:config value ("yes", "1", "off") is accepted the same way the
  // checkbox/select writes it, instead of being the one input that behaves
  // differently from the UI.
  function setEnabled(mode) {
    var api = prefsApi();
    if (!api) {
      return Promise.resolve({ ok: false, error: 'the prefs API is unavailable' });
    }
    var value = normalizeEnabled(mode);
    return Promise.resolve(api.setPrefs({ [PREF_ENABLED]: value }))
      .then(function(res) {
        if (!res || res.ok === false) {
          throw new Error((res && res.error) || 'could not write the pref');
        }
        return detect();
      })
      .then(function() { return config(true); })
      .then(function(cfg) {
        return { ok: true, enabled: resolveEnabled(cfg), mode: cfg.enabled,
                 handlers: handlerState(cfg), maxHandlers: MAX_HANDLERS };
      })
      .catch(function(err) {
        return { ok: false, error: err && err.message ? err.message : String(err) };
      });
  }

  browser.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    var action = message && message.action;
    if (action !== 'downloads-handoff:intercept' &&
        action !== 'downloads-handoff:status' &&
        action !== 'downloads-handoff:handlers' &&
        action !== 'downloads-handoff:set-handlers' &&
        action !== 'downloads-handoff:set-enabled' &&
        action !== 'downloads-handoff:probe' &&
        action !== 'downloads-handoff:browser-download') {
      return false;
    }
    if (action === 'downloads-handoff:status' ||
        action === 'downloads-handoff:handlers') {
      Promise.all([config(), detect()]).then(function(res) {
        sendResponse(statusPayload(res[0]));
      }, function() {
        sendResponse(statusPayload(state.config || defaultConfig()));
      });
      return true;
    }
    if (action === 'downloads-handoff:set-handlers') {
      setHandlers(message.handlers).then(function(res) {
        sendResponse(res);
      });
      return true;
    }
    if (action === 'downloads-handoff:set-enabled') {
      setEnabled(message.mode).then(function(res) {
        sendResponse(res);
      });
      return true;
    }
    if (action === 'downloads-handoff:probe') {
      detect().then(function() {
        sendResponse(statusPayload(state.config || defaultConfig()));
      }, function() {
        sendResponse(statusPayload(state.config || defaultConfig()));
      });
      return true;
    }
    if (action === 'downloads-handoff:browser-download') {
      // Layer A's detached-anchor release (see content.js): the click hook
      // let a download-attribute candidate go, and the anchor the click
      // belongs to is gone, so the download itself starts here. The ok/id
      // shape is the one every other action in this extension answers in.
      var rel = message.data || {};
      startBrowserDownload(rel.url, rel.filename).then(function(id) {
        sendResponse({ ok: true, id: id });
      }, function(err) {
        sendResponse({ ok: false,
          error: String((err && err.message) || err) });
      });
      return true;
    }
    interceptLink(message.data).then(function(reply) {
      sendResponse(withLinkConfig(
        reply, (state.config || defaultConfig())));
    }, function(err) {
      sendResponse(withLinkConfig({
        ok: false,
        reason: err && err.message ? err.message : String(err),
      }, (state.config || defaultConfig())));
    });
    return true;
  });

  // ------------------------------------------------------------------ init

  function onAddonChanged() {
    // An install, enable or disable of an ext: handler - or of anything else -
    // changes the answer without the user touching a pref. It also changes
    // whether defer_to is in force, and the deferral is cached for a couple of
    // seconds precisely because this listener exists to catch that.
    deferState = { at: 0, value: null, id: null };
    config(true);
    detect().catch(function() {});
  }

  function init() {
    if (typeof browser.downloads === 'undefined') {
      log('warn', 'the downloads API is unavailable; module disabled');
      return;
    }
    browser.downloads.onCreated.addListener(function(item) {
      handleCreated(item).catch(function(err) {
        log('error', 'interception failed for download ' + item.id + ': ' +
            (err && err.message));
      });
    });

    createEscapeMenu();

    config(true)
      .then(loadBypass)
      .then(detect)
      .catch(function(err) {
        log('error', 'initialisation failed:', err && err.message);
      });

    if (browser.management && browser.management.onInstalled) {
      browser.management.onInstalled.addListener(onAddonChanged);
      browser.management.onEnabled.addListener(onAddonChanged);
      browser.management.onDisabled.addListener(onAddonChanged);
    }
    if (browser.management && browser.management.onUninstalled) {
      browser.management.onUninstalled.addListener(onAddonChanged);
    }
  }

  init();
})();
