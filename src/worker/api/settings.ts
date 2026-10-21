import { Hono } from "hono";
import { z } from "zod";
import { HOSTNAME_RE } from "../../shared/domains";
import { NOT_FOUND_IMAGE_MAX_BYTES } from "../../shared/not-found";
import { notFoundSchema, purgeDomainSchema, settingsSchema } from "../../shared/schemas";
import { validateUtmTemplate } from "../../shared/target";
import type { PurgeDomainDTO, SettingsDTO } from "../../shared/types";
import { aeAvailable } from "../ae";
import { readCapped } from "../body";
import { accessConfigured, adminAuthMode } from "../auth";
import { getDefaultUtm, getSetting, nowSec, setSettingStmt } from "../db";
import { digestData, renderDigest, runDigest } from "../digest";
import { autoClearDemo, clearDemo, demoStatus } from "../demo";
import { checkDomain } from "../dns-check";
import { purgeDomain } from "../domain-purge";
import { domainsOf, shortOrigin } from "../domains";
import { checkAndAlert, systemHealth, trackedRollup } from "../health";
import { validate, type AppEnv } from "../hono";
import { mailerStatus, providerName } from "../mailer";
import { deleteNotFoundImage, getNotFoundPage, notFoundImage, saveNotFoundImage, saveNotFoundSettings, sniffImageType } from "../not-found";
import { pendingRollup } from "../rollup";
import { clearSessionCookie, loginConfig, revokeAllSessions, securitySummary } from "../session";

export const settingsApi = new Hono<AppEnv>()
  .get("/", async (c) => {
    // Sample data goes once a real domain is configured (the daily cron checks too).
    await autoClearDemo(c.env);
    const [defaultUtm, lastRolled, rollupPending, lastDigestWeek, security, perDomain, demo] = await Promise.all([
      getDefaultUtm(c.env.DB),
      getSetting(c.env.DB, "last_rolled"),
      pendingRollup(c.env),
      getSetting(c.env.DB, "last_digest_week"),
      securitySummary(c.env.DB, nowSec()),
      c.env.DB.prepare("SELECT domain, COUNT(*) AS n FROM links GROUP BY domain").all<{ domain: string; n: number }>(),
      demoStatus(c.env.DB),
    ]);
    const { list, primary, admin } = domainsOf(c.env);
    const digest = mailerStatus(c.env);
    const settings: SettingsDTO = {
      defaultUtm,
      publicOrigin: shortOrigin(c.env, c.req.raw, primary),
      domains: list,
      primaryDomain: primary,
      adminHost: admin,
      linksPerDomain: Object.fromEntries(perDomain.results.map((r) => [r.domain, r.n])),
      demo,
      aeAvailable: aeAvailable(c.env),
      lastRolled,
      rollupPending,
      lastDigestWeek,
      digestTo: c.env.DIGEST_TO,
      digestProvider: providerName(digest.provider),
      digestProblem: digest.problem,
      security: {
        email: c.get("identity"),
        mode: adminAuthMode(c.env) ?? "access+password",
        accessConfigured: accessConfigured(c.env),
        passwordConfigured: loginConfig(c.env) !== null,
        sessionExpiresAt: c.get("sessionExp") ?? null,
        ...security,
      },
    };
    return c.json(settings);
  })

  .put("/", validate("json", settingsSchema), async (c) => {
    const { defaultUtm } = c.req.valid("json");
    const err = validateUtmTemplate(defaultUtm);
    if (err) return c.json({ error: err }, 400);
    await setSettingStmt(c.env.DB, "default_utm", defaultUtm).run();
    // Links using the default template need republishing: the client follows
    // up with /resync so each call stays small.
    return c.json({ defaultUtm, resyncRequired: true });
  })

  .get("/not-found", async (c) => c.json({ page: await getNotFoundPage(c.env), fallbackUrl: c.env.FALLBACK_URL }))

  .put("/not-found", validate("json", notFoundSchema), async (c) => {
    const settings = c.req.valid("json");
    await saveNotFoundSettings(c.env, settings);
    return c.json({ settings });
  })

  .get("/not-found/image", async (c) => {
    const img = await notFoundImage(c.env, true);
    if (!img) return c.json({ error: "No image" }, 404);
    return c.body(img.bytes, 200, { "Content-Type": img.type });
  })

  .put("/not-found/image", async (c) => {
    // Refuse oversized uploads without buffering them (the form adds a little to the file).
    const raw = await readCapped(c.req.raw, NOT_FOUND_IMAGE_MAX_BYTES + 16 * 1024);
    if (!raw) return c.json({ error: "The image must be 512 KB or smaller" }, 413);
    const body = await new Request(c.req.url, { method: "PUT", headers: c.req.raw.headers, body: raw }).formData().then((f) => Object.fromEntries(f));
    const file = body.file;
    if (!(file instanceof File)) return c.json({ error: "Choose an image file" }, 400);
    if (file.size > NOT_FOUND_IMAGE_MAX_BYTES) return c.json({ error: "The image must be 512 KB or smaller" }, 400);
    const bytes = await file.arrayBuffer();
    const type = sniffImageType(new Uint8Array(bytes));
    if (!type) return c.json({ error: "Use a PNG, JPEG, GIF or WebP image" }, 400);
    return c.json({ image: await saveNotFoundImage(c.env, bytes, type) });
  })

  .delete("/not-found/image", async (c) => {
    await deleteNotFoundImage(c.env);
    return c.json({ image: null });
  })

  .post("/rollup", async (c) => {
    return c.json(await trackedRollup(c.env));
  })

  .get("/health", async (c) => c.json(await systemHealth(c.env)))

  .post("/health/test-alert", async (c) => c.json(await checkAndAlert(c.env, new Date(), true)))

  .get("/digest/preview", async (c) => {
    const data = await digestData(c.env);
    const { primary } = domainsOf(c.env);
    return c.json({ ...renderDigest(data, new URL(c.req.url).origin, primary), week: data.week });
  })

  .post("/digest/test", async (c) => {
    return c.json(await runDigest(c.env, new Date(), true));
  })

  .get(
    "/domains/check",
    validate("query", z.object({ domain: z.string().trim().toLowerCase().regex(HOSTNAME_RE, "Enter a domain such as links.example.com") })),
    async (c) => c.json(await checkDomain(c.env, c.req.valid("query").domain)),
  )

  .post("/domains/purge", validate("json", purgeDomainSchema), async (c) => {
    // Admin sessions only, like revoking sessions: a leaked API token must not wipe a domain.
    if (c.get("identity") === "api-token") return c.json({ error: "Not available with the API token" }, 403);
    const { domain } = c.req.valid("json");
    const result = await purgeDomain(c.env, domain);
    if (result.done) console.log(JSON.stringify({ message: "domain data deleted", domain, email: c.get("identity") }));
    return c.json({ domain, ...result } satisfies PurgeDomainDTO);
  })

  .delete("/demo", async (c) => c.json({ removed: await clearDemo(c.env) }))

  .post("/sessions/revoke", async (c) => {
    // Admin sessions only: the API token must not be able to lock the owner out.
    if (c.get("identity") === "api-token") return c.json({ error: "Not available with the API token" }, 403);
    await revokeAllSessions(c.env.DB);
    console.log(JSON.stringify({ message: "admin sessions revoked", email: c.get("identity") }));
    c.header("Set-Cookie", clearSessionCookie());
    return c.json({ revoked: true });
  });
