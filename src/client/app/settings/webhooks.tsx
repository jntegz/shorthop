// Settings → Webhooks: signed JSON POSTs for link events.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ChevronRight, Clock, Pencil, Plus, RotateCcw, ScrollText, Send, Trash2, XCircle } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import type { WebhookDeliveryDTO, WebhookDTO } from "../../../shared/types";
import { WEBHOOK_EVENTS, webhookUrlProblem } from "../../../shared/webhooks";
import { api, call, keys } from "../../api";
import { ago, hostOf, num, when } from "../../lib/format";
import { SETTINGS_HELP } from "../../lib/help";
import { Badge, Button, Checkbox, Dialog, Empty, ErrorState, IconButton, Input, Notice, Section, Switch } from "../ui";
import { CodeBlock, HelpTip, RowsLoading, SecretField, toastError } from "./parts";

const EVENT_LABEL: Record<string, string> = { ...Object.fromEntries(WEBHOOK_EVENTS.map((e) => [e.type, e.label])), "webhook.test": "Test event" };

const VERIFY_SNIPPET = `// Node.js: check X-Shorthop-Signature before trusting a request.
import crypto from "node:crypto";

function verify(rawBody, header, secret) {
  const [, t, v1] = /^t=(\\d+),v1=([0-9a-f]{64})$/.exec(header ?? "") ?? [];
  if (!t || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = crypto.createHmac("sha256", secret).update(\`\${t}.\${rawBody}\`).digest();
  return crypto.timingSafeEqual(Buffer.from(v1, "hex"), expected);
}`;

function urlParts(url: string): { host: string; path: string } {
  try {
    const u = new URL(url);
    return { host: u.host, path: u.pathname !== "/" ? u.pathname : "" };
  } catch {
    return { host: url, path: "" };
  }
}

/** Shown once: after creating an endpoint and after rotating its secret. */
function SecretReveal({ secret }: { secret: string }) {
  return (
    <div className="settings-a-stack">
      <Notice tone="info">Copy this signing secret now: it can't be shown again, only replaced.</Notice>
      <SecretField value={secret} copied="Secret copied" label="Signing secret" />
      <details className="settings-a-disclosure">
        <summary>
          <ChevronRight aria-hidden className="settings-a-chevron" />
          How your endpoint checks a request
        </summary>
        <div className="settings-a-stack">
          <p className="settings-a-prose">
            Each POST has <code className="settings-a-mono">X-Shorthop-Signature: t=…,v1=…</code>, an HMAC-SHA256 of <code className="settings-a-mono">t.body</code>. Use{" "}
            <code className="settings-a-mono">X-Shorthop-Delivery</code> to ignore repeats: a delivery can arrive more than once.
          </p>
          <CodeBlock title="Node.js" code={VERIFY_SNIPPET} copied="Code copied" copyLabel="Copy code" />
        </div>
      </details>
    </div>
  );
}

function WebhookDialog({ hook, onClose }: { hook: WebhookDTO | "new"; onClose: () => void }) {
  const qc = useQueryClient();
  const formId = useId();
  const editing = hook !== "new";
  const [url, setUrl] = useState(editing ? hook.url : "");
  const [description, setDescription] = useState(editing ? hook.description : "");
  // Every click is a lot of requests: a new webhook starts with everything else.
  const [events, setEvents] = useState<string[]>(editing ? hook.events : WEBHOOK_EVENTS.map((e) => e.type).filter((t) => t !== "link.clicked"));
  const [clickTags, setClickTags] = useState(editing ? hook.clickTags.join(", ") : "");
  const [active, setActive] = useState(editing ? hook.active : true);
  const [touched, setTouched] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const urlProblem = url ? webhookUrlProblem(url) : "Enter the endpoint's address.";
  const json = { url: url.trim(), description: description.trim(), events, active, clickTags: clickTags.split(",").map((t) => t.trim()).filter(Boolean) };

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
    onError: toastError,
  });
  const rotate = useMutation({
    mutationFn: () => call(api.webhooks[":id"].rotate.$post({ param: { id: String((hook as WebhookDTO).id) } })),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: keys.webhooks });
      setSecret(r.secret);
    },
    onError: toastError,
  });

  if (secret) {
    return (
      <Dialog
        open
        onOpenChange={() => undefined}
        title={editing ? "New signing secret" : "Webhook added"}
        description="Your endpoint uses it to check that a request really came from Shorthop."
        size="lg"
        footer={
          <Button variant="primary" onClick={onClose}>
            I've saved it
          </Button>
        }
      >
        <SecretReveal secret={secret} />
      </Dialog>
    );
  }

  const showUrlError = touched || url;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={editing ? "Edit webhook" : "Add a webhook"}
      description="Shorthop sends a signed JSON POST to this address when the events you pick happen."
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form={formId} variant="primary" loading={save.isPending}>
            {editing ? "Save" : "Add webhook"}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="settings-a-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (!urlProblem && events.length) save.mutate();
        }}
      >
        <Input
          label="Endpoint URL"
          type="url"
          inputMode="url"
          placeholder="https://hooks.zapier.com/hooks/catch/…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          hint="For example a Zapier, Make or n8n webhook, or your own app. https:// only."
          error={showUrlError ? urlProblem : null}
        />
        <Input label="Description" hint="Optional: a note for yourself." maxLength={120} placeholder="Post new links to Slack" value={description} onChange={(e) => setDescription(e.target.value)} />
        <fieldset className="settings-a-fieldset">
          <legend className="ui-field-label">Events</legend>
          <div className="settings-a-checks">
            {WEBHOOK_EVENTS.map((ev) => (
              <Checkbox
                key={ev.type}
                label={
                  <>
                    {ev.label} <code className="settings-a-mono is-quiet">{ev.type}</code>
                  </>
                }
                description={ev.description}
                checked={events.includes(ev.type)}
                onCheckedChange={(on) => setEvents(on ? [...events, ev.type] : events.filter((x) => x !== ev.type))}
              />
            ))}
          </div>
          {events.includes("link.clicked") ? (
            <Input label="Clicks only on links tagged" hint="Comma-separated. Empty sends a click on any link." value={clickTags} onChange={(e) => setClickTags(e.target.value)} placeholder="launch, newsletter" />
          ) : null}
          {touched && !events.length ? (
            <p role="alert" className="ui-field-error">
              Choose at least one event.
            </p>
          ) : null}
        </fieldset>
        {editing ? (
          <div className="settings-a-group">
            <Switch label="Active" description="While paused, nothing is sent and new events aren't queued for it." checked={active} onCheckedChange={setActive} />
            <div className="settings-a-split">
              <div>
                <p className="settings-a-strong">Signing secret</p>
                <p className="settings-a-hint">
                  {hook.secretReadable
                    ? "Replace it if it may have leaked. The old one stops working at once."
                    : "It can't be read anymore (its encryption key, ENCRYPTION_KEY or SESSION_SECRET, changed): replace it to resume deliveries."}
                </p>
              </div>
              <Button size="sm" icon={RotateCcw} onClick={() => rotate.mutate()} loading={rotate.isPending}>
                New secret
              </Button>
            </div>
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}

const STATUS_ICON = { delivered: CheckCircle2, failed: XCircle, pending: Clock } as const;
const STATUS_WORD = { delivered: "Delivered", failed: "Failed", pending: "Waiting" } as const;

function DeliveryRow({ d }: { d: WebhookDeliveryDTO }) {
  const qc = useQueryClient();
  const again = useMutation({
    mutationFn: () => call(api.webhooks.deliveries[":delivery"].redeliver.$post({ param: { delivery: d.id } })),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: keys.webhooks });
      if (r.delivery.status === "delivered") toast.success("Delivered", { description: `HTTP ${r.delivery.httpStatus} in ${num(r.delivery.durationMs ?? 0)} ms` });
      else toast.error(r.delivery.error ?? "Not delivered");
    },
    onError: toastError,
  });
  const status = d.status as keyof typeof STATUS_ICON;
  const Icon = STATUS_ICON[status] ?? Clock;
  let pretty = d.payload;
  try {
    pretty = JSON.stringify(JSON.parse(d.payload), null, 2);
  } catch {
    // Shown as stored.
  }
  return (
    <li>
      <details className="settings-a-delivery">
        <summary>
          <ChevronRight aria-hidden className="settings-a-chevron" />
          <Icon className="settings-a-status-icon" data-status={d.status} aria-label={STATUS_WORD[status] ?? d.status} />
          <span className="settings-a-name">{EVENT_LABEL[d.type] ?? d.type}</span>
          <span className="settings-a-quiet" title={when(d.createdAt)}>
            {ago(d.createdAt)}
          </span>
          <span className="settings-a-delivery-meta">
            {d.httpStatus ? `HTTP ${d.httpStatus}` : d.status === "pending" && !d.attempts ? "Sending…" : "No answer"}
            {d.durationMs !== null ? ` · ${num(d.durationMs)} ms` : ""}
            {d.attempts > 1 ? ` · ${d.attempts} tries` : ""}
          </span>
        </summary>
        <div className="settings-a-delivery-body">
          {d.error ? (
            <p className="settings-a-problem" data-tone={d.status === "failed" ? "bad" : "warn"}>
              <AlertTriangle aria-hidden />
              <span>
                {d.error}
                {d.status === "pending" && d.nextAt ? ` Next try ${ago(d.nextAt)}.` : d.status === "failed" ? " Given up." : ""}
              </span>
            </p>
          ) : null}
          <p className="settings-a-mono is-quiet">{d.id}</p>
          <pre className="settings-a-payload" tabIndex={0} aria-label="Payload">
            {pretty}
          </pre>
          <div>
            <Button size="sm" icon={Send} onClick={() => again.mutate()} loading={again.isPending}>
              Send again
            </Button>
          </div>
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
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Deliveries to ${hostOf(hook.url)}`}
      description="The last 100, kept for 30 days. Failed ones are retried after 30 minutes, 2, 6, 12 and 24 hours."
      size="lg"
    >
      {q.isPending ? (
        <RowsLoading rows={4} />
      ) : q.isError && !q.data ? (
        <ErrorState what="Deliveries" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} compact />
      ) : list.length === 0 ? (
        <Empty compact title="Nothing sent yet">
          <p>Send a test event, or change a link, to see deliveries here.</p>
        </Empty>
      ) : (
        <ul className="settings-a-deliveries">
          {list.map((d) => (
            <DeliveryRow key={d.id} d={d} />
          ))}
        </ul>
      )}
    </Dialog>
  );
}

export function WebhooksSection() {
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
    onError: toastError,
  });
  const remove = useMutation({
    mutationFn: (h: WebhookDTO) => call(api.webhooks[":id"].$delete({ param: { id: String(h.id) } })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.webhooks });
      toast.success("Webhook deleted");
      setDeleting(null);
    },
    onError: toastError,
  });

  return (
    <Section
      id="webhooks"
      title="Webhooks"
      sub="Send link events to Zapier, Make, n8n or your own app as signed JSON."
      aside={
        <>
          {hooks.length ? (
            <Button size="sm" icon={Plus} onClick={() => setEditing("new")}>
              Add webhook
            </Button>
          ) : null}
          <HelpTip help={SETTINGS_HELP.webhooks} />
        </>
      }
    >
      {q.isPending ? (
        <RowsLoading rows={2} />
      ) : q.isError ? (
        <ErrorState what="Webhooks" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} compact />
      ) : hooks.length === 0 ? (
        <Empty
          compact
          title="No webhooks yet"
          action={
            <Button variant="primary" icon={Plus} onClick={() => setEditing("new")}>
              Add a webhook
            </Button>
          }
        >
          <p>Get a POST when links are created, changed or deleted, when a destination goes down, or when a link passes a click milestone.</p>
        </Empty>
      ) : (
        <ul className="settings-a-list" aria-label="Webhooks">
          {hooks.map((h) => {
            const { host, path } = urlParts(h.url);
            const testing = test.isPending && test.variables?.id === h.id;
            return (
              <li key={h.id} className="settings-a-item">
                <div className="settings-a-item-main">
                  <p className="settings-a-item-title">
                    <span className="settings-a-url" title={h.url}>
                      <span className="settings-a-name">{host}</span>
                      <span className="settings-a-quiet">{path}</span>
                    </span>
                    {h.active ? null : <Badge tone="warn">Paused</Badge>}
                  </p>
                  {h.description ? <p className="settings-a-item-sub">{h.description}</p> : null}
                  <p className="settings-a-item-sub">
                    <span className="ui-sr">Events: </span>
                    {h.events.map((e) => EVENT_LABEL[e] ?? e).join(" · ")}
                  </p>
                  <p className="settings-a-item-sub">
                    {h.last ? (
                      <span className={h.last.ok ? "settings-a-good" : "settings-a-bad"}>
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
                    <p className="settings-a-problem" data-tone="bad">
                      <AlertTriangle aria-hidden />
                      <span>The signing secret can't be read since its encryption key (ENCRYPTION_KEY or SESSION_SECRET) changed. Edit the webhook and create a new secret.</span>
                    </p>
                  ) : null}
                </div>
                <div className="settings-a-item-tools">
                  <Button
                    size="sm"
                    icon={Send}
                    onClick={() => test.mutate(h)}
                    loading={testing}
                    disabled={!h.active || (test.isPending && !testing)}
                    title={h.active ? undefined : "Paused: turn it on to send a test"}
                  >
                    Test
                  </Button>
                  <Button size="sm" variant="ghost" icon={ScrollText} onClick={() => setLog(h)}>
                    Deliveries
                  </Button>
                  <IconButton size="sm" icon={Pencil} label={`Edit webhook ${host}`} onClick={() => setEditing(h)} />
                  <IconButton size="sm" icon={Trash2} label={`Delete webhook ${host}`} onClick={() => setDeleting(h)} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {editing ? <WebhookDialog key={editing === "new" ? "new" : editing.id} hook={editing} onClose={() => setEditing(null)} /> : null}
      {log ? <DeliveriesDialog hook={log} onClose={() => setLog(null)} /> : null}
      <Dialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete the webhook to ${deleting ? hostOf(deleting.url) : ""}?`}
        description="Nothing more is sent to it, and its delivery log is deleted too."
        size="sm"
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => deleting && remove.mutate(deleting)} loading={remove.isPending}>
              Delete webhook
            </Button>
          </>
        }
      />
    </Section>
  );
}
