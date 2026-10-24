import { Hono } from "hono";
import { checkSettingsSchema, linkParamSchema } from "../../shared/schemas";
import type { CheckRunDTO, LinkChecksDTO } from "../../shared/types";
import { getLink } from "../db";
import { lastJobRun } from "../health";
import { validate, type AppEnv } from "../hono";
import { checkLinkNow, linkCheck, listChecks, recheckProblems, saveCheckSettings } from "../link-check";

export const checksApi = new Hono<AppEnv>()
  .get("/", async (c) => {
    const [list, lastRun] = await Promise.all([listChecks(c.env), lastJobRun(c.env.DB, "links")]);
    const dto: LinkChecksDTO = { ...list, lastRun };
    return c.json(dto);
  })

  // Partial: what's left out keeps its saved value.
  .put("/settings", validate("json", checkSettingsSchema), async (c) => {
    return c.json({ settings: await saveCheckSettings(c.env, c.req.valid("json")) });
  })

  /** Warnings, failures and never-checked destinations, as many as one request can check. */
  .post("/recheck", async (c) => {
    const { checked, remaining } = await recheckProblems(c.env);
    const dto: CheckRunDTO = { checked, remaining };
    return c.json(dto);
  })

  .get("/links/:domain/:slug", validate("param", linkParamSchema), async (c) => {
    const { domain, slug } = c.req.valid("param");
    const result = await linkCheck(c.env, domain, slug);
    if (!result) return c.json({ error: "Link not found" }, 404);
    return c.json(result);
  })

  /** Checks one link's destinations now. Only stored destinations are ever fetched. */
  .post("/links/:domain/:slug", validate("param", linkParamSchema), async (c) => {
    const { domain, slug } = c.req.valid("param");
    const link = await getLink(c.env.DB, domain, slug);
    if (!link) return c.json({ error: "Link not found" }, 404);
    if (!(await checkLinkNow(c.env, domain, slug))) return c.json({ error: "The check couldn't run. Try again in a minute." }, 503);
    const result = await linkCheck(c.env, domain, slug);
    return c.json(result!);
  });
