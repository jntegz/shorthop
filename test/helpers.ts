import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { resetDaySaltCache } from "../src/worker/analytics";
import type { KvLink } from "../src/worker/db";
import { resetDeadLinkCache } from "../src/worker/dead-link";
import worker from "../src/worker/index";
import { resetMissPolicyCache } from "../src/worker/misses";
import { resetNotFoundCache } from "../src/worker/not-found";

export const ORIGIN = "https://sh.example";
export const API = `${ORIGIN}/api`;
export const bearer = { Authorization: `Bearer ${env.API_TOKEN}` };

/** Calls the Worker and waits for its background work (analytics) to finish. */
export async function call(input: string | Request, init?: RequestInit, envOverride: Partial<Env> = {}): Promise<Response> {
  const request = typeof input === "string" ? new Request(input, init) : input;
  const ctx = createExecutionContext();
  const res = await worker.fetch(request as Parameters<typeof worker.fetch>[0], { ...env, ...envOverride }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export function captureClicks() {
  const points: AnalyticsEngineDataPoint[] = [];
  const CLICKS = { writeDataPoint: (p?: AnalyticsEngineDataPoint) => void (p && points.push(p)) } as AnalyticsEngineDataset;
  return { points, CLICKS };
}

export async function putLink(slug: string, link: Partial<KvLink> & { u: string }, domain = "sh.example"): Promise<void> {
  await env.LINKS.put(`${domain}/${slug}`, JSON.stringify({ a: 1, e: null, utm: 0, qp: 0, ...link }));
}

export function json(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json", ...bearer, ...headers }, body: JSON.stringify(body) };
}

/** Clears D1 rows, settings state and KV between tests (storage is shared per file). */
export async function resetData(): Promise<void> {
  resetMissPolicyCache();
  resetNotFoundCache();
  resetDaySaltCache();
  resetDeadLinkCache();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM links"),
    env.DB.prepare("DELETE FROM target_checks"),
    env.DB.prepare("DELETE FROM link_versions"),
    env.DB.prepare("DELETE FROM preview_images"),
    env.DB.prepare("DELETE FROM daily_stats"),
    env.DB.prepare("DELETE FROM daily_dims"),
    env.DB.prepare("DELETE FROM auth_failures"),
    env.DB.prepare("DELETE FROM login_events"),
    env.DB.prepare("DELETE FROM settings WHERE key != 'default_utm'"),
    env.DB.prepare(
      "UPDATE settings SET value = 'utm_source={domain}&utm_medium=shortlink&utm_campaign={slug}' WHERE key = 'default_utm'",
    ),
  ]);
  const { keys } = await env.LINKS.list();
  await Promise.all(keys.map((k) => env.LINKS.delete(k.name)));
}
