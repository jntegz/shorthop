import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API, call, json, resetData } from "./helpers";

beforeEach(async () => {
  await resetData();
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://blog.example.com/")) {
      return new Response(`<html><head><title>How to write a CV</title><meta name="description" content="A guide to CVs that get interviews."></head></html>`, { headers: { "Content-Type": "text/html" } });
    }
    return real(input, init);
  });
});
afterEach(() => vi.restoreAllMocks());

/** A Workers AI binding that answers with `response` and records what it was asked. */
function fakeAi(response: unknown) {
  const asked: unknown[] = [];
  return { asked, AI: { run: async (_model: string, input: unknown) => (asked.push(input), { response }) } as unknown as Ai };
}

describe("Workers AI suggestions", () => {
  it("offers only slugs that pass the slug rules", async () => {
    const ai = fakeAi({ slugs: ["CV Guide", "cv-guide", "_bad", "write-a-cv", "a"] });
    const res = await call(`${API}/previews/ai/slug`, json({ url: "https://blog.example.com/cv" }), { AI: ai.AI } as Partial<Env>);
    expect(await res.json()).toEqual({ slugs: ["cv-guide", "bad", "write-a-cv"] });
    expect(JSON.stringify(ai.asked[0])).toContain("How to write a CV");
  });

  it("writes a preview within the limits, and reads an answer given as text", async () => {
    const ai = fakeAi(JSON.stringify({ title: `"${"T".repeat(200)}"`, description: "Get more interviews." }));
    const res = await call(`${API}/previews/ai/preview`, json({ url: "https://blog.example.com/cv" }), { AI: ai.AI } as Partial<Env>);
    const body = await res.json<{ title: string; description: string }>();
    expect(body.title).toHaveLength(120);
    expect(body.description).toBe("Get more interviews.");
  });

  it("answers 501 without the binding, and says so in /me", async () => {
    expect((await call(`${API}/previews/ai/slug`, json({ url: "https://blog.example.com/cv" }))).status).toBe(501);
    const me = await (await call(`${API}/me`, { headers: json({}).headers })).json<{ workspace: { aiAvailable: boolean } }>();
    expect(me.workspace.aiAvailable).toBe(false);
  });
});
