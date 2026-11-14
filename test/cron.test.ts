import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isCleanupRun, isRevenueRun, isWebRollupRun, lastJobRun } from "../src/worker/health";
import worker from "../src/worker/index";
import { RUNS_PER_DAY } from "../src/worker/link-check";
import { enableChecks, resetData } from "./helpers";
// The crons the setup writes, as text (the config has comments).
import wranglerText from "../wrangler.example.jsonc?raw";

beforeEach(resetData);
afterEach(() => vi.restoreAllMocks());

async function cron(cronText: string, at: Date, extra: Partial<Env> = {}) {
  const ctx = createExecutionContext();
  await worker.scheduled({ cron: cronText, scheduledTime: at.getTime(), noRetry() {} } as ScheduledController, { ...env, ...extra }, ctx);
  await waitOnExecutionContext(ctx);
}

/** Just enough of an R2 bucket for the backup job. */
function memoryBucket() {
  const objects = new Map<string, string>();
  const bucket = {
    put: async (key: string, value: string) => void objects.set(key, value),
    list: async ({ prefix }: { prefix: string }) => ({ objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), delimitedPrefixes: [] }),
    delete: async (keys: string[]) => keys.forEach((k) => objects.delete(k)),
  } as unknown as R2Bucket;
  return { objects, bucket };
}

const errors = () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  return () => spy.mock.calls.map((c) => String(c[0]));
};

describe("cron dispatch", () => {
  it("names the digest's weekday, in the config and in the handler alike", async () => {
    const crons = /"crons":\s*\[([^\]]*)\]/.exec(wranglerText)![1]!;
    expect(crons).toContain('"0 7 * * MON"');
    expect(crons).not.toContain('"0 7 * * 1"');
    // The handler answers to every configured cron: none is logged as unknown.
    const logged = errors();
    for (const c of crons.split(",").map((s) => s.trim().replace(/^"|"$/g, ""))) await cron(c, new Date("2026-11-09T07:00:00Z"));
    expect(logged().filter((m) => m.includes("unknown cron"))).toEqual([]);
  });

  it("runs nothing for an unknown cron, and says so", async () => {
    const logged = errors();
    await cron("5 4 * * *", new Date("2026-11-09T04:05:00Z"));
    expect(logged().filter((m) => m.includes("unknown cron")).length).toBe(1);
    expect(await lastJobRun(env.DB, "rollup")).toBeNull();
    expect(await lastJobRun(env.DB, "digest")).toBeNull();
  });

  it("still sends the digest for the weekday number an older config has", async () => {
    const logged = errors();
    await cron("0 7 * * 1", new Date("2026-11-08T07:00:00Z"));
    expect(logged().filter((m) => m.includes("unknown cron"))).toEqual([]);
    // The digest job's rollup ran (the digest itself is skipped: no email is set up here).
    expect(await lastJobRun(env.DB, "rollup")).not.toBeNull();
  });

  it("does the daily run from the hourly cron at 01:15 only, or by its local name", async () => {
    await cron("15 * * * *", new Date("2026-11-09T10:15:00Z"));
    expect(await lastJobRun(env.DB, "rollup")).toBeNull();
    await cron("15 * * * *", new Date("2026-11-09T01:15:00Z"));
    expect(await lastJobRun(env.DB, "rollup")).not.toBeNull();
    await env.DB.prepare("DELETE FROM settings WHERE key = 'job_runs'").run();
    await cron("15 1 * * *", new Date("2026-11-09T10:40:00Z"));
    expect(await lastJobRun(env.DB, "rollup")).not.toBeNull();
  });

  it("goes back to destination checks once Sunday's backup is complete", async () => {
    await enableChecks();
    const { objects, bucket } = memoryBucket();
    const withBucket = { BACKUPS: bucket } as unknown as Partial<Env>;
    const sunday = new Date("2026-11-01T04:00:00Z");
    const slot = (n: number) => new Date(sunday.getTime() + n * 30 * 60_000);

    // Slots copy the backup until the manifest is written; none of them checks destinations.
    let slots = 0;
    while (![...objects.keys()].some((k) => k.endsWith("/manifest.json")) && slots < 8) {
      await cron("*/30 * * * *", slot(slots), withBucket);
      slots++;
    }
    expect([...objects.keys()].some((k) => k.endsWith("/manifest.json"))).toBe(true);
    expect(slots).toBeLessThan(8);
    expect(await lastJobRun(env.DB, "links")).toBeNull();
    const written = objects.size;

    // The next Sunday slot has no backup left to do: the usual run.
    await cron("*/30 * * * *", slot(slots), withBucket);
    expect(await lastJobRun(env.DB, "links")).toMatchObject({ ok: true });
    expect(objects.size).toBe(written);
  });

  it("checks destinations in Sunday's slots when no bucket is bound", async () => {
    await enableChecks();
    await cron("*/30 * * * *", new Date("2026-11-01T04:00:00Z"));
    expect(await lastJobRun(env.DB, "links")).toMatchObject({ ok: true });
  });

  it("counts the runs a day that check destinations", () => {
    const day = Array.from({ length: 48 }, (_, i) => new Date(Date.UTC(2026, 10, 9, 0, i * 30)));
    // The slots the half-hourly cron gives to other work (src/worker/index.ts), on a weekday.
    const other = day.filter((d) => isCleanupRun(d) || isWebRollupRun(d) || isRevenueRun(d));
    expect(other).toHaveLength(3);
    expect(RUNS_PER_DAY).toBe(day.length - other.length);
  });
});
