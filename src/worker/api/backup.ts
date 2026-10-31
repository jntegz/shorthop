// Settings → Backup: the workspace's data a table page at a time, for the
// browser to zip (src/worker/backup.ts says what's left out, and why).

import { Hono } from "hono";
import { z } from "zod";
import { can } from "../../shared/permissions";
import { BACKUP_TABLE_NAMES, BACKUP_TABLES, backupPage, manifest, type BackupTable } from "../backup";
import { getSetting } from "../db";
import { validate, type AppEnv } from "../hono";

const pageQuery = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  /** Include people's details (emails, customer and visitor ids): needs revenue.view. */
  personal: z.enum(["0", "1"]).default("0"),
});

export const backupApi = new Hono<AppEnv>()
  /** What a backup holds, and the page settings kept in KV (the not-found and "no longer working" pages). */
  .get("/backup", async (c) => {
    const [notFound, deadLink, last] = await Promise.all([c.env.LINKS.get("cfg:not-found", "json"), c.env.LINKS.get("cfg:dead-link", "json"), getSetting(c.env.DB, "backup_last")]);
    return c.json({
      tables: BACKUP_TABLE_NAMES.map((t) => ({ name: t, personalOnly: "personalTable" in BACKUP_TABLES[t] })),
      kv: { "not-found": notFound, "dead-link": deadLink },
      canPersonal: can(c.get("actor"), "revenue.view"),
      scheduled: Boolean((c.env as { BACKUPS?: unknown }).BACKUPS),
      lastScheduled: last ? (JSON.parse(last) as { id: string; at: number; rows: number }) : null,
      manifest: manifest({}, false),
    });
  })

  .get("/backup/:table", validate("query", pageQuery), async (c) => {
    const table = c.req.param("table");
    if (!(BACKUP_TABLE_NAMES as string[]).includes(table)) return c.json({ error: "Not a table in backups" }, 404);
    const { offset, personal } = c.req.valid("query");
    const withPeople = personal === "1";
    if (withPeople && !can(c.get("actor"), "revenue.view")) return c.json({ error: "People's details need the revenue.view permission.", code: "forbidden" }, 403);
    return c.json(await backupPage(c.env.DB, table as BackupTable, offset, { personal: withPeople }));
  });
