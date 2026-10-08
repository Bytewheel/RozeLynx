// RozeLynx Default Preferences
// Installed system-wide to /usr/lib/rozelynx/browser/defaults/preferences/

// Enable RozeLynx features extension (unsigned)
pref("extensions.autoDisableScopes", 0);
pref("extensions.enabledScopes", 15);
pref("xpinstall.signatures.required", false);
pref("extensions.langpacks.signatures.required", false);
pref("extensions.installDistroAddons", true);
pref("extensions.startupCache.enabled", false);

// Hide the "could not be verified" warning bars for unsigned add-ons.
// Honoured because this is an unofficial (MOZILLA_OFFICIAL=0) build.
pref("extensions.ui.disableUnsignedWarnings", true);

// Enable userChrome.css / userContent.css for browser chrome theming
pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);

// RozeLynx branding
pref("app.update.channel", "rozelynx");
pref("app.vendorURL", "https://bytewheel.org");
pref("app.releaseNotesURL", "https://bytewheel.org/rozelynx/releasenotes");
pref("app.support.baseURL", "https://bytewheel.org/rozelynx/support");

// Profile settings
pref("app.update.auto", false);
pref("app.update.enabled", false);
pref("browser.shell.checkDefaultBrowser", false);

// Enable PWA base features
pref("browser.ssb.enabled", true);
pref("browser.ssb.supported", true);

// Enable keyboard shortcuts
pref("browser.shortcuts.loglevel", "Warn");

// RozeLynx experiments
pref("rozelynx.experiments.enabled", true);
pref("rozelynx.experiments.bucket", 0);

// Chromium Web Store support
pref("rozelynx.cws.enabled", true);
pref("rozelynx.cws.autoConvert", true);

// External browser
pref("rozelynx.external-browser.enabled", true);
pref("network.protocol-handler.external.rozelynx-ext", true);
pref("network.protocol-handler.expose.rozelynx-ext", true);
pref("network.protocol-handler.warn-external.rozelynx-ext", true);

// Mouse gestures
pref("rozelynx.mouse-gestures.enabled", true);
pref("rozelynx.mouse-gestures.trailColor", "#8B5CF6");
pref("rozelynx.mouse-gestures.trailWidth", 3);

// QR Code
pref("rozelynx.qr-code.enabled", true);

// PWA
pref("rozelynx.pwa.enabled", true);
pref("rozelynx.pwa.generateDesktopEntries", true);

// Lepton skin (disabled by default - enable via extension or about:config)
pref("rozelynx.lepton-skin.enabled", false);

// IP Protection
pref("rozelynx.ip-protection.enabled", false);

// Netiface (network interface assignment; needs www-client/firefox USE=net-iface)
// Layered: tab (runtime map, extension) > URL rule > container > profile >
// default routing.
pref("rozelynx.netiface.enabled", true);
pref("rozelynx.netiface.profile", ""); // per-profile default iface ("" = normal routing table)
// Container assignments use dynamic pref names (set at runtime via the
// extension / about:config): rozelynx.netiface.container.<userContextId>
// Per-interface DoH override (split-DNS networks): empty -> global network.trr.uri
//   rozelynx.netiface.trr.uri.<ifname>
// Per-URL rules, edited from the extension popup's collapsible section (the
// popup writes exactly these prefs, so about:config stays the source of truth):
//   pref("rozelynx.netiface.urlrules.enabled", true)   master switch
//   pref("rozelynx.netiface.urlrule.<n>.pattern", "*.example.com")
//   pref("rozelynx.netiface.urlrule.<n>.iface", "wlan0")  "" = force default routing
//   pref("rozelynx.netiface.urlrule.<n>.enabled", true)   optional, default true
// Pattern: "*.example.com" (host + subdomains), "example.com" (that host),
// "*://example.com/mail" (any scheme, path prefix), "*" / "?" globs inside the
// host.  Overlapping rules resolve most-specific first; see
// cpp/net-iface/RozeLynxNetIface.h (RozeLynxNetIfaceUrlRule).
// Note: stock network.trr.* prefs (librewolf.cfg / about:config / the
// DNSOverHTTPS policy) stay the single source of truth for resolver config;
// per-channel TRR enforcement for assigned loads lives in the necko patch.

// The URL-rule layer's master switch. Default on: it is inert until a rule
// exists, so "on when rules exist" needs no extra migration.
pref("rozelynx.netiface.urlrules.enabled", true);

// v13: attribute extension DNS lookups (browser.dns.resolve, e.g. uBlock
// Origin's dnsResolveEnabled) to the interface a channel most recently used
// for the same host, so those lookups ride the interface's DoH path instead
// of egressing the default route.
pref("rozelynx.netiface.dnsAttribution", true);

// Re-resolve negative (failed) A/AAAA cache entries asynchronously on every
// use instead of serving the cached failure.  Stock default is false, which
// is what let one failed bound DoH lookup wedge a hostname for the whole
// negative TTL: interface-assigned records fail closed (no native fallback,
// by design), so nothing else could ever refresh the entry and the page sat
// dead until the user rebound the interface (whose only real effect was the
// DNS flush).  The necko patch also retries transport-failed TRR lookups on
// a fresh connection; this makes any remaining negative entry self-healing.
pref("network.dns.refresh_negative_addr_on_use", true);

// Download hand-off (needs www-client/firefox USE=download-handoff)
// Hands a download off to a download manager instead of letting the browser
// download it, so the manager owns the queue, the GUI and the resume data and
// the browser's save UI never appears. NOTHING HERE IS SPECIFIC TO ONE
// MANAGER: the handler list below is either `uget` (a builtin - it speaks
// uget-integrator's own stdio protocol, which is a real integration and not
// "run a program"), `ext:<extension-id>` (any extension that answers a
// cross-extension download message) or `cmd:<program>` (any program on PATH).
//
//   pref("rozelynx.downloads.handoff.enabled", "auto")
//     "auto" = on when at least one enabled handler is available (the
//     default), "true" = always, "false" = never. A string, not a boolean,
//     because the default has to be a third state.
//   pref("rozelynx.downloads.handoff.min_size", 307200)
//     Anything smaller stays with the browser.
//   pref("rozelynx.downloads.handoff.exclude", "")
//     Space/comma separated URL substrings that are never intercepted.
//   pref("rozelynx.downloads.handoff.link_intercept", true)
//     Whether a click on a file link is intercepted before the browser starts
//     the download at all (the only way to stop the save UI appearing).
//   pref("rozelynx.downloads.handoff.link_extensions", "<defaults>")
//     The file extensions the link hook treats as downloads. A `download`
//     attribute counts whatever it says, independently of this list.
//
// The handler list, edited from the extension popup's collapsible section or
// here. THE ORDER IS THE PRIORITY: the first handler that accepts a download
// gets it, and the rest are not tried. n is 0..15, and deleting the last row
// CLEARS its prefs rather than blanking them, so nothing is left live in
// about:config that the editor no longer shows.
//   pref("rozelynx.downloads.handler.<n>.id", "uget")
//   pref("rozelynx.downloads.handler.<n>.args", "{url}")
//     Only a cmd: handler uses args. {url} {filename} {referer} {ua}
//     {cookies} are substituted per-token, so a url is always one argument
//     however much whitespace or punctuation it carries. {cookies} expands to
//     the path of a 0600 file the native host writes in the session runtime
//     directory, because a manager that wants cookies wants to open a file.
//   pref("rozelynx.downloads.handler.<n>.enabled", true)
//
// Handler 0 is the uget builtin so a fresh profile keeps the behaviour this
// feature shipped with; the list is meant to be edited from there.
pref("rozelynx.downloads.handoff.enabled", "auto");
pref("rozelynx.downloads.handoff.min_size", 307200);
pref("rozelynx.downloads.handoff.exclude", "");
pref("rozelynx.downloads.handoff.link_intercept", true);
//   pref("rozelynx.downloads.handoff.defer_to", "uget-integration@slgobinath")
pref("rozelynx.downloads.handoff.defer_to", "");
pref("rozelynx.downloads.handler.0.id", "uget");
pref("rozelynx.downloads.handler.0.args", "");
pref("rozelynx.downloads.handler.0.enabled", true);

// User agent
pref("general.useragent.override", "");
pref("general.useragent.compatMode.firefox", true);

// Privacy defaults from RozeLynx
pref("privacy.donottrackheader.enabled", true);
pref("privacy.globalprivacycontrol.enabled", true);
pref("privacy.globalprivacycontrol.functionality.enabled", true);
pref("network.cookie.cookieBehavior", 4); // Only accept from visited sites
pref("network.cookie.lifetimePolicy", 2); // Session only

// Extension management
pref("extensions.getAddons.showPane", false);
pref("extensions.htmlaboutaddons.recommendations.enabled", false);
pref("extensions.getAddons.cache.enabled", false);

// Disable built-in addon recommendations
pref("browser.discovery.enabled", false);
pref("browser.newtabpage.activity-stream.asrouter.userprefs.cfr.addons", false);
pref("browser.newtabpage.activity-stream.asrouter.userprefs.cfr.features", false);

// Set RozeLynx as the app distributor
pref("distribution.id", "rozelynx-bytewheel");
pref("distribution.version", "1.0.0");
pref("distribution.about", "RozeLynx by ByteWheel");
