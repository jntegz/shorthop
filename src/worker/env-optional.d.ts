// Secrets that only some deployments set. `wrangler types` only knows the
// required ones (secrets.required in the config).
declare namespace Cloudflare {
  interface Env {
    /** Account Analytics Read token for the Analytics Engine SQL API. */
    CF_ANALYTICS_TOKEN?: string;
    /** The owners' password in plain text, when ADMIN_PASSWORD_HASH isn't set (Deploy to Cloudflare installs). */
    ADMIN_PASSWORD?: string;
    /** The key stored secrets are encrypted with; without it, one derived from SESSION_SECRET. */
    ENCRYPTION_KEY?: string;
    /** "off": Advanced tracking makes no outbound lookups (reverse DNS, VPN lists). Tests set it. */
    TRACKING_NET?: string;
    /** Code Mode's sandbox (worker_loaders, Workers Paid): commented out in the default config. */
    LOADER?: WorkerLoader;
  }
}
interface Env {
  CF_ANALYTICS_TOKEN?: string;
  ADMIN_PASSWORD?: string;
  ENCRYPTION_KEY?: string;
  TRACKING_NET?: string;
  LOADER?: WorkerLoader;
}

// The qrcode package's encoder alone (src/worker/qr-svg.ts); @types/qrcode covers only the entry.
declare module "qrcode/lib/core/qrcode" {
  export function create(text: string, options?: { errorCorrectionLevel?: "L" | "M" | "Q" | "H" }): { modules: { size: number; data: Uint8Array } };
}
