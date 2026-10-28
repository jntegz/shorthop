/*! Shorthop website analytics · served at /_t/script.js
 *
 * <script defer src="https://<short domain>/_t/script.js" data-site="st_…"></script>
 *
 * Attributes: data-site (required), data-api (collector URL, for a proxy),
 * data-hash (count #/route changes as pages), data-allow-localhost,
 * data-debug (log to the console why nothing is sent; also ?sh_debug=1),
 * data-consent-banner (consent sites: ask with a small built-in banner;
 * data-consent-text replaces its sentence).
 *
 * API: shorthop("goal", name, props) · shorthop("identify", {email, name, id}) ·
 * shorthop("pageview") · shorthop("consent", true|false) · shorthop("consent-settings")
 * (shows the built-in banner again, for a "Cookie settings" link) · shorthop.ref() (the visit
 * reference for checkout metadata) · shorthop.checkout(url) (a checkout URL
 * carrying that reference) · shorthop.visitor().
 *
 * Markup: data-sh-goal="name" (+ data-sh-goal-<prop>) on clicks;
 * data-sh-scroll="name" (+ -threshold 0–1, -delay ms) when scrolled into view.
 *
 * Cookieless sites store nothing on the device. Persistent sites keep one
 * first-party ID in localStorage (sh_vid), unless the browser sends GPC/DNT.
 * Consent sites do that only after shorthop("consent", true).
 */
(function () {
  "use strict";
  var w = window, d = document, loc = w.location, nav = w.navigator;
  var script = d.currentScript;
  var queued = (w.shorthop && w.shorthop.q) || [];
  var debug = !!(script && script.hasAttribute("data-debug")) || /[?&]sh_debug=1\b/.test(loc.search);
  function noop() {}
  function off(why) {
    if (debug && w.console) console.info("Shorthop analytics is off: " + why);
    var stub = function () {};
    stub.ref = stub.visitor = function () { return null; };
    stub.checkout = function (u) { return u; };
    w.shorthop = stub;
  }

  if (!script) return off("no script element");
  var siteId = script.getAttribute("data-site");
  var api = script.getAttribute("data-api") || new URL("/_t/e", script.src).href;
  var hashMode = script.hasAttribute("data-hash");
  var bannerOn = script.hasAttribute("data-consent-banner");

  function store(k, v) {
    try {
      if (v === undefined) return w.localStorage.getItem(k);
      if (v === null) w.localStorage.removeItem(k);
      else w.localStorage.setItem(k, v);
    } catch (e) { /* storage blocked */ }
    return null;
  }

  var ignoreParam = /[?&]sh_ignore=(1|true|0|false)\b/.exec(loc.search);
  if (ignoreParam) {
    var ignoring = /1|true/.test(ignoreParam[1]);
    store("sh_ignore", ignoring ? "1" : null);
    toast(ignoring ? "Your visits from this browser are no longer counted on " + loc.host + "." : "Your visits from this browser are counted again.");
  }
  var local = /^(localhost|127\.|\[::1\]|.*\.local$)/.test(loc.hostname) || loc.protocol === "file:";
  if (!siteId) return off("data-site is missing");
  if (nav.webdriver) return off("automated browser");
  if (store("sh_ignore") === "1") return off("this browser is excluded (?sh_ignore=0 counts it again)");
  if (local && !script.hasAttribute("data-allow-localhost")) return off("localhost (add data-allow-localhost)");

  /** A short note at the bottom of the page, for the owner who just excluded their browser. */
  function toast(text) {
    var show = function () {
      var el = d.createElement("div");
      el.setAttribute("role", "status");
      el.textContent = text;
      el.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;max-width:90vw;background:#111;color:#fff;font:500 14px/1.4 system-ui,sans-serif;padding:10px 16px;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.25)";
      d.body.appendChild(el);
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 6000);
    };
    if (d.body) show();
    else d.addEventListener("DOMContentLoaded", show);
  }

  function rid(n) {
    var a = new Uint8Array(n), s = "", c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    (w.crypto || w.msCrypto).getRandomValues(a);
    for (var i = 0; i < n; i++) s += c[a[i] & 63];
    return s;
  }

  // The visitor id only reaches storage when the server says the site is persistent.
  var vid = store("sh_vid") || rid(22);
  // Consent sites: what the visitor chose, kept so the next page doesn't drop the id before the banner speaks.
  var consent = store("sh_consent") === "1";
  // asks: the server said this is a consent site with a question to ask; reopen: settings asked for before it said so.
  var asks = false, reopen = false, banner = null;
  var ref = null;
  var refListeners = [];

  // A short-link click token rides on the landing URL once; take it off the address bar.
  var clickToken = null;
  var landing = new URL(loc.href);
  if (landing.searchParams.has("sh_c")) {
    clickToken = landing.searchParams.get("sh_c");
    landing.searchParams.delete("sh_c");
    try { history.replaceState(history.state, "", landing.pathname + landing.search + landing.hash); } catch (e) { /* ignore */ }
  }

  var PRIVATE = /^(e-?mail|name|first_?name|last_?name|phone|tel|mobile|password|pass|pwd|token|access_token|id_token|auth|code|key|api_?key|secret|license|ssn|address)$/i;
  function cleanUrl(href) {
    var u = new URL(href);
    var drop = [];
    u.searchParams.forEach(function (_, k) { if (PRIVATE.test(k)) drop.push(k); });
    for (var i = 0; i < drop.length; i++) u.searchParams.delete(drop[i]);
    if (!hashMode) u.hash = "";
    return u.href;
  }

  // Provider ids a return page shows after checkout (?session_id={CHECKOUT_SESSION_ID} and the like).
  function claims(href) {
    var out = [], u = new URL(href);
    ["session_id", "checkout_id", "order_id", "payment_id", "subscription_id", "_ptxn", "transaction_id"].forEach(function (k) {
      var v = u.searchParams.get(k);
      if (v && /^(cs_|ch_|ord_|pay_|sub_|txn_|in_|pi_)[A-Za-z0-9_]{4,190}$/.test(v)) out.push(v);
    });
    return out;
  }

  function send(type, extra, beacon) {
    var body = { s: siteId, t: type, u: cleanUrl(loc.href), r: d.referrer || "", w: w.screen ? w.screen.width : 0, v: vid };
    if (consent) body.cs = 1;
    for (var k in extra) body[k] = extra[k];
    var json = JSON.stringify(body);
    if (beacon && nav.sendBeacon) {
      try { if (nav.sendBeacon(api, new Blob([json], { type: "text/plain" }))) return; } catch (e) { /* fall through */ }
    }
    if (!w.fetch) return;
    w.fetch(api, { method: "POST", body: json, headers: { "Content-Type": "text/plain" }, keepalive: true, credentials: "omit" })
      .then(function (r) { return r.status === 200 ? r.json() : null; })
      .then(function (res) {
        if (!res) return;
        if (res.m === "p") store("sh_vid", vid);
        else if (res.m === "c") store("sh_vid", null);
        if (res.a && !asks) {
          asks = true;
          var answered = store("sh_consent") === "1" || store("sh_consent") === "0";
          if (reopen || (bannerOn && !answered)) showBanner();
        }
        if (res.s && res.s !== ref) {
          ref = res.s;
          decorateAll();
          for (var i = 0; i < refListeners.length; i++) refListeners[i](ref);
          refListeners = [];
        }
      })
      .catch(noop);
  }

  // ---- Reading: engaged time and scroll depth of the current page.
  // Time counts while the page is visible and the visitor did something in the
  // last minute (scroll, key, pointer, touch); a page left open idle stops counting.
  var IDLE_MS = 60000, MAX_PAGE_MS = 1800000;
  var page = null;
  function newPage() {
    var now = Date.now();
    page = { u: cleanUrl(loc.href), ms: 0, sent: 0, active: now, since: 0, scroll: 0, sentScroll: 0 };
    tick(now);
    measureScroll();
  }
  function tick(now) {
    if (!page) return;
    if (page.since) {
      var end = Math.min(now, page.active + IDLE_MS);
      if (end > page.since) page.ms = Math.min(MAX_PAGE_MS, page.ms + end - page.since);
    }
    page.since = d.visibilityState === "visible" && now - page.active < IDLE_MS ? now : 0;
  }
  function measureScroll() {
    if (!page) return;
    var el = d.documentElement, body = d.body;
    var height = Math.max(body ? body.scrollHeight : 0, el ? el.scrollHeight : 0);
    var seen = (w.pageYOffset || (el && el.scrollTop) || 0) + (w.innerHeight || 0);
    var pct = height <= 0 || seen >= height - 4 ? 100 : Math.round((seen / height) * 100);
    if (pct > page.scroll) page.scroll = Math.min(100, pct);
  }
  var lastActivity = 0, scrollQueued = false;
  function activity() {
    var now = Date.now();
    if (!page || now - lastActivity < 1000) return;
    lastActivity = now;
    tick(now);
    page.active = now;
    tick(now);
  }
  function onScroll() {
    activity();
    if (scrollQueued) return;
    scrollQueued = true;
    setTimeout(function () { scrollQueued = false; measureScroll(); }, 200);
  }
  /** Sends what's new since the last flush: engaged milliseconds and the deepest scroll, for the page they belong to. */
  function flushEngaged(beacon) {
    if (!page) return;
    tick(Date.now());
    measureScroll();
    var delta = Math.round(page.ms - page.sent);
    if (delta < 1000 && page.scroll <= page.sentScroll) return;
    page.sent += delta;
    page.sentScroll = page.scroll;
    send("engage", { u: page.u, d: delta, sd: page.scroll }, beacon);
  }
  w.addEventListener("scroll", onScroll, { passive: true });
  w.addEventListener("resize", onScroll, { passive: true });
  ["mousemove", "mousedown", "keydown", "touchstart", "wheel"].forEach(function (ev) { d.addEventListener(ev, activity, { passive: true, capture: true }); });
  d.addEventListener("visibilitychange", function () {
    if (!page) return;
    if (d.visibilityState === "hidden") flushEngaged(true);
    else { page.active = Date.now(); tick(page.active); }
  });
  w.addEventListener("pagehide", function () { flushEngaged(true); });

  // ---- Page speed (Core Web Vitals) of the page as it first loaded: largest
  // contentful paint, cumulative layout shift and the slowest interaction
  // (close to INP), sent once when the page is hidden. No library, and nothing
  // where PerformanceObserver is missing.
  var vitals = { lcp: 0, cls: 0, inp: 0, sent: false, u: null };
  function observe(type, fn, opts) {
    try {
      var po = new PerformanceObserver(function (list) { list.getEntries().forEach(fn); });
      var o = { type: type, buffered: true };
      for (var k in opts) o[k] = opts[k];
      po.observe(o);
    } catch (e) { /* not supported */ }
  }
  if (w.PerformanceObserver) {
    observe("largest-contentful-paint", function (e) { vitals.lcp = e.startTime; });
    observe("layout-shift", function (e) { if (!e.hadRecentInput) vitals.cls += e.value; });
    observe("event", function (e) { if (e.interactionId && e.duration > vitals.inp) vitals.inp = e.duration; }, { durationThreshold: 40 });
  }
  function flushVitals() {
    if (vitals.sent || !vitals.u || (!vitals.lcp && !vitals.inp)) return;
    vitals.sent = true;
    send("vitals", { u: vitals.u, lcp: Math.round(vitals.lcp), cls: Math.round(vitals.cls * 1000) / 1000, inp: Math.round(vitals.inp) }, true);
  }
  d.addEventListener("visibilitychange", function () { if (d.visibilityState === "hidden") flushVitals(); });
  w.addEventListener("pagehide", flushVitals);

  // ---- Pageviews, including single-page apps.
  var lastPage = null;
  function pageKey() { return loc.pathname + loc.search + (hashMode ? loc.hash : ""); }
  function pageview(force) {
    var key = pageKey();
    if (!force && key === lastPage) return;
    if (lastPage !== null) flushEngaged(false);
    // Vitals belong to the page that loaded; later in-app navigations don't reset them.
    if (lastPage === null) vitals.u = cleanUrl(loc.href);
    lastPage = key;
    newPage();
    var extra = {};
    if (clickToken) { extra.c = clickToken; clickToken = null; }
    var k = claims(loc.href);
    if (k.length) extra.k = k;
    send("pageview", extra);
  }
  function wrap(name) {
    var orig = history[name];
    if (!orig) return;
    history[name] = function () {
      var r = orig.apply(this, arguments);
      setTimeout(function () { pageview(false); }, 0);
      return r;
    };
  }
  wrap("pushState");
  wrap("replaceState");
  w.addEventListener("popstate", function () { pageview(false); });
  if (hashMode) w.addEventListener("hashchange", function () { pageview(false); });

  // ---- Checkout links: carry the visit reference into the provider's metadata.
  function rootOf(host) { return host.replace(/^www\./, ""); }
  var ownRoot = rootOf(loc.hostname);
  function provider(u) {
    var h = u.hostname;
    if (h === "buy.stripe.com") return "stripe";
    if (/\.lemonsqueezy\.com$/.test(h) && /\/checkout\//.test(u.pathname)) return "lemonsqueezy";
    if (/(^|\.)checkout\.dodopayments\.com$/.test(h)) return "dodo";
    if (/(^|\.)creem\.io$/.test(h) && /^\/(test\/)?payment\//.test(u.pathname)) return "creem";
    if (/(^|\.)gumroad\.com$/.test(h) && /^\/l\//.test(u.pathname)) return "gumroad";
    return null;
  }
  function withRef(href) {
    if (!ref) return href;
    var u;
    try { u = new URL(href, loc.href); } catch (e) { return href; }
    var p = provider(u), q = u.searchParams;
    if (p === "stripe" && !q.has("client_reference_id")) q.set("client_reference_id", "sh_" + ref);
    else if (p === "lemonsqueezy") q.set("checkout[custom][sh_ref]", ref);
    else if (p === "dodo") q.set("metadata_tl_ref", ref);
    else if (p === "creem") q.set("metadata[sh_ref]", ref);
    else if (p === "gumroad") q.set("sh_ref", ref);
    else return href;
    return u.href;
  }
  function decorate(a) {
    if (!a.href || a.getAttribute("data-sh-skip") !== null) return;
    var next = withRef(a.href);
    if (next !== a.href) a.href = next;
  }
  function decorateAll() {
    var links = d.links;
    for (var i = 0; i < links.length; i++) decorate(links[i]);
  }
  function linkOf(e) {
    var t = e.target;
    while (t && t.tagName !== "A") t = t.parentElement;
    return t && t.href ? t : null;
  }
  function onPointer(e) { var a = linkOf(e); if (a) decorate(a); }
  d.addEventListener("pointerdown", onPointer, true);
  d.addEventListener("keydown", function (e) { if (e.key === "Enter") onPointer(e); }, true);

  // ---- Clicks: goals (data-sh-goal), checkout links, outbound links.
  var GOAL_ATTRS = ["data-sh-goal"];
  function goalProps(el, attr, skip) {
    var props = {}, attrs = el.attributes;
    for (var i = 0; i < attrs.length; i++) {
      var name = attrs[i].name;
      if (name.indexOf(attr + "-") !== 0) continue;
      var key = name.slice(attr.length + 1).replace(/-/g, "_");
      if (key && !(skip && skip.test(key))) props[key] = String(attrs[i].value).slice(0, 255);
    }
    return props;
  }
  function goalOf(el) {
    for (; el && el.getAttribute; el = el.parentElement) {
      for (var i = 0; i < GOAL_ATTRS.length; i++) {
        var n = el.getAttribute(GOAL_ATTRS[i]);
        if (n !== null && n.trim()) return { n: n.trim(), p: goalProps(el, GOAL_ATTRS[i]) };
      }
    }
    return null;
  }
  function onClick(e) {
    if (e.type === "auxclick" && e.button !== 1) return;
    var goal = goalOf(e.target);
    if (goal) send("goal", goal);
    var a = linkOf(e);
    if (!a || !/^https?:/.test(a.protocol)) return;
    var u = new URL(a.href);
    if (provider(u)) { decorate(a); send("checkout", { n: a.href }); return; }
    var host = rootOf(u.hostname);
    if (host !== ownRoot && host.slice(-ownRoot.length - 1) !== "." + ownRoot && ownRoot.slice(-host.length - 1) !== "." + host) send("outbound", { n: a.href });
  }
  d.addEventListener("click", onClick, true);
  d.addEventListener("auxclick", onClick, true);

  // ---- Scroll goals: data-sh-scroll="name" fires once when the element is in view.
  var SCROLL_ATTRS = ["data-sh-scroll"];
  var watched = typeof WeakSet !== "undefined" ? new WeakSet() : null, observers = {};
  function watchScrollGoal(el, attr) {
    if (!watched || watched.has(el)) return;
    watched.add(el);
    var threshold = parseFloat(el.getAttribute(attr + "-threshold"));
    if (!(threshold >= 0 && threshold <= 1)) threshold = 0.5;
    var delay = parseInt(el.getAttribute(attr + "-delay"), 10);
    if (!(delay >= 0)) delay = 0;
    var key = String(threshold);
    observers[key] = observers[key] || new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var t = entry.target;
        if (t.__shFired) return;
        if (!entry.isIntersecting || entry.intersectionRatio < threshold - 0.001) { clearTimeout(t.__shTimer); t.__shTimer = null; return; }
        if (t.__shTimer) return;
        t.__shTimer = setTimeout(function () {
          t.__shTimer = null;
          t.__shFired = true;
          measureScroll();
          var props = goalProps(t, attr, /^(threshold|delay)$/);
          props.scroll_percentage = String(page ? page.scroll : 0);
          send("goal", { n: t.getAttribute(attr).trim().slice(0, 64), p: props });
          observers[key].unobserve(t);
        }, delay);
      });
    }, { threshold: [0, threshold] });
    observers[key].observe(el);
  }
  function scanScrollGoals() {
    for (var a = 0; a < SCROLL_ATTRS.length; a++) {
      var els = d.querySelectorAll("[" + SCROLL_ATTRS[a] + "]");
      for (var i = 0; i < els.length; i++) if (els[i].getAttribute(SCROLL_ATTRS[a]).trim()) watchScrollGoal(els[i], SCROLL_ATTRS[a]);
    }
  }
  function startScrollGoals() {
    if (!w.IntersectionObserver || !d.body) return;
    scanScrollGoals();
    if (w.MutationObserver) {
      var pending = false;
      new MutationObserver(function () {
        if (pending) return;
        pending = true;
        setTimeout(function () { pending = false; scanScrollGoals(); }, 250);
      }).observe(d.body, { childList: true, subtree: true });
    }
  }
  if (d.readyState === "loading") d.addEventListener("DOMContentLoaded", startScrollGoals);
  else startScrollGoals();

  // ---- Paddle.js: merge the reference into customData of every checkout it opens.
  var paddleTries = 0;
  (function hookPaddle() {
    var P = w.Paddle;
    if (P && P.Checkout && P.Checkout.open && !P.Checkout.open.__sh) {
      var open = P.Checkout.open;
      P.Checkout.open = function (opts) {
        opts = opts || {};
        if (ref) {
          var cd = opts.customData || {};
          if (!cd.sh_ref) cd.sh_ref = ref;
          opts.customData = cd;
        }
        send("checkout", { n: "https://paddle.com/checkout" });
        return open.call(this, opts);
      };
      P.Checkout.open.__sh = true;
    } else if (paddleTries++ < 20) setTimeout(hookPaddle, 500);
  })();

  // ---- FastSpring Store Builder: tag the order with the reference once both are known.
  var fsTagged = null, fsTries = 0;
  (function tagFastSpring() {
    var fs = w.fastspring;
    if (ref && fs && fs.builder && fs.builder.tag && fsTagged !== ref) {
      try { fs.builder.tag({ sh_ref: ref }); fsTagged = ref; } catch (e) { /* not ready yet */ }
    }
    if (fsTagged !== ref && fsTries++ < 40) setTimeout(tagFastSpring, 500);
  })();

  // ---- Built-in consent banner (data-consent-banner): Accept / Decline, kept until the visitor chooses.
  function showBanner() {
    reopen = false;
    if (banner || !d.body) {
      if (!d.body) d.addEventListener("DOMContentLoaded", showBanner);
      return;
    }
    banner = d.createElement("div");
    banner.setAttribute("role", "dialog");
    banner.setAttribute("aria-label", "Privacy choice");
    banner.style.cssText = "position:fixed;left:16px;right:16px;bottom:16px;margin:0 auto;max-width:560px;z-index:2147483647;display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;background:#111;color:#fff;font:400 14px/1.45 system-ui,sans-serif;padding:14px 16px;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.25)";
    var text = d.createElement("span");
    text.style.cssText = "flex:1 1 260px";
    text.textContent = script.getAttribute("data-consent-text") || "We use a random ID in your browser to recognise returning visits. No ads, no sharing.";
    banner.appendChild(text);
    var buttons = d.createElement("span");
    buttons.style.cssText = "display:flex;gap:8px;margin-left:auto";
    [["Decline", false], ["Accept", true]].forEach(function (b) {
      var btn = d.createElement("button");
      btn.type = "button";
      btn.textContent = b[0];
      btn.style.cssText = "cursor:pointer;font:600 14px/1 system-ui,sans-serif;padding:9px 14px;border-radius:8px;border:1px solid " + (b[1] ? "#fff;background:#fff;color:#111" : "rgba(255,255,255,.4);background:transparent;color:#fff");
      btn.addEventListener("click", function () {
        shorthop("consent", b[1]);
        // Keep this visit's id, so the next page is the same visitor.
        if (b[1]) store("sh_vid", vid);
        if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
        banner = null;
      });
      buttons.appendChild(btn);
    });
    banner.appendChild(buttons);
    d.body.appendChild(banner);
  }

  // ---- Public API.
  function shorthop(cmd, a, b) {
    if (cmd === "goal" || cmd === "track") { if (a) send("goal", { n: String(a).slice(0, 64), p: b || {} }); }
    else if (cmd === "identify") { if (a && typeof a === "object") send("identify", { e: { email: a.email, name: a.name, id: a.user_id || a.id } }); }
    else if (cmd === "pageview") pageview(true);
    else if (cmd === "consent") {
      consent = a !== false;
      // "0" remembers a no, so the banner doesn't ask again on every page.
      store("sh_consent", consent ? "1" : "0");
      if (!consent) { store("sh_vid", null); vid = rid(22); }
    }
    else if (cmd === "consent-settings") { if (asks) showBanner(); else reopen = true; }
  }
  // The visit reference: put it in checkout metadata as sh_ref.
  shorthop.ref = function (cb) {
    if (typeof cb === "function") { if (ref) cb(ref); else refListeners.push(cb); }
    return ref;
  };
  shorthop.checkout = withRef;
  shorthop.visitor = function () { return store("sh_vid"); };
  w.shorthop = shorthop;

  // Consent calls queued before load come first, so the first pageview already carries the answer.
  var calls = queued;
  function run(c) { shorthop.apply(null, c); }
  function isConsent(c) { return c[0] === "consent"; }
  for (var i = 0; i < calls.length; i++) if (isConsent(calls[i])) run(calls[i]);
  pageview(true);
  for (var j = 0; j < calls.length; j++) if (!isConsent(calls[j])) run(calls[j]);
})();
