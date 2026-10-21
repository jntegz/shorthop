import { describe, expect, it } from "vitest";
import { addDays, isoWeek, rangeBounds } from "../src/shared/dates";
import { normalizeTags } from "../src/shared/schemas";
import { generateSlug, isRoutableSlug, validateSlug } from "../src/shared/slug";
import { buildLocation, normalizeTarget, renderUtm, splitOwnParams, validateUtmTemplate } from "../src/shared/target";
import { csvCell } from "../src/worker/hono";

describe("slugs", () => {
  it("validates native slugs", () => {
    expect(validateSlug("guide", "native")).toBeNull();
    expect(validateSlug("My_Guide-2", "native")).toBeNull();
    expect(validateSlug("-guide", "native")).not.toBeNull();
    expect(validateSlug("a.b", "native")).not.toBeNull();
    expect(validateSlug("a".repeat(65), "native")).not.toBeNull();
  });

  it("allows dots and tildes for imports only", () => {
    expect(validateSlug("v1.2~beta", "import")).toBeNull();
    expect(validateSlug(".hidden", "import")).not.toBeNull();
    expect(validateSlug("_x", "import")).not.toBeNull();
    expect(validateSlug("a/b", "import")).not.toBeNull();
  });

  it("rejects reserved slugs case-insensitively", () => {
    for (const s of ["api", "API", "health", "robots.txt", "Favicon.ico", "cdn-cgi"]) {
      expect(validateSlug(s, "import")).toMatch(/reserved/);
      expect(isRoutableSlug(s)).toBe(false);
    }
  });

  it("generates base62 slugs", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const s = generateSlug();
      expect(s).toMatch(/^[0-9A-Za-z]{6}$/);
      seen.add(s);
    }
    expect(seen.size).toBeGreaterThan(495);
  });
});

describe("targets", () => {
  it("requires https by default", () => {
    expect(normalizeTarget("https://example.com/guide")).toEqual({ ok: true, url: "https://example.com/guide" });
    expect(normalizeTarget("http://example.com").ok).toBe(false);
    expect(normalizeTarget("http://example.com", { allowHttp: true }).ok).toBe(true);
  });

  it("rejects dangerous or invalid targets", () => {
    for (const t of ["javascript:alert(1)", "data:text/html,hi", "ftp://x.com", "not a url", "", "https://user:pw@x.com", "https://localhost/x"]) {
      expect(normalizeTarget(t, { allowHttp: true }).ok, t).toBe(false);
    }
    expect(normalizeTarget("https://sh.example/x", { selfHosts: ["sh.example"] }).ok).toBe(false);
    expect(normalizeTarget("https://www.sh.example/x", { selfHosts: ["sh.example"] }).ok).toBe(false);
  });

  it("normalizes to ASCII", () => {
    const r = normalizeTarget("https://příklad.cz/cesta é");
    expect(r.ok && r.url).toBe("https://xn--pklad-zsa96e.cz/cesta%20%C3%A9");
  });
});

describe("own params", () => {
  it("strips s always and q only when 1", () => {
    expect(splitOwnParams("?s=li&q=1&x=1")).toEqual({ sourceTag: "li", qr: true, passthrough: ["x=1"] });
    expect(splitOwnParams("?q=hello")).toEqual({ sourceTag: null, qr: false, passthrough: ["q=hello"] });
    expect(splitOwnParams("")).toEqual({ sourceTag: null, qr: false, passthrough: [] });
  });

  it("keeps raw encoding of passthrough params", () => {
    expect(splitOwnParams("?a=%20b&c").passthrough).toEqual(["a=%20b", "c"]);
  });
});

describe("buildLocation", () => {
  it("returns the stored target untouched when nothing is appended", () => {
    expect(buildLocation("https://a.com", [], null)).toBe("https://a.com");
    expect(buildLocation("https://a.com/p?x=1#top", [], null)).toBe("https://a.com/p?x=1#top");
  });

  it("appends before the fragment with the right joiner", () => {
    expect(buildLocation("https://a.com/p", ["x=1"], null)).toBe("https://a.com/p?x=1");
    expect(buildLocation("https://a.com/p?y=2", ["x=1"], null)).toBe("https://a.com/p?y=2&x=1");
    expect(buildLocation("https://a.com/p?", ["x=1"], null)).toBe("https://a.com/p?x=1");
    expect(buildLocation("https://a.com/p#h", ["x=1"], "utm_source=t")).toBe("https://a.com/p?x=1&utm_source=t#h");
  });

  it("never overrides UTM keys the target already has", () => {
    expect(buildLocation("https://a.com/?utm_source=nl", [], "utm_source=sh.example&utm_campaign=g")).toBe(
      "https://a.com/?utm_source=nl&utm_campaign=g",
    );
    expect(buildLocation("https://a.com/", ["utm_campaign=x"], "utm_campaign=g")).toBe("https://a.com/?utm_campaign=x");
  });
});

describe("utm templates", () => {
  it("renders placeholders encoded", () => {
    expect(renderUtm("utm_campaign={slug}&utm_content={source}", { slug: "a b", source: "li", domain: "sh.example" })).toBe(
      "utm_campaign=a%20b&utm_content=li",
    );
    expect(renderUtm("utm_source={domain}&utm_campaign={slug}", { slug: "x", source: "", domain: "alt.example" })).toBe(
      "utm_source=alt.example&utm_campaign=x",
    );
  });

  it("validates", () => {
    expect(validateUtmTemplate("utm_source=sh.example&utm_campaign={slug}")).toBeNull();
    expect(validateUtmTemplate("?utm_source=x")).not.toBeNull();
    expect(validateUtmTemplate("utm_source")).not.toBeNull();
    expect(validateUtmTemplate("a=b c")).not.toBeNull();
    expect(validateUtmTemplate("a=ž")).not.toBeNull();
  });
});

describe("misc helpers", () => {
  it("computes date ranges and ISO weeks", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(rangeBounds("7d", new Date("2026-10-19T12:00:00Z"))).toEqual({ from: "2026-10-13", to: "2026-10-19" });
    expect(isoWeek("2026-10-18")).toBe("2026-W42");
    expect(isoWeek("2027-01-01")).toBe("2026-W53");
  });

  it("normalizes tags", () => {
    expect(normalizeTags([" Career ", "career", "job search", ""])).toEqual(["career", "job-search"]);
  });

  it("escapes CSV cells including formulas", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("=HYPERLINK()")).toBe("'=HYPERLINK()");
    expect(csvCell(null)).toBe("");
  });
});
