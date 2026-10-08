/* RozeLynx experiment API: per-site security toggles.
 *
 * setCanvasData / getCanvasData grant, revoke and read the "canvas" site
 * permission for an origin. Firefox's fingerprinting protection spoofs
 * HTML5 canvas extraction (toDataURL / toBlob / getImageData return
 * randomized noise) unless that permission is ALLOWed for the origin -
 * the same per-site permission the canvas permission prompt (the
 * canvas-permissions-prompt pref family) writes when the user answers
 * "Allow". This namespace is only a direct, deliberate switch for it.
 *
 * The granularity is per-origin, not per-window: a PWA IS a fixed origin,
 * so "canvas data for this app" and "canvas data for this origin" are the
 * same statement. Granting it does not weaken any other origin, and a
 * content page can never reach this namespace (scopes: addon_parent).
 *
 * Every entry point answers {ok:false, error} rather than throwing, the
 * same contract the rozelynxWindows entry points keep, so callers can
 * degrade without try/catch noise.
 */

"use strict";

var rozelynxSecurity = class extends ExtensionAPI {
  getAPI(context) {
    // The site permission the RFP canvas spoof consults. Not a pref, and
    // not RozeLynx-defined: it is the permission type the site
    // permissions UI shows as the canvas icon (data-permission-id
    // "canvas") and the extraction prompt grants.
    const CANVAS_PERMISSION = "canvas";

    // The grant is per-origin (scheme + host + port), so the principal
    // carries exactly what the caller named and nothing broader.
    // testExactPermissionFromPrincipal below is equally deliberate:
    // testPermissionFromPrincipal would also inherit a grant made for a
    // parent domain, which would let one app's toggle silently speak for
    // sibling subdomains.
    function principalFor(origin) {
      const uri = Services.io.newURI(origin);
      return Services.scriptSecurityManager.createContentPrincipal(uri, {});
    }

    return {
      rozelynxSecurity: {
        async setCanvasData(origin, enable) {
          try {
            const principal = principalFor(origin);
            if (enable) {
              Services.perms.addFromPrincipal(
                principal, CANVAS_PERMISSION, Services.perms.ALLOW_ACTION);
            } else {
              Services.perms.removeFromPrincipal(principal, CANVAS_PERMISSION);
            }
            return { ok: true, enabled: !!enable };
          } catch (e) {
            return { ok: false, error: String(e) };
          }
        },

        async getCanvasData(origin) {
          try {
            const principal = principalFor(origin);
            const action = Services.perms.testExactPermissionFromPrincipal(
              principal, CANVAS_PERMISSION);
            return {
              ok: true,
              enabled: action === Services.perms.ALLOW_ACTION,
              action: action,
            };
          } catch (e) {
            return { ok: false, error: String(e) };
          }
        },
      },
    };
  }
};
