// Optional Cloudflare Turnstile on the password pages (log in, forgot password,
// invite and reset links). Off by default: Cloudflare Access already keeps bots
// away from them. The site key and the switch live in D1; the secret only in
// the TURNSTILE_SECRET Wrangler secret. It turns on only through a check that
// passed (/_admin/bot-check), so a wrong key or secret can't lock everyone out.

import { getSetting, setSettingStmt } from "./db";

export interface TurnstileSettings {
  enabled: boolean;
  siteKey: string;
}

const SETTINGS_KEY = "turnstile";
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TIMEOUT_MS = 5_000;
/** The field Turnstile adds to the form it sits in. */
export const TURNSTILE_FIELD = "cf-turnstile-response";
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

export function turnstileSecret(env: Env): string {
  return ((env as unknown as { TURNSTILE_SECRET?: string }).TURNSTILE_SECRET ?? "").trim();
}

export async function turnstileSettings(db: D1Database): Promise<TurnstileSettings> {
  try {
    const raw = await getSetting(db, SETTINGS_KEY);
    const s = raw ? (JSON.parse(raw) as Partial<TurnstileSettings>) : {};
    return { enabled: s.enabled === true, siteKey: typeof s.siteKey === "string" ? s.siteKey : "" };
  } catch (err) {
    console.error(JSON.stringify({ message: "turnstile settings unreadable, treating as off", error: String(err) }));
    return { enabled: false, siteKey: "" };
  }
}

export function saveTurnstileStmt(db: D1Database, s: TurnstileSettings): D1PreparedStatement {
  return setSettingStmt(db, SETTINGS_KEY, JSON.stringify(s));
}

/** The site key to show on the password pages, or null while the check is off. */
export async function activeTurnstile(env: Env): Promise<{ siteKey: string } | null> {
  const s = await turnstileSettings(env.DB);
  return s.enabled && s.siteKey && turnstileSecret(env) ? { siteKey: s.siteKey } : null;
}

export type TurnstileResult = { ok: true } | { ok: false; reason: string };

/**
 * Asks Cloudflare whether the token is a passed check. A missing or rejected
 * token fails. If Cloudflare can't be reached, `failOpen` lets the request
 * through (the login lockouts still apply) so an outage there can't lock
 * everyone out; turning the check on never fails open.
 */
export async function verifyTurnstile(env: Env, token: string, ip: string | undefined, failOpen = true): Promise<TurnstileResult> {
  if (!token) return { ok: false, reason: "Complete the bot check, then try again." };
  const secret = turnstileSecret(env);
  if (!secret) return { ok: false, reason: "The TURNSTILE_SECRET secret is not set." };
  const body = new FormData();
  body.set("secret", secret);
  body.set("response", token);
  if (ip) body.set("remoteip", ip);
  let data: { success?: boolean; "error-codes"?: string[] };
  try {
    const res = await fetch(SITEVERIFY, { method: "POST", body, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = (await res.json()) as typeof data;
  } catch (err) {
    console.error(JSON.stringify({ message: "turnstile siteverify unreachable", failOpen, error: String(err) }));
    return failOpen ? { ok: true } : { ok: false, reason: "Cloudflare's bot check couldn't be reached. Try again in a minute." };
  }
  if (data.success === true) return { ok: true };
  const codes = (data["error-codes"] ?? []).join(", ");
  console.warn(JSON.stringify({ message: "turnstile check failed", codes }));
  return { ok: false, reason: `The bot check didn't pass${codes ? ` (${codes})` : ""}. Try again.` };
}
