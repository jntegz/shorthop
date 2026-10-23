import { Hono } from "hono";
import { z } from "zod";
import { DEFAULT_QR_STYLE, parseQrStyle, validateQrStyle } from "../../shared/qr";
import { getSetting, setSettingStmt } from "../db";
import { validate, type AppEnv } from "../hono";

const KEY = "qr_default";

/** The design new QR codes start from (each link can save its own). */
export const qrApi = new Hono<AppEnv>()
  .get("/default", async (c) => c.json({ style: parseQrStyle(await getSetting(c.env.DB, KEY)) ?? DEFAULT_QR_STYLE }))

  .put("/default", validate("json", z.object({ style: z.record(z.string(), z.unknown()) })), async (c) => {
    const r = validateQrStyle(c.req.valid("json").style);
    if (!r.ok) return c.json({ error: r.error }, 400);
    await setSettingStmt(c.env.DB, KEY, JSON.stringify(r.style)).run();
    return c.json({ style: r.style });
  });
