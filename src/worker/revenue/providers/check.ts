// Helpers for "Check connection": a read-only API call, and a test event
// signed the way the provider signs, run through the adapter's own verify.

import type { VerifyContext } from "../types";

/** null when the call succeeds; otherwise the status and the start of the provider's answer. */
export async function apiCheck(url: string, headers: Record<string, string>, init: RequestInit = {}): Promise<string | null> {
  try {
    const res = await fetch(url, { ...init, headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(8000) });
    if (res.ok) return null;
    const text = (await res.text()).replace(/\s+/g, " ").slice(0, 160);
    return `HTTP ${res.status}${text ? `: ${text}` : ""}`;
  } catch (err) {
    return `couldn't reach it (${String(err).slice(0, 120)})`;
  }
}

export const TEST_BODY = JSON.stringify({ test: "shorthop connection check" });

export const testContext = (settings: Record<string, string>): VerifyContext => ({ apiKey: null, settings, url: new URL("https://example.invalid/") });
