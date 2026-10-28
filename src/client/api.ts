import type { LinkDTO, Period } from "../shared/types";
import { createApiClient } from "../worker/client";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

async function adminFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, { ...init, credentials: "same-origin", redirect: "manual" });
  // An expired Cloudflare Access session answers with a redirect to its login.
  if (res.type === "opaqueredirect") {
    window.location.reload();
    throw new ApiError("Your session expired. Reloading…", 401);
  }
  // Removed or paused in People since the page loaded: reload to show why.
  if (res.status === 403) {
    const body = (await res
      .clone()
      .json()
      .catch(() => null)) as { code?: string } | null;
    if (body?.code === "not_allowed" || body?.code === "paused") {
      window.location.reload();
      throw new ApiError(body.code === "paused" ? "Your access was paused. Reloading…" : "Your access was removed. Reloading…", 403);
    }
  }
  // An expired password session: back to the login page, then here again.
  if (res.status === 401) {
    const body = (await res
      .clone()
      .json()
      .catch(() => null)) as { code?: string } | null;
    if (body?.code === "login_required") {
      window.location.assign(`/_admin/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
      throw new ApiError("Your session expired. Redirecting to the login…", 401);
    }
  }
  return res;
}

/**
 * Saves an admin file (a CSV export) through adminFetch, so an expired session
 * leads to the login instead of saving its error page as the file. `init`
 * makes it a POST, for exports whose subject mustn't appear in the URL.
 */
export async function downloadFile(path: string, init?: RequestInit): Promise<void> {
  const res = await adminFetch(path, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(body?.error ?? `Export failed (${res.status})`, res.status);
  }
  const fallback = (res.headers.get("Content-Type") ?? "").includes("json") ? "export.json" : "export.csv";
  const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? fallback;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Uploads a social-preview image (raw bytes); returns the image to store in the link's preview. */
export async function uploadPreviewImage(file: File): Promise<{ kind: "upload"; key: string; width: number | null; height: number | null }> {
  const res = await adminFetch("/_admin/api/previews/images", { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
  const body = (await res.json().catch(() => null)) as { image?: { kind: "upload"; key: string; width: number | null; height: number | null }; error?: string } | null;
  if (!res.ok || !body?.image) throw new ApiError(body?.error ?? `Upload failed (${res.status})`, res.status, body);
  return body.image;
}

export const api = createApiClient(`${window.location.origin}/_admin/api`, { fetch: adminFetch });

// Responses typed with an explicit error status have ok: false; success routes
// without an explicit status are typed ok: boolean, so exclude only the errors.
type OkJson<R> = R extends { ok: false } ? never : R extends { json(): Promise<infer J> } ? J : never;

/** Awaits an RPC call and returns its typed success body, or throws ApiError. */
export async function call<R extends { ok: boolean; status: number; json(): Promise<unknown> }>(
  request: Promise<R>,
): Promise<OkJson<R>> {
  const res = await request;
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    let body: unknown;
    try {
      body = await res.json();
      const err = (body as { error?: unknown }).error;
      if (typeof err === "string") message = err;
    } catch {
      // Non-JSON error body.
    }
    throw new ApiError(message, res.status, body);
  }
  return (await res.json()) as OkJson<R>;
}

/** For 502 "saved but not published" responses that still carry the link. */
export function linkFromError(err: unknown): LinkDTO | null {
  if (err instanceof ApiError && err.status === 502) {
    const link = (err.body as { link?: LinkDTO } | undefined)?.link;
    return link ?? null;
  }
  return null;
}

export const keys = {
  links: (params: object) => ["links", params] as const,
  allLinks: ["links"] as const,
  link: (domain: string, slug: string) => ["link", domain, slug] as const,
  tags: ["tags"] as const,
  linkStats: (domain: string, slug: string, period: Period) => ["stats", "link", domain, slug, period] as const,
  overview: (period: Period) => ["stats", "overview", period] as const,
  account: (period: Period) => ["stats", "account", period] as const,
  misses: (period: Period) => ["stats", "misses", period] as const,
  recent: (domain?: string, slug?: string) => ["stats", "recent", domain ?? "*", slug ?? "*"] as const,
  settings: ["settings"] as const,
  // Under "settings", so saving a setting also refreshes the workspace basics.
  me: ["settings", "me"] as const,
  people: ["people"] as const,
  apiKeys: (all: boolean) => ["api-keys", all] as const,
  health: ["settings", "health"] as const,
  version: ["settings", "version"] as const,
  turnstile: ["settings", "turnstile"] as const,
  checks: ["checks"] as const,
  linkHistory: (domain: string, slug: string) => ["history", domain, slug] as const,
  deleted: ["deleted"] as const,
  utmPresets: ["utm-presets"] as const,
  qrDefault: ["qr", "default"] as const,
  cap: (domain: string, slug: string) => ["cap", domain, slug] as const,
  webhooks: ["webhooks"] as const,
  linkCheck: (domain: string, slug: string) => ["checks", domain, slug] as const,
  sites: ["sites"] as const,
  site: (id: string) => ["sites", id] as const,
  siteData: (id: string, what: string, params: object) => ["sites", id, what, params] as const,
  connections: (id: string) => ["sites", id, "connections"] as const,
  linkRevenue: (domain: string, slug: string) => ["sites", "by-link", domain, slug] as const,
};
