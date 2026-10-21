/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* global Preferences */

/*
 * The General-pane "Download hand-off" section (rozelynx-handoff.inc.xhtml).
 *
 * Everything it shows comes from the XPCOM engine
 * (@bytewheel.org/handoff;1, uriloader/exthandler/rozelynx-handoff/) and
 * everything it writes goes back to the same prefs the engine reads, so
 * about:config, this editor and the interception gate can never disagree.
 *
 * THE ROW ORDER IS THE PRIORITY: the first handler that accepts a download
 * gets it, and a list that reads top to bottom says exactly that. There is
 * deliberately no separate "order" pref - a second thing to get out of
 * step with the first.
 */

"use strict";

const XHTML_NS = "http://www.w3.org/1999/xhtml";

const PREF_MODE = "rozelynx.downloads.handoff.enabled";
const PREF_MIN_SIZE = "rozelynx.downloads.handoff.min_size";
const PREF_HANDLER = "rozelynx.downloads.handler.";
const MAX_HANDLERS = 16;

const gRozeLynxHandoffPane = {
  _svc: null,
  _elements: {},

  init() {
    for (const [name, id] of Object.entries({
      mode: "rozelynx-handoff-mode",
      list: "rozelynx-handoff-list",
      empty: "rozelynx-handoff-empty",
      newId: "rozelynx-handoff-new-id",
      add: "rozelynx-handoff-add-btn",
      status: "rozelynx-handoff-status",
    })) {
      this._elements[name] = document.getElementById(id);
    }
    try {
      this._svc = Cc["@bytewheel.org/handoff;1"].getService(
        Ci.nsIRozeLynxHandoff
      );
    } catch (e) {
      // A build without USE=download-handoff has neither the service nor
      // this file; if only the service is missing, keep the section
      // visible so the failure can be seen rather than guessed at.
      this._setStatus(
        "The hand-off engine is not available in this build: " + e, true
      );
      return;
    }

    this._elements.mode.addEventListener("change", () => {
      // A three-state pref (auto / true / false) behind a three-option
      // select: the select writes exactly the string the engine reads.
      Services.prefs.setCharPref(PREF_MODE, this._elements.mode.value);
      this.refresh();
    });
    this._elements.add.addEventListener("command", () => this.add());
    this._elements.newId.addEventListener("change", () => {
      if (this._elements.newId.value.trim()) {
        this.add();
      }
    });

    this.refresh();
  },

  _setStatus(text, isError) {
    const el = this._elements.status;
    el.textContent = text || "";
    el.style.color = isError ? "var(--text-color-error, #e22850)" : "";
  },

  // Write the whole row list: indices 0..n-1 are set, every index >= n is
  // CLEARED - writing an empty value would leave a live pref the reader
  // skips only by accident of the gap rule, and an editor that says
  // "deleted" while the pref is still there is the bug this prevents.
  _write(handlers) {
    if (handlers.length > MAX_HANDLERS) {
      this._setStatus(
        `At most ${MAX_HANDLERS} handlers, got ${handlers.length}.`, true
      );
      return;
    }
    for (let i = 0; i < MAX_HANDLERS; i++) {
      const base = `${PREF_HANDLER}${i}.`;
      if (i >= handlers.length) {
        for (const field of ["id", "args", "enabled"]) {
          Services.prefs.clearUserPref(base + field);
        }
        continue;
      }
      const h = handlers[i];
      Services.prefs.setCharPref(base + "id", h.id);
      Services.prefs.setCharPref(base + "args", h.args || "");
      Services.prefs.setBoolPref(base + "enabled", h.enabled !== false);
    }
    this.refresh();
  },

  _kindBadge(kind) {
    if (kind === "builtin") {
      return "built in";
    }
    if (kind === "ext") {
      return "extension";
    }
    if (kind === "cmd") {
      return "program";
    }
    return "unknown";
  },

  refresh() {
    if (!this._svc) {
      return;
    }
    this._svc.refreshProbes();
    const handlers = this._svc.handlers;

    this._elements.mode.value =
      Services.prefs.getCharPref(PREF_MODE, "auto");

    const list = this._elements.list;
    list.textContent = "";
    this._elements.empty.hidden = handlers.length > 0;

    handlers.forEach((h, i) => {
      const row = document.createXULElement("hbox");
      row.setAttribute("align", "center");
      row.style.marginTop = "4px";

      const id = document.createElementNS(XHTML_NS, "input");
      id.type = "text";
      id.spellcheck = false;
      id.setAttribute("flex", "1");
      id.value = h.id;
      // The title carries the three shapes and why this row cannot take a
      // download right now - the question a bare id cannot answer.
      id.title = h.hint + (h.available ? "" : ` — ${h.detail}`);
      id.addEventListener("change", () => {
        const value = id.value.trim();
        const next = handlers.map(cloneHandler);
        if (!value) {
          // An empty id is not a handler; the row is removed rather than
          // saved as a no-op.
          next.splice(i, 1);
        } else {
          next[i].id = value;
        }
        this._write(next);
      });
      row.appendChild(id);

      const args = document.createElementNS(XHTML_NS, "input");
      args.type = "text";
      args.spellcheck = false;
      args.setAttribute("flex", "1");
      args.value = h.args || "";
      // An args template is meaningless for the other two kinds: shown but
      // not editable rather than hidden and then reappearing.
      args.disabled = h.kind !== "cmd";
      args.placeholder = h.kind === "cmd" ? "{url}" : "—";
      args.title =
        h.kind === "cmd"
          ? "Args for the program. {url} {filename} {referer} {ua} {cookies}"
          : "Only a cmd: handler takes arguments";
      args.addEventListener("change", () => {
        const next = handlers.map(cloneHandler);
        next[i].args = args.value;
        this._write(next);
      });
      row.appendChild(args);

      const on = document.createElementNS(XHTML_NS, "input");
      on.type = "checkbox";
      on.checked = h.enabled;
      on.title = "Enable this handler";
      on.addEventListener("change", () => {
        const next = handlers.map(cloneHandler);
        next[i].enabled = on.checked;
        this._write(next);
      });
      row.appendChild(on);

      const del = document.createXULElement("button");
      del.setAttribute("is", "highlightable-button");
      del.label = "Delete";
      del.addEventListener("command", () => {
        const next = handlers.map(cloneHandler);
        next.splice(i, 1);
        this._write(next);
      });
      row.appendChild(del);

      list.appendChild(row);

      // A second line per handler: the kind, the position and whether it
      // can take a download right now - without it an unavailable handler
      // looks identical to a working one and the feature fails silently.
      const note = document.createXULElement("label");
      note.className = "description-deemphasized";
      note.textContent =
        `${i + 1}. ${this._kindBadge(h.kind)}` +
        (h.enabled ? "" : " · disabled") +
        ` · ${h.available ? h.detail : h.detail}`;
      note.style.marginTop = "0";
      list.appendChild(note);
    });

    const live = handlers.filter(h => h.enabled && h.available).length;
    const mode = this._elements.mode.value;
    this._setStatus(
      `${handlers.length} configured, ${live} available` +
        (mode === "true" || (mode === "auto" && live > 0)
          ? " — hand-off is ON"
          : " — hand-off is off")
    );
  },

  add() {
    const value = this._elements.newId.value.trim();
    if (!value) {
      this._setStatus(
        "Type a handler id first: uget, ext:<id> or cmd:<program>.", true
      );
      return;
    }
    const handlers = this._svc ? this._svc.handlers.map(cloneHandler) : [];
    if (handlers.length >= MAX_HANDLERS) {
      this._setStatus(`The list is full (${MAX_HANDLERS} is the limit).`, true);
      return;
    }
    // A cmd: handler with no template would hand over a bare program with
    // no url, so the obvious default is filled in rather than left empty.
    handlers.push({
      id: value,
      args: value.startsWith("cmd:") ? "{url}" : "",
      enabled: true,
    });
    this._elements.newId.value = "";
    this._write(handlers);
  },
};

function cloneHandler(h) {
  return { id: h.id, args: h.args, enabled: h.enabled };
}

window.addEventListener("load", () => {
  // The pane scripts are loaded for the whole settings document; the
  // section itself lives in the General pane, so only build the editor
  // when its markup actually exists in this document.
  if (document.getElementById("rozelynxHandoffGroup")) {
    gRozeLynxHandoffPane.init();
  }
});
