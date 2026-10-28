// Link page → Share: read-only statistics pages for one link (src/worker/share.ts).
// The address can be copied again later (its secret is kept encrypted); a share
// ends when it expires, is revoked, or the link is deleted.

import { Hono } from "hono";
import { createShareSchema, linkParamSchema, shareParamSchema, updateShareSchema } from "../../shared/schemas";
import { getLink, nowSec } from "../db";
import { validate, type AppEnv } from "../hono";
import { hashLinkPassword } from "../link-password";
import { MAX_SHARES_PER_LINK, newShareSecret, shareOrigin, shareToDTO, type ShareRow } from "../share";
import { newKeyId, sha256Hex } from "../users";
import { encryptSecret } from "../webhooks";

export const sharesApi = new Hono<AppEnv>()
  .get("/links/:domain/:slug/shares", validate("param", linkParamSchema), async (c) => {
    const { domain, slug } = c.req.valid("param");
    const { results } = await c.env.DB.prepare("SELECT * FROM stat_shares WHERE domain = ? AND slug = ? ORDER BY created_at DESC LIMIT 100")
      .bind(domain, slug)
      .all<ShareRow>();
    const origin = shareOrigin(c.env, c.req.raw);
    return c.json({ shares: await Promise.all(results.map((r) => shareToDTO(c.env, r, origin))) });
  })

  .post("/links/:domain/:slug/shares", validate("param", linkParamSchema), validate("json", createShareSchema), async (c) => {
    const { domain, slug } = c.req.valid("param");
    const body = c.req.valid("json");
    if (!(await getLink(c.env.DB, domain, slug))) return c.json({ error: "Link not found" }, 404);
    // The secret is kept encrypted, and a password remembered with a signed cookie: both need it.
    if (!c.env.SESSION_SECRET) return c.json({ error: "Sharing needs the SESSION_SECRET secret (docs/RUNBOOK.md)." }, 503);
    const now = nowSec();
    if (body.expiresAt && body.expiresAt <= now) return c.json({ error: "expiresAt: Pick a time in the future." }, 400);

    const secret = newShareSecret();
    const row: ShareRow = {
      id: newKeyId(),
      domain,
      slug,
      secret_hash: await sha256Hex(secret),
      secret_enc: await encryptSecret(c.env, "share", secret),
      password_hash: body.password ? await hashLinkPassword(c.env, body.password) : null,
      expires_at: body.expiresAt ?? null,
      range_limit: body.rangeLimit ?? null,
      show_recent: body.showRecent ? 1 : 0,
      created_by: c.get("identity"),
      created_at: now,
      revoked_at: null,
      views: 0,
      last_viewed_at: null,
    };
    // Capped in the same statement, so parallel requests can't pass the limit.
    const res = await c.env.DB.prepare(
      `INSERT INTO stat_shares (id, domain, slug, secret_hash, secret_enc, password_hash, expires_at, range_limit, show_recent, created_by, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
       WHERE (SELECT COUNT(*) FROM stat_shares WHERE domain = ?2 AND slug = ?3 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?11)) < ?12`,
    )
      .bind(row.id, domain, slug, row.secret_hash, row.secret_enc, row.password_hash, row.expires_at, row.range_limit, row.show_recent, row.created_by, now, MAX_SHARES_PER_LINK)
      .run();
    if (!res.meta.changes) return c.json({ error: `A link can have at most ${MAX_SHARES_PER_LINK} active shares. Revoke one first.` }, 409);
    return c.json({ share: await shareToDTO(c.env, row, shareOrigin(c.env, c.req.raw)) }, 201);
  })

  .patch("/shares/:id", validate("param", shareParamSchema), validate("json", updateShareSchema), async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const row = await c.env.DB.prepare("SELECT * FROM stat_shares WHERE id = ?").bind(id).first<ShareRow>();
    if (!row) return c.json({ error: "Share not found" }, 404);
    if (row.revoked_at !== null) return c.json({ error: "This share was revoked. Create a new one instead." }, 409);
    const now = nowSec();
    const next: ShareRow = { ...row };
    if (body.expiresAt !== undefined) {
      if (body.expiresAt !== null && body.expiresAt <= now) return c.json({ error: "expiresAt: Pick a time in the future." }, 400);
      next.expires_at = body.expiresAt;
    }
    if (body.password !== undefined) next.password_hash = body.password === null ? null : await hashLinkPassword(c.env, body.password);
    if (body.rangeLimit !== undefined) next.range_limit = body.rangeLimit;
    if (body.showRecent !== undefined) next.show_recent = body.showRecent ? 1 : 0;
    if (body.revoke) next.revoked_at = now;
    await c.env.DB.prepare("UPDATE stat_shares SET expires_at = ?, password_hash = ?, range_limit = ?, show_recent = ?, revoked_at = ? WHERE id = ?")
      .bind(next.expires_at, next.password_hash, next.range_limit, next.show_recent, next.revoked_at, id)
      .run();
    return c.json({ share: await shareToDTO(c.env, next, shareOrigin(c.env, c.req.raw)) });
  })

  .delete("/shares/:id", validate("param", shareParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    const res = await c.env.DB.prepare("DELETE FROM stat_shares WHERE id = ?").bind(id).run();
    if (!res.meta.changes) return c.json({ error: "Share not found" }, 404);
    return c.json({ ok: true });
  });
