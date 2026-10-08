// Link-click interception for the downloads-handoff module.
//
// Registered at document_start in every frame, as a CAPTURE-phase click
// listener, so it runs before the page's own handlers and - the reason it is
// here at all - before the browser's default action. Preventing that default
// is what keeps the download machinery from ever starting: no channel, no
// download object, no "what should RozeLynx do with this file?" dialog, no
// file picker. background.js documents why no other extension hook can do
// that for a download.
//
// This file decides nothing. It recognises a *candidate* file link, prevents
// the default, and asks the background; a candidate the background declines
// (interception off, not a file, already handled, hand-off failed) is
// re-triggered with location.assign(), which is a navigation rather than a
// click and so cannot loop back through here. That keeps every policy - the
// enable pref, the exclude list, the hand-off - in one place.
//
// The one thing it does need locally is the list of extensions that count as
// a download, because candidate detection has to happen synchronously. The
// background sends the authoritative list back with the first reply and it is
// cached for the rest of the document; until then the built-in copy below is
// used, which is the same list the background defaults to.
//
// Not covered, by design: middle-click, ctrl/cmd/shift+click and "Save link
// as" (a modified click means something different, so the browser keeps it),
// and anything a page starts without a click. The background's
// downloads.onCreated hook is the catch-all for those.

(function() {
  'use strict';

  var ACTION = 'downloads-handoff:intercept';
  // Compound extensions are tried longest first: a.tar.gz matches "tar.gz"
  // before "gz".
  var MAX_EXT_PARTS = 2;
  // Same list, same order, as DEFAULT_LINK_EXTENSIONS in background.js.
  var FALLBACK_EXTENSIONS = new Set((
    'zip tar gz bz2 xz lz lzma zst 7z rar tgz txz tbz2 cab jar ' +
    'deb rpm apk appimage snap msix msi exe dll so bin run pkg dmg ' +
    'iso img vhd vmdk wim ' +
    'doc docx xls xlsx ppt pptx odt ods odp rtf epub mobi azw3 cbz cbr ' +
    'srt sub ass ssa ' +
    'ttf otf woff woff2 eot ' +
    'torrent crx xpi apkg sqlite'
  ).split(' '));

  var extensions = FALLBACK_EXTENSIONS;

  function anchorFor(node) {
    while (node && node.nodeType === 1) {
      if (String(node.tagName || '').toLowerCase() === 'a') return node;
      node = node.parentNode;
    }
    return null;
  }

  function hasDownloadExtension(href) {
    var path;
    try {
      path = new URL(href, location.href).pathname;
    } catch (e) {
      return false;
    }
    var leaf = path.split('/').pop();
    if (!leaf || leaf.indexOf('.') < 0) return false;
    var parts = leaf.toLowerCase().split('.');
    // parts[0] is the stem; try the last 1..MAX_EXT_PARTS dot-joined groups.
    for (var n = 1; n <= MAX_EXT_PARTS && n < parts.length; n++) {
      if (extensions.has(parts.slice(parts.length - n).join('.'))) return true;
    }
    return false;
  }

  // A navigation the click would have performed, minus the click. Anything
  // with a target other than _self goes to a new context, as it would have.
  function passThrough(anchor) {
    var target = (anchor.getAttribute('target') || '').toLowerCase();
    if (target && target !== '_self' && typeof window.open === 'function') {
      try {
        window.open(anchor.href, anchor.getAttribute('target'));
        return;
      } catch (e) {
        // Fall through to a same-tab navigation.
      }
    }
    location.assign(anchor.href);
  }

  function onClick(ev) {
    // A modified click means something else (new tab, new window, download
    // into a different place), and the page may already have handled it.
    if (ev.defaultPrevented || ev.button !== 0 ||
        ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) {
      return;
    }
    var anchor = anchorFor(ev.target);
    if (!anchor) return;
    var href = anchor.href;
    if (!href || href === '#') return;
    var downloadAttr = anchor.getAttribute('download');
    // A `download` attribute is an explicit statement by the page that this
    // is a file to fetch, whatever the extension is.
    if (downloadAttr === null && !hasDownloadExtension(href)) return;

    ev.preventDefault();
    ev.stopPropagation();

    var payload = {
      url: href,
      // The download attribute is a suggested name and may be empty.
      filename: downloadAttr || '',
      referrer: document.URL,
      pageUrl: location.href,
    };
    var settled = false;
    function finish(reply) {
      if (settled) return;
      settled = true;
      // The authoritative extension list rides back with the first reply,
      // whether or not this particular candidate was taken.
      if (reply && reply.config && Array.isArray(reply.config.linkExtensions)) {
        extensions = new Set(reply.config.linkExtensions.map(function(s) {
          return String(s).toLowerCase();
        }));
      }
      if (reply && reply.ok) return;
      passThrough(anchor);
    }
    try {
      browser.runtime.sendMessage({ action: ACTION, data: payload })
        .then(finish, function() { finish(null); });
    } catch (e) {
      finish(null);
    }
  }

  document.addEventListener('click', onClick, true);
})();
