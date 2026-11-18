// The website tracker against a small stand-in for a page. There is no DOM
// library here and no real browser: this checks the script's own logic only.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../../src/tracker/tracker.js", import.meta.url), "utf8");

class FakeScript {
  get [Symbol.toStringTag]() {
    return "HTMLScriptElement";
  }
  constructor(
    readonly src: string,
    private readonly attrs: Record<string, string>,
  ) {}
  hasAttribute(k: string) {
    return k in this.attrs;
  }
  getAttribute(k: string) {
    return this.attrs[k] ?? null;
  }
}

interface Sent {
  url: string;
  body: Record<string, unknown>;
}

interface PageOptions {
  url?: string;
  attrs?: Record<string, string>;
  currentScript?: unknown;
  storage?: Record<string, string>;
  reply?: Record<string, unknown>;
  /** What the collector does instead of a 200 with `reply`. */
  fetchResult?: () => Promise<unknown>;
  /** Replaces the page's setTimeout. */
  setTimer?: (fn: () => void, ms: number) => unknown;
}

function page(opts: PageOptions) {
  let current = new URL(opts.url ?? "https://shop.example.com/");
  const storage = new Map(Object.entries(opts.storage ?? {}));
  const sent: Sent[] = [];
  const nothing = () => undefined;
  const body = { appendChild: nothing, scrollHeight: 100 };
  const banners: string[] = [];
  const window: Record<string, unknown> = {
    get location() {
      return {
        get href() {
          return current.href;
        },
        get search() {
          return current.search;
        },
        get hostname() {
          return current.hostname;
        },
        get protocol() {
          return current.protocol;
        },
        get pathname() {
          return current.pathname;
        },
        get hash() {
          return current.hash;
        },
        get host() {
          return current.host;
        },
      };
    },
    navigator: {},
    screen: { width: 1440 },
    crypto: { getRandomValues: (a: Uint8Array) => a.map((_, i) => (a[i] = (i * 7 + 3) & 255)) },
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) },
    addEventListener: nothing,
    fetch: (url: string, init: { body: string }) => {
      sent.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
      if (opts.fetchResult) return opts.fetchResult();
      return Promise.resolve({ status: 200, json: () => Promise.resolve(opts.reply ?? { s: "visit-ref-0001", m: "p" }) });
    },
  };
  const document = {
    currentScript: "currentScript" in opts ? opts.currentScript : new FakeScript("https://go.example.net/_t/script.js", { "data-site": "st_abc123", ...opts.attrs }),
    referrer: "",
    readyState: "complete",
    visibilityState: "visible",
    links: [],
    body,
    documentElement: { scrollHeight: 100, scrollTop: 0 },
    addEventListener: nothing,
    querySelectorAll: () => [],
    createElement: () => {
      const el = { style: {}, setAttribute: nothing, appendChild: nothing, addEventListener: nothing, parentNode: null, textContent: "", type: "" };
      return new Proxy(el, {
        set(t, k, v) {
          if (k === "textContent") banners.push(String(v));
          return Reflect.set(t, k, v);
        },
      });
    },
  };
  const history = {
    state: null,
    replaceState: (_s: unknown, _t: string, path: string) => {
      current = new URL(path, current);
    },
  };
  const context = vm.createContext({ window, document, history, URL, Blob, setTimeout: opts.setTimer ?? setTimeout, clearTimeout, console });
  vm.runInContext(SOURCE, context);
  const shorthop = window.shorthop as ((...a: unknown[]) => void) & { ref(cb?: (r: string | null) => void): string | null; visitor(): string | null; checkout(u: string): string };
  return { sent, shorthop, storage, banners, href: () => current.href, settle: () => new Promise((r) => setTimeout(r, 0)) };
}

describe("what the tracker trusts on the page", () => {
  it("sends nothing when document.currentScript has been replaced by injected HTML", async () => {
    const fake = { [Symbol.toStringTag]: "HTMLImageElement", src: "https://evil.example/x.js", hasAttribute: () => true, getAttribute: (k: string) => (k === "data-api" ? "https://evil.example/collect" : "st_evil000") };
    const p = page({ currentScript: fake });
    await p.settle();
    assert.deepEqual(p.sent, []);
    assert.equal(p.shorthop.ref(), null);
    assert.equal(p.shorthop.checkout("https://buy.stripe.com/x"), "https://buy.stripe.com/x");
  });

  it("posts to the script's own origin unless data-api says otherwise", async () => {
    const p = page({});
    await p.settle();
    assert.equal(p.sent[0]?.url, "https://go.example.net/_t/e");
  });

  it("takes a relative or https data-api, and refuses a downgrade", async () => {
    const relative = page({ attrs: { "data-api": "/stats/e" } });
    assert.equal(relative.sent[0]?.url, "https://shop.example.com/stats/e");
    assert.equal(page({ attrs: { "data-api": "https://proxy.example.com/e" } }).sent[0]?.url, "https://proxy.example.com/e");
    assert.deepEqual(page({ attrs: { "data-api": "http://proxy.example.com/e" } }).sent, []);
    assert.deepEqual(page({ attrs: { "data-api": "javascript:alert(1)" } }).sent, []);
  });

  it("uses only a well-formed reference from the reply", async () => {
    const p = page({ reply: { s: 'x"><img src=x>', m: "c" } });
    await p.settle();
    assert.equal(p.shorthop.ref(), null);
  });
});

describe("the public functions checkout code uses", () => {
  it("keeps shorthop.ref(), shorthop.visitor() and shorthop.checkout() working", async () => {
    const p = page({});
    await p.settle();
    assert.equal(p.shorthop.ref(), "visit-ref-0001");
    assert.equal(p.shorthop.visitor(), p.storage.get("sh_vid"));
    assert.ok(p.shorthop.visitor());
    assert.ok(p.shorthop.checkout("https://buy.stripe.com/x").includes("client_reference_id=sh_visit-ref-0001"));
  });

  it("has no reference when the server gives none (Global Privacy Control)", async () => {
    const p = page({ reply: { m: "c" } });
    await p.settle();
    assert.equal(p.shorthop.ref(), null);
    assert.equal(p.shorthop.checkout("https://buy.stripe.com/x"), "https://buy.stripe.com/x");
    assert.equal(p.storage.has("sh_vid"), false);
  });
});

describe("shorthop.ref(callback) always answers", () => {
  const calls = (p: ReturnType<typeof page>) => {
    const got: (string | null)[] = [];
    p.shorthop.ref((r) => got.push(r));
    return got;
  };

  it("gives the reference when the server sends one", async () => {
    const p = page({});
    const got = calls(p);
    assert.deepEqual(got, []);
    await p.settle();
    assert.deepEqual(got, ["visit-ref-0001"]);
  });

  it("calls back with null when the reply has none (Global Privacy Control, Do Not Track)", async () => {
    const p = page({ reply: { m: "c" } });
    const got = calls(p);
    await p.settle();
    assert.deepEqual(got, [null]);
    assert.deepEqual(calls(p), [null], "a later caller gets the answer at once");
  });

  it("isn't settled by another event's reply arriving first", async () => {
    let release: (v: unknown) => void = () => undefined;
    const replies = [new Promise((r) => (release = r)), Promise.resolve({ status: 200, json: () => Promise.resolve({ m: "p" }) })];
    let n = 0;
    const p = page({ fetchResult: () => replies[n++]! });
    const got = calls(p);
    p.shorthop("identify", { email: "a@example.com" });
    await p.settle();
    assert.deepEqual(got, [], "the identify reply carries no reference and says nothing about one");
    release({ status: 200, json: () => Promise.resolve({ s: "visit-ref-0001", m: "p" }) });
    await p.settle();
    assert.deepEqual(got, ["visit-ref-0001"]);
  });

  for (const [name, fetchResult] of [
    ["the event wasn't stored (202)", () => Promise.resolve({ status: 202, json: () => Promise.reject(new Error("no body")) })],
    ["the request failed", () => Promise.reject(new Error("blocked"))],
  ] as const) {
    it(`calls back with null when ${name}`, async () => {
      const p = page({ fetchResult });
      const got = calls(p);
      await p.settle();
      assert.deepEqual(got, [null]);
    });
  }

  it("gives up after 3 seconds without an answer, and still uses a late reference", async () => {
    const timers: { fn: () => void; ms: number }[] = [];
    let release: (v: unknown) => void = () => undefined;
    const p = page({ fetchResult: () => new Promise((r) => (release = r)), setTimer: (fn, ms) => timers.push({ fn, ms }) });
    const got = calls(p);
    const wait = timers.find((t) => t.ms === 3000);
    assert.ok(wait);
    wait.fn();
    assert.deepEqual(got, [null]);
    release({ status: 200, json: () => Promise.resolve({ s: "visit-ref-0001", m: "p" }) });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(p.shorthop.ref(), "visit-ref-0001");
    assert.deepEqual(got, [null], "it isn't called twice");
  });

  it("calls back with null when tracking is off", () => {
    const p = page({ storage: { sh_ignore: "1" } });
    assert.deepEqual(calls(p), [null]);
    assert.equal(p.shorthop.visitor(), null);
  });

  it("keeps calling the others when one callback throws", async () => {
    const p = page({ reply: { m: "c" } });
    const got: (string | null)[] = [];
    p.shorthop.ref(() => {
      throw new Error("page bug");
    });
    p.shorthop.ref((r) => got.push(r));
    await p.settle();
    assert.deepEqual(got, [null]);
  });
});

describe("what leaves the address bar and the URL", () => {
  it("removes sh_c at once, also when tracking is off", () => {
    const off = page({ url: "https://shop.example.com/a?sh_c=token123&x=1", storage: { sh_ignore: "1" } });
    assert.equal(off.href(), "https://shop.example.com/a?x=1");
    const bad = page({ url: "https://shop.example.com/a?sh_c=token123", currentScript: null });
    assert.equal(bad.href(), "https://shop.example.com/a");
    const on = page({ url: "https://shop.example.com/a?sh_c=token123" });
    assert.equal(on.sent[0]?.body.c, "token123");
    assert.ok(!String(on.sent[0]?.body.u).includes("sh_c"));
  });

  it("sends a hash-mode route without what follows it, and no other fragment", () => {
    const route = page({ url: "https://shop.example.com/app#/orders/4?token=abc", attrs: { "data-hash": "" } });
    assert.equal(route.sent[0]?.body.u, "https://shop.example.com/app#/orders/4");
    const token = page({ url: "https://shop.example.com/app#access_token=abc", attrs: { "data-hash": "" } });
    assert.equal(token.sent[0]?.body.u, "https://shop.example.com/app");
    assert.equal(page({ url: "https://shop.example.com/app#/x" }).sent[0]?.body.u, "https://shop.example.com/app");
  });
});

describe("consent", () => {
  it("tells the server when consent is taken back, then forgets the id", async () => {
    const p = page({ storage: { sh_consent: "1", sh_vid: "old-browser-id-000001" }, reply: { s: "visit-ref-0001", m: "p", a: 1 } });
    await p.settle();
    assert.equal(p.storage.get("sh_vid"), "old-browser-id-000001");
    p.shorthop("consent", false);
    await p.settle();
    const withdrawn = p.sent.find((s) => s.body.t === "withdraw");
    assert.equal(withdrawn?.body.v, "old-browser-id-000001");
    assert.equal(withdrawn?.body.cs, undefined);
    assert.equal(p.storage.has("sh_vid"), false);
    assert.equal(p.storage.get("sh_consent"), "0");
  });

  it("stops using the old id when consent was taken back in another tab", async () => {
    const p = page({ storage: { sh_consent: "1", sh_vid: "old-browser-id-000001" }, reply: { s: "visit-ref-0001", m: "p", a: 1 } });
    await p.settle();
    p.storage.set("sh_consent", "0");
    p.storage.delete("sh_vid");
    p.shorthop("goal", "signup");
    await p.settle();
    const goal = p.sent.find((s) => s.body.t === "goal");
    assert.notEqual(goal?.body.v, "old-browser-id-000001");
    assert.equal(goal?.body.cs, undefined);
    assert.equal(p.storage.has("sh_vid"), false);
  });

  it("sends nothing when there was no consent to take back", async () => {
    const p = page({ reply: { m: "c" } });
    await p.settle();
    p.shorthop("consent", false);
    assert.equal(p.sent.some((s) => s.body.t === "withdraw"), false);
  });

  it("doesn't promise anything about sharing in the built-in banner", async () => {
    const p = page({ attrs: { "data-consent-banner": "" }, reply: { m: "c", a: 1 } });
    await p.settle();
    assert.ok(p.banners.some((t) => t.includes("random ID")));
    assert.ok(!p.banners.some((t) => /sharing/i.test(t)));
  });
});
