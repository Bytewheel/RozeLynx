/* RozeLynx: the download hand-off handler list editor.
 *
 * Renders the collapsible "Download hand-off" section at the bottom of the
 * extension popup (the qr-code one, which is the extension's only popup). The
 * markup is already in modules/qr-code/popup.html; this script owns it and
 * leaves it `hidden` unless the background module answers, so a build without
 * USE=download-handoff shows no empty box.
 *
 * Storage model, deliberately not its own: a handler is three prefs
 * (rozelynx.downloads.handler.<n>.id / .args / .enabled) and the whole list is
 * replaced through the background's `downloads-handoff:set-handlers`. The
 * background owns that because it is the only context that can clear a stale
 * index (clearPrefs) and the only one that can probe whether a handler works
 * (sendNativeMessage is unavailable to an extension page). The prefs stay the
 * single source of truth: about:config shows exactly what the editor shows.
 *
 * The ROW ORDER IS THE PRIORITY. There is deliberately no separate "order"
 * pref - the first handler that accepts a download gets it, and a list that is
 * read top to bottom says exactly that. A separate ordering pref would be a
 * second thing to get out of step with the first.
 *
 * The one piece of local state is the collapsed/expanded flag, in
 * storage.local, because it is a UI preference and not configuration.
 */
(function() {
  'use strict';

  var STORAGE_KEY = 'rozelynx_handoff_expanded';
  var LOG_PREFIX = '[RozeLynx:handoff-ui]';

  var section = document.getElementById('handoff-section');
  if (!section) {
    return;
  }

  var header = document.getElementById('handoff-header');
  var count = document.getElementById('handoff-count');
  var body = document.getElementById('handoff-body');
  var master = document.getElementById('handoff-enabled');
  var listEl = document.getElementById('handoff-list');
  var emptyEl = document.getElementById('handoff-empty');
  var newId = document.getElementById('handoff-new-id');
  var addBtn = document.getElementById('handoff-add-btn');
  var statusEl = document.getElementById('handoff-status');
  var modeEl = document.getElementById('handoff-mode');
  var masterWrap = document.getElementById('handoff-master-wrap');

  var handlers = [];
  var maxHandlers = 16;
  var expanded = false;

  function log(msg) {
    try {
      console.log(LOG_PREFIX, msg);
    } catch (e) {}
  }

  function showStatus(msg, isError) {
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('error', !!isError);
  }

  function ask(action, extra) {
    var msg = { action: action };
    if (extra) {
      Object.keys(extra).forEach(function(k) { msg[k] = extra[k]; });
    }
    return browser.runtime.sendMessage(msg);
  }

  // ── expand / collapse ────────────────────────────────────────────
  // A real <button>, so Enter and Space already work and the popup stays
  // keyboard-navigable; aria-expanded is the only state to keep in sync.
  function setExpanded(value) {
    expanded = !!value;
    header.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    body.hidden = !expanded;
    try {
      var d = {};
      d[STORAGE_KEY] = expanded;
      browser.storage.local.set(d);
    } catch (e) {}
  }

  header.addEventListener('click', function() {
    setExpanded(!expanded);
  });

  // ── data ─────────────────────────────────────────────────────────

  function readState() {
    return ask('downloads-handoff:handlers').then(function(res) {
      if (!res || res.ok !== true) {
        throw new Error((res && res.error) || 'the hand-off module did not answer');
      }
      apply(res);
    });
  }

  function apply(res) {
    handlers = Array.isArray(res.handlers) ? res.handlers : [];
    if (typeof res.maxHandlers === 'number') maxHandlers = res.maxHandlers;
    if (master) master.value = res.mode || 'auto';
    if (modeEl) {
      // 'auto' is the default and the interesting one, so it says what it
      // resolved to rather than just echoing the string.
      var live = handlers.filter(function(h) { return h.enabled && h.available; });
      modeEl.textContent = 'mode: ' + (res.mode || 'auto') + ' — ' +
        handlers.length + ' configured, ' + live.length + ' available' +
        (res.enabled ? '' : ' (off)');
    }
    render();
  }

  function write(next) {
    return ask('downloads-handoff:set-handlers', { handlers: next })
      .then(function(res) {
        if (!res || res.ok !== true) {
          showStatus((res && res.error) || 'Could not save the handlers.', true);
          return readState();
        }
        // The background answers with the RE-READ list, so the editor renders
        // what is stored rather than what it hoped to store. Part F's
        // invariant, for the same reason.
        apply(res);
        showStatus('');
      })
      .catch(function(e) {
        showStatus('Could not save the handlers: ' + ((e && e.message) || e), true);
      });
  }

  function clone() {
    return handlers.map(function(h) {
      return {
        id: h.id, args: h.args, enabled: h.enabled,
      };
    });
  }

  // ── render ───────────────────────────────────────────────────────

  function kindBadge(h) {
    if (h.kind === 'builtin') return 'built in';
    if (h.kind === 'ext') return 'extension';
    if (h.kind === 'cmd') return 'program';
    return 'unknown';
  }

  function render() {
    count.textContent = handlers.length
      ? (handlers.length + (handlers.length === 1 ? ' handler' : ' handlers'))
      : '';

    if (masterWrap) masterWrap.hidden = false;
    listEl.textContent = '';
    emptyEl.hidden = handlers.length > 0;

    handlers.forEach(function(h, i) {
      var row = document.createElement('div');
      row.className = 'handoff-row';

      var id = document.createElement('input');
      id.type = 'text';
      id.value = h.id || '';
      id.spellcheck = false;
      id.className = 'handoff-id';
      // The title carries the three shapes and why this row cannot take the
      // download right now - which is the question a bare id cannot answer.
      id.title = h.hint + (h.available ? '' : ' — ' + (h.detail || 'unavailable'));
      id.addEventListener('change', function() {
        var value = id.value.trim();
        if (value === (handlers[i].id || '')) return;
        var next = clone();
        next[i].id = value;
        write(next);
      });
      row.appendChild(id);

      var args = document.createElement('input');
      args.type = 'text';
      args.value = h.args || '';
      args.spellcheck = false;
      args.className = 'handoff-args';
      // An args template is meaningless for the other two kinds, so it is
      // shown but not editable rather than hidden and then reappearing.
      args.disabled = h.kind !== 'cmd';
      args.placeholder = h.kind === 'cmd' ? '{url}' : '—';
      args.title = h.kind === 'cmd'
        ? 'Args for the program. {url} {filename} {referer} {ua} {cookies}'
        : 'Only a cmd: handler takes arguments';
      args.addEventListener('change', function() {
        var next = clone();
        next[i].args = args.value;
        write(next);
      });
      row.appendChild(args);

      var on = document.createElement('input');
      on.type = 'checkbox';
      on.className = 'handoff-enabled';
      on.checked = h.enabled !== false;
      on.title = 'Enable this handler';
      on.addEventListener('change', function() {
        var next = clone();
        next[i].enabled = on.checked;
        write(next);
      });
      row.appendChild(on);

      var del = document.createElement('button');
      del.type = 'button';
      del.textContent = 'X';
      del.title = 'Delete this handler';
      del.addEventListener('click', function() {
        var next = clone();
        next.splice(i, 1);
        write(next);
      });
      row.appendChild(del);

      listEl.appendChild(row);

      // A second line per handler: the kind, and whether it can take a
      // download right now. Without it an unavailable handler looks identical
      // to a working one, and the whole feature then fails silently.
      var note = document.createElement('div');
      note.className = 'handoff-note' + (h.available ? '' : ' off');
      var pos = i + 1;
      note.textContent = pos + '. ' + kindBadge(h) +
        (h.enabled ? '' : ' · disabled') + ' · ' +
        (h.available ? (h.detail || 'available')
                     : (h.detail || 'unavailable'));
      listEl.appendChild(note);
    });

    if (addBtn) {
      addBtn.disabled = handlers.length >= maxHandlers;
      addBtn.title = handlers.length >= maxHandlers
        ? 'The list is full (' + maxHandlers + ' is the limit)'
        : 'Add a handler';
    }
  }

  // ── add ──────────────────────────────────────────────────────────

  function addHandler() {
    var value = (newId.value || '').trim();
    if (!value) {
      showStatus('Type a handler id first: uget, ext:<id> or cmd:<program>.', true);
      return;
    }
    if (handlers.length >= maxHandlers) {
      showStatus('The list is full (' + maxHandlers + ' is the limit).', true);
      return;
    }
    var next = clone();
    // A cmd: handler with no template would hand over a bare program with no
    // url, so the obvious default is filled in rather than left empty.
    next.push({
      id: value,
      args: value.indexOf('cmd:') === 0 ? '{url}' : '',
      enabled: true,
    });
    newId.value = '';
    write(next);
  }

  if (addBtn) addBtn.addEventListener('click', addHandler);
  if (newId) {
    newId.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        addHandler();
      }
    });
  }

  // ── the master switch ────────────────────────────────────────────
  // A <select>, not a checkbox, and deliberately: the pref is a STRING with
  // three states - 'auto' (the default: on when a handler is available),
  // 'true' (force on) and 'false' (force off) - and a two-state control cannot
  // express the default without either lying about it or inventing a third
  // widget to restore it. The netiface section can get away with a checkbox
  // because that pref genuinely is a boolean.
  if (master) {
    master.addEventListener('change', function() {
      ask('downloads-handoff:set-enabled', { mode: master.value })
        .then(function(res) {
          if (res && res.ok === true) {
            apply(res);
            showStatus('');
          } else {
            showStatus((res && res.error) || 'Could not change the mode.', true);
            readState();
          }
        })
        .catch(function(e) {
          showStatus('Could not change the mode: ' + ((e && e.message) || e), true);
        });
    });
  }

  // ── init ─────────────────────────────────────────────────────────

  function init() {
    readState().then(function() {
      // Only now is the section revealed: an empty box in a popup that has no
      // hand-off module is worse than no box.
      section.hidden = false;
      return browser.storage.local.get(STORAGE_KEY).catch(function() { return {}; });
    }).then(function(stored) {
      setExpanded(!!(stored && stored[STORAGE_KEY]));
    }).catch(function(e) {
      // The section stays hidden, which is the same outcome as a build without
      // the module. Say why once, in the console, where a developer looks.
      log('not showing the hand-off section:', (e && e.message) || e);
    });
  }

  init();
})();
