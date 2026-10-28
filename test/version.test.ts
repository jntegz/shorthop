import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nowSec } from "../src/worker/db";
import { appVersion, isNewer } from "../src/worker/version";
import { API, bearer, call, resetData } from "./helpers";

const release = (tag: string) => Response.json({ tag_name: tag, html_url: `https://github.com/jntegz/shorthop/releases/tag/${tag}` });
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  await resetData();
  await env.DB.prepare("DELETE FROM settings WHERE key = 'latest_release'").run();
  fetchMock = vi.fn(async () => release("v1.2.0"));
  vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);
});

afterEach(() => vi.restoreAllMocks());

describe("version notice", () => {
  it("compares versions", () => {
    expect(isNewer("1.2.0", "1.1.1")).toBe(true);
    expect(isNewer("v1.10.0", "1.9.9")).toBe(true);
    expect(isNewer("1.1.1", "1.1.1")).toBe(false);
    expect(isNewer("1.1.0", "1.1.1")).toBe(false);
    expect(isNewer("1.2.0", "dev")).toBe(false);
  });

  it("asks GitHub once, then answers from D1 for a day", async () => {
    const now = nowSec();
    const v = await appVersion(env, now, "1.1.1");
    expect(v).toEqual({ current: "1.1.1", latest: "1.2.0", url: "https://github.com/jntegz/shorthop/releases/tag/v1.2.0", checkedAt: now, updateAvailable: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://api.github.com/repos/jntegz/shorthop/releases/latest");

    expect(await appVersion(env, now + 3600, "1.1.1")).toEqual(v);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockImplementation(async () => release("v1.2.1"));
    expect(await appVersion(env, now + 25 * 3600, "1.1.1")).toMatchObject({ latest: "1.2.1", checkedAt: now + 25 * 3600 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("says nothing when it's the latest release", async () => {
    expect(await appVersion(env, nowSec(), "1.2.0")).toMatchObject({ current: "1.2.0", latest: "1.2.0", updateAvailable: false });
  });

  it("stays quiet when GitHub is down or answers nonsense, and asks again next time", async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error("network down");
    });
    expect(await appVersion(env, nowSec(), "1.1.1")).toEqual({ current: "1.1.1", latest: null, url: null, checkedAt: null, updateAvailable: false });
    fetchMock.mockImplementation(async () => new Response("rate limited", { status: 403 }));
    expect((await appVersion(env, nowSec(), "1.1.1")).latest).toBeNull();
    fetchMock.mockImplementation(async () => Response.json({ tag_name: "nightly" }));
    expect((await appVersion(env, nowSec(), "1.1.1")).latest).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("is served to people who manage the workspace", async () => {
    const res = await call(`${API}/settings/version`, { headers: bearer });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ latest: "1.2.0" });
  });
});
