import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ChevronRight, Clock, Copy, KeyRound, Pencil, Plus, RotateCcw, ScrollText, Send, Trash2, Webhook as WebhookIcon, XCircle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { WebhookDeliveryDTO, WebhookDTO } from "../../shared/types";
import { WEBHOOK_EVENTS, webhookUrlProblem } from "../../shared/webhooks";
import { api, call, keys } from "../api";
import { ago, hostOf, num, when } from "../lib/format";
import { SETTINGS_HELP } from "../lib/help";
import { cn, copy } from "../lib/utils";
import { Badge, Button, Card, CardHeader, Dialog, Empty, Field, Input, Notice, Spinner, Switch } from "./ui";

const EVENT_LABEL: Record<string, string> = { ...Object.fromEntries(WEBHOOK_EVENTS.map((e) => [e.type, e.label])), "webhook.test": "Test event" };

const VERIFY_SNIPPET = `// Node.js: check X-Shorthop-Signature before trusting a request.
import crypto from "node:crypto";

function verify(rawBody, header, secret) {
  const [, t, v1] = /^t=(\\d+),v1=([0-9a-f]{64})$/.exec(header ?? "") ?? [];
  if (!t || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = crypto.createHmac("sha256", secret).update(\`\${t}.\${rawBody}\`).digest();
  return crypto.timingSafeEqual(Buffer.from(v1, "hex"), expected);
}`;

/** Shown once: after creating an endpoint and after rotating its secret. */
function SecretReveal({ secret, onDone }: { secret: string; onDone: () => void }) {
  return (
    <div className="space-y-4">
      <Notice tone="accent">Copy this signing secret now: it can't be shown again, only replaced.</Notice>
      <div className="flex items-center gap-2 rounded-md border border-line bg-bg px-3 py-2.5">
        <KeyRound className="size-4 shrink-0 text-accent" aria-hidden />
        <code className="min-w-0 flex-1 font-mono text-xs break-all text-fg">{secret}</code>
        <Button type="button" variant="outline" size="sm" onClick={() => void copy(secret, "Secret copied")}>
          <Copy /> Copy
        </Button>
      </div>
      <details className="rounded-md border border-line">
        <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-fg">How your endpoint checks a request</summary>
        <div className="space-y-2 border-t border-line p-3">
          <p className="text-xs leading-relaxed text-muted">
            Each POST has <code className="font-mono">X-Shorthop-Signature: t=…,v1=…</code>, an HMAC-SHA256 of <code className="font-mono">t.body</code>. Use{" "}
            <code className="font-mono">X-Shorthop-Delivery</code> to ignore repeats: a delivery can arrive more than once.
          </p>
          <pre className="overflow-x-auto rounded-lg bg-[#222438] p-3 text-xs leading-relaxed text-white">{VERIFY_SNIPPET}</pre>
          <Button type="button" variant="ghost" size="sm" onClick={() => void copy(VERIFY_SNIPPET, "Code copied")}>
            <Copy /> Copy code
          </Button>
        </div>
      </details>
      <div className="flex justify-end">
        <Button onClick={onDone}>I've saved it</Button>
      </div>
    </div>
  );
}

function WebhookDialog({ hook, onClose }: { hook: WebhookDTO | "new"; onClose: () => void }) {
  const qc = useQueryClient();
  const editing = hook !== "new";
  const [url, setUrl] = useState(editing ? hook.url : "");
  const [description, setDescription] = useState(editing ? hook.description : "");
  const [events, setEvents] = useState<string[]>(editing ? hook.events : WEBHOOK_EVENTS.map((e) => e.type));
  const [active, setActive] = useState(editing ? hook.active : true);
  const [touched, setTouched] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const urlProblem = url ? webhookUrlProblem(url) : "Enter the endpoint's address.";
  const json = { url: url.trim(), description: description.trim(), events, active };

  const save = useMutation({
    mutationFn: async () => {
      if (editing) return { ...(await call(api.webhooks[":id"].$put({ param: { id: String(hook.id) }, json }))), secret: null };
      return call(api.webhooks.$post({ json }));
    },
    onSuccess: (r) => {
      qc.setQueryData(keys.webhooks, (old: { events: unknown } | undefined) => (old ? { ...old, webhooks: r.webhooks } : old));
      void qc.invalidateQueries({ queryKey: keys.webhooks });
      if (r.secret) setSecret(r.secret);
      else {
        toast.success("Webhook saved");
        onClose();
      }
    },
    onError: (e) => toast.error(e.message),
  });
  const rotate = useMutation({
    mutationFn: () => call(api.webhooks[":id"].rotate.$post({ param: { id: String((hook as WebhookDTO).id) } })),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: keys.webhooks });
      setSecret(r.secret);
    },
    onError: (e) => toast.error(e.message),
  });

  if (secret) {
    return (
      <Dialog open onOpenChange={() => undefined} title={editing ? "New signing secret" : "Webhook added"} description="Your endpoint uses it to check that a request really came from Shorthop.">
        <SecretReveal secret={secret} onDone={onClose} />
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={editing ? "Edit webhook" : "Add a webhook"} description="Shorthop sends a signed JSON POST to this address when the events you pick happen." wide>
      <form
        className="space-y-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (!urlProblem && events.length) save.mutate();
        }}
      >
        <Field label="Endpoint URL" htmlFor="hook-url" hint="For example a Zapier, Make or n8n webhook, or your own app. https:// only." error={touched || url ? urlProblem : null}>
          <Input id="hook-url" type="url" inputMode="url" placeholder="https://hooks.zapier.com/hooks/catch/…" value={url} onChange={(e) => setUrl(e.target.value)} autoFocus={!editing} />
        </Field>
        <Field label="Description" htmlFor="hook-description" hint="Optional: a note for yourself.">
          <Input id="hook-description" maxLength={120} placeholder="Post new links to Slack" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium text-fg">Events</legend>
          {WEBHOOK_EVENTS.map((ev) => {
            const on = events.includes(ev.type);
            return (
              <label key={ev.type} className={cn("flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 transition-colors", on ? "border-accent/50 bg-accent-soft/40" : "border-line hover:border-accent/30")}>
                <input type="checkbox" className="mt-1 accent-[var(--accent)]" checked={on} onChange={(e) => setEvents(e.target.checked ? [...events, ev.type] : events.filter((x) => x !== ev.type))} />
                <span className="min-w-0">
                  <span className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium text-fg">
                    {ev.label} <code className="font-mono text-xs font-normal text-muted">{ev.type}</code>
                  </span>
                  <span className="block text-xs text-muted">{ev.description}</span>
                </span>
              </label>
            );
          })}
          {touched && !events.length ? (
            <p role="alert" className="text-xs text-danger">
              Choose at least one event.
            </p>
          ) : null}
        </fieldset>
        {editing ? (
          <div className="space-y-4 rounded-md border border-line p-4">
            <Switch id="hook-active" label="Active" description="While paused, nothing is sent and new events aren't queued for it." checked={active} onCheckedChange={setActive} />
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4">
              <div>
                <p className="text-sm font-medium text-fg">Signing secret</p>
                <p className="text-xs text-muted">{hook.secretReadable ? "Replace it if it may have leaked. The old one stops working at once." : "It can't be read anymore (its encryption key, ENCRYPTION_KEY or SESSION_SECRET, changed): replace it to resume deliveries."}</p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => rotate.mutate()} loading={rotate.isPending}>
                <RotateCcw /> New secret
              </Button>
            </div>
          </div>
        ) : null}
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={save.isPending}>
            {editing ? "Save" : "Add webhook"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function DeliveryRow({ d }: { d: WebhookDeliveryDTO }) {
  const qc = useQueryClient();
  const again = useMutation({
    mutationFn: () => call(api.webhooks.deliveries[":delivery"].redeliver.$post({ param: { delivery: d.id } })),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: keys.webhooks });
      if (r.delivery.status === "delivered") toast.success("Delivered", { description: `HTTP ${r.delivery.httpStatus} in ${num(r.delivery.durationMs ?? 0)} ms` });
      else toast.error(r.delivery.error ?? "Not delivered");
    },
    onError: (e) => toast.error(e.message),
  });
  const Icon = d.status === "delivered" ? CheckCircle2 : d.status === "failed" ? XCircle : Clock;
  const tone = d.status === "delivered" ? "text-good" : d.status === "failed" ? "text-danger" : "text-warn";
  let pretty = d.payload;
  try {
    pretty = JSON.stringify(JSON.parse(d.payload), null, 2);
  } catch {
    // Shown as stored.
  }
  return (
    <li>
      <details className="group">
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-surface-2/60 [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-3.5 shrink-0 text-subtle transition-transform group-open:rotate-90" aria-hidden />
          <Icon className={cn("size-4 shrink-0", tone)} aria-label={d.status} />
          <span className="text-sm font-medium text-fg">{EVENT_LABEL[d.type] ?? d.type}</span>
          <span className="text-xs text-muted" title={when(d.createdAt)}>
            {ago(d.createdAt)}
          </span>
          <span className="ml-auto text-xs text-muted tabular">
            {d.httpStatus ? `HTTP ${d.httpStatus}` : d.status === "pending" && !d.attempts ? "Sending…" : "No answer"}
            {d.durationMs !== null ? ` · ${num(d.durationMs)} ms` : ""}
            {d.attempts > 1 ? ` · ${d.attempts} tries` : ""}
          </span>
        </summary>
        <div className="space-y-2 border-t border-line bg-bg px-4 py-3">
          {d.error ? (
            <p className={cn("flex items-start gap-1.5 text-xs", d.status === "failed" ? "text-danger" : "text-warn")}>
              <AlertTriangle className="mt-px size-3.5 shrink-0" />
              {d.error}
              {d.status === "pending" && d.nextAt ? ` Next try ${ago(d.nextAt)}.` : d.status === "failed" ? " Given up." : ""}
            </p>
          ) : null}
          <p className="font-mono text-xs text-muted">{d.id}</p>
          <pre className="max-h-64 overflow-auto rounded-lg border border-line bg-surface p-3 text-xs leading-relaxed text-fg">{pretty}</pre>
          <Button type="button" variant="outline" size="sm" onClick={() => again.mutate()} loading={again.isPending}>
            <Send /> Send again
          </Button>
        </div>
      </details>
    </li>
  );
}

function DeliveriesDialog({ hook, onClose }: { hook: WebhookDTO; onClose: () => void }) {
  const q = useQuery({
    queryKey: [...keys.webhooks, "deliveries", hook.id],
    queryFn: () => call(api.webhooks[":id"].deliveries.$get({ param: { id: String(hook.id) } })),
    refetchInterval: 15_000,
  });
  const list = q.data?.deliveries ?? [];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Deliveries to ${hostOf(hook.url)}`} description="The last 100, kept for 30 days. Failed ones are retried after 30 minutes, 2, 6, 12 and 24 hours." wide>
      {q.isPending ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : list.length === 0 ? (
        <Empty icon={<ScrollText />} title="Nothing sent yet">
          <p>Send a test event, or change a link, to see deliveries here.</p>
        </Empty>
      ) : (
        <ul className="-mx-6 divide-y divide-line border-y border-line">
          {list.map((d) => (
            <DeliveryRow key={d.id} d={d} />
          ))}
        </ul>
      )}
    </Dialog>
  );
}

/** Settings → Webhooks. */
export function Webhooks() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: keys.webhooks, queryFn: () => call(api.webhooks.$get()) });
  const [editing, setEditing] = useState<WebhookDTO | "new" | null>(null);
  const [log, setLog] = useState<WebhookDTO | null>(null);
  const [deleting, setDeleting] = useState<WebhookDTO | null>(null);
  const hooks = q.data?.webhooks ?? [];

  const test = useMutation({
    mutationFn: (h: WebhookDTO) => call(api.webhooks[":id"].test.$post({ param: { id: String(h.id) } })),
    onSuccess: (r, h) => {
      void qc.invalidateQueries({ queryKey: keys.webhooks });
      if (r.delivery.status === "delivered") toast.success(`Test delivered to ${hostOf(h.url)}`, { description: `HTTP ${r.delivery.httpStatus} in ${num(r.delivery.durationMs ?? 0)} ms` });
      else toast.error(`Test not delivered to ${hostOf(h.url)}`, { description: r.delivery.error ?? undefined });
    },
    onError: (e) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (h: WebhookDTO) => call(api.webhooks[":id"].$delete({ param: { id: String(h.id) } })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.webhooks });
      toast.success("Webhook deleted");
      setDeleting(null);
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Card id="webhooks" className="scroll-mt-6 lg:col-span-2">
      <CardHeader
        title="Webhooks"
        description="Send link events to Zapier, Make, n8n or your own app as signed JSON."
        info={SETTINGS_HELP.webhooks}
        action={
          hooks.length ? (
            <Button size="sm" variant="outline" onClick={() => setEditing("new")}>
              <Plus /> Add webhook
            </Button>
          ) : null
        }
      />
      {q.isPending ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : q.isError ? (
        <p className="px-4 pb-4 text-sm text-danger">{q.error.message}</p>
      ) : hooks.length === 0 ? (
        <Empty icon={<WebhookIcon />} title="No webhooks yet">
          <p>Get a POST when links are created, changed or deleted, when a destination goes down, or when a link passes a click milestone.</p>
          <Button className="mt-4" onClick={() => setEditing("new")}>
            <Plus /> Add a webhook
          </Button>
        </Empty>
      ) : (
        <ul className="divide-y divide-line border-t border-line">
          {hooks.map((h) => {
            const u = (() => {
              try {
                return new URL(h.url);
              } catch {
                return null;
              }
            })();
            return (
              <li key={h.id} className="flex flex-wrap items-start gap-x-4 gap-y-3 px-5 py-4">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 truncate text-sm" title={h.url}>
                      <span className="font-semibold text-fg">{u?.host ?? h.url}</span>
                      <span className="text-muted">{u && u.pathname !== "/" ? u.pathname : ""}</span>
                    </span>
                    {h.active ? <Badge tone="good">Active</Badge> : <Badge>Paused</Badge>}
                  </div>
                  {h.description ? <p className="text-xs text-muted">{h.description}</p> : null}
                  <div className="flex flex-wrap gap-1">
                    {h.events.map((e) => (
                      <Badge key={e} tone="accent">
                        {EVENT_LABEL[e] ?? e}
                      </Badge>
                    ))}
                  </div>
                  <p className="text-xs text-muted">
                    {h.last ? (
                      <span className={h.last.ok ? "text-good" : "text-danger"}>
                        {h.last.ok ? "Last delivery worked" : "Last delivery failed"}
                        {h.last.httpStatus ? ` (HTTP ${h.last.httpStatus})` : ""}
                      </span>
                    ) : (
                      "Nothing sent yet"
                    )}
                    {h.last ? ` · ${ago(h.last.at)}` : ""}
                    {h.retrying ? ` · ${num(h.retrying)} waiting to retry` : ""}
                    {h.failedRecent ? ` · ${num(h.failedRecent)} given up this week` : ""}
                  </p>
                  {!h.secretReadable ? (
                    <p className="flex items-center gap-1.5 text-xs text-danger">
                      <AlertTriangle className="size-3.5" /> The signing secret can't be read since its encryption key (ENCRYPTION_KEY or SESSION_SECRET) changed. Edit the webhook and create a new secret.
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <Button size="sm" variant="outline" onClick={() => test.mutate(h)} loading={test.isPending && test.variables?.id === h.id} disabled={!h.active || (test.isPending && test.variables?.id !== h.id)}>
                    {test.isPending && test.variables?.id === h.id ? null : <Send />} Test
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setLog(h)}>
                    <ScrollText /> Deliveries
                  </Button>
                  <Button size="icon-sm" variant="ghost" aria-label={`Edit webhook ${u?.host ?? h.url}`} onClick={() => setEditing(h)}>
                    <Pencil />
                  </Button>
                  <Button size="icon-sm" variant="ghost" aria-label={`Delete webhook ${u?.host ?? h.url}`} onClick={() => setDeleting(h)}>
                    <Trash2 />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {editing ? <WebhookDialog key={editing === "new" ? "new" : editing.id} hook={editing} onClose={() => setEditing(null)} /> : null}
      {log ? <DeliveriesDialog hook={log} onClose={() => setLog(null)} /> : null}
      <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)} title={`Delete the webhook to ${deleting ? hostOf(deleting.url) : ""}?`} description="Nothing more is sent to it, and its delivery log is deleted too.">
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setDeleting(null)}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => deleting && remove.mutate(deleting)} loading={remove.isPending}>
            Delete webhook
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}
