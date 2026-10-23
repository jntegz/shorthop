import { beforeEach, describe, expect, it } from "vitest";
import type { UtmPresetDTO } from "../src/shared/types";
import { buildTemplate, emptyParts, encodeValue, parseTemplate, partsProblem, previewUtm } from "../src/shared/utm";
import { API, bearer, call, json, resetData } from "./helpers";

describe("template fields", () => {
  it("round-trips a template through the fields", () => {
    const t = "utm_source=linkedin&utm_medium=social&utm_campaign={slug}&ref=sh&utm_content=Spring%20post";
    const parts = parseTemplate(t);
    expect(parts.fields).toMatchObject({ utm_source: "linkedin", utm_campaign: "{slug}", utm_content: "Spring post", utm_term: "" });
    expect(parts.extra).toEqual([{ key: "ref", value: "sh" }]);
    expect(buildTemplate(parts)).toBe("utm_source=linkedin&utm_medium=social&utm_campaign={slug}&utm_content=Spring%20post&ref=sh");
  });

  it("encodes what people type but keeps placeholders", () => {
    expect(encodeValue("Q4 launch & more {slug}")).toBe("Q4%20launch%20%26%20more%20{slug}");
    const parts = emptyParts();
    parts.fields.utm_campaign = "Q4 launch #1";
    expect(partsProblem(parts)).toBeNull();
    expect(buildTemplate(parts)).toBe("utm_campaign=Q4%20launch%20%231");
  });

  it("explains what can't be saved", () => {
    expect(partsProblem(emptyParts())).toBe("Fill in at least one parameter.");
    const bad = emptyParts();
    bad.fields.utm_source = "x";
    bad.extra = [{ key: "bad key", value: "1" }];
    expect(partsProblem(bad)).toContain("isn't a valid parameter name");
    const dup = emptyParts();
    dup.fields.utm_source = "x";
    dup.extra = [{ key: "utm_source", value: "y" }];
    expect(partsProblem(dup)).toBe("utm_source is set twice.");
  });

  it("previews the final URL and names parameters the destination already sets", () => {
    const p = previewUtm("https://example.com/page?utm_source=newsletter#top", "utm_source=linkedin&utm_campaign={slug}&utm_content={variant}", { slug: "guide", source: "li" });
    expect(p.url).toBe("https://example.com/page?utm_source=newsletter&utm_campaign=guide&utm_content=default#top");
    expect(p.kept).toEqual(["utm_source"]);
  });
});

describe("presets API", () => {
  beforeEach(resetData);
  const presets = async (res: Response) => ((await res.json()) as { presets: UtmPresetDTO[] }).presets;

  it("creates, renames, counts links using one, and deletes", async () => {
    const created = await call(`${API}/utm-presets`, json({ name: "LinkedIn", template: "utm_source=linkedin&utm_medium=social" }));
    expect(created.status).toBe(201);
    const [p] = await presets(created);
    expect(p).toMatchObject({ name: "LinkedIn", links: 0 });

    await call(`${API}/links`, json({ slug: "a", target: "https://example.com", utm: true, utmTemplate: "utm_source=linkedin&utm_medium=social" }));
    expect((await presets(await call(`${API}/utm-presets`, { headers: bearer })))[0]!.links).toBe(1);

    expect((await call(`${API}/utm-presets`, json({ name: "linkedin", template: "utm_source=x" }))).status).toBe(409);
    expect((await call(`${API}/utm-presets`, json({ name: "Bad", template: "utm source=x" }))).status).toBe(400);

    const renamed = await presets(await call(`${API}/utm-presets/${p!.id}`, { ...json({ name: "LinkedIn organic", template: "utm_source=linkedin" }), method: "PUT" }));
    expect(renamed[0]).toMatchObject({ name: "LinkedIn organic", links: 0 });
    expect(await presets(await call(`${API}/utm-presets/${p!.id}`, { method: "DELETE", headers: bearer }))).toEqual([]);
    expect((await call(`${API}/utm-presets/${p!.id}`, { method: "DELETE", headers: bearer })).status).toBe(404);
  });
});
