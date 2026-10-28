// Moves stored secrets onto the current encryption format and key (see the
// Secrets section of webhooks.ts). Daily, a page at a time: one query for every
// column and one batch of updates, so it adds at most two subrequests to the
// cleanup run, which has to fit Workers Free's 50 (src/worker/plan.ts).
// Values that can't be decrypted are left alone: the admin already shows them
// as unreadable, and they're replaced by pasting or rotating them.

import { decryptSecret, encryptSecret, isStaleSecret, type SecretPurpose } from "./webhooks";

const COLUMNS: { table: string; column: string; purpose: SecretPurpose }[] = [
  { table: "webhooks", column: "secret", purpose: "webhook" },
  { table: "stat_shares", column: "secret_enc", purpose: "share" },
  { table: "payment_connections", column: "webhook_secret", purpose: "connection:webhook_secret" },
  { table: "payment_connections", column: "api_key", purpose: "connection:api_key" },
];

/** Re-encrypts up to `limit` values per column; returns how many changed. */
export async function reencryptSecrets(env: Env, limit = 25): Promise<number> {
  const prefix = `v2:${env.ENCRYPTION_KEY ? "e" : "s"}:%`;
  // Extra rows per column, so a few undecryptable ones (which stay as they are) don't hold up the rest.
  const sql = COLUMNS.map(
    ({ table, column }, i) => `SELECT * FROM (SELECT ${i} AS col, id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL AND ${column} NOT LIKE ?1 ORDER BY id LIMIT ?2)`,
  ).join(" UNION ALL ");
  const { results } = await env.DB.prepare(sql)
    .bind(prefix, limit * 4)
    .all<{ col: number; id: string | number; value: string }>();

  const updates: D1PreparedStatement[] = [];
  const changed = COLUMNS.map(() => 0);
  for (const row of results) {
    const target = COLUMNS[row.col];
    if (!target || changed[row.col]! >= limit || !isStaleSecret(env, row.value)) continue;
    const plain = await decryptSecret(env, target.purpose, row.value);
    if (plain === null) continue;
    updates.push(
      env.DB.prepare(`UPDATE ${target.table} SET ${target.column} = ?1 WHERE id = ?2 AND ${target.column} = ?3`).bind(await encryptSecret(env, target.purpose, plain), row.id, row.value),
    );
    changed[row.col]!++;
  }
  if (updates.length) await env.DB.batch(updates);
  return updates.length;
}
