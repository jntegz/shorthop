// The sample data `npm run seed:dev` puts in the local database. The seed
// records what it wrote under `demo_data`, so it can be removed by hand
// (Settings → Domains) or on its own once a real domain is configured.

import { isPlaceholderHost } from "../shared/domains";
import type { DemoDTO } from "../shared/types";
import { getSetting, jsonChunks } from "./db";
import { deleteLinks } from "./domain-purge";
import { domainsOf } from "./domains";

const DEMO = "demo_data";

interface DemoMarker {
  domain: string;
  /** Sample links. */
  links: string[];
  /** Sample missed paths. */
  misses: string[];
}

async function demoMarker(db: D1Database): Promise<DemoMarker | null> {
  try {
    const v = JSON.parse((await getSetting(db, DEMO)) ?? "null") as Partial<DemoMarker> | null;
    if (!v || typeof v.domain !== "string") return null;
    const strings = (a: unknown) => (Array.isArray(a) ? a.filter((s): s is string => typeof s === "string") : []);
    return { domain: v.domain, links: strings(v.links), misses: strings(v.misses) };
  } catch {
    return null;
  }
}

export async function demoStatus(db: D1Database): Promise<DemoDTO | null> {
  const m = await demoMarker(db);
  return m && { domain: m.domain, links: m.links.length };
}

/** Deletes the sample links and their stats; links added by hand stay. */
export async function clearDemo(env: Env): Promise<boolean> {
  const m = await demoMarker(env.DB);
  if (!m) return false;
  await deleteLinks(env, m.links.map((slug) => ({ domain: m.domain, slug })));
  const pairs = jsonChunks([...m.links, ...m.misses].map((slug) => [m.domain, slug]));
  await env.DB.batch([
    ...["daily_stats", "daily_dims"].flatMap((table) =>
      pairs.map((chunk) =>
        env.DB.prepare(
          `DELETE FROM ${table} WHERE (domain, slug) IN
           (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?1))`,
        ).bind(chunk),
      ),
    ),
    env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(DEMO),
  ]);
  console.log(JSON.stringify({ message: "demo data removed", domain: m.domain, links: m.links.length }));
  return true;
}

/** Clears the sample data once a real domain other than the seeded one is configured. */
export async function autoClearDemo(env: Env): Promise<boolean> {
  const m = await demoMarker(env.DB);
  if (!m || !domainsOf(env).list.some((d) => d !== m.domain && !isPlaceholderHost(d))) return false;
  return clearDemo(env);
}
