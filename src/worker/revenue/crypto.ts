// Webhook signature checks shared by the provider adapters: HMAC-SHA256 with
// Web Crypto, compared in constant time by crypto.subtle.verify.

const enc = new TextEncoder();

export async function hmacKey(secret: Uint8Array<ArrayBuffer> | string): Promise<CryptoKey> {
  const raw = typeof secret === "string" ? enc.encode(secret) : secret;
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/** True when any of the candidate signatures is the HMAC of the message. */
export async function verifyAny(key: CryptoKey, message: string, candidates: (Uint8Array<ArrayBuffer> | null)[]): Promise<boolean> {
  const data = enc.encode(message);
  for (const sig of candidates) {
    if (sig && sig.length === 32 && (await crypto.subtle.verify("HMAC", key, sig, data))) return true;
  }
  return false;
}

/** For tests and the "send a test event" helpers: the hex or base64 HMAC of a message. */
export async function sign(secret: Uint8Array<ArrayBuffer> | string, message: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(message)));
}

/** Tolerance for signed timestamps: provider clocks and retries. */
export const TOLERANCE_SEC = 5 * 60;
