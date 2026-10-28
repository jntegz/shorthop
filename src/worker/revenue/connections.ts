// Payment provider connections: their rows, what the admin sees of them,
// saving (pasted secrets encrypted, or the names of Cloudflare secrets), and
// "Check connection", which tests each part without waiting for a payment.

import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
import type { ConnectionCheckDTO, ConnectionDTO, connectionSchema, Provider, SecretMode } from "../../shared/sites";
import { PROVIDER_INFO } from "../../shared/sites";
import { decryptSecret, encryptSecret } from "../webhooks";
import { ADAPTERS } from "./providers";
import { resolveSecret, type ResolvedSecret } from "./secrets";

export interface ConnectionRow {
  id: string;
  site_id: string;
  provider: string;
  label: string;
  enabled: number;
  webhook_secret: string | null;
  webhook_secret_ref: string | null;
  api_key: string | null;
  api_key_ref: string | null;
  settings: string;
  product_filter: string;
  created_at: number;
  last_event_at: number | null;
  last_error: string | null;
  last_error_at: number | null;
  last_check: string | null;
}

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export const settingsOf = (row: ConnectionRow) => parseJson<Record<string, string>>(row.settings, {});

const mode = (stored: string | null, ref: string | null): SecretMode | null => (ref ? "cloudflare" : stored ? "stored" : null);

export function connectionDTO(row: ConnectionRow, origin: string, urlToken: string | null = null): ConnectionDTO {
  return {
    id: row.id,
    siteId: row.site_id,
    provider: row.provider as Provider,
    label: row.label,
    enabled: row.enabled !== 0,
    hasSecret: Boolean(row.webhook_secret || row.webhook_secret_ref),
    hasApiKey: Boolean(row.api_key || row.api_key_ref),
    webhookSecretMode: mode(row.webhook_secret, row.webhook_secret_ref),
    webhookSecretRef: row.webhook_secret_ref,
    apiKeyMode: mode(row.api_key, row.api_key_ref),
    apiKeyRef: row.api_key_ref,
    settings: settingsOf(row),
    productFilter: parseJson<string[]>(row.product_filter, []),
    webhookUrl: `${origin}/_pay/${row.provider}/${row.id}${urlToken ? `?token=${encodeURIComponent(urlToken)}` : ""}`,
    createdAt: row.created_at,
    lastEventAt: row.last_event_at,
    lastError: row.last_error,
    lastErrorAt: row.last_error_at,
    lastCheck: parseJson<ConnectionCheckDTO | null>(row.last_check, null),
  };
}

export async function connectionSecrets(env: Env, row: ConnectionRow): Promise<{ webhook: ResolvedSecret; apiKey: ResolvedSecret }> {
  const [webhook, apiKey] = await Promise.all([resolveSecret(env, "connection:webhook_secret", row.webhook_secret, row.webhook_secret_ref), resolveSecret(env, "connection:api_key", row.api_key, row.api_key_ref)]);
  return { webhook, apiKey };
}

/**
 * The admin's view of a connection; providers that authenticate by URL token
 * get it in the webhook address. Only a token this app generated (stored
 * encrypted) is ever shown: a value read from a named Worker secret never is,
 * or naming another secret would reveal it.
 */
export async function connectionView(env: Env, row: ConnectionRow, origin: string): Promise<ConnectionDTO> {
  if (!PROVIDER_INFO[row.provider as Provider]?.urlToken || row.webhook_secret_ref || !row.webhook_secret) return connectionDTO(row, origin);
  return connectionDTO(row, origin, await decryptSecret(env, "connection:webhook_secret", row.webhook_secret));
}

type ConnectionInput = Partial<z.infer<typeof connectionSchema>>;

/** The column changes an input asks for. A pasted value replaces a secret name and the other way round. */
export async function connectionChanges(env: Env, input: ConnectionInput, current: ConnectionRow | null): Promise<Record<string, unknown>> {
  const provider = (input.provider ?? current?.provider) as Provider;
  // The URL token is shown in the webhook address, so it's always one this app generated.
  if (PROVIDER_INFO[provider]?.urlToken && input.webhookSecretRef) {
    throw new HTTPException(400, { message: "This provider's token is part of the webhook address, so it can't come from a Cloudflare secret." });
  }
  const out: Record<string, unknown> = {};
  if (input.label !== undefined) out.label = input.label;
  if (input.enabled !== undefined) out.enabled = input.enabled ? 1 : 0;
  if (input.productFilter !== undefined) out.product_filter = JSON.stringify(input.productFilter);
  if (input.settings !== undefined) out.settings = JSON.stringify({ ...(current ? settingsOf(current) : {}), ...input.settings });
  for (const [field, col] of [
    ["webhookSecret", "webhook_secret"],
    ["apiKey", "api_key"],
  ] as const) {
    const value = input[field];
    const ref = input[`${field}Ref` as "webhookSecretRef" | "apiKeyRef"];
    if (value !== undefined) {
      out[col] = value ? await encryptSecret(env, `connection:${col}`, value) : null;
      if (value) out[`${col}_ref`] = null;
    }
    if (ref !== undefined) {
      out[`${col}_ref`] = ref;
      if (ref) out[col] = null;
    }
  }
  return out;
}

// ---- Check connection ------------------------------------------------------------------------

type Check = ConnectionCheckDTO["checks"][number];

/**
 * Tests a connection end to end without a real payment:
 * 1. the signing secret can be read (stored or the named Cloudflare secret) and
 *    a payload signed with it passes this Worker's own verification;
 * 2. the API key (or the provider's credentials) is accepted by the provider;
 * 3. webhooks have arrived, and the last one wasn't refused.
 */
export async function checkConnection(env: Env, row: ConnectionRow): Promise<ConnectionCheckDTO> {
  const provider = row.provider as Provider;
  const info = PROVIDER_INFO[provider];
  const adapter = ADAPTERS[provider];
  const settings = settingsOf(row);
  const { webhook, apiKey } = await connectionSecrets(env, row);
  const checks: Check[] = [];
  const where = (s: ResolvedSecret, ref: string | null) => (s.source === "cloudflare" ? `Cloudflare secret ${ref}` : "saved, encrypted");

  if (row.enabled === 0) checks.push({ id: "enabled", label: "Turned on", status: "warn", detail: "This connection is off: webhooks are answered but nothing is recorded." });

  if (info.webhookSecret) {
    if (webhook.problem) checks.push({ id: "secret", label: info.webhookSecret.label, status: "error", detail: webhook.problem });
    else if (!webhook.value) checks.push({ id: "secret", label: info.webhookSecret.label, status: "error", detail: "Not set yet." });
    else {
      const format = info.webhookSecret.prefix && !webhook.value.startsWith(info.webhookSecret.prefix) ? ` It doesn't start with ${info.webhookSecret.prefix}; check you copied the right value.` : "";
      let detail = `Found (${where(webhook, row.webhook_secret_ref)}).`;
      let status: Check["status"] = format ? "warn" : "ok";
      if (adapter.testSignature) {
        const self = await adapter.testSignature(webhook.value, settings).catch((e: unknown) => String(e));
        if (self) {
          status = "error";
          detail = `Found, but a test signature didn't verify: ${self}`;
        } else detail += " A test event signed with it verifies.";
      }
      checks.push({ id: "secret", label: info.webhookSecret.label, status, detail: detail + format });
    }
  }

  if (info.apiKey) {
    if (apiKey.problem) checks.push({ id: "apiKey", label: info.apiKey.label, status: "error", detail: apiKey.problem });
    else if (!apiKey.value) checks.push({ id: "apiKey", label: info.apiKey.label, status: info.apiKey.required ? "error" : "warn", detail: info.apiKey.required ? "Not set yet." : `Not set. ${info.apiKey.use}` });
    else if (adapter.testApiKey) {
      const problem = await adapter.testApiKey(apiKey.value, settings).catch((e: unknown) => String(e));
      checks.push({ id: "apiKey", label: info.apiKey.label, status: problem ? "error" : "ok", detail: problem ? `The provider refused it: ${problem}` : `Accepted by ${info.label} (${where(apiKey, row.api_key_ref)}).` });
    } else checks.push({ id: "apiKey", label: info.apiKey.label, status: "ok", detail: `Found (${where(apiKey, row.api_key_ref)}).` });
  }

  for (const s of info.settings) {
    if (s.required && !settings[s.key]) checks.push({ id: s.key, label: s.label, status: "error", detail: "Not set yet." });
  }

  const refusedLast = row.last_error && (!row.last_event_at || (row.last_error_at ?? 0) > row.last_event_at);
  checks.push(
    refusedLast
      ? { id: "events", label: "Webhooks", status: "error", detail: `The last webhook was refused: ${row.last_error}` }
      : row.last_event_at
        ? { id: "events", label: "Webhooks", status: "ok", detail: `The last event arrived ${new Date(row.last_event_at * 1000).toISOString().replace("T", " ").slice(0, 16)} UTC.` }
        : { id: "events", label: "Webhooks", status: "warn", detail: `None received yet. Send a test event from ${info.label}, or make a test purchase.` },
  );

  const result: ConnectionCheckDTO = { at: Math.floor(Date.now() / 1000), ok: !checks.some((c) => c.status === "error"), checks };
  await env.DB.prepare("UPDATE payment_connections SET last_check = ?2 WHERE id = ?1").bind(row.id, JSON.stringify(result)).run();
  return result;
}
