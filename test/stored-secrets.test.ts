// Stored secrets: the older v1 format still reads, v2 binds each value to what
// it's for, and ENCRYPTION_KEY takes over through the daily re-encryption.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { systemHealth } from "../src/worker/health";
import { reencryptSecrets } from "../src/worker/reencrypt";
import { resetGeneratedSecretsCache, withGeneratedSecrets } from "../src/worker/secrets";
import { decryptSecret, encryptSecret } from "../src/worker/webhooks";
import { fromBase64Url, toBase64Url } from "../src/shared/password";
import { resetData } from "./helpers";

const KEY = "an-encryption-key-0123456789abcdef-0123";
const withKey = { ...env, ENCRYPTION_KEY: KEY } as Env;

beforeEach(async () => {
  await resetData();
  await env.DB.prepare("DELETE FROM webhooks").run();
});

/** A value in the v1 format, as earlier releases stored it. */
async function v1(secret: string): Promise<string> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.SESSION_SECRET), "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("shorthop-webhooks"), info: new TextEncoder().encode("webhook-secret-v1") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(secret));
  return `v1:${toBase64Url(iv)}:${toBase64Url(new Uint8Array(data))}`;
}

const addHook = (secret: string) =>
  env.DB.prepare("INSERT INTO webhooks (url, events, secret, active, created_at, updated_at) VALUES ('https://hooks.example.com/', '[]', ?, 1, 0, 0) RETURNING id")
    .bind(secret)
    .first<{ id: number }>();
const hookSecret = async (id: number) => (await env.DB.prepare("SELECT secret FROM webhooks WHERE id = ?").bind(id).first<{ secret: string }>())!.secret;

describe("stored secrets", () => {
  it("reads the older v1 format", async () => {
    expect(await decryptSecret(env, "webhook", await v1("whsec_old"))).toBe("whsec_old");
  });

  it("binds a value to what it's for", async () => {
    const stored = await encryptSecret(env, "connection:webhook_secret", "token");
    expect(stored).toMatch(/^v2:s:/);
    expect(await decryptSecret(env, "connection:webhook_secret", stored)).toBe("token");
    expect(await decryptSecret(env, "connection:api_key", stored)).toBeNull();
    expect(await decryptSecret(env, "share", stored)).toBeNull();
  });

  it("uses ENCRYPTION_KEY when set, so SESSION_SECRET can change", async () => {
    const stored = await encryptSecret(withKey, "share", "abc");
    expect(stored).toMatch(/^v2:e:/);
    expect(await decryptSecret({ ...withKey, SESSION_SECRET: "a-new-session-secret-0123456789abcdef" }, "share", stored)).toBe("abc");
    expect(await decryptSecret(env, "share", stored)).toBeNull();
    // A tampered value is refused rather than half-read.
    const parts = stored.split(":");
    const data = fromBase64Url(parts[3]!)!;
    data[0]! ^= 1;
    expect(await decryptSecret(withKey, "share", [...parts.slice(0, 3), toBase64Url(data)].join(":"))).toBeNull();
  });

  it("moves older values onto the current key, and leaves unreadable ones alone", async () => {
    const old = (await addHook(await v1("whsec_one")))!.id;
    const bySession = (await addHook(await encryptSecret(env, "webhook", "whsec_two")))!.id;
    const unreadable = (await addHook("v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA"))!.id;

    expect(await reencryptSecrets(env)).toBe(1);
    expect(await hookSecret(old)).toMatch(/^v2:s:/);

    expect(await reencryptSecrets(withKey)).toBe(2);
    for (const [id, plain] of [[old, "whsec_one"], [bySession, "whsec_two"]] as const) {
      expect(await hookSecret(id)).toMatch(/^v2:e:/);
      expect(await decryptSecret(withKey, "webhook", await hookSecret(id))).toBe(plain);
    }
    expect(await hookSecret(unreadable)).toBe("v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA");
    expect(await reencryptSecrets(withKey)).toBe(0);
  });
});

describe("the status page", () => {
  it("suggests ENCRYPTION_KEY only when SESSION_SECRET comes from D1", async () => {
    resetGeneratedSecretsCache();
    const button = await withGeneratedSecrets({ ...env, SESSION_SECRET: "" } as Env);
    const notice = async (e: Env) => (await systemHealth(e)).checks.find((c) => c.id === "encryption");
    expect(await notice(button)).toMatchObject({ status: "warn", advisory: true });
    expect(await notice(env)).toBeUndefined();
    button.ENCRYPTION_KEY = KEY;
    expect(await notice(button)).toBeUndefined();
  });
});
