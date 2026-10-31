// Optional Workers AI (an `AI` binding): suggests slugs for a destination and
// writes a social preview's title and description from the page's own. The
// page is read the way "Start from the destination's preview" reads it
// (fetchDestinationPreview: public hosts only, size and time capped); only its
// address, title and description go to the model, which runs on your own
// Cloudflare account. Without the binding, the admin hides the buttons.

import { PREVIEW_DESCRIPTION_MAX, PREVIEW_TITLE_MAX } from "../shared/preview";
import { validateSlug } from "../shared/slug";

/** Small and cheap: a suggestion costs a few of the 10,000 free neurons a day. */
export const AI_MODEL = "@cf/meta/llama-3.2-3b-instruct";

type AiEnv = Env & { AI?: Ai };

export function aiAvailable(env: Env): boolean {
  return Boolean((env as AiEnv).AI);
}

export interface PageFacts {
  url: string;
  title: string;
  description: string;
}

/** The model's answer as an object: JSON mode when it works, the first {...} in the text when it doesn't. */
function parseAnswer(out: unknown): Record<string, unknown> {
  const response = (out as { response?: unknown } | null)?.response ?? out;
  if (response && typeof response === "object") return response as Record<string, unknown>;
  const text = String(response ?? "");
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const m = /\{[\s\S]*\}/.exec(text);
    if (!m) return {};
    try {
      return JSON.parse(m[0]) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}

async function ask(env: Env, system: string, user: string, schema: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ai = (env as AiEnv).AI;
  if (!ai) throw new Error("Workers AI isn't set up");
  const out = await (ai as unknown as { run: (model: string, input: unknown) => Promise<unknown> }).run(AI_MODEL, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_schema", json_schema: schema },
    max_tokens: 200,
  });
  return parseAnswer(out);
}

const facts = (p: PageFacts) => `Address: ${p.url}\nPage title: ${p.title || "(none)"}\nPage description: ${p.description || "(none)"}`;

/** Up to three short, readable slugs that pass the native slug rules. */
export async function suggestSlugs(env: Env, page: PageFacts): Promise<string[]> {
  const answer = await ask(
    env,
    "You name short links. Reply with JSON {\"slugs\": [...]} holding three short, memorable slugs for the page: lowercase words joined by hyphens, 3 to 24 characters, letters, digits and hyphens only, no dates unless the page is about one.",
    facts(page),
    { type: "object", properties: { slugs: { type: "array", items: { type: "string" } } }, required: ["slugs"] },
  );
  const raw = Array.isArray(answer.slugs) ? answer.slugs : [];
  const clean = raw
    .map((s) =>
      String(s)
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/-{2,}/g, "-")
        .slice(0, 40),
    )
    .filter((s) => s.length >= 2 && !validateSlug(s, "native"));
  return [...new Set(clean)].slice(0, 3);
}

/** A social preview's title and description, within the preview limits. */
export async function writePreview(env: Env, page: PageFacts): Promise<{ title: string; description: string }> {
  const answer = await ask(
    env,
    `You write link previews for social media. Reply with JSON {"title": ..., "description": ...}: a clear title of at most 70 characters and a description of at most 160 characters that says what the reader gets. Plain text, no hashtags, no emoji, no quotation marks around them. Write in the page's own language.`,
    facts(page),
    { type: "object", properties: { title: { type: "string" }, description: { type: "string" } }, required: ["title", "description"] },
  );
  const tidy = (v: unknown, max: number) =>
    String(v ?? "")
      .replace(/\s+/g, " ")
      .replace(/^["'“”]+|["'“”]+$/g, "")
      .trim()
      .slice(0, max);
  return { title: tidy(answer.title, PREVIEW_TITLE_MAX), description: tidy(answer.description, PREVIEW_DESCRIPTION_MAX) };
}
