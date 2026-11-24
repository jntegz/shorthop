// Time-based one-time passwords (RFC 6238) for authenticator apps: HMAC-SHA1,
// 6 digits, 30-second steps, on WebCrypto. A code is accepted one step either
// side of now (clock drift), and the caller stores the step it matched, so a
// code can't be used twice.

export const TOTP_STEP_SEC = 30;
export const TOTP_DIGITS = 6;
/** Steps accepted either side of the current one. */
export const TOTP_DRIFT = 1;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Null for anything but base32 (spaces, dashes, lowercase and padding are fine). */
export function base32Decode(text: string): Uint8Array | null {
  const clean = text.replace(/[\s=-]/g, "").toUpperCase();
  if (!clean) return null;
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i === -1) return null;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** A new shared secret: 20 random bytes (160 bits, as RFC 4226 recommends), base32. */
export function newTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

export function totpStep(nowSec: number): number {
  return Math.floor(nowSec / TOTP_STEP_SEC);
}

/** The code for one time step. */
export async function totpCode(secret: Uint8Array, step: number): Promise<string> {
  const counter = new Uint8Array(8);
  let n = step;
  for (let i = 7; i >= 0; i--) {
    counter[i] = n & 255;
    n = Math.floor(n / 256);
  }
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
  const offset = mac[mac.length - 1]! & 15;
  const bin = ((mac[offset]! & 127) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/** Six digits, with any spaces taken out; null when it isn't one. */
export function normalizeTotp(code: string): string | null {
  const c = code.replace(/\s/g, "");
  return /^\d{6}$/.test(c) ? c : null;
}

function sameCode(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  return x.length === y.length && crypto.subtle.timingSafeEqual(x, y);
}

/**
 * The time step a code matches, newest first, or null. Steps at or before
 * `lastStep` (already used) never match.
 */
export async function matchTotp(secretB32: string, code: string, nowSec: number, lastStep: number | null = null): Promise<number | null> {
  const secret = base32Decode(secretB32);
  const c = normalizeTotp(code);
  if (!secret || !c) return null;
  const now = totpStep(nowSec);
  for (let s = now + TOTP_DRIFT; s >= now - TOTP_DRIFT; s--) {
    if (lastStep !== null && s <= lastStep) break;
    if (sameCode(await totpCode(secret, s), c)) return s;
  }
  return null;
}

/** The otpauth:// link an authenticator app reads from the QR code. */
export function otpauthUri(opts: { issuer: string; account: string; secret: string }): string {
  const label = encodeURIComponent(`${opts.issuer}:${opts.account}`);
  const q = new URLSearchParams({ secret: opts.secret, issuer: opts.issuer, algorithm: "SHA1", digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SEC) });
  return `otpauth://totp/${label}?${q.toString()}`;
}
