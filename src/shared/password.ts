// PBKDF2-SHA256 password hashes for the admin login. WebCrypto only, so the
// Worker, the Node scripts and the tests all use the same code.
//
// Stored as "pbkdf2-sha256:<iterations>:<salt>:<hash>" (base64url). Colons,
// not "$", so dotenv in .dev.vars can't mistake parts of it for variables.

const PREFIX = "pbkdf2-sha256";
const PBKDF2_MIN_ITERATIONS = 10_000;
/** workerd refuses PBKDF2 above 100,000 iterations. */
const PBKDF2_MAX_ITERATIONS = 100_000;
const DEFAULT_ITERATIONS = PBKDF2_MAX_ITERATIONS;
/** Cost per Workers plan: Free has 10 ms of CPU per request, Paid allows the workerd maximum. */
export const PLAN_ITERATIONS = { free: 25_000, paid: PBKDF2_MAX_ITERATIONS } as const;
const SALT_BYTES = 16;
const HASH_BYTES = 32;
/** Longer input is rejected before hashing, so a huge body can't cost CPU. */
export const MAX_PASSWORD_LENGTH = 1024;
/** Shortest admin password: the setup refuses shorter, and the Worker ignores a shorter ADMIN_PASSWORD. */
export const MIN_ADMIN_PASSWORD_LENGTH = 9;

export interface PasswordHash {
  iterations: number;
  salt: Uint8Array<ArrayBuffer>;
  hash: Uint8Array<ArrayBuffer>;
}

export function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromBase64Url(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export function parsePasswordHash(encoded: string): PasswordHash | null {
  const parts = encoded.trim().split(":");
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < PBKDF2_MIN_ITERATIONS || iterations > PBKDF2_MAX_ITERATIONS) return null;
  const salt = fromBase64Url(parts[2] ?? "");
  const hash = fromBase64Url(parts[3] ?? "");
  if (!salt || !hash || salt.length < SALT_BYTES || hash.length !== HASH_BYTES) return null;
  return { iterations, salt, hash };
}

export function formatPasswordHash(h: PasswordHash): string {
  return `${PREFIX}:${h.iterations}:${toBase64Url(h.salt)}:${toBase64Url(h.hash)}`;
}

/** The raw PBKDF2 output for a password (NFC-normalized). */
export async function derivePassword(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password.normalize("NFC")), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, HASH_BYTES * 8);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, iterations = DEFAULT_ITERATIONS): Promise<string> {
  if (iterations < PBKDF2_MIN_ITERATIONS || iterations > PBKDF2_MAX_ITERATIONS) {
    throw new Error(`Iterations must be between ${PBKDF2_MIN_ITERATIONS} and ${PBKDF2_MAX_ITERATIONS}.`);
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  return formatPasswordHash({ iterations, salt, hash: await derivePassword(password, salt, iterations) });
}
