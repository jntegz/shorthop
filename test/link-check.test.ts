import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOWN_AFTER_FAILS, everyText, isFetchableUrl, MAX_HOPS, nextRecord, OK_INTERVAL, okIntervalFor, spreadByHost, type CheckOutcome } from "../src/shared/link-check";
import type { LinkChecksDTO, LinkListItem, TargetCheckDTO } from "../src/shared/types";
import { isCleanupRun, isRevenueRun, isWebRollupRun, systemHealth } from "../src/worker/health";
import worker from "../src/worker/index";
import { checkUrl, runLinkChecks } from "../src/worker/link-check";
import { API, bearer, call, enableChecks, json, resetData } from "./helpers";

/** Now, unless that's the half-hourly cron's 02:00 cleanup, 02:30 website rollup or 03:00 revenue slot (UTC): then two hours earlier, so the run checks destinations. */
const checksRunTime = () => {
  const now = new Date();
  return isCleanupRun(now) || isWebRollupRun(now) || isRevenueRun(now) ? Date.now() - 2 * 3600_000 : Date.now();
};

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;
let routes: Record<string, Route>;
let fetchMock: ReturnType<typeof vi.fn>;
/** Requests made to sites, as "METHOD url" (email API calls excluded). */
const visited = () =>
  fetchMock.mock.calls
    .map(([u, init]) => `${(init as RequestInit | undefined)?.method ?? "GET"} ${String(u)}`)
    .filter((c) => !c.includes("api.resend.com"));
const emails = () =>
  fetchMock.mock.calls
    .filter(([u]) => String(u).includes("api.resend.com"))
    .map(([, init]) => JSON.parse((init as RequestInit).body as string) as { subject: string; text: string });

beforeEach(async () => {
  await resetData();
  routes = {};
  fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url.startsWith("https://api.resend.com")) return new Response(JSON.stringify({ id: "msg" }), { status: 200 });
    const route = routes[url];
    if (!route) throw new TypeError(`unexpected fetch ${url}`);
    return route(url, init);
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);
});
afterEach(() => vi.restoreAllMocks());

// Response() only takes 200–599, but real servers send others (LinkedIn's 999).
const status = (code: number, headers: Record<string, string> = {}) => () =>
  code > 599 ? ({ status: code, headers: new Headers(headers), body: null } as unknown as Response) : new Response(null, { status: code, headers });
const redirect = (location: string, code = 301) => status(code, { Location: location });
/** HEAD answers `head`, GET answers `get`. */
const byMethod = (head: number, get: number): Route => (_u, init) => new Response(null, { status: init.method === "HEAD" ? head : get });

const mailEnv = { ...env, DIGEST_PROVIDER: "resend", DIGEST_API_KEY: "re_key" } as unknown as Env;

/** A link with its destination check on (it's off unless asked for). */
async function createLink(slug: string, target: string, extra: Record<string, unknown> = {}) {
  const res = await call(`${API}/links`, json({ slug, target, monitor: true, ...extra }));
  expect(res.status).toBe(201);
}
/** Makes every stored check due again, as if time had passed. */
const makeDue = () => env.DB.prepare("UPDATE target_checks SET next_at = 0").run();
const row = (target: string) => env.DB.prepare("SELECT * FROM target_checks WHERE target = ?").bind(target).first<Record<string, unknown>>();

describe("outbound URL safety", () => {
  it.each([
    ["https://example.com/a", true],
    ["http://example.com:8080/", true],
    ["https://example.com:22/", false],
    ["ftp://example.com/", false],
    ["https://user:pw@example.com/", false],
    ["http://localhost/", false],
    ["http://intranet/", false],
    ["http://printer.local/", false],
    ["http://127.0.0.1/", false],
    ["http://2130706433/", false],
    ["http://10.1.2.3/", false],
    ["http://172.20.0.1/", false],
    ["http://192.168.1.1/", false],
    ["http://169.254.169.254/latest/meta-data", false],
    ["http://100.64.0.1/", false],
    ["http://8.8.8.8/", true],
    ["http://[::1]/", false],
    ["http://[fd00::1]/", false],
    ["http://[fe80::1]/", false],
    ["http://[::ffff:127.0.0.1]/", false],
    ["http://[::127.0.0.1]/", false],
    ["http://[::a9fe:a9fe]/", false],
    ["http://[64:ff9b::10.0.0.1]/", false],
    ["http://[64:ff9b::8.8.8.8]/", true],
    ["http://[2002:7f00:1::]/", false],
    ["http://[2002:808:808::1]/", true],
    ["http://[2001:0:4136:e378::1]/", false],
    ["http://[0:0:0:0:0:ffff:a00:1]/", false],
    ["http://[2606:4700::1111]/", true],
  ])("%s → %s", (url, ok) => {
    expect(isFetchableUrl(new URL(url))).toBe(ok);
  });
});

describe("status model", () => {
  const fail: CheckOutcome = { kind: "fail", httpStatus: 404, problem: "not_found", finalUrl: null, hops: 0, ms: 5 };
  const ok: CheckOutcome = { kind: "ok", httpStatus: 200, problem: null, finalUrl: null, hops: 0, ms: 5 };

  it("needs repeated failures before a destination counts as not working", () => {
    let rec = nextRecord(null, fail, 1000);
    expect(rec).toMatchObject({ status: "warning", fails: 1, since: 1000 });
    expect(rec.nextAt - 1000).toBe(3600);
    for (let i = 2; i <= DOWN_AFTER_FAILS; i++) rec = nextRecord(rec, fail, 1000 * i);
    expect(rec).toMatchObject({ status: "down", fails: DOWN_AFTER_FAILS, since: 1000 * DOWN_AFTER_FAILS, lastOkAt: null });
    const again = nextRecord({ ...rec, notified: true }, fail, 9000);
    expect(again).toMatchObject({ status: "down", since: rec.since, notified: true });
  });

  it("recovers on one success and never escalates sites that refuse checks", () => {
    const down = { status: "down" as const, fails: 4, since: 1, lastOkAt: null, notified: true };
    expect(nextRecord(down, ok, 50)).toMatchObject({ status: "ok", fails: 0, since: 50, lastOkAt: 50, notified: false });
    const blocked: CheckOutcome = { ...fail, kind: "blocked", httpStatus: 403, problem: "refused" };
    expect(nextRecord(nextRecord(null, blocked, 1), blocked, 2)).toMatchObject({ status: "blocked", fails: 0, since: 1 });
  });
});

describe("guardrails for large collections", () => {
  it("stretches the interval only when the schedule can't keep up", () => {
    expect(okIntervalFor(100, 1200)).toBe(OK_INTERVAL); // 24 hours
    expect(okIntervalFor(900, 1200)).toBe(OK_INTERVAL);
    expect(okIntervalFor(1000, 1200)).toBe(27 * 3600); // a little over a day, with room for retries
    expect(okIntervalFor(5000, 1200)).toBe(134 * 3600);
    // The chosen frequency is the floor; capacity can only stretch it.
    expect(okIntervalFor(100, 1200, 168 * 3600)).toBe(168 * 3600);
    expect(okIntervalFor(1000, 1200, 24 * 3600)).toBe(27 * 3600);
    expect(okIntervalFor(10, 1200, 3600)).toBe(3600);
    const ok: CheckOutcome = { kind: "ok", httpStatus: 200, problem: null, finalUrl: null, hops: 0, ms: 5 };
    expect(nextRecord(null, ok, 0, 27 * 3600).nextAt).toBe(27 * 3600);
  });

  it("checks at most a couple of pages of one site per run", () => {
    const items = ["https://a.com/1", "https://www.a.com/2", "https://a.com/3", "https://b.com/1", "https://a.com/4", "https://c.com/"].map((target) => ({ target }));
    expect(spreadByHost(items, 10, 2).map((i) => i.target)).toEqual(["https://a.com/1", "https://www.a.com/2", "https://b.com/1", "https://c.com/"]);
    expect(spreadByHost(items, 2, 2)).toHaveLength(2);
  });
});

describe("checking one destination", () => {
  const T = "https://site.example/page";
  const check = (budget = { left: 40 }) => checkUrl(T, budget);

  it("accepts a plain 200 with a single HEAD request", async () => {
    routes[T] = status(200);
    const budget = { left: 40 };
    expect(await check(budget)).toMatchObject({ kind: "ok", httpStatus: 200, hops: 0, finalUrl: null });
    expect(visited()).toEqual([`HEAD ${T}`]);
    expect(budget.left).toBe(39);
  });

  it("retries with GET when HEAD isn't supported", async () => {
    routes[T] = byMethod(405, 200);
    expect(await check()).toMatchObject({ kind: "ok", httpStatus: 200 });
    expect(visited()).toEqual([`HEAD ${T}`, `GET ${T}`]);
  });

  it.each([
    [404, "fail", "not_found"],
    [410, "fail", "gone"],
    [500, "fail", "server_error"],
    [400, "fail", "client_error"],
    [530, "fail", "dns"],
    [526, "fail", "tls"],
    [403, "blocked", "refused"],
    [429, "blocked", "refused"],
    [999, "blocked", "refused"],
  ])("HTTP %i is %s (%s)", async (code, kind, problem) => {
    routes[T] = status(code);
    expect(await check()).toMatchObject({ kind, problem, httpStatus: code });
  });

  it("treats a Cloudflare challenge as a site refusing checks", async () => {
    routes[T] = status(503, { "cf-mitigated": "challenge" });
    expect(await check()).toMatchObject({ kind: "blocked", problem: "refused" });
  });

  it("follows relative redirects and reports where they end", async () => {
    routes[T] = redirect("/new");
    routes["https://site.example/new"] = status(200);
    expect(await check()).toMatchObject({ kind: "ok", hops: 1, finalUrl: "https://site.example/new" });
  });

  it("never follows a redirect to a private address", async () => {
    routes[T] = redirect("http://169.254.169.254/latest/meta-data");
    expect(await check()).toMatchObject({ kind: "fail", problem: "unsafe_redirect", hops: 1 });
    expect(visited()).toEqual([`HEAD ${T}`]);
  });

  it("gives up after too many redirects", async () => {
    routes[T] = redirect(T);
    expect(await check()).toMatchObject({ kind: "fail", problem: "too_many_redirects", hops: MAX_HOPS });
    expect(visited()).toHaveLength(MAX_HOPS + 1);
  });

  it("names network errors and timeouts", async () => {
    routes[T] = () => {
      throw new TypeError("Network connection lost.");
    };
    expect(await check()).toMatchObject({ kind: "fail", problem: "network", httpStatus: null });
    routes[T] = () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    expect(await check()).toMatchObject({ kind: "fail", problem: "timeout" });
  });

  it("stops without a verdict when the budget runs out", async () => {
    routes[T] = redirect("/next");
    routes["https://site.example/next"] = status(200);
    expect(await check({ left: 1 })).toBeNull();
  });
});

describe("frequency wording", () => {
  it("says how often in words", () => {
    expect([1, 12, 24, 48, 72, 168, 336].map(everyText)).toEqual(["every hour", "every 12 hours", "once a day", "every 2 days", "every 3 days", "once a week", "every 14 days"]);
  });
});

describe("automatic checking", () => {
  it("is off until activated, while Check now still works", async () => {
    routes["https://a.example/"] = status(200);
    await createLink("one", "https://a.example/");
    const list = (await (await call(`${API}/checks`, { headers: bearer })).json()) as LinkChecksDTO;
    expect(list.settings).toEqual({ enabled: false, notify: true, everyHours: 24, scope: "selected" });
    expect(await runLinkChecks(env)).toMatchObject({ checked: 0, skipped: expect.any(String) });

    const ctx = createExecutionContext();
    await worker.scheduled({ cron: "*/30 * * * *", scheduledTime: checksRunTime(), noRetry() {} } as ScheduledController, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await row("https://a.example/")).toBeNull();
    expect((await systemHealth(env)).checks.find((c) => c.id === "links")).toMatchObject({ status: "ok", detail: expect.stringContaining("Activate automatic checking") });

    const now = await call(`${API}/checks/links/sh.example/one`, { method: "POST", headers: bearer });
    expect(await now.json()).toMatchObject({ automatic: false, check: { state: "ok" } });
  });

  it("schedules working destinations at the chosen frequency", async () => {
    routes["https://a.example/"] = status(200);
    await createLink("one", "https://a.example/");
    await enableChecks(72);
    await runLinkChecks(env);
    const r = (await row("https://a.example/")) as { next_at: number; checked_at: number };
    expect(r.next_at - r.checked_at).toBeGreaterThanOrEqual(72 * 3600);
    expect(r.next_at - r.checked_at).toBeLessThan(72 * 3600 + 1800);
  });

  it("reschedules working destinations when the frequency changes, but not failing ones", async () => {
    routes["https://a.example/"] = status(200);
    routes["https://b.example/"] = status(404);
    await createLink("one", "https://a.example/");
    await createLink("two", "https://b.example/");
    await enableChecks(168);
    await runLinkChecks(env);
    const warningBefore = (await row("https://b.example/"))!.next_at;

    await enableChecks(24);
    const ok = (await row("https://a.example/")) as { next_at: number; checked_at: number };
    expect(ok.next_at - ok.checked_at).toBeGreaterThanOrEqual(24 * 3600);
    expect(ok.next_at - ok.checked_at).toBeLessThan(24 * 3600 + 1800);
    expect((await row("https://b.example/"))!.next_at).toBe(warningBefore);
  });

  it("validates the frequency and keeps what isn't sent", async () => {
    await enableChecks(72);
    const put = (body: unknown) => call(`${API}/checks/settings`, { ...json(body), method: "PUT" });
    expect((await put({ everyHours: 0 })).status).toBe(400);
    expect((await put({ everyHours: 721 })).status).toBe(400);
    const res = await put({ enabled: true, notify: false });
    expect(await res.json()).toEqual({ settings: { enabled: true, notify: false, everyHours: 72, scope: "selected" } });
    expect((await put({ scope: "some" })).status).toBe(400);
    expect(await (await put({ scope: "all" })).json()).toEqual({ settings: { enabled: true, notify: false, everyHours: 72, scope: "all" } });
  });
});

describe("scheduled runs", () => {
  beforeEach(() => enableChecks());

  it("checks each live destination once and skips links that shouldn't be checked", async () => {
    routes["https://a.example/"] = status(200);
    routes["https://b.example/"] = status(404);
    await createLink("one", "https://a.example/");
    await createLink("two", "https://a.example/");
    await createLink("three", "https://b.example/");
    await createLink("off", "https://c.example/", { active: false });
    await createLink("quiet", "https://d.example/", { monitor: false });
    await createLink("old", "https://e.example/", { expiresAt: 1_000_000 });

    const r = await runLinkChecks(env);
    expect(r).toMatchObject({ checked: 2, remaining: 0 });
    expect(visited().sort()).toEqual(["GET https://b.example/", "HEAD https://a.example/", "HEAD https://b.example/"]);
    expect(await row("https://a.example/")).toMatchObject({ status: "ok", http_status: 200 });
    expect(await row("https://b.example/")).toMatchObject({ status: "warning", problem: "not_found", fails: 1 });

    // Nothing is due again until its time comes.
    fetchMock.mockClear();
    expect(await runLinkChecks(env)).toMatchObject({ checked: 0 });
    expect(visited()).toEqual([]);
  });

  it("emails once when a destination is confirmed down, and again when it works", async () => {
    routes["https://gone.example/"] = status(404);
    await createLink("gone", "https://gone.example/");
    for (let i = 1; i < DOWN_AFTER_FAILS; i++) {
      await runLinkChecks(mailEnv);
      await makeDue();
    }
    expect(emails()).toHaveLength(0);
    const r = await runLinkChecks(mailEnv);
    expect(r.newlyDown).toEqual(["https://gone.example/"]);
    expect(emails()).toHaveLength(1);
    expect(emails()[0]).toMatchObject({ subject: "Shorthop: a link stopped working", text: expect.stringContaining("/gone") });
    expect(emails()[0]!.text).toContain("Page not found (HTTP 404)");
    expect(await row("https://gone.example/")).toMatchObject({ status: "down", notified: 1 });

    await makeDue();
    await runLinkChecks(mailEnv);
    expect(emails()).toHaveLength(1); // still down: not repeated

    routes["https://gone.example/"] = status(200);
    await makeDue();
    await runLinkChecks(mailEnv);
    expect(emails()).toHaveLength(2);
    expect(emails()[1]!.subject).toBe("Shorthop: a link works again");
  });

  it("spreads a site's many links over several runs", async () => {
    for (let i = 0; i < 5; i++) {
      routes[`https://big.example/p${i}`] = status(200);
      await createLink(`big${i}`, `https://big.example/p${i}`);
    }
    routes["https://small.example/"] = status(200);
    await createLink("small", "https://small.example/");
    expect(await runLinkChecks(env)).toMatchObject({ checked: 3 });
    const hosts = visited().map((v) => new URL(v.split(" ")[1]!).host);
    expect(hosts.filter((h) => h === "big.example")).toHaveLength(2);
    expect(hosts).toContain("small.example");
    expect(await runLinkChecks(env)).toMatchObject({ checked: 2 });
  });

  it("does nothing while turned off, and forgets destinations no link uses", async () => {
    routes["https://a.example/"] = status(200);
    await createLink("one", "https://a.example/");
    await call(`${API}/checks/settings`, { ...json({ enabled: false, notify: true }), method: "PUT" });
    expect(await runLinkChecks(env)).toMatchObject({ checked: 0, skipped: expect.any(String) });

    await call(`${API}/checks/settings`, { ...json({ enabled: true, notify: true }), method: "PUT" });
    await runLinkChecks(env);
    expect(await row("https://a.example/")).not.toBeNull();
    await call(`${API}/links/sh.example/one`, { method: "DELETE", headers: bearer });
    await runLinkChecks(env);
    expect(await row("https://a.example/")).toBeNull();
  });

  it("runs from the half-hourly cron and shows in the system status", async () => {
    routes["https://a.example/"] = status(200);
    await createLink("one", "https://a.example/");
    const ctx = createExecutionContext();
    await worker.scheduled({ cron: "*/30 * * * *", scheduledTime: checksRunTime(), noRetry() {} } as ScheduledController, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await row("https://a.example/")).toMatchObject({ status: "ok" });
    const check = (await systemHealth(env)).checks.find((c) => c.id === "links");
    expect(check).toMatchObject({ status: "ok", detail: expect.stringContaining("Last run") });
  });

  it("checks every link but those set to never be checked when the scope is all links", async () => {
    routes["https://a.example/"] = status(200);
    routes["https://b.example/"] = status(200);
    await createLink("chosen", "https://a.example/");
    await createLink("plain", "https://b.example/", { monitor: false });
    await createLink("never", "https://c.example/", { monitor: false, neverCheck: true });

    expect(await runLinkChecks(env)).toMatchObject({ checked: 1 });
    expect(visited()).toEqual(["HEAD https://a.example/"]);

    fetchMock.mockClear();
    await call(`${API}/checks/settings`, { ...json({ scope: "all" }), method: "PUT" });
    expect(await runLinkChecks(env)).toMatchObject({ checked: 1 });
    expect(visited()).toEqual(["HEAD https://b.example/"]);

    const list = (await (await call(`${API}/checks`, { headers: bearer })).json()) as LinkChecksDTO;
    expect(list.items.map((i) => i.target).sort()).toEqual(["https://a.example/", "https://b.example/"]);
    expect(list.excluded).toBe(1);
    const never = await (await call(`${API}/checks/links/sh.example/never`, { headers: bearer })).json();
    expect(never).toMatchObject({ monitored: false, reason: "This link is set to never be checked.", scope: "all" });
    const plain = await (await call(`${API}/checks/links/sh.example/plain`, { headers: bearer })).json();
    expect(plain).toMatchObject({ monitored: true, scope: "all" });
  });
});

describe("checks API", () => {
  beforeEach(() => enableChecks());

  it("lists destinations with their links, and filters the links list by problems", async () => {
    routes["https://a.example/"] = status(200);
    routes["https://b.example/"] = status(500);
    await createLink("one", "https://a.example/");
    await createLink("two", "https://a.example/", { title: "Second" });
    await createLink("three", "https://b.example/");
    await createLink("quiet", "https://d.example/", { monitor: false });
    await runLinkChecks(env);

    const list = (await (await call(`${API}/checks`, { headers: bearer })).json()) as LinkChecksDTO;
    expect(list.settings).toEqual({ enabled: true, notify: true, everyHours: 24, scope: "selected" });
    expect(list.excluded).toBe(1);
    expect(list.lastRun).toBeNull(); // only the cron records a run
    const a = list.items.find((i) => i.target === "https://a.example/")!;
    expect(a).toMatchObject({ state: "ok", httpStatus: 200 });
    expect(a.links.map((l) => l.slug)).toEqual(["one", "two"]);
    expect(list.items.find((i) => i.target === "https://b.example/")).toMatchObject({ state: "warning", problem: "server_error" });

    const failing = (await (await call(`${API}/links?status=failing`, { headers: bearer })).json()) as { links: LinkListItem[] };
    expect(failing.links.map((l) => l.slug)).toEqual(["three"]);
    expect(failing.links[0]!.check).toMatchObject({ state: "warning", problem: "server_error", httpStatus: 500 });
  });

  it("checks one link on demand and explains links that aren't checked", async () => {
    routes["https://a.example/"] = status(200);
    await createLink("one", "https://a.example/");
    const before = (await (await call(`${API}/checks/links/sh.example/one`, { headers: bearer })).json()) as { check: TargetCheckDTO; monitored: boolean };
    expect(before).toMatchObject({ monitored: true, check: { state: "unchecked" } });

    const res = await call(`${API}/checks/links/sh.example/one`, { method: "POST", headers: bearer });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ monitored: true, check: { state: "ok", httpStatus: 200 } });

    await call(`${API}/links/sh.example/one`, { ...json({ monitor: false }), method: "PATCH" });
    const off = await (await call(`${API}/checks/links/sh.example/one`, { headers: bearer })).json();
    expect(off).toMatchObject({ monitored: false, reason: "Checks are turned off for this link." });
    expect((await call(`${API}/checks/links/sh.example/nope`, { headers: bearer })).status).toBe(404);
  });

  it("leaves a new link unchecked unless asked", async () => {
    expect((await call(`${API}/links`, json({ slug: "plain", target: "https://a.example/" }))).status).toBe(201);
    const { link } = (await (await call(`${API}/links/sh.example/plain`, { headers: bearer })).json()) as { link: { monitor: boolean } };
    expect(link.monitor).toBe(false);
    const state = await (await call(`${API}/checks/links/sh.example/plain`, { headers: bearer })).json();
    expect(state).toMatchObject({ monitored: false, reason: "Checks are turned off for this link." });
  });

  it("keeps the check switch and never-check apart", async () => {
    const link = async () =>
      ((await (await call(`${API}/links/sh.example/x`, { headers: bearer })).json()) as { link: { monitor: boolean; neverCheck: boolean } }).link;
    const patch = (body: unknown) => call(`${API}/links/sh.example/x`, { ...json(body), method: "PATCH" });
    await createLink("x", "https://a.example/", { neverCheck: true });
    expect(await link()).toEqual(expect.objectContaining({ monitor: false, neverCheck: true }));
    await patch({ monitor: false });
    expect(await link()).toEqual(expect.objectContaining({ monitor: false, neverCheck: true }));
    await patch({ monitor: true });
    expect(await link()).toEqual(expect.objectContaining({ monitor: true, neverCheck: false }));
    await patch({ neverCheck: true });
    expect(await link()).toEqual(expect.objectContaining({ monitor: false, neverCheck: true }));
    await patch({ neverCheck: false });
    expect(await link()).toEqual(expect.objectContaining({ monitor: false, neverCheck: false }));
  });

  it("rechecks problems on request", async () => {
    routes["https://b.example/"] = status(404);
    await createLink("three", "https://b.example/");
    await runLinkChecks(env);
    fetchMock.mockClear();
    routes["https://b.example/"] = status(200);
    const res = await call(`${API}/checks/recheck`, { method: "POST", headers: bearer });
    expect(await res.json()).toEqual({ checked: 1, remaining: 0 });
    expect(await row("https://b.example/")).toMatchObject({ status: "ok" });
  });
});
