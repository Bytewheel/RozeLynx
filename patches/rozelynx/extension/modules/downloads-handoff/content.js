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

  // True while a released anchor's own re-dispatched click is in flight.
  // HTMLElement.click() fires the event synchronously, so a plain flag is
  // enough to keep the re-dispatched click from being intercepted again -
  // and only for the duration of that one event, so the user's next real
  // click on the same anchor is a candidate like any other.
  var releasing = false;

  // The default action we prevented on a download-attribute candidate was a
  // DOWNLOAD, not a navigation - that attribute is the page's own statement
  // that the link is a file to fetch, and it is why onClick treated the click
  // as a candidate at all. A navigation is not that action: for an image it
  // replaces "save" with "display", and for anything the browser can render
  // it turns the download the page asked for into a tab navigation. The old
  // passThrough did exactly that, so a declined <a download> - a page's own
  // "Download PNG" button, or the synthetic menu's Save-As before it moved to
  // the background - navigated instead of saved.
  //
  // The restore is a second click on the same anchor with the hook stood
  // down: the browser then performs its own default action, which is the
  // download the attribute describes - picker included when the user asked
  // for one, suggested filename and all.
  function releaseDownload(anchor, downloadAttr) {
    releasing = true;
    try {
      // A detached anchor cannot be re-clicked: the event would fire on it,
      // but no default action follows, so nothing would download. The page
      // may well have removed it while the answer was in flight - a click
      // handler of its own, a route change - so this is checked rather than
      // assumed.
      if (anchor.isConnected) {
        anchor.click();
        releasing = false;
        return;
      }
    } catch (e) {
      // An anchor that cannot be re-clicked at all is the same situation as
      // a detached one: the background starts the download instead.
    }
    releasing = false;
    // The background can start the same download itself, so ask it to
    // rather than eat the click: downloads.download is scheme-checked and
    // gate-checked there exactly as here, and every reason Layer A declined
    // (no handler, excluded, bypassed, deferred, non-http) is a decline
    // Layer B makes too, so the restore cannot loop back.
    browser.runtime.sendMessage({
      action: 'downloads-handoff:browser-download',
      data: { url: anchor.href, filename: downloadAttr || '' },
    }).catch(function() {});
  }

  // A navigation the click would have performed, minus the click. Anything
  // with a target other than _self goes to a new context, as it would have.
  // Only for candidates that carried NO download attribute: those clicks
  // would have navigated, so a navigation is a faithful restore.
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
    // A release's own re-dispatched click: not a candidate, and not to be
    // prevented - the browser's default action is the whole point.
    if (releasing) return;
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
      // The restore has to match the action it is restoring: a download
      // for a download-attribute candidate, a navigation for a plain link.
      if (downloadAttr !== null) {
        releaseDownload(anchor, downloadAttr);
        return;
      }
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
