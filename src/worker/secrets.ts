// Secrets a Deploy to Cloudflare install has no way to generate. When the
// SESSION_SECRET or VISITOR_SALT Wrangler secret is missing, a random value is
// created once, kept in D1 and used instead; a Wrangler secret, once set,
// always wins. Installs made with `npm run setup` set both and never read D1
// for them.

import { toBase64Url } from "../shared/password";

const GENERATED = {
  SESSION_SECRET: "generated_session_secret",
  VISITOR_SALT: "generated_visitor_salt",
} as const;
type Name = keyof typeof GENERATED;
const NAMES = Object.keys(GENERATED) as Name[];

// Per isolate: the values never change once written.
let loaded: Promise<Record<Name, string>> | null = null;

async function load(db: D1Database): Promise<Record<Name, string>> {
  // Every isolate inserts its own candidate; the first one written is kept by all.
  const results = await db.batch<{ key: string; value: string }>([
    ...NAMES.map((n) =>
      db
        .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING")
        .bind(GENERATED[n], toBase64Url(crypto.getRandomValues(new Uint8Array(32)))),
    ),
    db.prepare("SELECT key, value FROM settings WHERE key IN (?, ?)").bind(GENERATED.SESSION_SECRET, GENERATED.VISITOR_SALT),
  ]);
  const rows = results.at(-1)?.results ?? [];
  const value = (n: Name) => rows.find((r) => r.key === GENERATED[n])?.value ?? "";
  return { SESSION_SECRET: value("SESSION_SECRET"), VISITOR_SALT: value("VISITOR_SALT") };
}

/** Tests only: forget the values read in this isolate. */
export function resetGeneratedSecretsCache(): void {
  loaded = null;
}

// The envs withGeneratedSecrets filled in, and with what.
const filledFromD1 = new WeakMap<Env, Name[]>();

/** The secrets this env (as withGeneratedSecrets returned it) took from D1. */
export function secretsFromD1(env: Env): Name[] {
  return filledFromD1.get(env) ?? [];
}

/** The Wrangler secrets this env lacks, and so takes from D1. */
export function generatedSecretNames(env: Env): Name[] {
  return NAMES.filter((n) => !(env[n] ?? ""));
}

/**
 * The env with any missing SESSION_SECRET or VISITOR_SALT filled in from D1.
 * If D1 can't be read, the env is returned as it is: the admin then stays
 * closed (no session secret), and clicks are still recorded.
 */
export async function withGeneratedSecrets(env: Env): Promise<Env> {
  const missing = generatedSecretNames(env);
  if (!missing.length) return env;
  try {
    loaded ??= load(env.DB).catch((err: unknown) => {
      loaded = null;
      throw err;
    });
    const values = await loaded;
    const filled: Env = { ...env, ...Object.fromEntries(missing.map((n) => [n, values[n]])) };
    filledFromD1.set(filled, missing);
    return filled;
  } catch (err) {
    console.error(JSON.stringify({ message: "generated secrets unavailable", error: String(err) }));
    return env;
  }
}
