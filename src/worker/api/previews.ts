import { Hono } from "hono";
import { PREVIEW_IMAGE_MAX_BYTES } from "../../shared/preview";
import { fetchPreviewSchema } from "../../shared/schemas";
import { readCapped } from "../body";
import { validate, type AppEnv } from "../hono";
import { fetchDestinationPreview, savePreviewImage } from "../preview";
import { aiAvailable, suggestSlugs, writePreview } from "../ai";

export const previewsApi = new Hono<AppEnv>()
  /** Uploads a preview image: the raw bytes as the body. The link refers to it once saved. */
  .post("/images", async (c) => {
    const body = await readCapped(c.req.raw, PREVIEW_IMAGE_MAX_BYTES);
    if (!body) return c.json({ error: "The image must be 5 MB or smaller." }, 413);
    const result = await savePreviewImage(c.env, body.buffer as ArrayBuffer);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    const { key, width, height, type, bytes } = result;
    return c.json({ image: { kind: "upload" as const, key, width, height }, type, bytes }, 201);
  })

  /** Workers AI: three slug ideas for a destination. */
  .post("/ai/slug", validate("json", fetchPreviewSchema), async (c) => {
    const page = await aiPage(c.env, c.get("identity"), c.req.valid("json").url);
    if ("error" in page) return c.json({ error: page.error }, page.status);
    try {
      return c.json({ slugs: await suggestSlugs(c.env, page) });
    } catch (err) {
      return c.json({ error: aiFailed(err) }, 502);
    }
  })

  /** Workers AI: a preview title and description written from the destination's own. */
  .post("/ai/preview", validate("json", fetchPreviewSchema), async (c) => {
    const page = await aiPage(c.env, c.get("identity"), c.req.valid("json").url);
    if ("error" in page) return c.json({ error: page.error }, page.status);
    try {
      return c.json(await writePreview(c.env, page));
    } catch (err) {
      return c.json({ error: aiFailed(err) }, 502);
    }
  })

  /** Reads a page's own title, description and image, to start a preview from. */
  .post("/fetch", validate("json", fetchPreviewSchema), async (c) => {
    const result = await fetchDestinationPreview(c.req.valid("json").url);
    if ("error" in result) return c.json({ error: result.error }, 422);
    return c.json(result);
  });

/** Checks AI can answer for this person, then reads the destination: 501 without the AI binding, 429 when asked too often. */
async function aiPage(env: Env, identity: string, url: string): Promise<{ url: string; title: string; description: string } | { error: string; status: 501 | 429 }> {
  if (!aiAvailable(env)) return { error: "Workers AI isn't set up: add the AI binding (docs/CLOUDFLARE-FREE-TIER.md).", status: 501 };
  // Per person, on the public limiter's budget: the free allowance is shared by everyone.
  try {
    const { success } = await env.PUBLIC_LIMITER.limit({ key: `ai:${identity}` });
    if (!success) return { error: "Too many suggestions in a minute. Try again shortly.", status: 429 };
  } catch (err) {
    console.error(JSON.stringify({ message: "ai rate limiter failed", error: String(err) }));
  }
  const page = await fetchDestinationPreview(url);
  return "error" in page ? { url, title: "", description: "" } : { url: page.url, title: page.title, description: page.description };
}

function aiFailed(err: unknown): string {
  console.error(JSON.stringify({ message: "workers ai failed", error: String(err) }));
  return "Workers AI didn't answer. Try again in a moment.";
}
