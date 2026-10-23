import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { change } from "../src/shared/change";
import { addDays } from "../src/shared/dates";
import { linkStats, overview } from "../src/worker/stats-data";
import { resetData } from "./helpers";

const NOW = new Date("2026-10-20T12:00:00Z");
const TODAY = "2026-10-20";

async function day(date: string, slug: string, clicks: number, uniques = clicks, bots = 0) {
  await env.DB.prepare("INSERT INTO daily_dims (date, domain, slug, dim, value, clicks, uniques, bots) VALUES (?, 'sh.example', ?, 'total', '', ?, ?, ?)")
    .bind(date, slug, clicks, uniques, bots)
    .run();
}

beforeEach(async () => {
  await resetData();
  // Last 7 days (6 completed, today in progress): 10 a day for guide, 2 for other.
  for (let i = 1; i <= 6; i++) {
    await day(addDays(TODAY, -i), "guide", 10, 8, 1);
    await day(addDays(TODAY, -i), "other", 2);
  }
  // The 6 days before: 5 a day for guide.
  for (let i = 7; i <= 12; i++) await day(addDays(TODAY, -i), "guide", 5, 4);
  // Outside both windows.
  await day(addDays(TODAY, -13), "guide", 1000);
  // Stats read rollups up to the last rolled-up day.
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('last_rolled', ?)").bind(addDays(TODAY, -1)).run();
});

describe("comparison with the previous period", () => {
  it("compares completed days with the same number of days before", async () => {
    const s = await linkStats(env, "sh.example", "guide", { range: "7d" }, NOW);
    expect(s.comparison).toMatchObject({
      current: { from: "2026-10-14", to: "2026-10-19", clicks: 60, uniques: 48, bots: 6 },
      previous: { from: "2026-10-08", to: "2026-10-13", clicks: 30, uniques: 24, bots: 0 },
    });
    expect(s.comparison!.series).toHaveLength(6);
    expect(s.comparison!.series[0]).toEqual({ date: "2026-10-08", clicks: 5, uniques: 4, bots: 0 });
  });

  it("covers every link on the dashboard", async () => {
    const o = await overview(env, { range: "7d" }, NOW);
    expect(o.comparison).toMatchObject({ current: { clicks: 72 }, previous: { clicks: 30 } });
  });

  it("uses a custom period's own length", async () => {
    const s = await linkStats(env, "sh.example", "guide", { range: "custom", from: "2026-10-16", to: "2026-10-18" }, NOW);
    expect(s.comparison).toMatchObject({ current: { from: "2026-10-16", to: "2026-10-18", clicks: 30 }, previous: { from: "2026-10-13", to: "2026-10-15", clicks: 25 } });
  });

  it("has nothing to compare for today or all time", async () => {
    expect((await linkStats(env, "sh.example", "guide", { range: "today" }, NOW)).comparison).toBeNull();
    expect((await linkStats(env, "sh.example", "guide", { range: "all" }, NOW)).comparison).toBeNull();
  });
});

describe("change wording", () => {
  it("uses percentages only when the base is big enough", () => {
    expect(change(0, 0)).toBeNull();
    expect(change(5, 0)).toMatchObject({ text: "New", dir: "up" });
    expect(change(7, 4)).toMatchObject({ text: "+3", dir: "up" });
    expect(change(2, 9)).toMatchObject({ text: "−7", dir: "down" });
    expect(change(150, 100)).toMatchObject({ text: "+50%", dir: "up", title: "150 vs 100" });
    expect(change(80, 100)).toMatchObject({ text: "−20%", dir: "down" });
    expect(change(1001, 1000)).toMatchObject({ text: "±0%", dir: "flat" });
  });
});
