import { Hono } from "hono";
import { can } from "../../shared/permissions";
import { checkConfirmSchema, checkSettingsSchema, linkParamSchema } from "../../shared/schemas";
import type { CheckRunDTO, LinkChecksDTO } from "../../shared/types";
import { linkKey } from "../../shared/domains";
import { getLink } from "../db";
import { lastJobRun } from "../health";
import { validate, type AppEnv } from "../hono";
import { checkLinkNow, confirmTarget, linkCheck, listChecks, recheckProblems, saveCheckSettings } from "../link-check";

export const checksApi = new Hono<AppEnv>()
  .get("/", async (c) => {
    const [list, lastRun] = await Promise.all([listChecks(c.env), lastJobRun(c.env.DB, "links")]);
    let items = list.items;
    // Where a password-protected link goes is for people who can edit links.
    if (!can(c.get("actor"), "links.edit")) {
      const { results } = await c.env.DB.prepare("SELECT domain, slug FROM links WHERE password_hash IS NOT NULL").all<{ domain: string; slug: string }>();
      const hidden = new Set(results.map((r) => linkKey(r.domain, r.slug)));
      if (hidden.size) {
        items = items.flatMap((i) => {
          const links = i.links.filter((l) => !hidden.has(linkKey(l.domain, l.slug)));
          return links.length ? [{ ...i, links }] : [];
        });
      }
    }
    const dto: LinkChecksDTO = { ...list, items, lastRun };
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

  /** A person opened a destination that refuses checks and it loads: it counts as working until a check says otherwise. */
  .put("/confirmed", validate("json", checkConfirmSchema), async (c) => {
    const { target, confirmed } = c.req.valid("json");
    if (!(await confirmTarget(c.env, target, confirmed))) return c.json({ error: "Only a destination that refuses checks can be confirmed." }, 409);
    return c.json({ ok: true });
  })

  .get("/links/:domain/:slug", validate("param", linkParamSchema), async (c) => {
    const { domain, slug } = c.req.valid("param");
    const result = await linkCheck(c.env, domain, slug, { hideProtected: !can(c.get("actor"), "links.edit") });
    if (!result) return c.json({ error: "Link not found" }, 404);
    return c.json(result);
  })

  /** Checks one link's destinations now. Only stored destinations are ever fetched. */
  .post("/links/:domain/:slug", validate("param", linkParamSchema), async (c) => {
    const { domain, slug } = c.req.valid("param");
    const link = await getLink(c.env.DB, domain, slug);
    if (!link) return c.json({ error: "Link not found" }, 404);
    if (!(await checkLinkNow(c.env, domain, slug))) return c.json({ error: "The check couldn't run. Try again in a minute." }, 503);
    const result = await linkCheck(c.env, domain, slug, { hideProtected: !can(c.get("actor"), "links.edit") });
    return c.json(result!);
  });
