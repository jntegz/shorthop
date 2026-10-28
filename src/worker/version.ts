// The running version and the newest release on GitHub (Dashboard → System
// status). GitHub is asked at most once a day, and only when someone opens the
// page: the answer is kept in D1. The admin's CSP allows only its own origin,
// so the Worker asks for it.

import { APP_NAME, APP_VERSION, REPO_URL } from "../shared/brand";
import type { AppVersionDTO } from "../shared/types";
import { getSetting, nowSec, setSettingStmt } from "./db";

const KEY = "latest_release";
const MAX_AGE_SEC = 24 * 3600;
const RELEASES_API = `${REPO_URL.replace("https://github.com/", "https://api.github.com/repos/")}/releases/latest`;

interface Cached {
  version: string;
  url: string;
  checkedAt: number;
}

/** "v1.2.0" → [1, 2, 0]; null for anything else. */
function parseVersion(v: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? m.slice(1).map(Number) : null;
}

/** True when `latest` is a higher version than `current`. A "dev" build is never behind. */
export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

async function fetchLatest(): Promise<Omit<Cached, "checkedAt"> | null> {
  try {
    const res = await fetch(RELEASES_API, {
      // GitHub's API refuses requests without a User-Agent.
      headers: { Accept: "application/vnd.github+json", "User-Agent": `${APP_NAME}/${APP_VERSION}` },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const body = await res.json<{ tag_name?: unknown; html_url?: unknown }>();
    const tag = typeof body.tag_name === "string" ? body.tag_name : "";
    if (!parseVersion(tag)) return null;
    return { version: tag.replace(/^v/, ""), url: typeof body.html_url === "string" ? body.html_url : `${REPO_URL}/releases/tag/${tag}` };
  } catch {
    return null;
  }
}

export async function appVersion(env: Env, now = nowSec(), current = APP_VERSION): Promise<AppVersionDTO> {
  let cached: Cached | null = null;
  try {
    cached = JSON.parse((await getSetting(env.DB, KEY)) ?? "null") as Cached | null;
  } catch {
    cached = null;
  }
  if (!cached || now - cached.checkedAt >= MAX_AGE_SEC) {
    const latest = await fetchLatest();
    // GitHub down: say nothing now, and ask again next time.
    if (latest) {
      cached = { ...latest, checkedAt: now };
      await setSettingStmt(env.DB, KEY, JSON.stringify(cached)).run();
    } else cached = null;
  }
  return {
    current,
    latest: cached?.version ?? null,
    url: cached?.url ?? null,
    checkedAt: cached?.checkedAt ?? null,
    updateAvailable: cached ? isNewer(cached.version, current) : false,
  };
}
