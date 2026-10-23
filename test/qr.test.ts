import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { contrastRatio, DEFAULT_QR_STYLE, qrWarnings, validateQrStyle, type QrStyle } from "../src/shared/qr";
import type { LinkDTO, VersionDTO } from "../src/shared/types";
import { nowSec } from "../src/worker/db";
import { prunePreviewImages } from "../src/worker/preview";
import { API, bearer, call, json, resetData } from "./helpers";

const style = (over: Partial<QrStyle> = {}): QrStyle => ({ ...DEFAULT_QR_STYLE, ...over });

describe("designs", () => {
  it("accepts a design, forcing the strongest error correction under a logo", () => {
    const r = validateQrStyle(style({ fg: "#1A2B3C", logo: { key: "abcdefghij0123456789.png", size: 0.2 }, level: "L", caption: "  Scan for the guide  " })); // gitleaks:allow (made-up logo key)
    expect(r).toMatchObject({ ok: true, style: { fg: "#1a2b3c", level: "H", caption: "Scan for the guide" } });
  });

  it.each([
    [{ fg: "red" }, "Colours"],
    [{ margin: 0 }, "quiet zone"],
    [{ modules: "stars" }, "module shape"],
    [{ logo: { key: "../x.png", size: 0.2 } }, "logo"],
    [{ logo: { key: "abcdefghij0123456789.png", size: 0.5 } }, "logo"], // gitleaks:allow (made-up logo key)
  ])("rejects %o", (over, message) => {
    const r = validateQrStyle({ ...style(), ...over });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.toLowerCase()).toContain(message.toLowerCase());
  });

  it("judges contrast, inversion and quiet zone", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(qrWarnings(style())).toEqual([]);
    expect(qrWarnings(style({ fg: "#bbbbbb" }))[0]).toMatchObject({ level: "error" });
    expect(qrWarnings(style({ fg: "#ffffff", bg: "#000000" })).map((w) => w.message).join(" ")).toContain("inverted");
    expect(qrWarnings(style({ margin: 2 })).map((w) => w.message).join(" ")).toContain("quiet zone");
  });
});

describe("API", () => {
  beforeEach(async () => {
    await resetData();
    await call(`${API}/links`, json({ slug: "guide", target: "https://example.com" }));
  });
  const patch = (body: unknown) => call(`${API}/links/sh.example/guide`, { ...json(body), method: "PATCH" });

  it("saves a link's design, keeps it in the history, and clears it", async () => {
    const res = await patch({ qr: style({ modules: "dots", eyes: "circle", fg: "#6554c0" }) });
    expect(((await res.json()) as { link: LinkDTO }).link.qr).toMatchObject({ modules: "dots", fg: "#6554c0" });
    const { versions } = (await (await call(`${API}/links/sh.example/guide/history`, { headers: bearer })).json()) as { versions: VersionDTO[] };
    expect(versions[0]!.snapshot.qr).toContain("dots");
    expect((await patch({ qr: { ...style(), fg: "nope" } })).status).toBe(400);
    expect(((await (await patch({ qr: null })).json()) as { link: LinkDTO }).link.qr).toBeNull();
  });

  it("stores the default design", async () => {
    expect(await (await call(`${API}/qr/default`, { headers: bearer })).json()).toEqual({ style: DEFAULT_QR_STYLE });
    const put = await call(`${API}/qr/default`, { ...json({ style: style({ frame: "box", caption: "Scan me" }) }), method: "PUT" });
    expect(put.status).toBe(200);
    expect(await (await call(`${API}/qr/default`, { headers: bearer })).json()).toMatchObject({ style: { frame: "box" } });
  });

  it("keeps uploaded logos that a design uses", async () => {
    const png = new Uint8Array(64);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 64, 0, 0, 0, 64]);
    const upload = async () =>
      ((await (await call(`${API}/previews/images`, { method: "POST", headers: { ...bearer, "Content-Type": "image/png" }, body: png })).json()) as { image: { key: string } }).image.key;
    const [onLink, onDefault, unused] = [await upload(), await upload(), await upload()];
    await patch({ qr: style({ logo: { key: onLink, size: 0.2 } }) });
    await call(`${API}/qr/default`, { ...json({ style: style({ logo: { key: onDefault, size: 0.2 } }) }), method: "PUT" });
    expect(await prunePreviewImages(env, nowSec() + 2 * 86400)).toBe(1);
    expect(await env.LINKS.get(`og:${unused}`)).toBeNull();
    expect(await env.LINKS.get(`og:${onLink}`)).not.toBeNull();
    expect(await env.LINKS.get(`og:${onDefault}`)).not.toBeNull();
  });
});
