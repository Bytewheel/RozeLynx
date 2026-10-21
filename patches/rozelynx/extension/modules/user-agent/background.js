/* RozeLynx: user agent switcher - engine.
 *
 * Two layers, one resolver:
 *   1. a GLOBAL user agent (rozelynx.ua.global, "" = the browser's own),
 *      picked from the preset dropdown or typed as a raw string;
 *   2. per-URL RULES (rozelynx.ua.rule.<n>.{pattern,ua,enabled}), exactly
 *      like the netiface URL rules: a rule that matches a page overrides
 *      the global string for that page only. The rules layer has its own
 *      master switch (rozelynx.ua.rules.enabled) and is inert until a rule
 *      exists.
 *
 * Storage is PREF-BACKED on purpose, mirroring the netiface rules: the prefs
 * stay the single source of truth, about:config shows exactly what the
 * dropdowns show, and the values stored are always FULL RAW STRINGS - a
 * preset is only a convenience for picking one.
 *
 * Application, both halves:
 *   - request headers: webRequest.onBeforeSendHeaders (blocking) rewrites
 *     the User-Agent header for every http(s) request whose URL resolves to
 *     an override (rule match, else the global string);
 *   - page JavaScript: the content script (modules/user-agent/content.js)
 *     asks this resolver for the document's override at document_start and
 *     redefines navigator.userAgent and friends into the page, because
 *     header rewriting alone leaves navigator.userAgent exposing the truth.
 *
 * The pattern grammar is the netiface grammar (see cpp/net-iface/
 * RozeLynxNetIface.h), ported so both rule systems answer the same question
 * the same way:
 *   *.example.com          host + all subdomains
 *   example.com            that host only
 *   *foo?.example.com      any glob inside the host
 *   *                      any host
 *   *://host/mail          optional scheme + path prefix ("/mail*" implied)
 * When several rules match, the most specific wins (host rank, then host
 * length, then a path over none, then path length, then a scheme over none,
 * then the lowest rule index).
 */
(function() {
  'use strict';

  var LOG_PREFIX = '[RozeLynx:user-agent]';

  var PREF_GLOBAL = 'rozelynx.ua.global';
  var PREF_RULES_ENABLED = 'rozelynx.ua.rules.enabled';
  var PREF_RULE_PREFIX = 'rozelynx.ua.rule.';
  var PREF_RULE_FIELDS = ['pattern', 'ua', 'enabled'];

  // Same bound both sides: the reader stops at the first index with no
  // pattern, so a higher bound costs one pref read per empty index and
  // nothing else.
  var MAX_RULES = 64;

  function log(level, msg) {
    var args = Array.prototype.slice.call(arguments, 1);
    if (level === 'error') {
      console.error.apply(console, [LOG_PREFIX].concat(args));
    } else if (level === 'warn') {
      console.warn.apply(console, [LOG_PREFIX].concat(args));
    } else {
      console.log.apply(console, [LOG_PREFIX].concat(args));
    }
  }

  function prefsApi() {
    var api = browser.rozelynxPrefs;
    return (api && api.getPrefs) ? api : null;
  }

  // ── the pattern grammar ───────────────────────────────────────────
  // A JS port of the netiface C++ matcher (RozeLynxNetIfaceUrlRule): parse
  // once per pref change, compare per request.

  function parseRule(pattern, index) {
    var rule = {
      raw: pattern,
      index: index,
      hasScheme: false,
      hasPath: false,
      subdomainHost: false,
      hostRank: 0,
      scheme: '',
      host: '',
      path: '',
      ok: false,
    };
    var s = String(pattern || '').trim().toLowerCase();
    if (!s) {
      return rule;
    }
    // optional scheme
    var m = /^([a-z*][a-z0-9*+-]*):\/\//i.exec(s);
    if (m) {
      rule.hasScheme = true;
      rule.scheme = m[1];
      s = s.slice(m[0].length);
    }
    // host [/path]
    var slash = s.indexOf('/');
    var hostPart = slash >= 0 ? s.slice(0, slash) : s;
    rule.path = slash >= 0 ? s.slice(slash) : '';
    rule.hasPath = rule.path.length > 0;
    if (rule.hasPath && rule.path.slice(-1) !== '*') {
      rule.path += '*';  // implied trailing glob, matches the whole rest
    }
    rule.host = hostPart.replace(/\.+$/, '');
    if (!rule.host) {
      return rule;
    }
    if (rule.host === '*') {
      rule.hostRank = 0;
    } else if (rule.host.slice(0, 2) === '*.') {
      rule.subdomainHost = true;
      rule.host = rule.host.slice(2);
      rule.hostRank = 1;
    } else if (rule.host.indexOf('*') >= 0 || rule.host.indexOf('?') >= 0) {
      rule.hostRank = 0;
    } else {
      rule.hostRank = 2;  // exact host
    }
    rule.ok = true;
    return rule;
  }

  function ruleMatches(rule, url) {
    if (!rule.ok) {
      return false;
    }
    var u;
    try {
      u = new URL(url);
    } catch (e) {
      return false;
    }
    if (rule.hasScheme && rule.scheme !== '*' &&
        u.protocol.replace(/:$/, '') !== rule.scheme) {
      return false;
    }
    var host = u.hostname.toLowerCase().replace(/\.+$/, '');
    if (rule.hostRank === 2) {
      if (host !== rule.host) return false;
    } else if (rule.subdomainHost) {
      if (host !== rule.host && host.slice(-(rule.host.length + 1)) !==
          '.' + rule.host) {
        return false;
      }
    } else if (rule.host === '*') {
      // any host
    } else {
      // glob host: '*' and '?' stay WITHIN LABELS (netiface semantics), so
      // a glob cannot accidentally cross subdomain dots - spoofing too
      // broadly is a fingerprinting hazard, not a feature.
      if (!globToRegExpLabels(rule.host).test(host)) return false;
    }
    if (rule.hasPath) {
      var pathQuery = u.pathname + u.search + u.hash;
      if (!globPathMatches(rule.path, pathQuery)) return false;
    }
    return true;
  }

  function globToRegExpLabels(glob) {
    // host glob where '*' is any run of non-dot characters and '?' exactly
    // one non-dot character (netiface semantics inside a label)
    var out = '';
    for (var i = 0; i < glob.length; i++) {
      var ch = glob[i];
      if (ch === '*') out += '[^.]*';
      else if (ch === '?') out += '[^.]';
      else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp('^' + out + '$', 'i');
  }

  function globPathMatches(pattern, path) {
    // simple prefix glob: characters must match; '*' matches any run; the
    // pattern already carries its implied trailing '*'.
    function inner(pIdx, sIdx) {
      while (pIdx < pattern.length) {
        var ch = pattern[pIdx];
        if (ch === '*') {
          if (pIdx === pattern.length - 1) return true;
          for (var k = sIdx; k <= path.length; k++) {
            if (inner(pIdx + 1, k)) return true;
          }
          return false;
        }
        if (sIdx >= path.length || path[sIdx] !== ch) return false;
        pIdx++;
        sIdx++;
      }
      return sIdx === path.length;
    }
    return inner(0, 0);
  }

  function ruleScore(rule, url) {
    var u;
    try {
      u = new URL(url);
    } catch (e) {
      return null;
    }
    var host = u.hostname.toLowerCase().replace(/\.+$/, '');
    return {
      hostRank: rule.hostRank,
      hostLength: rule.host.length,
      hasPath: rule.hasPath ? 1 : 0,
      pathLength: rule.path.length,
      hasScheme: rule.hasScheme ? 1 : 0,
      index: rule.index,
    };
  }

  function betterRule(a, b) {
    // higher is more specific; ties go to the lowest index
    if (!b) return true;
    if (a.hostRank !== b.hostRank) return a.hostRank > b.hostRank;
    if (a.hostLength !== b.hostLength) return a.hostLength > b.hostLength;
    if (a.hasPath !== b.hasPath) return a.hasPath > b.hasPath;
    if (a.pathLength !== b.pathLength) return a.pathLength > b.pathLength;
    if (a.hasScheme !== b.hasScheme) return a.hasScheme > b.hasScheme;
    return a.index < b.index;
  }

  // ── pref-backed rule storage ──────────────────────────────────────

  var state = {
    global: '',           // "" = browser default
    rulesEnabled: true,   // master switch for the RULES layer
    rules: [],            // [{index, pattern, ua, enabled}] as stored
    parsed: [],           // parsed matchers, rebuilt on every change
    warnedNoPrefs: false,
  };

  function allRulePrefNames() {
    var out = [PREF_GLOBAL, PREF_RULES_ENABLED];
    for (var i = 0; i < MAX_RULES; i++) {
      out.push(PREF_RULE_PREFIX + i + '.pattern');
      out.push(PREF_RULE_PREFIX + i + '.ua');
      out.push(PREF_RULE_PREFIX + i + '.enabled');
    }
    return out;
  }

  function readState() {
    var api = prefsApi();
    if (!api) {
      if (!state.warnedNoPrefs) {
        state.warnedNoPrefs = true;
        log('warn', 'rozelynxPrefs unavailable; the user agent module ' +
            'runs on built-in defaults and cannot see about:config');
      }
      return Promise.resolve(state);
    }
    return Promise.resolve(api.getPrefs(allRulePrefNames())).then(function(list) {
      var by = {};
      (list || []).forEach(function(p) { by[p.name] = p; });
      var global = by[PREF_GLOBAL];
      state.global = (global && global.type === 'string') ? global.value : '';
      var master = by[PREF_RULES_ENABLED];
      state.rulesEnabled = master && master.type === 'boolean'
        ? master.value !== false : true;
      var rules = [];
      for (var i = 0; i < MAX_RULES; i++) {
        var idName = PREF_RULE_PREFIX + i + '.pattern';
        var idPref = by[idName];
        if (!idPref || idPref.type === 'missing' || !idPref.value) {
          break;  // a gap ends the list, like the netiface reader
        }
        var uaPref = by[PREF_RULE_PREFIX + i + '.ua'];
        var enPref = by[PREF_RULE_PREFIX + i + '.enabled'];
        rules.push({
          index: i,
          pattern: String(idPref.value),
          ua: (uaPref && uaPref.type === 'string') ? uaPref.value : '',
          enabled: enPref ? enPref.type === 'boolean'
            ? enPref.value !== false : true : true,
        });
      }
      state.rules = rules;
      state.parsed = rules.map(function(r) {
        return parseRule(r.pattern, r.index);
      });
      return state;
    }, function(err) {
      log('warn', 'pref read failed, keeping previous state:',
        err && err.message);
      return state;
    });
  }

  // Write the whole rule list: indices 0..n-1 are set, every index >= n has
  // its prefs CLEARED (so a deleted row cannot linger live in about:config -
  // the same invariant the netiface rules maintain).
  function writeRules(rules) {
    var api = prefsApi();
    if (!api) {
      return Promise.resolve({ ok: false,
        error: 'the prefs API is unavailable' });
    }
    if (!Array.isArray(rules)) {
      return Promise.resolve({ ok: false, error: 'rules must be a list' });
    }
    if (rules.length > MAX_RULES) {
      return Promise.resolve({
        ok: false,
        error: 'at most ' + MAX_RULES + ' rules, got ' + rules.length,
      });
    }
    var set = {};
    var clear = [];
    for (var i = 0; i < MAX_RULES; i++) {
      var base = PREF_RULE_PREFIX + i + '.';
      if (i >= rules.length) {
        for (var c = 0; c < PREF_RULE_FIELDS.length; c++) {
          clear.push(base + PREF_RULE_FIELDS[c]);
        }
        continue;
      }
      var r = rules[i] || {};
      var pattern = String(r.pattern || '').trim();
      if (!pattern) {
        return Promise.resolve({
          ok: false, error: 'rule ' + i + ': empty pattern' });
      }
      set[base + 'pattern'] = pattern;
      set[base + 'ua'] = String(r.ua == null ? '' : r.ua);
      set[base + 'enabled'] = r.enabled !== false;
    }
    // Clear first, then set: a shrink followed by a grow within one save
    // must not leave a cleared index the same save is about to write.
    return Promise.resolve(api.clearPrefs ? api.clearPrefs(clear) : null)
      .then(function(res) {
        if (res && res.ok === false) {
          throw new Error('could not clear stale rules: ' + res.error);
        }
        return api.setPrefs(set);
      })
      .then(function(res) {
        if (!res || res.ok === false) {
          throw new Error((res && res.error) || 'could not write the rules');
        }
        return readState();
      })
      .then(function() {
        return { ok: true, rules: state.rules, enabled: state.rulesEnabled };
      })
      .catch(function(err) {
        return { ok: false,
          error: err && err.message ? err.message : String(err) };
      });
  }

  // ── the resolver (both halves ask this) ────────────────────────────

  /**
   * The user agent to use for a URL: the winning rule's string, else the
   * global string, else "" (the browser's own). The RULES layer is gated by
   * its master switch; the global string is not (it is off by being empty).
   * The match info rides along so the UI's status line can say WHICH rule
   * won - the answer comes from the same resolver the header hook and the
   * content script use, so it cannot disagree with either.
   */
  function resolve(url) {
    var out = { ua: state.global, matched: false, index: -1, pattern: '',
                layer: state.global ? 'global' : '' };
    if (state.rulesEnabled) {
      var winner = null;
      var winnerScore = null;
      for (var i = 0; i < state.parsed.length; i++) {
        var parsed = state.parsed[i];
        var rule = state.rules[i];
        if (!rule || !rule.enabled || !rule.ua) continue;
        if (!ruleMatches(parsed, url)) continue;
        var score = ruleScore(parsed, url);
        if (betterRule(score, winnerScore)) {
          winner = rule;
          winnerScore = score;
        }
      }
      if (winner) {
        out.ua = winner.ua;
        out.matched = true;
        out.index = winner.index;
        out.pattern = winner.pattern;
        out.layer = 'url';
      }
    }
    return out;
  }

  function resolveUA(url) {
    return resolve(url).ua;
  }

  // ── request-header half ────────────────────────────────────────────

  function rewriteHeader(details) {
    var url = details.url || '';
    if (url.indexOf('http:') !== 0 && url.indexOf('https:') !== 0) {
      return {};
    }
    var ua = resolveUA(url);
    if (!ua) {
      return {};
    }
    var headers = details.requestHeaders || [];
    var found = false;
    for (var i = 0; i < headers.length; i++) {
      if (headers[i].name &&
          headers[i].name.toLowerCase() === 'user-agent') {
        headers[i].value = ua;
        found = true;
        break;
      }
    }
    if (!found) {
      headers.push({ name: 'User-Agent', value: ua });
    }
    return { requestHeaders: headers };
  }

  browser.webRequest.onBeforeSendHeaders.addListener(rewriteHeader,
    { urls: ['*://*/*'] },
    ['blocking', 'requestHeaders']);

  // ── messages ──────────────────────────────────────────────────────
  // 'user-agent:present' answers with ok:true, which is how the popup
  // decides to load the UI script at all (the netiface section's guard
  // pattern - ask the thing that would work). The rest are the UI's
  // read/write calls; every write answers with the RE-READ state so the
  // editors render what is stored, not what they hoped to store.

  browser.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    var action = message && message.action;
    if (action !== 'user-agent:present' &&
        action !== 'user-agent:resolve' &&
        action !== 'user-agent:get-state' &&
        action !== 'user-agent:set-rules' &&
        action !== 'user-agent:set-global' &&
        action !== 'user-agent:set-rules-enabled') {
      return false;
    }

    if (action === 'user-agent:present') {
      sendResponse({ ok: true, version: browser.runtime.getManifest().version });
      return false;
    }
    if (action === 'user-agent:resolve') {
      readState().then(function() {
        var r = resolve(message.url || '');
        sendResponse({ ok: true, ua: r.ua, matched: r.matched,
                       index: r.index, pattern: r.pattern, layer: r.layer });
      }).catch(function() {
        sendResponse({ ok: true, ua: '', matched: false });
      });
      return true;
    }
    if (action === 'user-agent:get-state') {
      readState().then(function() {
        sendResponse({
          ok: true,
          global: state.global,
          enabled: state.rulesEnabled,
          rules: state.rules,
          maxRules: MAX_RULES,
        });
      }).catch(function(e) {
        sendResponse({ ok: false,
          error: (e && e.message) || String(e) });
      });
      return true;
    }
    if (action === 'user-agent:set-rules') {
      writeRules(message.rules || []).then(sendResponse);
      return true;
    }
    if (action === 'user-agent:set-global') {
      var api = prefsApi();
      if (!api) {
        sendResponse({ ok: false, error: 'the prefs API is unavailable' });
        return true;
      }
      Promise.resolve(api.setPrefs({
        [PREF_GLOBAL]: String(message.ua || ''),
      })).then(function(res) {
        if (!res || res.ok === false) {
          throw new Error((res && res.error) || 'could not write the pref');
        }
        return readState();
      }).then(function() {
        sendResponse({ ok: true, global: state.global });
      }).catch(function(e) {
        sendResponse({ ok: false,
          error: e && e.message ? e.message : String(e) });
      });
      return true;
    }
    if (action === 'user-agent:set-rules-enabled') {
      var api2 = prefsApi();
      if (!api2) {
        sendResponse({ ok: false, error: 'the prefs API is unavailable' });
        return true;
      }
      Promise.resolve(api2.setPrefs({
        [PREF_RULES_ENABLED]: !!message.enabled,
      })).then(function(res) {
        if (!res || res.ok === false) {
          throw new Error((res && res.error) || 'could not write the pref');
        }
        return readState();
      }).then(function() {
        sendResponse({ ok: true, enabled: state.rulesEnabled });
      }).catch(function(e) {
        sendResponse({ ok: false,
          error: e && e.message ? e.message : String(e) });
      });
      return true;
    }
    return false;
  });

  // The keepalive alarm (background.js) wakes this event page twice a
  // minute, and every wakeup re-reads the prefs below - which bounds how
  // stale an about:config edit can be. The header hook resolves per
  // request from that state, so there is no listener to keep registered.
  readState().then(function() {
    log('info', 'user agent switcher ready: ' + state.rules.length +
        ' rule(s), global override ' + (state.global ? 'set' : 'off'));
  });
})();
