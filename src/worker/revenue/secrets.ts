// Where a payment connection's secrets live. Two ways, chosen per field:
//
//   stored      pasted in the admin; kept in D1 encrypted with AES-256-GCM,
//               the key derived from SESSION_SECRET (src/worker/webhooks.ts),
//               never shown or sent to the browser again.
//   cloudflare  only the NAME of a Worker secret is kept; its value is set
//               with `wrangler secret put NAME` (or the dashboard) and never
//               touches D1 or the admin at all.
//
// The Worker reads a named secret from its own environment, so names of the
// Worker's own secrets are refused: a connection can't be pointed at them.

import { isReservedSecretName } from "../../shared/sites";
import { decryptSecret } from "../webhooks";

export type SecretSource = "stored" | "cloudflare" | "none";

export interface ResolvedSecret {
  value: string | null;
  source: SecretSource;
  /** Why a configured secret can't be read. */
  problem: string | null;
}

export async function resolveSecret(env: Env, stored: string | null, ref: string | null): Promise<ResolvedSecret> {
  if (ref) {
    if (isReservedSecretName(ref)) return { value: null, source: "cloudflare", problem: `${ref} is one of the Worker's own secrets and can't be used here.` };
    const value = (env as unknown as Record<string, unknown>)[ref];
    if (typeof value !== "string" || !value) {
      return { value: null, source: "cloudflare", problem: `No Worker secret named ${ref} yet. Add it with: npx wrangler secret put ${ref}` };
    }
    return { value, source: "cloudflare", problem: null };
  }
  if (stored) {
    const value = await decryptSecret(env, stored);
    return value
      ? { value, source: "stored", problem: null }
      : { value: null, source: "stored", problem: "The saved secret can't be decrypted (SESSION_SECRET changed?). Paste it again." };
  }
  return { value: null, source: "none", problem: null };
}
