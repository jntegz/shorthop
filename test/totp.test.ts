import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, matchTotp, newTotpSecret, normalizeTotp, otpauthUri, totpCode, totpStep } from "../src/worker/totp";

// RFC 6238, appendix B (SHA-1): the secret is the ASCII "12345678901234567890".
const RFC_SECRET = new TextEncoder().encode("12345678901234567890");
const RFC_B32 = base32Encode(RFC_SECRET);

describe("TOTP", () => {
  it("matches the RFC 6238 test vectors (last six digits)", async () => {
    const vectors: [number, string][] = [
      [59, "287082"],
      [1111111109, "081804"],
      [1111111111, "050471"],
      [1234567890, "005924"],
      [2000000000, "279037"],
    ];
    for (const [time, code] of vectors) expect(await totpCode(RFC_SECRET, totpStep(time))).toBe(code);
  });

  it("round-trips base32 and refuses anything else", () => {
    expect(RFC_B32).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode(RFC_B32)).toEqual(RFC_SECRET);
    expect(base32Decode("gezd gnbv-gy3t qojq gezd gnbv gy3t qojq")).toEqual(RFC_SECRET);
    expect(base32Decode("GEZ1")).toBeNull();
    expect(base32Decode("")).toBeNull();
    expect(base32Decode(newTotpSecret())?.length).toBe(20);
  });

  it("accepts one step of drift either way, never more", async () => {
    const now = 1_800_000_000;
    const step = totpStep(now);
    for (const d of [-1, 0, 1]) expect(await matchTotp(RFC_B32, await totpCode(RFC_SECRET, step + d), now)).toBe(step + d);
    for (const d of [-2, 2]) expect(await matchTotp(RFC_B32, await totpCode(RFC_SECRET, step + d), now)).toBeNull();
  });

  it("never matches a step at or before the last one used", async () => {
    const now = 1_800_000_000;
    const step = totpStep(now);
    const code = await totpCode(RFC_SECRET, step);
    expect(await matchTotp(RFC_B32, code, now, step - 1)).toBe(step);
    expect(await matchTotp(RFC_B32, code, now, step)).toBeNull();
    expect(await matchTotp(RFC_B32, await totpCode(RFC_SECRET, step - 1), now, step - 1)).toBeNull();
  });

  it("takes six digits with spaces, nothing else", () => {
    expect(normalizeTotp("123 456")).toBe("123456");
    expect(normalizeTotp("12345")).toBeNull();
    expect(normalizeTotp("abcdef")).toBeNull();
  });

  it("builds the otpauth link authenticator apps read", () => {
    const uri = otpauthUri({ issuer: "Shorthop (short.example.com)", account: "owner@example.com", secret: RFC_B32 });
    expect(uri).toBe(
      `otpauth://totp/Shorthop%20(short.example.com)%3Aowner%40example.com?secret=${RFC_B32}&issuer=Shorthop+%28short.example.com%29&algorithm=SHA1&digits=6&period=30`,
    );
  });
});
