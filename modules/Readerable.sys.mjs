/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

//@line 1 "$SRCDIR/toolkit/components/reader/readability/Readability-readerable.js"
/*
 * Copyright (c) 2010 Arc90 Inc
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*
 * This code is heavily based on Arc90's readability.js (1.7.1) script
 * available at: http://code.google.com/p/arc90labs-readability
 */

var REGEXPS = {
  // NOTE: These two regular expressions are duplicated in
  // Readability.js. Please keep both copies in sync.
  unlikelyCandidates:
    /-ad-|ai2html|banner|breadcrumbs|combx|comment|community|cover-wrap|disqus|extra|footer|gdpr|header|legends|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|pagination|pager|popup|yom-remote/i,
  okMaybeItsACandidate: /and|article|body|column|content|main|shadow/i,
};

function isNodeVisible(node) {
  // Have to null-check node.style and node.className.includes to deal with SVG and MathML nodes.
  return (
    (!node.style || node.style.display != "none") &&
    !node.hasAttribute("hidden") &&
    //check for "fallback-image" so that wikimedia math images are displayed
    (!node.hasAttribute("aria-hidden") ||
      node.getAttribute("aria-hidden") != "true" ||
      (node.className &&
        node.className.includes &&
        node.className.includes("fallback-image")))
  );
}

/**
 * Decides whether or not the document is reader-able without parsing the whole thing.
 * @param {Object} options Configuration object.
 * @param {number} [options.minContentLength=140] The minimum node content length used to decide if the document is readerable.
 * @param {number} [options.minScore=20] The minumum cumulated 'score' used to determine if the document is readerable.
 * @param {Function} [options.visibilityChecker=isNodeVisible] The function used to determine if a node is visible.
 * @return {boolean} Whether or not we suspect Readability.parse() will suceeed at returning an article object.
 */
function isProbablyReaderable(doc, options = {}) {
  // For backward compatibility reasons 'options' can either be a configuration object or the function used
  // to determine if a node is visible.
  if (typeof options == "function") {
    options = { visibilityChecker: options };
  }

  var defaultOptions = {
    minScore: 20,
    minContentLength: 140,
    visibilityChecker: isNodeVisible,
  };
  options = Object.assign(defaultOptions, options);

  var nodes = doc.querySelectorAll("p, pre, article");

  // Get <div> nodes which have <br> node(s) and append them into the `nodes` variable.
  // Some articles' DOM structures might look like
  // <div>
  //   Sentences<br>
  //   <br>
  //   Sentences<br>
  // </div>
  var brNodes = doc.querySelectorAll("div > br");
  if (brNodes.length) {
    var set = new Set(nodes);
    [].forEach.call(brNodes, function (node) {
      set.add(node.parentNode);
    });
    nodes = Array.from(set);
  }

  var score = 0;
  // This is a little cheeky, we use the accumulator 'score' to decide what to return from
  // this callback:
  return [].some.call(nodes, function (node) {
    if (!options.visibilityChecker(node)) {
      return false;
    }

    var matchString = node.className + " " + node.id;
    if (
      REGEXPS.unlikelyCandidates.test(matchString) &&
      !REGEXPS.okMaybeItsACandidate.test(matchString)
    ) {
      return false;
    }

    if (node.matches("li p")) {
      return false;
    }

    var textContentLength = node.textContent.trim().length;
    if (textContentLength < options.minContentLength) {
      return false;
    }

    score += Math.sqrt(textContentLength - options.minContentLength);

    if (score > options.minScore) {
      return true;
    }
    return false;
  });
}

if (typeof module === "object") {
  /* eslint-disable-next-line no-redeclare */
  /* global module */
  module.exports = isProbablyReaderable;
}
//@line 1 "$SRCDIR/toolkit/components/reader/Readerable.js"
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

// This file and Readability-readerable.js are merged together into
// Readerable.sys.mjs.

/* exported Readerable */
/* import-globals-from readability/Readability-readerable.js */

const { XPCOMUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/XPCOMUtils.sys.mjs"
);

var Readerable = {
  get isEnabledForParseOnLoad() {
    return this.isEnabled;
  },

  /**
   * Decides whether or not a document is reader-able without parsing the whole thing.
   *
   * @param doc A document to parse.
   * @return boolean Whether or not we should show the reader mode button.
   */
  isProbablyReaderable(doc) {
    // Only care about 'real' HTML documents:
    if (
      doc.mozSyntheticDocument ||
      !doc.defaultView.HTMLDocument.isInstance(doc) ||
      doc.contentType == "application/pdf"
    ) {
      return false;
    }

    let uri = Services.io.newURI(doc.location.href);
    if (!this.shouldCheckUri(uri)) {
      return false;
    }

    return isProbablyReaderable(doc, this._isNodeVisible);
  },

  _isNodeVisible(node) {
    return node.clientHeight > 0 && node.clientWidth > 0;
  },

  _blockedHosts: [
    "amazon.com",
    "github.com",
    "mail.google.com",
    "pinterest.com",
    "reddit.com",
    "twitter.com",
    "youtube.com",
    "app.slack.com",
  ],

  shouldCheckUri(uri, isBaseUri = false) {
    if (!["http", "https", "file", "moz-nullprincipal"].includes(uri.scheme)) {
      return false;
    }

    if (!isBaseUri && uri.scheme.startsWith("http")) {
      // Sadly, some high-profile pages have false positives, so bail early for those:
      let { host } = uri;
      if (this._blockedHosts.some(blockedHost => host.endsWith(blockedHost))) {
        // Allow github on non-project pages
        if (
          host == "github.com" &&
          !uri.filePath.includes("/projects") &&
          !uri.filePath.includes("/issues")
        ) {
          return true;
        }
        return false;
      }

      if (uri.filePath == "/") {
        return false;
      }
    }

    return true;
  },
};

XPCOMUtils.defineLazyPreferenceGetter(
  Readerable,
  "isEnabled",
  "reader.parse-on-load.enabled",
  true
);
//@line 7 "$SRCDIR/toolkit/components/reader/Readerable.sys.mjs"

export { Readerable, isProbablyReaderable };
