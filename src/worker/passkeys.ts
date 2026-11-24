// Passkeys (WebAuthn): a sign-in on its own, no password needed, because a
// passkey is already two factors (the device, unlocked with a fingerprint,
// face or PIN, which userVerification "required" insists on). They also count
// as two-factor sign-in for the workspace rule. Stored in auth_factors next to
// the authenticator app; challenges in auth_challenges, used once.

import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { fromBase64Url, toBase64Url } from "../shared/password";
import type { FactorRow } from "./two-factor";
import { randomToken } from "./users";

/**
 * The WebAuthn library, loaded on first use: it's large (certificate parsing
 * for attestation formats), and the short-link redirects share this Worker, so
 * their cold starts shouldn't pay for it.
 */
const webauthn = () => import("@simplewebauthn/server");

/** The relying party: this admin host. A passkey works only on the host it was made on. */
export interface RelyingParty {
  rpID: string;
  origin: string;
}

export function relyingParty(requestUrl: string): RelyingParty {
  const url = new URL(requestUrl);
  return { rpID: url.hostname, origin: url.origin };
}

const REGISTER = "passkey-register";
const LOGIN = "passkey-login";
const CHALLENGE_TTL_SEC = 5 * 60;
const TIMEOUT_MS = 120_000;
/** No one needs more; it also caps the allowCredentials list. */
export const MAX_PASSKEYS = 10;

/** The same WebAuthn user handle for every passkey of one person, so a device replaces its own older one. */
async function userHandle(email: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`shorthop-webauthn-user|${email}`))).slice(0, 16);
}

async function passkeysOf(db: D1Database, email: string): Promise<FactorRow[]> {
  const { results } = await db.prepare("SELECT * FROM auth_factors WHERE email = ? AND kind = 'passkey' ORDER BY created_at").bind(email).all<FactorRow>();
  return results;
}

const transportsOf = (f: Pick<FactorRow, "transports">): string[] | undefined => (f.transports ? f.transports.split(",").filter(Boolean) : undefined);

/** Replaces any earlier challenge of this kind for this person: one ceremony at a time. */
function saveChallengeStmts(db: D1Database, email: string, purpose: string, challenge: string, now: number): D1PreparedStatement[] {
  return [
    db.prepare("DELETE FROM auth_challenges WHERE email = ? AND purpose = ?").bind(email, purpose),
    db.prepare("INSERT INTO auth_challenges (id, email, purpose, value, expires_at) VALUES (?, ?, ?, ?, ?)").bind(randomToken(16), email, purpose, challenge, now + CHALLENGE_TTL_SEC),
  ];
}

/** Takes the waiting challenge (it works once, even with two answers at the same time), or null. */
async function takeChallenge(db: D1Database, email: string, purpose: string, now: number): Promise<string | null> {
  const row = await db
    .prepare("DELETE FROM auth_challenges WHERE email = ? AND purpose = ? AND expires_at > ? RETURNING value")
    .bind(email, purpose, now)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function passkeyCount(db: D1Database, email: string): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM auth_factors WHERE email = ? AND kind = 'passkey'").bind(email).first<{ n: number }>();
  return row?.n ?? 0;
}

// --- Adding a passkey (Settings) ------------------------------------------------

export async function registrationOptions(db: D1Database, email: string, rp: RelyingParty, now: number): Promise<PublicKeyCredentialCreationOptionsJSON | null> {
  const existing = await passkeysOf(db, email);
  if (existing.length >= MAX_PASSKEYS) return null;
  const { generateRegistrationOptions } = await webauthn();
  const options = await generateRegistrationOptions({
    rpName: "Shorthop",
    rpID: rp.rpID,
    userName: email,
    userDisplayName: email,
    userID: await userHandle(email),
    attestationType: "none",
    timeout: TIMEOUT_MS,
    excludeCredentials: existing.map((f) => ({ id: f.credential_id!, transports: transportsOf(f) })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });
  await db.batch(saveChallengeStmts(db, email, REGISTER, options.challenge, now));
  return options;
}

export type RegisterResult = { ok: true; factor: FactorRow } | { ok: false; reason: "expired" | "invalid" | "exists" | "too-many" };

export async function verifyRegistration(db: D1Database, email: string, response: RegistrationResponseJSON, name: string, rp: RelyingParty, now: number): Promise<RegisterResult> {
  const challenge = await takeChallenge(db, email, REGISTER, now);
  if (!challenge) return { ok: false, reason: "expired" };
  if ((await passkeyCount(db, email)) >= MAX_PASSKEYS) return { ok: false, reason: "too-many" };
  let info;
  try {
    const { verifyRegistrationResponse } = await webauthn();
    const result = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: rp.origin, expectedRPID: rp.rpID, requireUserVerification: true });
    if (!result.verified) return { ok: false, reason: "invalid" };
    info = result.registrationInfo;
  } catch (err) {
    console.warn(JSON.stringify({ message: "passkey registration refused", email, error: String(err) }));
    return { ok: false, reason: "invalid" };
  }
  const factor: FactorRow = {
    id: randomToken(12),
    email,
    kind: "passkey",
    name: name.trim().slice(0, 60) || "Passkey",
    secret_enc: null,
    credential_id: info.credential.id,
    public_key: toBase64Url(info.credential.publicKey),
    sign_count: info.credential.counter,
    transports: info.credential.transports?.join(",") || null,
    last_step: null,
    created_at: now,
    last_used_at: null,
  };
  try {
    await db
      .prepare("INSERT INTO auth_factors (id, email, kind, name, credential_id, public_key, sign_count, transports, created_at) VALUES (?, ?, 'passkey', ?, ?, ?, ?, ?, ?)")
      .bind(factor.id, email, factor.name, factor.credential_id, factor.public_key, factor.sign_count, factor.transports, now)
      .run();
  } catch (err) {
    if (/UNIQUE/i.test(String(err))) return { ok: false, reason: "exists" };
    throw err;
  }
  return { ok: true, factor };
}

// --- Signing in with a passkey -------------------------------------------------

/** Request options for this person's passkeys, or null when they have none. */
export async function loginOptions(db: D1Database, email: string, rp: RelyingParty, now: number): Promise<PublicKeyCredentialRequestOptionsJSON | null> {
  const existing = await passkeysOf(db, email);
  if (!existing.length) return null;
  const { generateAuthenticationOptions } = await webauthn();
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    timeout: TIMEOUT_MS,
    userVerification: "required",
    allowCredentials: existing.map((f) => ({ id: f.credential_id!, transports: transportsOf(f) })),
  });
  await db.batch(saveChallengeStmts(db, email, LOGIN, options.challenge, now));
  return options;
}

export type LoginResult = { ok: true; factor: FactorRow } | { ok: false; reason: "expired" | "unknown" | "invalid" };

/**
 * Whether the answer is from one of this person's own passkeys, for the
 * waiting challenge, with the user verified. A signature counter that doesn't
 * move forward (when the device keeps one) is refused: a cloned key.
 */
export async function verifyLogin(db: D1Database, email: string, response: AuthenticationResponseJSON, rp: RelyingParty, now: number): Promise<LoginResult> {
  const challenge = await takeChallenge(db, email, LOGIN, now);
  if (!challenge) return { ok: false, reason: "expired" };
  const factor = await db
    .prepare("SELECT * FROM auth_factors WHERE email = ? AND kind = 'passkey' AND credential_id = ?")
    .bind(email, response.id)
    .first<FactorRow>();
  const publicKey = factor?.public_key ? fromBase64Url(factor.public_key) : null;
  if (!factor || !publicKey) return { ok: false, reason: "unknown" };
  try {
    const { verifyAuthenticationResponse } = await webauthn();
    const { verified, authenticationInfo } = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
      credential: { id: factor.credential_id!, publicKey: new Uint8Array(publicKey), counter: factor.sign_count, transports: transportsOf(factor) },
    });
    if (!verified) return { ok: false, reason: "invalid" };
    // Only if no other sign-in moved the counter meanwhile.
    const res = await db
      .prepare("UPDATE auth_factors SET sign_count = ?1, last_used_at = ?2 WHERE id = ?3 AND sign_count = ?4")
      .bind(authenticationInfo.newCounter, now, factor.id, factor.sign_count)
      .run();
    if (!res.meta.changes) return { ok: false, reason: "invalid" };
    return { ok: true, factor: { ...factor, sign_count: authenticationInfo.newCounter, last_used_at: now } };
  } catch (err) {
    console.warn(JSON.stringify({ message: "passkey sign-in refused", email, error: String(err) }));
    return { ok: false, reason: "invalid" };
  }
}
