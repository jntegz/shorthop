// Payment providers of one website (Settings and setup → #payments): every
// provider with a switch; switching one on creates its connection and opens
// its setup (webhook address, credentials, settings, check, product filter,
// import of past payments, remove). No boxes inside the section: rows under
// 1 px rules, the open setup indented under its row, step numbers in ink-3.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronDown, CircleAlert, CircleX, ShieldCheck, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { PROVIDER_INFO, PROVIDERS, type ConnectionCheckDTO, type ConnectionDTO, type Provider, type SecretMode, type SiteDTO } from "../../../shared/sites";
import { api, ApiError, call, keys } from "../../api";
import { ago } from "../../lib/format";
import { useMe } from "../../lib/me";
import { copy } from "../../lib/utils";
import { Badge, Button, Dialog, ErrorState, Input, Section, Segmented, Select, Skeleton, Switch, errorText } from "../ui";
import { C, CopyField } from "./parts";

/** "Demo shop" → "DEMO_SHOP", for secret names that stay apart between sites. */
function siteSuffix(site: SiteDTO): string {
  return site.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 20) || "SITE";
}

export const suggestedSecretName = (base: string, site: SiteDTO) => `${base}_${siteSuffix(site)}`;

const message = (e: unknown) => errorText(e) ?? "Something went wrong";

/** A badge only when there's news: paused, needs setup, refused, check failed, receiving, waiting. Off says nothing (the switch says it). */
function StatusBadge({ conn }: { conn: ConnectionDTO | undefined }) {
  if (!conn) return null;
  if (!conn.enabled) return <Badge>Paused</Badge>;
  const info = PROVIDER_INFO[conn.provider];
  const missing = ((info.webhookSecret || info.urlToken) && !conn.hasSecret) || (info.apiKey?.required && !conn.hasApiKey) || info.settings.some((s) => s.required && !conn.settings[s.key]);
  if (missing) return <Badge tone="danger">Needs setup</Badge>;
  const refused = conn.lastError && (!conn.lastEventAt || (conn.lastErrorAt ?? 0) > conn.lastEventAt);
  if (refused) return <Badge tone="danger">Last webhook refused</Badge>;
  if (conn.lastCheck && !conn.lastCheck.ok) return <Badge tone="danger">Check failed</Badge>;
  if (conn.lastEventAt) return <Badge tone="good">Receiving · {ago(conn.lastEventAt)}</Badge>;
  return <Badge tone="warn">Waiting for the first webhook</Badge>;
}

/** Every provider with a switch; switching one on creates its connection and opens its setup. */
export function PaymentProviders({ site }: { site: SiteDTO }) {
  const qc = useQueryClient();
  const conns = useQuery({ queryKey: keys.connections(site.id), queryFn: () => call(api.sites[":id"].connections.$get({ param: { id: site.id } })) });
  const [open, setOpen] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: keys.connections(site.id) });
  const create = useMutation({
    mutationFn: (provider: Provider) => call(api.sites[":id"].connections.$post({ param: { id: site.id }, json: { provider } })),
    onSuccess: (c) => {
      void refresh();
      setOpen(c.id);
    },
    onError: (e) => toast.error(e.message),
  });
  const toggle = useMutation({
    mutationFn: (c: ConnectionDTO) => call(api.sites[":id"].connections[":conn"].$patch({ param: { id: site.id, conn: c.id }, json: { enabled: !c.enabled } })),
    onSuccess: (c) => {
      void refresh();
      toast.success(`${PROVIDER_INFO[c.provider].label} ${c.enabled ? "turned on" : "paused"}`, { description: c.enabled ? undefined : "Webhooks are answered but nothing is recorded until you turn it back on." });
    },
    onError: (e) => toast.error(message(e)),
  });
  const list = conns.data?.connections ?? [];

  return (
    <Section id="payments" title="Payment providers" sub="Switch on each service you sell with. Its setup opens below: copy the webhook address into the provider, add its secret, then check the connection.">
      {conns.isPending ? (
        <ul className="sitepage-prov-list" aria-busy aria-label="Loading payment providers">
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="sitepage-prov-row">
              <span className="sitepage-prov-main">
                <Skeleton className="ui-skel-text" style={{ width: 110 }} />
                <Skeleton className="ui-skel-text" style={{ width: "70%" }} />
              </span>
            </li>
          ))}
        </ul>
      ) : conns.isError && !conns.data ? (
        // Without the list every switch would look off, and switching one on would add a duplicate.
        <ErrorState compact what="Your payment connections" error={conns.error} onRetry={() => void conns.refetch()} retrying={conns.isFetching} />
      ) : (
        <ul className="sitepage-prov-list">
          {PROVIDERS.map((p) => {
            const conn = list.find((c) => c.provider === p);
            const expanded = Boolean(conn && open === conn.id);
            const info = PROVIDER_INFO[p];
            const busy = (create.isPending && create.variables === p) || (toggle.isPending && toggle.variables?.provider === p);
            return (
              <li key={p} className="sitepage-prov">
                <div className="sitepage-prov-row">
                  {conn ? (
                    <button type="button" className="sitepage-prov-main is-button" aria-expanded={expanded} aria-controls={`setup-${conn.id}`} onClick={() => setOpen(expanded ? null : conn.id)}>
                      <span className="sitepage-prov-name">
                        {info.label}
                        <ChevronDown aria-hidden className="sitepage-prov-chevron" data-open={expanded ? "" : undefined} />
                      </span>
                      <span className="sitepage-prov-sub">{info.checkout}</span>
                    </button>
                  ) : (
                    <span className="sitepage-prov-main">
                      <span className="sitepage-prov-name">{info.label}</span>
                      <span className="sitepage-prov-sub">{info.checkout}</span>
                    </span>
                  )}
                  <span className="sitepage-prov-status">
                    <StatusBadge conn={conn} />
                  </span>
                  <Switch
                    id={`prov-${p}`}
                    className="sitepage-prov-switch"
                    label={`${info.label} on`}
                    hideLabel
                    checked={Boolean(conn?.enabled)}
                    disabled={busy}
                    onCheckedChange={() => (conn ? toggle.mutate(conn) : create.mutate(p))}
                  />
                </div>
                {conn && expanded ? <ProviderSetup site={site} conn={conn} onRemoved={() => setOpen(null)} /> : null}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="sitepage-step">
      <span className="sitepage-step-n" aria-hidden>{n}</span>
      <div className="sitepage-step-body">
        <h3 className="sitepage-h3">
          <span className="ui-sr">Step {n}: </span>
          {title}
        </h3>
        {children}
      </div>
    </section>
  );
}

/** One connection's setup: webhook address, secrets, settings, product filter, check, import. */
function ProviderSetup({ site, conn, onRemoved }: { site: SiteDTO; conn: ConnectionDTO; onRemoved: () => void }) {
  const qc = useQueryClient();
  const info = PROVIDER_INFO[conn.provider];
  const [settings, setSettings] = useState<Record<string, string>>(conn.settings);
  const [filter, setFilter] = useState(conn.productFilter.join(", "));
  const refresh = () => qc.invalidateQueries({ queryKey: keys.connections(site.id) });
  const save = useMutation({
    mutationFn: (json: Record<string, unknown>) => call(api.sites[":id"].connections[":conn"].$patch({ param: { id: site.id, conn: conn.id }, json })),
    onSuccess: () => {
      toast.success("Saved");
      void refresh();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't save"),
  });
  const [removing, setRemoving] = useState(false);
  const remove = useMutation({
    mutationFn: () => call(api.sites[":id"].connections[":conn"].$delete({ param: { id: site.id, conn: conn.id } })),
    onSuccess: () => {
      setRemoving(false);
      void refresh();
      onRemoved();
    },
    onError: (e) => toast.error(message(e)),
  });
  let n = 0;

  return (
    <div className="sitepage-setup" id={`setup-${conn.id}`}>
      <Step n={++n} title={`Add the webhook in ${info.label}`}>
        <p>
          {info.where}. Paste this address{info.urlToken ? " (the token in it is the secret, so keep it private)" : ""}:
        </p>
        <CopyField id={`wh-${conn.id}`} value={conn.webhookUrl} label="Webhook address" />
        <div>
          <p className="sitepage-label">Send these events</p>
          <ul className="sitepage-chips" aria-label="Events">
            {info.events.map((e) => (
              <li key={e}>
                <button type="button" className="sitepage-chip" onClick={() => void copy(e, "Event name copied")} title="Copy" aria-label={`Copy ${e}`}>
                  {e}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </Step>

      {info.webhookSecret || info.apiKey || info.settings.length ? (
        <Step n={++n} title="Add its credentials">
          {info.webhookSecret ? (
            <SecretField
              site={site}
              conn={conn}
              field="webhookSecret"
              label={info.webhookSecret.label}
              hint={info.webhookSecret.hint}
              baseName={info.webhookSecret.suggestedName}
              required
              saving={save.isPending}
              onSave={(json) => save.mutate(json)}
            />
          ) : null}
          {info.apiKey ? (
            <SecretField
              site={site}
              conn={conn}
              field="apiKey"
              label={info.apiKey.label}
              hint={`${info.apiKey.hint} ${info.apiKey.use}`}
              baseName={info.apiKey.suggestedName}
              required={info.apiKey.required}
              saving={save.isPending}
              onSave={(json) => save.mutate(json)}
            />
          ) : null}
          {info.settings.length ? (
            <div className="sitepage-subgroup">
              <div className="sitepage-grid2">
                {info.settings.map((s) =>
                  s.toggle ? (
                    <Switch
                      key={s.key}
                      className="sitepage-span2"
                      id={`set-${conn.id}-${s.key}`}
                      checked={Boolean(settings[s.key])}
                      onCheckedChange={(v) => setSettings((x) => ({ ...x, [s.key]: v ? "1" : "" }))}
                      label={s.label}
                      description={s.hint}
                    />
                  ) : (
                    <Input
                      key={s.key}
                      id={`set-${conn.id}-${s.key}`}
                      label={`${s.label}${s.required ? "" : " (optional)"}`}
                      hint={s.hint}
                      value={settings[s.key] ?? ""}
                      placeholder={s.placeholder}
                      onChange={(e) => setSettings((x) => ({ ...x, [s.key]: e.target.value }))}
                    />
                  ),
                )}
              </div>
              <div className="sitepage-actions">
                <Button size="sm" onClick={() => save.mutate({ settings })} loading={save.isPending}>
                  Save settings
                </Button>
              </div>
            </div>
          ) : null}
        </Step>
      ) : null}

      <Step n={++n} title="Check the connection">
        <CheckPanel site={site} conn={conn} />
      </Step>

      <details className="sitepage-more">
        <summary>More options</summary>
        <div className="sitepage-more-body">
          <div className="sitepage-inline-form">
            <Input
              id={`pf-${conn.id}`}
              label="Only these products (optional)"
              hint="Product IDs, comma-separated. Use it when one provider account sells for several sites. Empty counts every payment."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="prod_123, pdt_456"
            />
            <Button onClick={() => save.mutate({ productFilter: filter.split(/[\s,]+/).filter(Boolean) })}>Save</Button>
          </div>
          {info.importable ? <ImportPast site={site} conn={conn} /> : null}
          <div>
            <Button variant="ghost" size="sm" className="sitepage-danger-text" icon={Trash2} onClick={() => setRemoving(true)}>
              Remove this connection
            </Button>
          </div>
        </div>
      </details>
      <Dialog
        open={removing}
        onOpenChange={setRemoving}
        size="sm"
        title={`Remove ${info.label} from ${site.name}?`}
        description="Its webhooks stop being recorded. Payments already recorded stay."
        footer={
          <>
            <Button onClick={() => setRemoving(false)}>Cancel</Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
              Remove connection
            </Button>
          </>
        }
      />
    </div>
  );
}

/**
 * A secret, kept either as a Cloudflare Worker secret (only its name is saved
 * here) or pasted and stored encrypted. Neither is ever shown again.
 */
function SecretField({
  site,
  conn,
  field,
  label,
  hint,
  baseName,
  required,
  saving,
  onSave,
}: {
  site: SiteDTO;
  conn: ConnectionDTO;
  field: "webhookSecret" | "apiKey";
  label: string;
  hint: string;
  baseName: string;
  required: boolean;
  saving: boolean;
  onSave: (json: Record<string, unknown>) => void;
}) {
  const currentMode = field === "webhookSecret" ? conn.webhookSecretMode : conn.apiKeyMode;
  const currentRef = field === "webhookSecret" ? conn.webhookSecretRef : conn.apiKeyRef;
  // Only owners may name a Worker secret (the API refuses it for anyone else).
  const owner = useMe().data?.owner ?? false;
  // Cloudflare is where secrets belong: the picker starts there even when a pasted value is saved.
  const [mode, setMode] = useState<SecretMode>(owner ? "cloudflare" : "stored");
  const [name, setName] = useState(currentRef ?? suggestedSecretName(baseName, site));
  const [value, setValue] = useState("");
  const id = `${field}-${conn.id}`;
  const command = `npx wrangler secret put ${name || "NAME"}`;

  return (
    <div className="sitepage-subgroup">
      <div className="sitepage-secret-head">
        <p className="sitepage-secret-title">
          {label}
          {required ? "" : " (optional)"}
          {currentMode === "cloudflare" ? (
            <Badge>Cloudflare secret: <span className="sitepage-mono">{currentRef}</span></Badge>
          ) : currentMode === "stored" ? (
            <Badge tone="good">Saved, encrypted</Badge>
          ) : (
            <Badge tone={required ? "warn" : "neutral"}>Not set</Badge>
          )}
        </p>
        {owner ? (
          <Segmented<SecretMode>
            size="sm"
            label={`Where ${label} is kept`}
            value={mode}
            onChange={setMode}
            options={[
              { value: "cloudflare", label: "Cloudflare secret (recommended)", short: "Cloudflare secret" },
              { value: "stored", label: "Paste here" },
            ]}
          />
        ) : null}
      </div>
      <p className="sitepage-note">{hint}</p>
      {owner ? null : <p className="sitepage-note">Pasted values are saved encrypted and never shown again. Only an owner can use a Cloudflare secret instead.</p>}
      {mode === "cloudflare" && currentMode === "stored" ? (
        <p className="sitepage-note">A pasted value is saved (encrypted) and works. To move it to Cloudflare, add the secret below and press Use this name: the pasted copy is then deleted.</p>
      ) : null}
      {owner && mode === "cloudflare" ? (
        <>
          <div className="sitepage-inline-form">
            <Input
              id={`${id}-name`}
              label="Secret name"
              hint="Only this name is saved here. The value lives in Cloudflare and never reaches the database or this page."
              className="sitepage-mono-field"
              value={name}
              onChange={(e) => setName(e.target.value.toUpperCase())}
              autoComplete="off"
              spellCheck={false}
            />
            <Button onClick={() => onSave({ [`${field}Ref`]: name })} loading={saving} disabled={!name}>
              Use this name
            </Button>
          </div>
          <ol className="sitepage-steps-small">
            <li>
              In the project folder, run <C>{command}</C>{" "}
              <button type="button" className="ui-text-button" onClick={() => void copy(command, "Command copied")}>
                Copy<span className="ui-sr"> the command</span>
              </button>{" "}
              and paste the value when asked.
            </li>
            <li>
              Or in the Cloudflare dashboard: Workers &amp; Pages → your Worker → Settings → Variables and Secrets → Add → type Secret, name <C>{name}</C>. Then Deploy.
            </li>
            <li>
              Press <strong>Use this name</strong>, then <strong>Check connection</strong> below. A new secret works right away, without a redeploy of the code.
            </li>
          </ol>
        </>
      ) : (
        <div className="sitepage-inline-form">
          <Input
            id={`${id}-value`}
            label={label}
            hideLabel
            type="password"
            autoComplete="off"
            value={value}
            placeholder={currentMode === "stored" ? "•••••••• (paste to replace)" : "Paste the value"}
            onChange={(e) => setValue(e.target.value)}
          />
          <Button
            onClick={() => {
              onSave({ [field]: value });
              setValue("");
            }}
            loading={saving}
            disabled={!value}
          >
            Save
          </Button>
        </div>
      )}
    </div>
  );
}

const CHECK_ICON = { ok: CheckCircle2, warn: CircleAlert, error: CircleX } as const;
const CHECK_WORD = { ok: "Passed", warn: "Warning", error: "Failed" } as const;

function CheckPanel({ site, conn }: { site: SiteDTO; conn: ConnectionDTO }) {
  const qc = useQueryClient();
  const [result, setResult] = useState<ConnectionCheckDTO | null>(conn.lastCheck);
  const run = useMutation({
    mutationFn: () => call(api.sites[":id"].connections[":conn"].check.$post({ param: { id: site.id, conn: conn.id } })),
    onSuccess: (r) => {
      setResult(r);
      void qc.invalidateQueries({ queryKey: keys.connections(site.id) });
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <>
      <p>Reads each secret, signs a test event with it and verifies it here, asks {PROVIDER_INFO[conn.provider].label} whether the API key works, and shows whether webhooks are arriving.</p>
      <div>
        <Button icon={ShieldCheck} onClick={() => run.mutate()} loading={run.isPending}>
          Check connection
        </Button>
      </div>
      {result ? (
        <div className="sitepage-checks" aria-live="polite">
          <ul>
            {result.checks.map((c) => {
              const Icon = CHECK_ICON[c.status];
              return (
                <li key={c.id} data-status={c.status}>
                  <Icon aria-hidden />
                  <div>
                    <p className="sitepage-check-label">
                      {c.label}
                      <span className="ui-sr">: {CHECK_WORD[c.status]}</span>
                    </p>
                    <p className="sitepage-note">{c.detail}</p>
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="sitepage-note">
            {result.ok ? "Everything needed is in place." : "Fix the items marked with ✕."} Checked {ago(result.at)}.
          </p>
        </div>
      ) : null}
    </>
  );
}

function ImportPast({ site, conn }: { site: SiteDTO; conn: ConnectionDTO }) {
  const qc = useQueryClient();
  const [days, setDays] = useState(365);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const run = async () => {
    setRunning(true);
    setDone(0);
    let cursor: string | null = null;
    let total = 0;
    try {
      do {
        const r: { imported: number; next: string | null } = await call(api.sites[":id"].connections[":conn"].import.$post({ param: { id: site.id, conn: conn.id }, json: { days, cursor } }));
        total += r.imported;
        setDone(total);
        cursor = r.next;
      } while (cursor);
      toast.success(`Imported ${total} past payment${total === 1 ? "" : "s"}`, { description: "Ones already recorded were skipped." });
      void qc.invalidateQueries({ queryKey: keys.site(site.id) });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Import failed");
    } finally {
      setRunning(false);
    }
  };
  return (
    <div className="sitepage-inline-form">
      <Select
        id={`imp-${conn.id}`}
        label="Import past payments"
        hint={conn.hasApiKey ? "Reads earlier payments through the API. Safe to run again: payments already recorded are skipped." : `Add the ${PROVIDER_INFO[conn.provider].apiKey?.label ?? "API key"} first.`}
        value={String(days)}
        onChange={(e) => setDays(Number(e.target.value))}
        options={[
          { value: "30", label: "Last 30 days" },
          { value: "90", label: "Last 90 days" },
          { value: "365", label: "Last 12 months" },
          { value: "1095", label: "Last 3 years" },
        ]}
      />
      <Button onClick={() => void run()} loading={running} disabled={!conn.hasApiKey}>
        Import
      </Button>
      {done !== null ? <span className="sitepage-note sitepage-tabular" role="status">{done} imported</span> : null}
    </div>
  );
}
