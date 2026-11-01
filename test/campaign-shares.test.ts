// Campaign reports: one shared statistics page for every link with a tag, or a
// picked set, optionally with the revenue credited to them.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { addDays, utcDate } from "../src/shared/dates";
import type { ShareDTO } from "../src/shared/types";
import { API, call, json, ORIGIN, resetData } from "./helpers";
import { addUser, adminCall } from "./people";

const PERSON = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const YESTERDAY = addDays(utcDate(new Date()), -1);

beforeEach(resetData);

async function link(slug: string, tags = "") {
  expect((await call(`${API}/links`, json({ slug, target: `https://example.com/${slug}`, tags }))).status).toBe(201);
}

/** Rolled-up clicks for a link yesterday. */
async function clicks(slug: string, n: number) {
  await env.DB.prepare("INSERT INTO daily_dims (date, domain, slug, dim, value, clicks, uniques, bots) VALUES (?, 'sh.example', ?, 'total', '', ?, ?, 0)").bind(YESTERDAY, slug, n, n).run();
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_rolled', ?)").bind(YESTERDAY).run();
}

const report = async (body: Record<string, unknown>) => {
  const res = await call(`${API}/shares`, json(body));
  return { res, share: res.ok ? ((await res.json()) as { share: ShareDTO }).share : null };
};
const open = (url: string) => call(new Request(url, { headers: { "User-Agent": PERSON, "CF-Connecting-IP": "198.51.100.7" } }));

describe("campaign reports", () => {
  it("keeps a report that shows revenue from people who may not see revenue", async () => {
    await link("a", "launch");
    const { share: money } = await report({ scope: "tag", tag: "launch", title: "With money", showRevenue: true, password: "sponsor password" });
    const { share: plain } = await report({ scope: "tag", tag: "launch", title: "Clicks only" });
    await addUser("editor@example.com", "user", ["stats.view", "links.edit"]);
    const list = await (await adminCall("editor@example.com", "/shares")).json<{ shares: ShareDTO[] }>();
    expect(list.shares.find((s) => s.id === money!.id)).toMatchObject({ url: null, showRevenue: true });
    // Addresses are built on the host asked (localhost here), so compare the share's own path.
    const path = (url: string | null | undefined) => (url ? new URL(url).pathname : null);
    expect(path(list.shares.find((s) => s.id === plain!.id)?.url)).toBe(path(plain!.url));
    expect((await adminCall("editor@example.com", `/shares/${money!.id}`, { method: "PATCH", body: { password: null } })).status).toBe(403);
    expect((await adminCall("editor@example.com", `/shares/${money!.id}`, { method: "DELETE" })).status).toBe(403);
    expect((await adminCall("editor@example.com", `/shares/${plain!.id}`, { method: "PATCH", body: { showRecent: true } })).status).toBe(200);
    // Someone who may see revenue still gets its address.
    const admin = await (await adminCall("", "/shares")).json<{ shares: ShareDTO[] }>();
    expect(path(admin.shares.find((s) => s.id === money!.id)?.url)).toBe(path(money!.url));
  });

  it("shows every link with a tag, including links tagged later", async () => {
    await link("a", "launch");
    await link("b", "launch");
    await link("c", "other");
    await clicks("a", 5);
    await clicks("b", 3);
    await clicks("c", 100);
    const { res, share } = await report({ scope: "tag", tag: "Launch", title: "Launch week" });
    expect(res.status).toBe(201);
    expect(share).toMatchObject({ scope: "tag", tag: "launch", title: "Launch week", status: "active" });

    let html = await (await open(share!.url!)).text();
    expect(html).toContain("Launch week");
    expect(html).toContain("sh.example/a");
    expect(html).not.toContain("sh.example/c");
    expect(html).not.toContain("example.com");
    expect(html).toMatch(/Clicks<\/div><div class="v">8</);

    await link("d", "launch");
    html = await (await open(share!.url!)).text();
    expect(html).toContain("sh.example/d");

    const list = await (await call(`${API}/shares`, { headers: json({}).headers })).json<{ shares: ShareDTO[] }>();
    expect(list.shares.map((s) => s.id)).toEqual([share!.id]);
  });

  it("shows a picked set, and leaves out links deleted since", async () => {
    await link("a");
    await link("b");
    await clicks("a", 2);
    const { share } = await report({ scope: "set", title: "Sponsor: Acme", links: [{ domain: "sh.example", slug: "a" }, { domain: "sh.example", slug: "b" }] });
    expect(share!.links).toEqual(["sh.example/a", "sh.example/b"]);
    await call(`${API}/links/sh.example/b`, { method: "DELETE", headers: json({}).headers });
    const html = await (await open(share!.url!)).text();
    expect(html).toContain("Sponsor: Acme");
    expect(html).toContain("sh.example/a");
    expect(html).not.toContain("sh.example/b");
  });

  it("shows revenue only when asked, and only by people who may see it", async () => {
    await link("a", "launch");
    const plain = await report({ scope: "tag", tag: "launch", title: "No money" });
    expect(await (await open(plain.share!.url!)).text()).not.toContain("Revenue");
    const money = await report({ scope: "tag", tag: "launch", title: "With money", showRevenue: true });
    expect(await (await open(money.share!.url!)).text()).toContain("Revenue");

    await addUser("editor@example.com", "user", ["stats.view", "links.edit"]);
    const refused = await adminCall("editor@example.com", "/shares", { body: { scope: "tag", tag: "launch", title: "x", showRevenue: true } });
    expect(refused.status).toBe(403);
  });

  it("needs a tag or links, and a title", async () => {
    expect((await report({ scope: "tag", title: "x" })).res.status).toBe(400);
    expect((await report({ scope: "set", title: "x", links: [] })).res.status).toBe(400);
    expect((await report({ scope: "tag", tag: "a" })).res.status).toBe(400);
  });

  it("ends when revoked", async () => {
    await link("a", "t");
    const { share } = await report({ scope: "tag", tag: "t", title: "T" });
    await call(`${API}/shares/${share!.id}`, { ...json({ revoke: true }), method: "PATCH" });
    expect((await open(share!.url!)).status).toBe(410);
    expect(ORIGIN).toBeTruthy();
  });
});
