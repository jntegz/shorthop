// Secrets that only some deployments set. `wrangler types` only knows the
// required ones (secrets.required in the config).
declare namespace Cloudflare {
  interface Env {
    /** Account Analytics Read token for the Analytics Engine SQL API. */
    CF_ANALYTICS_TOKEN?: string;
  }
}
interface Env {
  CF_ANALYTICS_TOKEN?: string;
}
