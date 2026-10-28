import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronDown, CircleAlert, CircleX, Cloud, Copy, KeyRound, Lock, ShieldCheck, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { PROVIDER_INFO, PROVIDERS, type ConnectionCheckDTO, type ConnectionDTO, type Provider, type SecretMode, type SiteDTO } from "../../shared/sites";
import { api, ApiError, call, keys } from "../api";
import { ago } from "../lib/format";
import { useMe } from "../lib/me";
import { cn, copy } from "../lib/utils";
import { Badge, Button, Card, CardHeader, Field, Input, Segmented, Select, Spinner, Switch } from "./ui";

/** "Demo shop" → "DEMO_SHOP", for secret names that stay apart between sites. */
function siteSuffix(site: SiteDTO): string {
  return site.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 20) || "SITE";
}

export const suggestedSecretName = (base: string, site: SiteDTO) => `${base}_${siteSuffix(site)}`;

function StatusBadge({ conn }: { conn: ConnectionDTO | undefined }) {
  if (!conn) return <Badge>Off</Badge>;
  if (!conn.enabled) return <Badge>Paused</Badge>;
  const info = PROVIDER_INFO[conn.provider];
  const missing = ((info.webhookSecret || info.urlToken) && !conn.hasSecret) || (info.apiKey?.required && !conn.hasApiKey) || info.settings.some((s) => s.required && !conn.settings[s.key]);
  if (missing) return <Badge tone="warn">Needs setup</Badge>;
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
  });
  const list = conns.data?.connections ?? [];

  return (
    <Card>
      <CardHeader
        title="2. Payment providers"
        description="Switch on each service you sell with. Its setup opens below: copy the webhook address into the provider, add its secret, then check the connection."
      />
      {conns.isPending ? (
        <div className="flex justify-center py-8"><Spinner /></div>
      ) : (
        <ul className="divide-y divide-line border-t border-line">
          {PROVIDERS.map((p) => {
            const conn = list.find((c) => c.provider === p);
            const expanded = conn && open === conn.id;
            const info = PROVIDER_INFO[p];
            return (
              <li key={p}>
                <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-default"
                    disabled={!conn}
                    onClick={() => conn && setOpen(expanded ? null : conn.id)}
                    aria-expanded={Boolean(expanded)}
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-surface-2 text-sm font-semibold text-fg">{info.label.slice(0, 1)}</span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-fg">{info.label}</span>
                      <span className="block truncate text-xs text-muted">{info.checkout}</span>
                    </span>
                    {conn ? <ChevronDown className={cn("ml-auto size-4 shrink-0 text-muted transition-transform", expanded && "rotate-180")} /> : null}
                  </button>
                  <StatusBadge conn={conn} />
                  <ProviderSwitch
                    id={`prov-${p}`}
                    label={`${info.label} on`}
                    checked={Boolean(conn?.enabled)}
                    busy={(create.isPending && create.variables === p) || (toggle.isPending && toggle.variables?.provider === p)}
                    onChange={() => (conn ? toggle.mutate(conn) : create.mutate(p))}
                  />
                </div>
                {conn && expanded ? <ProviderSetup site={site} conn={conn} onRemoved={() => setOpen(null)} /> : null}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function ProviderSwitch({ id, label, checked, busy, onChange }: { id: string; label: string; checked: boolean; busy: boolean; onChange: () => void }) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={busy}
      onClick={onChange}
      className={cn("relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-60", checked ? "bg-accent" : "bg-line")}
    >
      <span className={cn("block size-5 rounded-full bg-white shadow transition-transform", checked ? "translate-x-5.5" : "translate-x-0.5")} />
    </button>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="flex gap-3">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">{n}</span>
      <div className="min-w-0 flex-1 space-y-3">
        <h4 className="text-sm font-semibold text-fg">{title}</h4>
        {children}
      </div>
    </section>
  );
}

function CopyField({ id, value, label }: { id: string; value: string; label: string }) {
  return (
    <div className="flex gap-2">
      <Input id={id} readOnly value={value} className="font-mono text-xs" aria-label={label} onFocus={(e) => e.currentTarget.select()} />
      <Button type="button" variant="outline" size="icon" aria-label={`Copy ${label}`} onClick={() => void copy(value, `${label} copied`)}><Copy /></Button>
    </div>
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
  const remove = useMutation({
    mutationFn: () => call(api.sites[":id"].connections[":conn"].$delete({ param: { id: site.id, conn: conn.id } })),
    onSuccess: () => {
      void refresh();
      onRemoved();
    },
  });
  let n = 0;

  return (
    <div className="space-y-6 border-t border-line bg-bg/50 px-4 py-5 sm:pl-16">
      <Step n={++n} title={`Add the webhook in ${info.label}`}>
        <p className="text-sm text-muted">{info.where}. Paste this address{info.urlToken ? " (the token in it is the secret, so keep it private)" : ""}:</p>
        <CopyField id={`wh-${conn.id}`} value={conn.webhookUrl} label="Webhook address" />
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted">Send these events</p>
          <div className="flex flex-wrap gap-1.5">
            {info.events.map((e) => (
              <button key={e} type="button" onClick={() => void copy(e, "Event name copied")} className="rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[11px] text-fg hover:border-accent/40" title="Copy">
                {e}
              </button>
            ))}
          </div>
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
            <div className="grid gap-3 rounded-md border border-line bg-surface p-3 sm:grid-cols-2">
              {info.settings.map((s) =>
                s.toggle ? (
                  <div key={s.key} className="sm:col-span-2">
                    <Switch id={`set-${conn.id}-${s.key}`} checked={Boolean(settings[s.key])} onCheckedChange={(v) => setSettings((x) => ({ ...x, [s.key]: v ? "1" : "" }))} label={s.label} description={s.hint} />
                  </div>
                ) : (
                  <Field key={s.key} label={`${s.label}${s.required ? "" : " (optional)"}`} htmlFor={`set-${conn.id}-${s.key}`} hint={s.hint}>
                    <Input id={`set-${conn.id}-${s.key}`} value={settings[s.key] ?? ""} placeholder={s.placeholder} onChange={(e) => setSettings((x) => ({ ...x, [s.key]: e.target.value }))} />
                  </Field>
                ),
              )}
              <div className="flex justify-end sm:col-span-2">
                <Button size="sm" variant="outline" onClick={() => save.mutate({ settings })} loading={save.isPending}>Save settings</Button>
              </div>
            </div>
          ) : null}
        </Step>
      ) : null}

      <Step n={++n} title="Check the connection">
        <CheckPanel site={site} conn={conn} />
      </Step>

      <details className="group rounded-md border border-line bg-surface">
        <summary className="cursor-pointer list-none px-3 py-2 text-sm font-medium text-fg">More options</summary>
        <div className="space-y-4 border-t border-line p-3">
          <Field label="Only these products (optional)" htmlFor={`pf-${conn.id}`} hint="Product IDs, comma-separated. Use it when one provider account sells for several sites. Empty counts every payment.">
            <div className="flex gap-2">
              <Input id={`pf-${conn.id}`} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="prod_123, pdt_456" />
              <Button variant="outline" onClick={() => save.mutate({ productFilter: filter.split(/[\s,]+/).filter(Boolean) })}>Save</Button>
            </div>
          </Field>
          {info.importable ? <ImportPast site={site} conn={conn} /> : null}
          <div className="flex justify-end">
            <Button variant="ghost" size="sm" className="text-danger" onClick={() => confirm(`Remove ${info.label} from ${site.name}? Payments already recorded stay.`) && remove.mutate()} loading={remove.isPending}>
              <Trash2 /> Remove this connection
            </Button>
          </div>
        </div>
      </details>
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
    <div className="space-y-3 rounded-md border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <KeyRound className="size-4 text-muted" />
          <span className="text-sm font-medium">{label}{required ? "" : " (optional)"}</span>
          {currentMode === "cloudflare" ? <Badge tone="accent"><Cloud className="size-3" /> {currentRef}</Badge> : currentMode === "stored" ? <Badge tone="good"><Lock className="size-3" /> Saved, encrypted</Badge> : <Badge>Not set</Badge>}
        </div>
        {owner ? (
          <Segmented<SecretMode>
            label={`Where ${label} is kept`}
            value={mode}
            onChange={setMode}
            options={[{ value: "cloudflare", label: "Cloudflare secret (recommended)" }, { value: "stored", label: "Paste here" }]}
          />
        ) : null}
      </div>
      <p className="text-xs text-muted">{hint}</p>
      {owner ? null : <p className="text-xs text-muted">Pasted values are saved encrypted and never shown again. Only an owner can use a Cloudflare secret instead.</p>}
      {mode === "cloudflare" && currentMode === "stored" ? (
        <p className="rounded-md bg-accent-soft px-3 py-2 text-xs text-accent">A pasted value is saved (encrypted) and works. To move it to Cloudflare, add the secret below and press Use this name: the pasted copy is then deleted.</p>
      ) : null}
      {owner && mode === "cloudflare" ? (
        <div className="space-y-2">
          <Field label="Secret name" htmlFor={`${id}-name`} hint="Only this name is saved here. The value lives in Cloudflare and never reaches the database or this page.">
            <div className="flex gap-2">
              <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value.toUpperCase())} className="font-mono text-xs" />
              <Button variant="outline" onClick={() => onSave({ [`${field}Ref`]: name })} loading={saving} disabled={!name}>Use this name</Button>
            </div>
          </Field>
          <ol className="list-decimal space-y-1.5 pl-5 text-xs text-muted">
            <li>
              In the project folder, run <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-fg">{command}</code>{" "}
              <button type="button" className="text-accent hover:underline" onClick={() => void copy(command, "Command copied")}>copy</button> and paste the value when asked.
            </li>
            <li>Or in the Cloudflare dashboard: Workers &amp; Pages → your Worker → Settings → Variables and Secrets → Add → type Secret, name <code className="font-mono text-fg">{name}</code>. Then Deploy.</li>
            <li>Press <strong>Use this name</strong>, then <strong>Check connection</strong> below. A new secret works right away, without a redeploy of the code.</li>
          </ol>
        </div>
      ) : (
        <div className="flex gap-2">
          <Input id={`${id}-value`} type="password" autoComplete="off" value={value} placeholder={currentMode === "stored" ? "•••••••• (paste to replace)" : "Paste the value"} onChange={(e) => setValue(e.target.value)} aria-label={label} />
          <Button
            variant="outline"
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
const CHECK_TONE = { ok: "text-good", warn: "text-warn", error: "text-danger" } as const;

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
    <div className="space-y-3">
      <p className="text-sm text-muted">Reads each secret, signs a test event with it and verifies it here, asks {PROVIDER_INFO[conn.provider].label} whether the API key works, and shows whether webhooks are arriving.</p>
      <Button onClick={() => run.mutate()} loading={run.isPending}><ShieldCheck /> Check connection</Button>
      {result ? (
        <div className="rounded-md border border-line bg-surface">
          <ul className="divide-y divide-line">
            {result.checks.map((c) => {
              const Icon = CHECK_ICON[c.status];
              return (
                <li key={c.id} className="flex gap-3 px-3 py-2.5 text-sm">
                  <Icon className={cn("mt-0.5 size-4 shrink-0", CHECK_TONE[c.status])} aria-label={c.status} />
                  <div className="min-w-0">
                    <p className="font-medium text-fg">{c.label}</p>
                    <p className="text-xs break-words text-muted">{c.detail}</p>
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="border-t border-line px-3 py-2 text-xs text-muted">{result.ok ? "Everything needed is in place." : "Fix the items marked with ✕."} Checked {ago(result.at)}.</p>
        </div>
      ) : null}
    </div>
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
    <Field label="Import past payments" htmlFor={`imp-${conn.id}`} hint={conn.hasApiKey ? "Reads earlier payments through the API. Safe to run again: payments already recorded are skipped." : `Add the ${PROVIDER_INFO[conn.provider].apiKey?.label ?? "API key"} first.`}>
      <div className="flex flex-wrap items-center gap-2">
        <Select id={`imp-${conn.id}`} value={days} onChange={(e) => setDays(Number(e.target.value))} className="h-10 w-44">
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={365}>Last 12 months</option>
          <option value={1095}>Last 3 years</option>
        </Select>
        <Button variant="outline" onClick={() => void run()} loading={running} disabled={!conn.hasApiKey}>Import</Button>
        {done !== null ? <span className="text-xs text-muted">{done} imported</span> : null}
      </div>
    </Field>
  );
}
