// Link change history in D1 (link_versions). Every write path records the
// link's state after the change in the same batch as the change itself, so
// history and links can't drift apart.

import { DELETED_RETENTION_DAYS, HISTORY_ACTIONS, HISTORY_RETENTION_DAYS, snapshotOf, type HistoryAction, type StoredSnapshot } from "../shared/history";
import type { DeletedLinkDTO, VersionDTO } from "../shared/types";
import { nowSec, type LinkRow } from "./db";

/** SQL for a version's snapshot, built from a `links` row (keep in step with snapshotOf). */
export const SNAPSHOT_SQL = `json_object('target', target, 'active', active, 'expires_at', expires_at, 'utm', utm, 'utm_template', utm_template,
  'pass_query', pass_query, 'title', title, 'tags', tags, 'notes', notes, 'broken', broken, 'replacement', replacement,
  'monitor', monitor, 'routing', routing, 'preview', preview, 'qr', qr, 'password_hash', password_hash, 'max_clicks', max_clicks, 'source', source, 'imported_clicks', imported_clicks, 'created_at', created_at)`;

/** Most versions returned for one link. */
const LIST_LIMIT = 200;

export function versionStmt(
  db: D1Database,
  row: LinkRow,
  action: HistoryAction,
  actor: string,
  opts: { at?: number; restoredFrom?: number } = {},
): D1PreparedStatement {
  // Except for a delete, only while the link exists: an edit that lost a race
  // with a delete must not leave a newer version that hides the delete.
  const exists = action === "delete" ? "" : " WHERE EXISTS (SELECT 1 FROM links WHERE domain = ?1 AND slug = ?2)";
  return db
    .prepare(`INSERT INTO link_versions (domain, slug, at, action, actor, snapshot, restored_from) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7${exists}`)
    .bind(row.domain, row.slug, opts.at ?? nowSec(), action, actor, JSON.stringify(snapshotOf(row)), opts.restoredFrom ?? null);
}

interface VersionRow {
  id: number;
  at: number;
  action: string;
  actor: string;
  snapshot: string;
  restored_from: number | null;
}

function toDTO(r: VersionRow): VersionDTO | null {
  try {
    const snapshot = JSON.parse(r.snapshot) as StoredSnapshot;
    const action = (HISTORY_ACTIONS as readonly string[]).includes(r.action) ? (r.action as HistoryAction) : "update";
    return { id: r.id, at: r.at, action, actor: r.actor, snapshot, restoredFrom: r.restored_from };
  } catch {
    return null;
  }
}

/** What the admin sees of a password hash: only that it's set, and whether it changed. */
async function fingerprint(hash: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(hash)));
  return `set:${[...digest.slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** A link's versions, newest first. A link created again after a delete lists its earlier life too. */
export async function listVersions(db: D1Database, domain: string, slug: string): Promise<VersionDTO[]> {
  const { results } = await db
    .prepare("SELECT id, at, action, actor, snapshot, restored_from FROM link_versions WHERE domain = ? AND slug = ? ORDER BY id DESC LIMIT ?")
    .bind(domain, slug, LIST_LIMIT)
    .all<VersionRow>();
  const versions = results.map(toDTO).filter((v): v is VersionDTO => v !== null);
  for (const v of versions) if (v.snapshot.password_hash) v.snapshot.password_hash = await fingerprint(v.snapshot.password_hash);
  return versions;
}

export async function getVersion(db: D1Database, domain: string, slug: string, id: number): Promise<VersionDTO | null> {
  const r = await db
    .prepare("SELECT id, at, action, actor, snapshot, restored_from FROM link_versions WHERE domain = ? AND slug = ? AND id = ?")
    .bind(domain, slug, id)
    .first<VersionRow>();
  return r ? toDTO(r) : null;
}

/** Deleted links that can still be restored: the latest version of each is a delete, and no link has the slug now. */
export async function deletedLinks(db: D1Database, now = nowSec()): Promise<DeletedLinkDTO[]> {
  const { results } = await db
    .prepare(
      `SELECT v.id, v.domain, v.slug, v.at, v.actor, v.snapshot FROM link_versions v
       JOIN (SELECT domain, slug, MAX(id) AS id FROM link_versions GROUP BY domain, slug) last ON last.id = v.id
       LEFT JOIN links l ON l.domain = v.domain AND l.slug = v.slug
       WHERE v.action = 'delete' AND l.slug IS NULL AND v.at > ?1
       ORDER BY v.id DESC LIMIT 200`,
    )
    .bind(now - DELETED_RETENTION_DAYS * 86400)
    .all<{ id: number; domain: string; slug: string; at: number; actor: string; snapshot: string }>();
  return results.flatMap((r) => {
    try {
      const s = JSON.parse(r.snapshot) as StoredSnapshot;
      return [{ versionId: r.id, domain: r.domain, slug: r.slug, deletedAt: r.at, actor: r.actor, target: s.target, title: s.title }];
    } catch {
      return [];
    }
  });
}

/**
 * Daily cleanup: versions older than a year (keeping each link's latest), and
 * every version of a link deleted longer ago than it can be restored.
 */
export async function pruneHistory(db: D1Database, now = nowSec()): Promise<void> {
  await db.batch([
    db
      .prepare(
        `DELETE FROM link_versions WHERE at < ?1
         AND id NOT IN (SELECT MAX(id) FROM link_versions GROUP BY domain, slug)`,
      )
      .bind(now - HISTORY_RETENTION_DAYS * 86400),
    db
      .prepare(
        `DELETE FROM link_versions WHERE (domain, slug) IN (
           SELECT v.domain, v.slug FROM link_versions v
           JOIN (SELECT domain, slug, MAX(id) AS id FROM link_versions GROUP BY domain, slug) last ON last.id = v.id
           LEFT JOIN links l ON l.domain = v.domain AND l.slug = v.slug
           WHERE v.action = 'delete' AND l.slug IS NULL AND v.at <= ?1)`,
      )
      .bind(now - DELETED_RETENTION_DAYS * 86400),
  ]);
}
