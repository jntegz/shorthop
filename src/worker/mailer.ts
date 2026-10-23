// Digest delivery. Cloudflare Email Service by default; any of a few HTTPS
// email APIs, any JSON email API ("custom"), or a signed webhook.
//
// The provider, sender and Mailgun domain come from wrangler.jsonc, or from
// Settings → Weekly digest (kept in D1), which overrides it.
//
// Security: keys live only in Wrangler secrets and are never returned by the
// admin API; each provider has its own, so switching never sends one
// provider's key to another. Provider hosts are fixed here, and the custom and
// webhook URLs are secrets, so nothing the admin can change sends a key
// anywhere new. Redirects are refused, so credentials never follow one. The
// recipient is DIGEST_TO, or (sendPersonMail) someone's row in Settings →
// People; never an address from a request.

import { HOSTNAME_RE } from "../shared/domains";
import { DIGEST_PROVIDERS, type DigestProvider, type MailProviderDTO } from "../shared/types";
import { mailSettingsSchema, type MailSettings } from "../shared/schemas";
import { getSetting } from "./db";
import type { UserRow } from "./users";

export { DIGEST_PROVIDERS, type DigestProvider };

/** Optional settings that aren't in every deployment's wrangler.jsonc. */
interface DigestEnv {
  DIGEST?: SendEmail;
  /**
   * Optional send_email binding without a fixed recipient, for mail to people
   * in Settings → People (invite and password links) with the "cloudflare"
   * provider. Needs Cloudflare Email Sending on the Workers Paid plan.
   */
  PEOPLE_MAIL?: SendEmail;
  DIGEST_PROVIDER?: string;
  /** Secret: API key of the provider named in DIGEST_PROVIDER (older setups). */
  DIGEST_API_KEY?: string;
  RESEND_API_KEY?: string;
  EMAILIT_API_KEY?: string;
  POSTMARK_API_KEY?: string;
  SENDGRID_API_KEY?: string;
  MAILGUN_API_KEY?: string;
  /** Secret: HTTPS endpoint of a JSON email API. */
  DIGEST_CUSTOM_URL?: string;
  /** Secret: its API key, sent as DIGEST_CUSTOM_AUTH says. */
  DIGEST_CUSTOM_API_KEY?: string;
  /** "Header-Name: value with {key}". Default "Authorization: Bearer {key}". */
  DIGEST_CUSTOM_AUTH?: string;
  /** JSON body with {from}, {from_email}, {from_name}, {to}, {subject}, {html} and {text}. */
  DIGEST_CUSTOM_BODY?: string;
  DIGEST_MAILGUN_DOMAIN?: string;
  /** "us" (default) or "eu". */
  DIGEST_MAILGUN_REGION?: string;
  /** Secret: HTTPS endpoint that receives the digest as signed JSON. */
  DIGEST_WEBHOOK_URL?: string;
  /** Secret: HMAC-SHA256 key for the webhook signature (32+ characters). */
  DIGEST_WEBHOOK_SECRET?: string;
}

export interface OutgoingEmail {
  from: { email: string; name: string };
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface MailerStatus {
  provider: DigestProvider | string;
  /** Why it can't send, or null when it can. */
  problem: string | null;
}

const TIMEOUT_MS = 10_000;
const MIN_WEBHOOK_SECRET = 32;

const PROVIDER_NAMES: Record<DigestProvider, string> = {
  cloudflare: "Cloudflare Email Service",
  resend: "Resend",
  emailit: "Emailit",
  postmark: "Postmark",
  sendgrid: "SendGrid",
  mailgun: "Mailgun",
  custom: "Custom email API",
  webhook: "Webhook",
  off: "Off",
};

/** The secret holding each API provider's key. */
const KEY_SECRET = {
  resend: "RESEND_API_KEY",
  emailit: "EMAILIT_API_KEY",
  postmark: "POSTMARK_API_KEY",
  sendgrid: "SENDGRID_API_KEY",
  mailgun: "MAILGUN_API_KEY",
  custom: "DIGEST_CUSTOM_API_KEY",
} as const satisfies Partial<Record<DigestProvider, keyof DigestEnv>>;

const SECRETS: Record<DigestProvider, (keyof DigestEnv)[]> = {
  cloudflare: [],
  resend: [KEY_SECRET.resend],
  emailit: [KEY_SECRET.emailit],
  postmark: [KEY_SECRET.postmark],
  sendgrid: [KEY_SECRET.sendgrid],
  mailgun: [KEY_SECRET.mailgun],
  custom: ["DIGEST_CUSTOM_URL", KEY_SECRET.custom],
  webhook: ["DIGEST_WEBHOOK_URL", "DIGEST_WEBHOOK_SECRET"],
  off: [],
};

const DEFAULT_CUSTOM_AUTH = "Authorization: Bearer {key}";
const DEFAULT_CUSTOM_BODY = '{"from":"{from}","to":["{to}"],"subject":"{subject}","html":"{html}","text":"{text}"}';
const HEADER_RE = /^([A-Za-z0-9-]+):[ \t]*(.+)$/;
const RESERVED_HEADERS = new Set(["host", "content-length", "content-type", "transfer-encoding", "connection"]);

export function providerName(p: string): string {
  return PROVIDER_NAMES[p as DigestProvider] ?? p;
}

function digestEnv(env: Env): DigestEnv {
  return env as unknown as DigestEnv;
}

function provider(env: Env): string {
  return (digestEnv(env).DIGEST_PROVIDER || "cloudflare").trim().toLowerCase();
}

/** Where the settings chosen in the admin are kept. */
const SETTINGS_KEY = "mail";
/** The provider wrangler.jsonc names, so DIGEST_API_KEY only ever goes to it. */
const CONFIGURED = Symbol("configured provider");
/** Set when D1 couldn't be read: the admin may have turned email off, so nothing is sent. */
const UNREADABLE = Symbol("mail settings unreadable");

/**
 * The admin's choices from D1, null when wrangler.jsonc applies (no choice, or
 * a malformed one), or "unreadable" when D1 failed.
 */
export async function mailSettings(db: D1Database): Promise<MailSettings | null | "unreadable"> {
  let raw: string | null;
  try {
    raw = await getSetting(db, SETTINGS_KEY);
  } catch (err) {
    console.error(JSON.stringify({ message: "mail settings unreadable", error: String(err) }));
    return "unreadable";
  }
  if (!raw) return null;
  try {
    const parsed = mailSettingsSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // Falls through to the log below.
  }
  console.error(JSON.stringify({ message: "mail settings malformed, using wrangler.jsonc" }));
  return null;
}

export const mailSettingsKey = SETTINGS_KEY;

/** `env` with the admin's mail choices applied. Use it for everything that sends. */
export async function withMailSettings(env: Env): Promise<Env> {
  return applyMailSettings(env, await mailSettings(env.DB));
}

export function applyMailSettings(env: Env, s: MailSettings | null | "unreadable"): Env {
  // Applying twice must not mistake the admin's choice for the configured one.
  const configured = (env as unknown as Record<symbol, string | undefined>)[CONFIGURED] ?? provider(env);
  const merged = { ...env, [CONFIGURED]: configured } as Env & DigestEnv;
  if (s === "unreadable") return { ...merged, [UNREADABLE]: true } as Env;
  if (!s) return merged;
  merged.DIGEST_PROVIDER = s.provider;
  // Off and webhook don't need a sender; keep the configured one then.
  if (s.from) merged.DIGEST_FROM = s.from;
  if (s.mailgunDomain !== undefined) merged.DIGEST_MAILGUN_DOMAIN = s.mailgunDomain;
  if (s.mailgunRegion !== undefined) merged.DIGEST_MAILGUN_REGION = s.mailgunRegion;
  return merged;
}

function apiKey(env: Env, p: string): string | undefined {
  const e = digestEnv(env);
  const own = e[KEY_SECRET[p as keyof typeof KEY_SECRET]];
  if (own) return own;
  const configured = (env as unknown as Record<symbol, string | undefined>)[CONFIGURED] ?? provider(env);
  return configured === p ? e.DIGEST_API_KEY : undefined;
}

function keyProblem(env: Env, p: string): string | null {
  return apiKey(env, p) ? null : `The ${KEY_SECRET[p as keyof typeof KEY_SECRET]} secret is not set.`;
}

/** "Header-Name: value" from DIGEST_CUSTOM_AUTH, or an error. */
function customAuth(e: DigestEnv): { name: string; value: string } | string {
  const m = HEADER_RE.exec((e.DIGEST_CUSTOM_AUTH || DEFAULT_CUSTOM_AUTH).trim());
  if (!m || RESERVED_HEADERS.has(m[1]!.toLowerCase())) return 'DIGEST_CUSTOM_AUTH must look like "Authorization: Bearer {key}" or "X-Api-Key: {key}".';
  return { name: m[1]!, value: m[2]! };
}

function customBody(e: DigestEnv): unknown {
  // Wrangler passes a var written as a JSON object as an object, not a string.
  const raw = e.DIGEST_CUSTOM_BODY as unknown;
  if (raw && typeof raw === "object") return raw;
  try {
    const body = JSON.parse((raw as string) || DEFAULT_CUSTOM_BODY) as unknown;
    return body && typeof body === "object" ? body : undefined;
  } catch {
    return undefined;
  }
}

/** Fills {placeholders} in every string of the template. Values are inserted as data, so they can't change its shape. */
function fill(template: unknown, values: Record<string, string>): unknown {
  if (typeof template === "string") return template.replace(/\{(\w+)\}/g, (m, k: string) => (Object.hasOwn(values, k) ? values[k]! : m));
  if (Array.isArray(template)) return template.map((v) => fill(v, values));
  if (template && typeof template === "object") return Object.fromEntries(Object.entries(template).map(([k, v]) => [k, fill(v, values)]));
  return template;
}

function httpsUrl(value: string | undefined, name: string): string | null {
  let url: URL;
  try {
    url = new URL(value ?? "");
  } catch {
    return `The ${name} secret is not a valid URL.`;
  }
  return url.protocol === "https:" ? null : `${name} must use https://.`;
}

/** Every provider and whether it could send right now, for the setup guide. */
export function mailProviders(env: Env): MailProviderDTO[] {
  const e = digestEnv(env) as Record<string, unknown>;
  return DIGEST_PROVIDERS.map((id) => ({
    id,
    name: providerName(id),
    problem: mailerStatus({ ...applyMailSettings(env, null), DIGEST_PROVIDER: id } as Env).problem,
    secrets: SECRETS[id].map((name) => ({ name, set: Boolean(e[name]) || (name === KEY_SECRET[id as keyof typeof KEY_SECRET] && Boolean(apiKey(env, id))) })),
  }));
}

/** The configured provider and what, if anything, stops it from sending. */
export function mailerStatus(env: Env): MailerStatus {
  const e = digestEnv(env);
  const p = provider(env);
  const problem = ((): string | null => {
    if ((env as unknown as Record<symbol, unknown>)[UNREADABLE]) return "The email settings couldn't be read from D1.";
    if (!(DIGEST_PROVIDERS as readonly string[]).includes(p)) return `DIGEST_PROVIDER "${p}" isn't one of: ${DIGEST_PROVIDERS.join(", ")}.`;
    if (p === "off") return "Email is turned off.";
    if (!env.DIGEST_TO) return "DIGEST_TO is not set.";
    if (p !== "webhook" && !env.DIGEST_FROM) return "DIGEST_FROM is not set.";
    switch (p as DigestProvider) {
      case "cloudflare":
        return e.DIGEST ? null : "The DIGEST send_email binding is missing from wrangler.jsonc.";
      case "mailgun":
        if (!e.DIGEST_MAILGUN_DOMAIN || !HOSTNAME_RE.test(e.DIGEST_MAILGUN_DOMAIN)) return "DIGEST_MAILGUN_DOMAIN must be your Mailgun sending domain.";
        if (e.DIGEST_MAILGUN_REGION && !["us", "eu"].includes(e.DIGEST_MAILGUN_REGION)) return 'DIGEST_MAILGUN_REGION must be "us" or "eu".';
        return keyProblem(env, p);
      case "custom": {
        const urlProblem = httpsUrl(e.DIGEST_CUSTOM_URL, "DIGEST_CUSTOM_URL");
        if (urlProblem) return urlProblem;
        const auth = customAuth(e);
        if (typeof auth === "string") return auth;
        if (!customBody(e)) return "DIGEST_CUSTOM_BODY must be a JSON object.";
        return auth.value.includes("{key}") ? keyProblem(env, p) : null;
      }
      case "webhook": {
        const urlProblem = httpsUrl(e.DIGEST_WEBHOOK_URL, "DIGEST_WEBHOOK_URL");
        if (urlProblem) return urlProblem;
        if ((e.DIGEST_WEBHOOK_SECRET ?? "").length < MIN_WEBHOOK_SECRET) return `The DIGEST_WEBHOOK_SECRET secret must be ${MIN_WEBHOOK_SECRET}+ characters.`;
        return null;
      }
      default:
        return keyProblem(env, p);
    }
  })();
  return { provider: p, problem };
}

/**
 * Whether mail can reach the people in Settings → People, not just DIGEST_TO.
 * The DIGEST binding is pinned to one address and a webhook only delivers the
 * digest, so those need another way.
 */
export function peopleMailStatus(env: Env): MailerStatus {
  const status = mailerStatus(env);
  if (status.problem) return status;
  if (status.provider === "webhook") return { ...status, problem: "The digest webhook can't email people." };
  if (status.provider === "cloudflare" && !digestEnv(env).PEOPLE_MAIL) {
    return { ...status, problem: "The DIGEST binding only sends to DIGEST_TO. Add a PEOPLE_MAIL send_email binding (Email Sending, Workers Paid) or use another provider." };
  }
  return status;
}

export class MailerError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

const mailbox = (m: OutgoingEmail["from"]) => `${m.name.replace(/["\r\n<>]/g, "")} <${m.email}>`;

async function post(url: string, init: { headers: Record<string, string>; body: string | FormData }): Promise<Response> {
  const res = await fetch(url, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), ...init });
  if (res.status >= 300 && res.status < 400) throw new MailerError(`HTTP ${res.status}: redirects are not followed`);
  if (!res.ok) {
    // Provider error bodies explain the problem ("domain not verified"); keep them short.
    const detail = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
    throw new MailerError(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return res;
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** "t=<unix seconds>,v1=<hex HMAC-SHA256 of `${t}.${body}`>" */
export async function webhookSignature(secret: string, body: string, t: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `t=${t},v1=${hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`)))}`;
}

/**
 * Sends one email through the configured provider. Throws MailerError on
 * failure, with any secret taken out of the message: it ends up in logs, the
 * status page and alert emails.
 */
export async function sendMail(env: Env, msg: OutgoingEmail): Promise<{ messageId?: string }> {
  try {
    return await deliver(env, msg);
  } catch (err) {
    const e = digestEnv(env) as Record<string, unknown>;
    const secrets = [...Object.values(KEY_SECRET), "DIGEST_API_KEY", "DIGEST_CUSTOM_URL", "DIGEST_WEBHOOK_URL", "DIGEST_WEBHOOK_SECRET"]
      .map((name) => e[name])
      .filter((v): v is string => typeof v === "string" && v.length >= 8);
    // Cloudflare's binding sets a string code (E_SENDER_NOT_VERIFIED); fetch errors are DOMExceptions with numeric codes.
    const code = (err as { code?: unknown }).code;
    let text = err instanceof MailerError || typeof code === "string" ? String(err instanceof MailerError ? err.code : code) : err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    for (const s of secrets) text = text.replaceAll(s, "***");
    throw new MailerError(text);
  }
}

async function deliver(env: Env, msg: OutgoingEmail): Promise<{ messageId?: string }> {
  const { provider: p, problem } = mailerStatus(env);
  if (problem) throw new MailerError(problem);
  const e = digestEnv(env);
  const key = apiKey(env, p) ?? "";
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);

  switch (p as DigestProvider) {
    case "cloudflare": {
      const r = await e.DIGEST!.send({ from: msg.from, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text });
      return { messageId: r.messageId };
    }
    case "resend": {
      const res = await post("https://api.resend.com/emails", {
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: mailbox(msg.from), to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text }),
      });
      return { messageId: str((await json(res)).id) };
    }
    case "emailit": {
      const res = await post("https://api.emailit.com/v2/emails", {
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: mailbox(msg.from), to: msg.to, subject: msg.subject, html: msg.html, text: msg.text }),
      });
      return { messageId: str((await json(res)).id) };
    }
    case "postmark": {
      const res = await post("https://api.postmarkapp.com/email", {
        headers: { "X-Postmark-Server-Token": key, Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          From: mailbox(msg.from),
          To: msg.to,
          Subject: msg.subject,
          HtmlBody: msg.html,
          TextBody: msg.text,
          MessageStream: "outbound",
        }),
      });
      return { messageId: str((await json(res)).MessageID) };
    }
    case "sendgrid": {
      const res = await post("https://api.sendgrid.com/v3/mail/send", {
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: msg.to }] }],
          from: msg.from,
          subject: msg.subject,
          content: [
            { type: "text/plain", value: msg.text },
            { type: "text/html", value: msg.html },
          ],
        }),
      });
      return { messageId: res.headers.get("X-Message-Id") ?? undefined };
    }
    case "mailgun": {
      const host = e.DIGEST_MAILGUN_REGION === "eu" ? "api.eu.mailgun.net" : "api.mailgun.net";
      const form = new FormData();
      form.set("from", mailbox(msg.from));
      form.set("to", msg.to);
      form.set("subject", msg.subject);
      form.set("text", msg.text);
      form.set("html", msg.html);
      const res = await post(`https://${host}/v3/${e.DIGEST_MAILGUN_DOMAIN}/messages`, {
        headers: { Authorization: `Basic ${btoa(`api:${key}`)}` },
        body: form,
      });
      return { messageId: str((await json(res)).id) };
    }
    case "custom": {
      const auth = customAuth(e) as { name: string; value: string };
      const body = fill(customBody(e), {
        from: mailbox(msg.from),
        from_email: msg.from.email,
        from_name: msg.from.name,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
      });
      const res = await post(e.DIGEST_CUSTOM_URL!, {
        headers: { [auth.name]: auth.value.replaceAll("{key}", key), Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const r = await json(res);
      return { messageId: str(r.id) ?? str(r.messageId) ?? str(r.message_id) };
    }
    case "webhook": {
      const body = JSON.stringify({ type: "shorthop.digest", ...msg });
      const signature = await webhookSignature(e.DIGEST_WEBHOOK_SECRET!, body, Math.floor(Date.now() / 1000));
      const res = await post(e.DIGEST_WEBHOOK_URL!, {
        headers: { "Content-Type": "application/json", "X-Shorthop-Signature": signature },
        body,
      });
      return { messageId: str((await json(res)).id) };
    }
    default:
      throw new MailerError(`Unsupported provider ${p}`);
  }
}

/** Sends one email to someone in Settings → People: the address is their row's, never a request's. */
export async function sendPersonMail(env: Env, person: Pick<UserRow, "email">, msg: Omit<OutgoingEmail, "to">): Promise<{ messageId?: string }> {
  const { provider: p, problem } = peopleMailStatus(env);
  if (problem) throw new MailerError(problem);
  if (p === "cloudflare") {
    const r = await digestEnv(env).PEOPLE_MAIL!.send({ from: msg.from, to: person.email, subject: msg.subject, html: msg.html, text: msg.text });
    return { messageId: r.messageId };
  }
  return sendMail(env, { ...msg, to: person.email });
}
