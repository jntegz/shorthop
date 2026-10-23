import { Hono } from "hono";
import { utmPresetSchema } from "../../shared/schemas";
import { validateUtmTemplate } from "../../shared/target";
import type { UtmPresetDTO } from "../../shared/types";
import { MAX_PRESETS } from "../../shared/utm";
import { nowSec } from "../db";
import { validate, type AppEnv } from "../hono";
import { z } from "zod";

const idParam = z.object({ id: z.coerce.number().int().positive() });
const isUnique = (err: unknown) => /UNIQUE constraint failed/i.test(String(err));

async function list(db: D1Database): Promise<UtmPresetDTO[]> {
  const { results } = await db
    .prepare(
      `SELECT p.id, p.name, p.template, p.updated_at AS updatedAt,
              (SELECT COUNT(*) FROM links l WHERE l.utm = 1 AND l.utm_template = p.template) AS links
       FROM utm_presets p ORDER BY p.name COLLATE NOCASE`,
    )
    .all<UtmPresetDTO>();
  return results;
}

/** Saved UTM templates. A link gets a copy of one, so editing a preset never changes links. */
export const utmApi = new Hono<AppEnv>()
  .get("/", async (c) => c.json({ presets: await list(c.env.DB) }))

  .post("/", validate("json", utmPresetSchema), async (c) => {
    const { name, template } = c.req.valid("json");
    const err = validateUtmTemplate(template);
    if (err) return c.json({ error: `template: ${err}` }, 400);
    const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM utm_presets").first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_PRESETS) return c.json({ error: `Keep at most ${MAX_PRESETS} presets.` }, 400);
    const now = nowSec();
    try {
      await c.env.DB.prepare("INSERT INTO utm_presets (name, template, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(name, template, now, now).run();
    } catch (e) {
      if (isUnique(e)) return c.json({ error: `A preset named “${name}” already exists.` }, 409);
      throw e;
    }
    return c.json({ presets: await list(c.env.DB) }, 201);
  })

  .put("/:id", validate("param", idParam), validate("json", utmPresetSchema), async (c) => {
    const { id } = c.req.valid("param");
    const { name, template } = c.req.valid("json");
    const err = validateUtmTemplate(template);
    if (err) return c.json({ error: `template: ${err}` }, 400);
    try {
      const { meta } = await c.env.DB.prepare("UPDATE utm_presets SET name = ?, template = ?, updated_at = ? WHERE id = ?").bind(name, template, nowSec(), id).run();
      if (!meta.changes) return c.json({ error: "Preset not found" }, 404);
    } catch (e) {
      if (isUnique(e)) return c.json({ error: `A preset named “${name}” already exists.` }, 409);
      throw e;
    }
    return c.json({ presets: await list(c.env.DB) });
  })

  .delete("/:id", validate("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const { meta } = await c.env.DB.prepare("DELETE FROM utm_presets WHERE id = ?").bind(id).run();
    if (!meta.changes) return c.json({ error: "Preset not found" }, 404);
    return c.json({ presets: await list(c.env.DB) });
  });
