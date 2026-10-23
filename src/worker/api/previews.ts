import { Hono } from "hono";
import { PREVIEW_IMAGE_MAX_BYTES } from "../../shared/preview";
import { fetchPreviewSchema } from "../../shared/schemas";
import { validate, type AppEnv } from "../hono";
import { fetchDestinationPreview, savePreviewImage } from "../preview";

export const previewsApi = new Hono<AppEnv>()
  /** Uploads a preview image: the raw bytes as the body. The link refers to it once saved. */
  .post("/images", async (c) => {
    if (Number(c.req.header("Content-Length") ?? 0) > PREVIEW_IMAGE_MAX_BYTES) return c.json({ error: "The image must be 5 MB or smaller." }, 413);
    const result = await savePreviewImage(c.env, await c.req.arrayBuffer());
    if (!result.ok) return c.json({ error: result.error }, result.status);
    const { key, width, height, type, bytes } = result;
    return c.json({ image: { kind: "upload" as const, key, width, height }, type, bytes }, 201);
  })

  /** Reads a page's own title, description and image, to start a preview from. */
  .post("/fetch", validate("json", fetchPreviewSchema), async (c) => {
    const result = await fetchDestinationPreview(c.req.valid("json").url);
    if ("error" in result) return c.json({ error: result.error }, 422);
    return c.json(result);
  });
