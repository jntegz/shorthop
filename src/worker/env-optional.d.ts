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
  }
}
interface Env {
  CF_ANALYTICS_TOKEN?: string;
  ADMIN_PASSWORD?: string;
  ENCRYPTION_KEY?: string;
}
