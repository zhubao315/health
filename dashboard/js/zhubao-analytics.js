/*
 * ZHUBAO Growth Analytics — unified browser SDK wrapper (v1.0)
 *
 * Single PostHog project (ZHUBAO-PORTFOLIO) for every deployed site.
 * Site identity comes from data-* attributes on this script tag, never from a
 * second PostHog project. Load this file with:
 *
 *   <script src="/js/zhubao-analytics.js" async fetchpriority="low"
 *           data-site-id="home" data-site-group="BUILD"
 *           data-repo="zhubao315/zhubao315.github.io"></script>
 *
 * Add data-spa="true" on SPA-like sites (MkDocs navigation.instant) so a title
 * change triggers a new page_view; URLs are deduplicated automatically.
 *
 * Guarantees:
 *   - production only (zhubao315.github.io), DNT respected, one init, one page_view
 *   - no autocapture, no session replay, no surveys, no console logs
 *   - only UTM query params survive; all other query strings are stripped
 *   - PII / health / movement / assessment fields are denied at send time
 *
 * The token below is PostHog's public, write-only project token (safe in public apps).
 */
(function () {
  'use strict';

  var TOKEN = 'phc_rEdK3yK6qqStVMxDJPCQW9hi5w9HvCBC7wgNsxanF7Du';
  var API_HOST = 'https://us.i.posthog.com';
  var SCHEMA_VERSION = '1.0';
  var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'];
  var FORBIDDEN = [
    'health_metrics', 'gps_trace', 'assessment_answers', 'assessment_result',
    'email', 'phone', 'password', 'token', 'authorization'
  ];

  var script = document.currentScript;
  if (!script) {
    var all = document.getElementsByTagName('script');
    for (var i = all.length - 1; i >= 0; i--) {
      if (/zhubao-analytics\.js/.test(all[i].src || '')) { script = all[i]; break; }
    }
  }
  if (!script) return;

  // Production + DNT + single-init guards.
  if (window.location.hostname !== 'zhubao315.github.io') return;
  if (navigator.doNotTrack === '1' || window.doNotTrack === '1') return;
  if (window.__ZHUBAO_ANALYTICS__) return;
  window.__ZHUBAO_ANALYTICS__ = true;

  // Config may come from data-* attributes or a pre-boot global (MkDocs cannot
  // add attributes to extra_javascript tags).
  var boot = window.ZHUBAO_ANALYTICS_CONFIG || {};
  var siteId = script.getAttribute('data-site-id') || boot.site_id || 'unknown';
  var siteGroup = script.getAttribute('data-site-group') || boot.site_group || 'BUILD';
  var repo = script.getAttribute('data-repo') || boot.repo || '';
  var pageType = script.getAttribute('data-page-type') || boot.page_type || resolvePageType();
  var spaMode = script.getAttribute('data-spa') === 'true' || boot.spa === true;

  function resolvePageType() {
    var p = window.location.pathname.toLowerCase();
    if (p === '/' || p === '') return 'home';
    if (p.indexOf('/articles/') === 0 || p.indexOf('/books/') === 0) return 'article';
    if (p.indexOf('/work/') === 0 || p.indexOf('/repositories/') === 0) return 'project';
    if (p.indexOf('/docs/') === 0 || p.indexOf('/cli/') === 0) return 'documentation';
    return 'landing';
  }

  function sanitizeUrl(value) {
    if (typeof value !== 'string' || !value) return value;
    try {
      var url = new URL(value, window.location.href);
      var clean = new URLSearchParams();
      UTM_KEYS.forEach(function (key) {
        var found = url.searchParams.get(key);
        if (found) clean.set(key, found.slice(0, 120));
      });
      url.search = clean.toString() ? '?' + clean.toString() : '';
      url.hash = '';
      return url.toString();
    } catch (err) {
      return window.location.origin + window.location.pathname;
    }
  }

  function readUtm() {
    var params = new URLSearchParams(window.location.search);
    var out = {};
    UTM_KEYS.forEach(function (key) {
      var value = params.get(key);
      if (value) out[key] = value.slice(0, 120);
    });
    return out;
  }

  function scrub(properties) {
    var clean = {};
    Object.keys(properties || {}).forEach(function (key) {
      if (FORBIDDEN.indexOf(key) === -1) clean[key] = properties[key];
    });
    return clean;
  }

  // PostHog also stores initial/current URL and referrer fields we do not set.
  // Redact every URL-like property recursively, not just the two we know about.
  function looksLikeUrl(value) {
    return typeof value === 'string' &&
      (/^(https?:)?\/\//i.test(value) || /^\//.test(value) || value.indexOf('?') !== -1);
  }

  function redactUrls(value) {
    if (!value || typeof value !== 'object') return value;
    Object.keys(value).forEach(function (key) {
      var item = value[key];
      if (typeof item === 'string' && /(url|referrer|href)/i.test(key) && looksLikeUrl(item)) {
        value[key] = sanitizeUrl(item);
      } else if (item && typeof item === 'object') {
        redactUrls(item);
      }
    });
    return value;
  }

  // Official PostHog JS snippet (US Cloud). Loads the SDK async via array.js.
  !function (t, e) {
    var o, n, p, r;
    e.__SV || (window.posthog = e, e._i = [], e.init = function (i, s, a) {
      function g(t, e) {
        var o = e.split('.');
        2 === o.length && (t = t[o[0]], e = o[1]);
        t[e] = function () { t.push([e].concat(Array.prototype.slice.call(arguments, 0))); };
      }
      (p = t.createElement('script')).type = 'text/javascript';
      p.crossOrigin = 'anonymous';
      p.async = !0;
      p.src = s.api_host.replace('.i.posthog.com', '-assets.i.posthog.com') + '/static/array.js';
      (r = t.getElementsByTagName('script')[0]).parentNode.insertBefore(p, r);
      var u = e;
      for (void 0 !== a ? u = e[a] = [] : a = 'posthog',
           u.people = u.people || [],
           Object.defineProperty(u, 'toString', {
             configurable: !0, enumerable: !0, writable: !0,
             value: function (t) { var e = 'posthog'; return 'posthog' !== a && (e += '.' + a), t || (e += ' (stub)'), e; }
           }),
           Object.defineProperty(u.people, 'toString', {
             configurable: !0, enumerable: !0, writable: !0,
             value: function () { return u.toString(1) + '.people (stub)'; }
           }),
           o = 'init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagResult isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug'.split(' '),
           n = 0; n < o.length; n++) g(u, o[n]);
      e._i.push([i, s, a]);
    }, e.__SV = 1);
  }(document, window.posthog || []);

  var common = {
    site_id: siteId,
    site_group: siteGroup,
    repo: repo,
    environment: 'production',
    schema_version: SCHEMA_VERSION
  };

  window.posthog.init(TOKEN, {
    api_host: API_HOST,
    defaults: '2026-08-30',
    capture_pageview: false,
    capture_pageleave: false,
    autocapture: false,
    capture_dead_clicks: false,
    capture_exceptions: false,
    capture_heatmaps: false,
    capture_performance: false,
    disable_session_recording: true,
    disable_surveys: true,
    respect_dnt: true,
    person_profiles: 'identified_only',
    persistence: 'localStorage',
    secure_cookie: true,
    property_denylist: FORBIDDEN,
    logs: { captureConsoleLogs: false },
    before_send: function (event) {
      if (!event) return null;
      if (event.properties) event.properties = scrub(redactUrls(event.properties));
      if (event.$set) event.$set = scrub(redactUrls(event.$set));
      if (event.$set_once) event.$set_once = scrub(redactUrls(event.$set_once));
      return event;
    }
  });

  window.posthog.register(common);

  function track(event, properties) {
    if (!event || typeof event !== 'string') return;
    var payload = scrub(properties || {});
    payload.event_category = payload.event_category || 'engagement';
    payload.campaign = payload.campaign || readUtm().utm_campaign || 'none';
    payload.schema_version = SCHEMA_VERSION;
    payload.environment = 'production';
    window.posthog.capture(event, payload);
  }

  var lastPageViewUrl = null;
  function sendPageView() {
    var current = window.location.href;
    if (current === lastPageViewUrl) return; // dedupe per URL, not per document
    lastPageViewUrl = current;
    var utm = readUtm();
    var viewType = pageType === 'home' ? resolvePageType() : pageType;
    var pageView = {
      page_type: viewType,
      event_category: 'navigation',
      campaign: utm.utm_campaign || 'none'
    };
    UTM_KEYS.forEach(function (key) { if (utm[key]) pageView[key] = utm[key]; });
    track('page_view', pageView);
  }

  sendPageView();

  // SPA support: history navigation and (optionally) document title changes.
  window.addEventListener('popstate', function () { setTimeout(sendPageView, 0); });
  if (spaMode && typeof MutationObserver === 'function') {
    var lastTitle = document.title;
    var observer = new MutationObserver(function () {
      if (document.title !== lastTitle) {
        lastTitle = document.title;
        setTimeout(sendPageView, 0);
      }
    });
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
  }

  window.ZHUBAO = {
    track: track,
    pageview: sendPageView,
    getSiteId: function () { return siteId; },
    identifySite: function () { return common; },
    getAnalyticsConfig: function () {
      return {
        site_id: siteId,
        site_group: siteGroup,
        repo: repo,
        page_type: pageType,
        environment: 'production',
        schema_version: SCHEMA_VERSION,
        analytics_project: 'ZHUBAO-PORTFOLIO'
      };
    }
  };
})();
