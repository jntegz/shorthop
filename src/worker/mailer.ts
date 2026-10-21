// Digest delivery. Cloudflare Email Service by default; any of a few HTTPS
// email APIs, or a signed webhook, when DIGEST_PROVIDER says so.
//
// Security: keys live only in Wrangler secrets and are never returned by the
// admin API. Provider hosts are fixed here (config picks a provider, not a
// URL), so a key can't be sent anywhere else. Redirects are refused, so
// credentials never follow one. The recipient comes from config only, never
// from a request.

import { HOSTNAME_RE } from "../shared/domains";

const DIGEST_PROVIDERS = ["cloudflare", "resend", "postmark", "sendgrid", "mailgun", "webhook", "off"] as const;
export type DigestProvider = (typeof DIGEST_PROVIDERS)[number];

/** Optional settings that aren't in every deployment's wrangler.jsonc. */
interface DigestEnv {
  DIGEST?: SendEmail;
  DIGEST_PROVIDER?: string;
  /** Secret: API key for resend, postmark, sendgrid or mailgun. */
  DIGEST_API_KEY?: string;
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
  postmark: "Postmark",
  sendgrid: "SendGrid",
  mailgun: "Mailgun",
  webhook: "Webhook",
  off: "Off",
};

export function providerName(p: string): string {
  return PROVIDER_NAMES[p as DigestProvider] ?? p;
}

function digestEnv(env: Env): DigestEnv {
  return env as unknown as DigestEnv;
}

function provider(env: Env): string {
  return (digestEnv(env).DIGEST_PROVIDER || "cloudflare").trim().toLowerCase();
}

/** The configured provider and what, if anything, stops it from sending. */
export function mailerStatus(env: Env): MailerStatus {
  const e = digestEnv(env);
  const p = provider(env);
  const problem = ((): string | null => {
    if (!(DIGEST_PROVIDERS as readonly string[]).includes(p)) return `DIGEST_PROVIDER "${p}" isn't one of: ${DIGEST_PROVIDERS.join(", ")}.`;
    if (p === "off") return "The digest is turned off (DIGEST_PROVIDER=off).";
    if (!env.DIGEST_TO) return "DIGEST_TO is not set.";
    if (p !== "webhook" && !env.DIGEST_FROM) return "DIGEST_FROM is not set.";
    switch (p as DigestProvider) {
      case "cloudflare":
        return e.DIGEST ? null : "The DIGEST send_email binding is missing from wrangler.jsonc.";
      case "mailgun":
        if (!e.DIGEST_MAILGUN_DOMAIN || !HOSTNAME_RE.test(e.DIGEST_MAILGUN_DOMAIN)) return "DIGEST_MAILGUN_DOMAIN must be your Mailgun sending domain.";
        if (e.DIGEST_MAILGUN_REGION && !["us", "eu"].includes(e.DIGEST_MAILGUN_REGION)) return 'DIGEST_MAILGUN_REGION must be "us" or "eu".';
        return e.DIGEST_API_KEY ? null : "The DIGEST_API_KEY secret is not set.";
      case "webhook": {
        let url: URL | null = null;
        try {
          url = new URL(e.DIGEST_WEBHOOK_URL ?? "");
        } catch {
          return "The DIGEST_WEBHOOK_URL secret is not a valid URL.";
        }
        if (url.protocol !== "https:") return "DIGEST_WEBHOOK_URL must use https://.";
        if ((e.DIGEST_WEBHOOK_SECRET ?? "").length < MIN_WEBHOOK_SECRET) return `The DIGEST_WEBHOOK_SECRET secret must be ${MIN_WEBHOOK_SECRET}+ characters.`;
        return null;
      }
      default:
        return e.DIGEST_API_KEY ? null : "The DIGEST_API_KEY secret is not set.";
    }
  })();
  return { provider: p, problem };
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

/** Sends one email through the configured provider. Throws MailerError on failure. */
export async function sendMail(env: Env, msg: OutgoingEmail): Promise<{ messageId?: string }> {
  const { provider: p, problem } = mailerStatus(env);
  if (problem) throw new MailerError(problem);
  const e = digestEnv(env);
  const key = e.DIGEST_API_KEY ?? "";
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
