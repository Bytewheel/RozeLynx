/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * AppConstants is a set of immutable constants that are defined at build time.
 * These should not depend on any other JavaScript module.
 */
export var AppConstants = Object.freeze({
  // See this wiki page for more details about channel specific build
  // defines: https://wiki.mozilla.org/Platform/Channel-specific_build_defines
  NIGHTLY_BUILD: false,

  RELEASE_OR_BETA: true,

  EARLY_BETA_OR_EARLIER: false,

  IS_ESR: false,

  ACCESSIBILITY: true,

  // Official corresponds, roughly, to whether this build is performed
  // on Mozilla's continuous integration infrastructure. You should
  // disable developer-only functionality when this flag is set.
  MOZILLA_OFFICIAL: false,

  MOZ_OFFICIAL_BRANDING: false,

  BUILT_BY_MOZILLA:
//@line 36 "$SRCDIR/toolkit/modules/AppConstants.sys.mjs"
  false,
//@line 38 "$SRCDIR/toolkit/modules/AppConstants.sys.mjs"

  MOZ_DEV_EDITION: false,

  MOZ_SERVICES_SYNC: true,

  MOZ_DATA_REPORTING: true,

  MOZ_SANDBOX: true,

  MOZ_TELEMETRY_REPORTING:
//@line 51 "$SRCDIR/toolkit/modules/AppConstants.sys.mjs"
  false,
//@line 53 "$SRCDIR/toolkit/modules/AppConstants.sys.mjs"

  MOZ_UPDATER: false,

  MOZ_WEBRTC: true,

  MOZ_WIDGET_GTK:
//@line 60 "$SRCDIR/toolkit/modules/AppConstants.sys.mjs"
  true,
//@line 64 "$SRCDIR/toolkit/modules/AppConstants.sys.mjs"

  MOZ_WMF_CDM: false,

  XP_UNIX:
//@line 69 "$SRCDIR/toolkit/modules/AppConstants.sys.mjs"
  true,
//@line 73 "$SRCDIR/toolkit/modules/AppConstants.sys.mjs"

// NOTE! XP_LINUX has to go after MOZ_WIDGET_ANDROID otherwise Android
// builds will be misidentified as linux.
  platform:
//@line 78 "$SRCDIR/toolkit/modules/AppConstants.sys.mjs"
  "linux",
//@line 92 "$SRCDIR/toolkit/modules/AppConstants.sys.mjs"

// Most of our frontend code assumes that any desktop Unix platform
// is "linux". Add the distinction for code that needs it.
  unixstyle:
//@line 97 "$SRCDIR/toolkit/modules/AppConstants.sys.mjs"
    "linux",
//@line 109 "$SRCDIR/toolkit/modules/AppConstants.sys.mjs"

  isPlatformAndVersionAtLeast(platform, version) {
    let platformVersion = Services.sysinfo.getProperty("version");
    return platform == this.platform &&
           Services.vc.compare(platformVersion, version) >= 0;
  },

  isPlatformAndVersionAtMost(platform, version) {
    let platformVersion = Services.sysinfo.getProperty("version");
    return platform == this.platform &&
           Services.vc.compare(platformVersion, version) <= 0;
  },

  MOZ_CRASHREPORTER: false,

  MOZ_NORMANDY: true,

  MOZ_MAINTENANCE_SERVICE: false,

  MOZ_BACKGROUNDTASKS: true,

  MOZ_UPDATE_AGENT: false,

  MOZ_BITS_DOWNLOAD: false,

  DEBUG: false,

  ASAN: false,

  ASAN_REPORTER: false,

  TSAN: false,

  MOZ_SYSTEM_NSS: true,

  MOZ_PLACES: true,

  MOZ_REQUIRE_SIGNING: false,

  MOZ_UNSIGNED_APP_SCOPE: true,

  MOZ_UNSIGNED_SYSTEM_SCOPE: true,

  MOZ_ALLOW_ADDON_SIDELOAD: true,

  MOZ_WEBEXT_WEBIDL_ENABLED: false,

  MOZ_GECKOVIEW_HISTORY: false,

  DLL_PREFIX: "lib",
  DLL_SUFFIX: ".so",

  MOZ_APP_NAME: "rozelynx",
  MOZ_APP_BASENAME: "rozelynx",
  // N.b.: you almost certainly want brandShortName/brand-short-name:
  // MOZ_APP_DISPLAYNAME should only be used for static user-visible
  // fields (e.g., DLL properties, Mac Bundle name, or similar).
  MOZ_APP_DISPLAYNAME_DO_NOT_USE: "RozeLynx",
  MOZ_APP_VERSION: "158.0",
  MOZ_APP_VERSION_DISPLAY: "158.0",
  MOZ_BACKGROUNDTASK_ACTIVATABLE_CLASS_ID:
    "",
  MOZ_BUILDID: "20261015174423",
  MOZ_BUILD_APP: "browser",
  MOZ_MACBUNDLE_ID: "",
  MOZ_MACBUNDLE_NAME: "",
  MOZ_UPDATE_CHANNEL: "rozelynx",
  MOZ_WIDGET_TOOLKIT: "gtk",

  DEBUG_JS_MODULES: "",

  MOZ_BING_API_CLIENTID: "no-bing-api-clientid",
  MOZ_BING_API_KEY: "no-bing-api-key",
//@line 183 "$SRCDIR/toolkit/modules/AppConstants.sys.mjs"
  MOZ_GOOGLE_LOCATION_SERVICE_API_KEY: "no-google-location-service-api-key",
//@line 185 "$SRCDIR/toolkit/modules/AppConstants.sys.mjs"
  MOZ_GOOGLE_SAFEBROWSING_API_KEY: "no-google-safebrowsing-api-key",
  MOZ_MOZILLA_API_KEY: "no-mozilla-api-key",

  BROWSER_CHROME_URL: "chrome://browser/content/browser.xhtml",

  OMNIJAR_NAME: "omni.ja",

  // URL to the hg revision this was built from (e.g.
  // "https://hg.mozilla.org/mozilla-central/rev/6256ec9113c1")
  // On unofficial builds, this is an empty string.
//@line 198 "$SRCDIR/toolkit/modules/AppConstants.sys.mjs"
  SOURCE_REVISION_URL: "",

  HAVE_USR_LIB64_DIR:
//@line 204 "$SRCDIR/toolkit/modules/AppConstants.sys.mjs"
    false,
//@line 206 "$SRCDIR/toolkit/modules/AppConstants.sys.mjs"

  HAVE_SHELL_SERVICE: true,

  MOZ_CODE_COVERAGE: false,

  TELEMETRY_PING_FORMAT_VERSION: 4,

  ENABLE_WEBDRIVER: true,

  REMOTE_SETTINGS_SERVER_URLS:
//@line 219 "$SRCDIR/toolkit/modules/AppConstants.sys.mjs"
    [ "https://firefox.settings.services.mozilla.com/v2" ],
//@line 221 "$SRCDIR/toolkit/modules/AppConstants.sys.mjs"

  REMOTE_SETTINGS_VERIFY_SIGNATURE:
//@line 226 "$SRCDIR/toolkit/modules/AppConstants.sys.mjs"
    true,
//@line 228 "$SRCDIR/toolkit/modules/AppConstants.sys.mjs"

  REMOTE_SETTINGS_DEFAULT_BUCKET:
//@line 233 "$SRCDIR/toolkit/modules/AppConstants.sys.mjs"
    "main",
//@line 235 "$SRCDIR/toolkit/modules/AppConstants.sys.mjs"

  MOZ_GLEAN_ANDROID: false,

  MOZ_JXL: true,

//@line 256 "$SRCDIR/toolkit/modules/AppConstants.sys.mjs"

  MOZ_SYSTEM_POLICIES: true,

  MOZ_SELECTABLE_PROFILES: true,

  SQLITE_LIBRARY_FILENAME:
//@line 265 "$SRCDIR/toolkit/modules/AppConstants.sys.mjs"
  "libmozsqlite3.so",
//@line 267 "$SRCDIR/toolkit/modules/AppConstants.sys.mjs"

  MOZ_GECKOVIEW:
//@line 272 "$SRCDIR/toolkit/modules/AppConstants.sys.mjs"
    false,
//@line 274 "$SRCDIR/toolkit/modules/AppConstants.sys.mjs"

//@line 278 "$SRCDIR/toolkit/modules/AppConstants.sys.mjs"

  USE_LIBZ_RS: false,
});
