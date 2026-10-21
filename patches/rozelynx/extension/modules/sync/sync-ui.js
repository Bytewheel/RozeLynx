/* RozeLynx: sync UI - the panel the header button opens.
 *
 * Rendered into #sync-panel by popup.js (which loads this script on the
 * first click, after the background answered 'sync:present'). The panel is
 * deliberately small:
 *   - a history-depth choice (500 / 5000 / all), picked PER SYNC, because
 *     the one honest limit of a link that carries everything is its length;
 *   - "Create sync link", which runs gather -> gzip -> encrypt -> link and
 *     shows the result with a copy button;
 *   - the size warning, when the link is too big for some transports;
 *   - a paste box that restores a received link in THIS browser (the same
 *     restore path the rozelynxsync:// scheme handler drives), which is the
 *     answer for links too long to click through another app.
 */
(function() {
  'use strict';

  var panel = document.getElementById('sync-panel');
  if (!panel) {
    return;
  }
  panel.dataset.loaded = '1';

  var LOG_PREFIX = '[RozeLynx:sync-ui]';

  function log(msg) {
    try { console.log(LOG_PREFIX, msg); } catch (e) {}
  }

  panel.textContent = '';

  var title = document.createElement('h4');
  title.textContent = 'Sync this browser';
  panel.appendChild(title);

  var intro = document.createElement('div');
  intro.className = 'sync-size';
  intro.textContent = 'Gathers tabs, history, cookies, extensions and ' +
    'configuration, then produces an encrypted magic link that recreates ' +
    'this state in another RozeLynx. The link is self-contained - it holds ' +
    'the data and the key - so send it to yourself by any private channel.';
  panel.appendChild(intro);

  // ── history depth, chosen per sync ─────────────────────────────────

  var depths = [
    ['500', 'Recent 500 history entries'],
    ['5000', 'Recent 5000 history entries'],
    ['all', 'Everything (largest link)'],
  ];
  var depthBox = document.createElement('div');
  depths.forEach(function(d, i) {
    var label = document.createElement('label');
    label.className = 'sync-depth';
    var radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'rozelynx-sync-depth';
    radio.value = d[0];
    radio.checked = i === 1;  // 5000 is the default: bounded but generous
    label.appendChild(radio);
    var span = document.createElement('span');
    span.textContent = d[1];
    label.appendChild(span);
    depthBox.appendChild(label);
  });
  panel.appendChild(depthBox);

  // ── create ──────────────────────────────────────────────────────────

  var createBtn = document.createElement('button');
  createBtn.type = 'button';
  createBtn.id = 'sync-create';
  createBtn.textContent = 'Create sync link';
  panel.appendChild(createBtn);

  var progress = document.createElement('div');
  progress.id = 'sync-progress';
  progress.hidden = true;
  panel.appendChild(progress);

  var result = document.createElement('div');
  result.id = 'sync-result';
  result.hidden = true;
  var linkBox = document.createElement('textarea');
  linkBox.id = 'sync-link';
  linkBox.readOnly = true;
  linkBox.spellcheck = false;
  result.appendChild(linkBox);
  var warning = document.createElement('div');
  warning.id = 'sync-warning';
  result.appendChild(warning);
  var copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.id = 'sync-copy';
  copyBtn.textContent = 'Copy magic link';
  result.appendChild(copyBtn);
  panel.appendChild(result);

  var errBox = document.createElement('div');
  errBox.id = 'sync-warning';
  panel.appendChild(errBox);

  function setProgress(msg) {
    progress.hidden = !msg;
    progress.textContent = msg || '';
  }

  createBtn.addEventListener('click', function() {
    var depth = (panel.querySelector(
      'input[name="rozelynx-sync-depth"]:checked') || {}).value || '5000';
    createBtn.disabled = true;
    linkBox.value = '';
    warning.textContent = '';
    errBox.textContent = '';
    result.hidden = true;
    setProgress('Gathering and encrypting\u2026');
    browser.runtime.sendMessage({
      action: 'sync:create',
      historyDepth: depth,
    }).then(function(resp) {
      setProgress('');
      createBtn.disabled = false;
      resp = resp || {};
      if (!resp.ok) {
        errBox.textContent = 'Could not create the link: ' +
          (resp.error || 'unknown error');
        return;
      }
      result.hidden = false;
      linkBox.value = resp.url;
      warning.textContent = resp.warning || '';
    }).catch(function(e) {
      setProgress('');
      createBtn.disabled = false;
      errBox.textContent = 'Could not create the link: ' +
        ((e && e.message) || e);
    });
  });

  copyBtn.addEventListener('click', function() {
    navigator.clipboard.writeText(linkBox.value).then(function() {
      copyBtn.textContent = 'Copied!';
      setTimeout(function() {
        copyBtn.textContent = 'Copy magic link';
      }, 1500);
    }).catch(function() {
      // Popup clipboard can be denied; the textarea is selectable so the
      // manual path is one Ctrl-A Ctrl-C away.
      linkBox.focus();
      linkBox.select();
      copyBtn.textContent = 'Select and copy manually';
      setTimeout(function() {
        copyBtn.textContent = 'Copy magic link';
      }, 2500);
    });
  });

  // ── restore from a pasted link ─────────────────────────────────────
  // The same restore the scheme handler drives, for the links that cannot
  // survive being clicked through another app (a single command-line
  // argument is capped at 128 KiB by the kernel) and for pasted-in links
  // generally.

  var restoreHeading = document.createElement('h4');
  restoreHeading.textContent = 'Restore a received link';
  restoreHeading.style.marginTop = '10px';
  panel.appendChild(restoreHeading);

  var restoreBox = document.createElement('textarea');
  restoreBox.id = 'sync-restore';
  restoreBox.rows = 2;
  restoreBox.placeholder = 'Paste a rozelynxsync:// link here\u2026';
  restoreBox.spellcheck = false;
  restoreBox.style.cssText = linkBox.style.cssText;
  panel.appendChild(restoreBox);

  var restoreBtn = document.createElement('button');
  restoreBtn.type = 'button';
  restoreBtn.id = 'sync-restore-btn';
  restoreBtn.textContent = 'Restore';
  restoreBtn.style.width = '100%';
  panel.appendChild(restoreBtn);

  restoreBtn.addEventListener('click', function() {
    var url = restoreBox.value.trim();
    if (!url) {
      errBox.textContent = 'Paste a rozelynxsync:// link first.';
      return;
    }
    restoreBtn.disabled = true;
    setProgress('Decrypting and restoring\u2026');
    browser.runtime.sendMessage({
      action: 'sync:parse',
      url: url,
    }).then(function(resp) {
      setProgress('');
      restoreBtn.disabled = false;
      if (!resp || resp.ok !== true) {
        errBox.textContent = 'Restore failed: ' +
          ((resp && resp.error) || 'unknown error');
        return;
      }
      errBox.textContent = '';
      restoreBox.value = '';
      panel.hidden = true;
    }).catch(function(e) {
      setProgress('');
      restoreBtn.disabled = false;
      errBox.textContent = 'Restore failed: ' + ((e && e.message) || e);
    });
  });

  log('panel ready');
})();
