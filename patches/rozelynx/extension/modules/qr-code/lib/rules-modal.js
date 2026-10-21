/* RozeLynx: the all-rules modal plumbing, shared by the popup's rule
 * sections (netiface, user agent).
 *
 * The modal markup lives in modules/qr-code/popup.html; this script owns
 * the open/close behaviour and lets each rule UI register a renderer that
 * fills its block when the modal opens. The rule LIST belongs in the modal
 * and in the options page, never in the popup body itself - the body shows
 * only the current-page status, the "Add a rule for this site" button and
 * the add row (pattern input, value dropdown, Add button).
 *
 * The options page (options/options.js) does not use this file: it renders
 * the same editors inline in the settings, because a settings page has room
 * for the whole list and no need for an overlay.
 */
(function() {
  'use strict';

  var overlay = document.getElementById('rules-modal');
  if (!overlay) {
    return;
  }

  var closeBtn = document.getElementById('rules-modal-close');
  var renderers = [];

  function isOpen() {
    return !overlay.hidden;
  }

  function open() {
    overlay.hidden = false;
    // Every registered renderer refills its block from storage, so the
    // modal always shows what is actually stored rather than what the
    // popup last saw.
    renderers.forEach(function(fn) {
      try { fn(); } catch (e) {}
    });
  }

  function close() {
    overlay.hidden = true;
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', close);
  }
  // Clicking the backdrop (not the card) closes the modal.
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) close();
  });
  // Escape closes the modal - a popup is one window, so there is no
  // dialog chrome to grab Esc first.
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && isOpen()) close();
  });

  globalThis.RozeLynxRulesModal = {
    open: open,
    close: close,
    isOpen: isOpen,
    // onOpen(fn): register a renderer invoked (synchronously) every time
    // the modal opens.
    onOpen: function(fn) {
      if (typeof fn === 'function') renderers.push(fn);
    },
  };
})();
