/* RozeLynx experiment API: privileged live access to about:config prefs.
 * Backs the ip-protection toggle so preference changes apply immediately
 * (same mechanism about:config uses) instead of waiting for a restart;
 * user.js written through the native host remains the persistence layer.
 *
 * The experiment sandbox already provides ExtensionAPI, Services and Ci
 * as globals - do not import them here.
 */

this.rozelynxPrefs = class extends ExtensionAPI {
  getAPI(context) {
    const PREF_TYPES = {
      boolean: Ci.nsIPrefBranch.PREF_BOOL,
      string: Ci.nsIPrefBranch.PREF_STRING,
      integer: Ci.nsIPrefBranch.PREF_INT,
    };

    return {
      rozelynxPrefs: {
        async setPrefs(prefs) {
          let written = 0;
          const errors = [];
          for (const [name, value] of Object.entries(prefs || {})) {
            try {
              switch (typeof value) {
                case "boolean":
                  Services.prefs.setBoolPref(name, value);
                  written++;
                  break;
                case "string":
                  Services.prefs.setStringPref(name, value);
                  written++;
                  break;
                case "number":
                  if (Number.isInteger(value)) {
                    Services.prefs.setIntPref(name, value);
                    written++;
                  } else {
                    errors.push(name + ": non-integer number");
                  }
                  break;
                default:
                  errors.push(name + ": unsupported type " + typeof value);
              }
            } catch (e) {
              errors.push(name + ": " + (e && e.message ? e.message : String(e)));
            }
          }
          return {
            ok: errors.length === 0,
            written,
            error: errors.join("; "),
          };
        },

        async getPrefs(names) {
          const out = [];
          for (const name of names || []) {
            try {
              const t = Services.prefs.getPrefType(name);
              if (t === PREF_TYPES.boolean) {
                out.push({
                  name,
                  type: "boolean",
                  value: Services.prefs.getBoolPref(name),
                });
              } else if (t === PREF_TYPES.string) {
                out.push({
                  name,
                  type: "string",
                  value: Services.prefs.getStringPref(name),
                });
              } else if (t === PREF_TYPES.integer) {
                out.push({
                  name,
                  type: "integer",
                  value: Services.prefs.getIntPref(name),
                });
              } else {
                out.push({ name, type: "unknown", value: null });
              }
            } catch (e) {
              out.push({ name, type: "missing", value: null });
            }
          }
          return out;
        },

        /**
         * Read every USER-SET preference whose name starts with a prefix,
         * as [{name, type, value}]. Only names the user actually changed are
         * returned (prefHasUserValue), which is what a state-sync wants:
         * defaults come from the build, not from the link, and shipping a
         * machine's every pref would carry hardware paths and other
         * machine-specific noise. The sync module calls this with
         * "rozelynx." so the whole RozeLynx configuration travels without
         * a hand-maintained name list to fall out of date with.
         */
        async getPrefsByPrefix(prefix) {
          const out = [];
          const p = typeof prefix === "string" ? prefix : "";
          let names = [];
          try {
            names = Services.prefs.getChildList(p);
          } catch (e) {
            return out;
          }
          for (const name of names) {
            try {
              if (!Services.prefs.prefHasUserValue(name)) {
                continue;
              }
              const t = Services.prefs.getPrefType(name);
              if (t === PREF_TYPES.boolean) {
                out.push({ name, type: "boolean", value: Services.prefs.getBoolPref(name) });
              } else if (t === PREF_TYPES.string) {
                out.push({ name, type: "string", value: Services.prefs.getStringPref(name) });
              } else if (t === PREF_TYPES.integer) {
                out.push({ name, type: "integer", value: Services.prefs.getIntPref(name) });
              }
            } catch (e) {}
          }
          out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
          return out;
        },

        /**
         * Clear user values for a list of preferences.
         *
         * This exists for the indexed-pref lists (the download hand-off
         * handlers) rather than for convenience: writing an empty value is not
         * clearing one, and an editor that shrinks a list must not leave a
         * live row behind in about:config just because it has no way to say
         * "gone". Anything with a default in the prefs file falls back to that
         * default, which is what clearing a pref has always meant.
         *
         * The only guard is the same one setPrefs has: this API is reachable
         * from the RozeLynx extension's privileged contexts and nothing else.
         */
        async clearPrefs(names) {
          let cleared = 0;
          const errors = [];
          for (const name of names || []) {
            try {
              if (typeof name !== "string" || name.length === 0) {
                errors.push("(empty name)");
                continue;
              }
              if (Services.prefs.prefHasUserValue(name)) {
                Services.prefs.clearUserPref(name);
              }
              cleared++;
            } catch (e) {
              errors.push(name + ": " + (e && e.message ? e.message : String(e)));
            }
          }
          return {
            ok: errors.length === 0,
            cleared,
            error: errors.join("; "),
          };
        },
      },
    };
  }
};
