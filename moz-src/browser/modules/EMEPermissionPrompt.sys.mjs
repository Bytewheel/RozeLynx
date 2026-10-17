/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SitePermissions: "resource:///modules/SitePermissions.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "gBrowserBundle", function () {
  return Services.strings.createBundle(
    "chrome://browser/locale/browser.properties"
  );
});

const { PermissionUI } = ChromeUtils.importESModule(
  "resource:///modules/PermissionUI.sys.mjs"
);

/**
 * Creates a PermissionPrompt for a nsIContentPermissionRequest for
 * EME (Encrypted Media Extensions).
 *
 * @param request (nsIContentPermissionRequest)
 *        The request for a permission from content.
 */
export class EMEPermissionPrompt extends PermissionUI.PermissionPromptForRequest {
  constructor(request) {
    super();
    this.request = request;
  }

  get type() {
    return "media-key-system-access";
  }

  get permissionKey() {
    return "media-key-system-access";
  }

  get popupOptions() {
    let options = {
      learnMoreURL: Services.urlFormatter.formatURLPref("librewolf.eme.warning.infoURL"),
      displayURI: false,
      name: this.getPrincipalName(),
    };

    // Don't offer "always remember" action in PB mode
    options.checkbox = {
      show: !lazy.PrivateBrowsingUtils.isWindowPrivate(
        this.browser.documentGlobal
      ),
    };

    if (options.checkbox.show) {
      options.checkbox.label =
        lazy.gBrowserBundle.GetStringFromName("eme.remember2");
    }

    return options;
  }

  get notificationID() {
    return "media-key-system-access";
  }

  get anchorID() {
    return "eme-notification-icon";
  }

  get message() {
    return lazy.gBrowserBundle.formatStringFromName("eme.siteprompt2", [
      "<>",
    ]);
  }

  get promptActions() {
    return [
      {
        label: lazy.gBrowserBundle.GetStringFromName("eme.allow2"),
        accessKey: lazy.gBrowserBundle.GetStringFromName("eme.allow2.accesskey"),
        action: lazy.SitePermissions.ALLOW,
      },
      {
        label: lazy.gBrowserBundle.GetStringFromName("eme.block"),
        accessKey: lazy.gBrowserBundle.GetStringFromName("eme.block.accesskey"),
        action: lazy.SitePermissions.BLOCK,
      },
    ];
  }

  get principal() {
    // The standard/superclass method of getDelegatePrincipal (1) appears to return a null principal here
    // So we're overriding it to use topLevelPrincipal instead, as that's what GeckoView uses (2)
    // 1: https://searchfox.org/firefox-main/rev/e28b34ab/browser/modules/PermissionUI.sys.mjs#762
    // 2: https://searchfox.org/firefox-main/rev/e28b34ab/mobile/shared/components/geckoview/GeckoViewPermission.sys.mjs#124
    return this.request.topLevelPrincipal;
  }

  prompt() {
    // If the EME UI is disabled, we can't/shouldn't prompt users - so just cancel the request
    if (!Services.prefs.getBoolPref("browser.eme.ui.enabled")) {
      this.cancel();
    } else {
      super.prompt();
    }
    return;
  }
}
