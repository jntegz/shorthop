import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Copy, RefreshCw, RotateCcw } from "lucide-react";
import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { mailSettingsSchema, SENDERLESS_PROVIDERS } from "../../shared/schemas";
import type { DigestProvider, MailProviderDTO, MailSetupDTO } from "../../shared/types";
import { api, call, keys } from "../api";
import { cn, copy } from "../lib/utils";
import { Badge, Button, Dialog, Field, Input, Notice, Select, Spinner } from "./ui";

export const MAIL_QUERY_KEY = ["settings", "mail"] as const;

/** Off and webhook don't use a sender: an empty one keeps DIGEST_FROM from wrangler.jsonc. */
function senderFor(d: { provider: string; from: string }): string {
  return SENDERLESS_PROVIDERS.includes(d.provider) ? "" : d.from.trim();
}

/** Arrow keys move the choice, as in a native radio group. */
function moveChoice(e: KeyboardEvent<HTMLElement>, providers: MailProviderDTO[], current: string, choose: (id: DigestProvider) => void) {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
  if (!step) return;
  e.preventDefault();
  const i = providers.findIndex((p) => p.id === current);
  const next = providers[(i + step + providers.length) % providers.length];
  if (!next) return;
  choose(next.id);
  e.currentTarget.querySelector<HTMLElement>(`[data-provider="${next.id}"]`)?.focus();
}

interface Guide {
  blurb: string;
  docs?: string;
  steps: (ctx: { domain: string; from: string; to: string }) => ReactNode[];
}

/** A shell command or config snippet with a copy button. */
function Code({ children }: { children: string }) {
  return (
    <div className="group relative mt-1.5">
      <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 pr-10 font-mono text-xs text-fg">{children}</pre>
      <Button variant="ghost" size="icon-sm" className="absolute top-1.5 right-1.5" aria-label="Copy" onClick={() => void copy(children)}>
        <Copy />
      </Button>
    </div>
  );
}

const secretStep = (name: string) => (
  <>
    Save it as a Worker secret (paste the key when asked). It takes effect right away, no deploy needed:
    <Code>{`npx wrangler secret put ${name}`}</Code>
  </>
);

const GUIDES: Record<DigestProvider, Guide> = {
  cloudflare: {
    blurb: "Built into Cloudflare, no API key. Free when sending to a verified address in your own account.",
    docs: "https://developers.cloudflare.com/email-service/",
    steps: ({ domain, from, to }) => [
      <>
        Turn on sending for your domain. This adds the SPF and DKIM records to the zone:
        <Code>{`npx wrangler email sending enable ${domain}`}</Code>
      </>,
      <>
        Verify <strong>{to}</strong> as a destination address (Email Routing → Destination addresses), and keep the binding in wrangler.jsonc:
        <Code>{`"send_email": [{
  "name": "DIGEST",
  "destination_address": "${to}",
  "allowed_sender_addresses": ["${from}"]
}]`}</Code>
      </>,
      <>
        Deploy: <code className="text-fg">npm run deploy</code>
      </>,
    ],
  },
  resend: {
    blurb: "A simple developer email API with a free tier.",
    docs: "https://resend.com/docs/dashboard/domains/introduction",
    steps: ({ domain }) => [
      <>
        In Resend → <strong>Domains</strong>, add <strong>{domain}</strong> and publish the DNS records it shows until it says Verified.
      </>,
      <>
        In <strong>API Keys</strong>, create a key with <strong>Sending access</strong> only.
      </>,
      secretStep("RESEND_API_KEY"),
    ],
  },
  emailit: {
    blurb: "An affordable transactional email API (v2).",
    docs: "https://emailit.com/docs/domains/add-a-domain/",
    steps: ({ domain }) => [
      <>
        In Emailit → <strong>Email API → Domains</strong>, add <strong>{domain}</strong>, publish the SPF, DKIM and return-path records, then click{" "}
        <strong>Check DNS</strong>.
      </>,
      <>
        In <strong>Email API → API Keys</strong>, add a key with the <strong>Sending Only</strong> scope. It's shown only once.
      </>,
      secretStep("EMAILIT_API_KEY"),
      <>Until your workspace is verified, it can only send to workspace members' account emails. That's fine when the digest goes to your own account address.</>,
    ],
  },
  postmark: {
    blurb: "Transactional email known for fast, reliable delivery.",
    docs: "https://postmarkapp.com/support/article/1046-how-do-i-verify-a-domain",
    steps: ({ domain }) => [
      <>
        In Postmark → <strong>Sender Signatures</strong>, verify <strong>{domain}</strong> (DKIM and Return-Path).
      </>,
      <>
        Open your server → <strong>API Tokens</strong> and copy the <strong>Server API token</strong>.
      </>,
      secretStep("POSTMARK_API_KEY"),
    ],
  },
  sendgrid: {
    blurb: "Twilio SendGrid's email API.",
    docs: "https://www.twilio.com/docs/sendgrid/ui/account-and-settings/how-to-set-up-domain-authentication",
    steps: ({ domain }) => [
      <>
        In SendGrid → <strong>Settings → Sender Authentication</strong>, authenticate <strong>{domain}</strong>.
      </>,
      <>
        In <strong>Settings → API Keys</strong>, create a <strong>Restricted Access</strong> key with only <strong>Mail Send</strong> allowed.
      </>,
      secretStep("SENDGRID_API_KEY"),
    ],
  },
  mailgun: {
    blurb: "Mailgun's email API, in the US or EU region.",
    docs: "https://documentation.mailgun.com/docs/mailgun/user-manual/domains/domains-verify",
    steps: () => [
      <>
        In Mailgun → <strong>Sending → Domains</strong>, add your sending domain and publish its DNS records.
      </>,
      <>
        In the domain's settings → <strong>Sending API keys</strong>, create a key.
      </>,
      secretStep("MAILGUN_API_KEY"),
      <>Enter the sending domain and region below.</>,
    ],
  },
  custom: {
    blurb: "Any service with an HTTPS JSON API: Brevo, MailerSend, SMTP2GO, ZeptoMail, your own relay…",
    steps: () => [
      <>
        Save the service's send endpoint (https:// only) and API key as secrets:
        <Code>{`npx wrangler secret put DIGEST_CUSTOM_URL
npx wrangler secret put DIGEST_CUSTOM_API_KEY`}</Code>
      </>,
      <>
        That's all for a Resend-style API that takes <code className="text-fg">Authorization: Bearer</code> and{" "}
        <code className="text-fg">{"{ from, to, subject, html, text }"}</code>. Otherwise describe the header and body in wrangler.jsonc vars, then{" "}
        <code className="text-fg">npm run deploy</code>. For example, Brevo:
        <Code>{`"DIGEST_CUSTOM_AUTH": "api-key: {key}",
"DIGEST_CUSTOM_BODY": "{\\"sender\\":{\\"email\\":\\"{from_email}\\",\\"name\\":\\"{from_name}\\"},\\"to\\":[{\\"email\\":\\"{to}\\"}],\\"subject\\":\\"{subject}\\",\\"htmlContent\\":\\"{html}\\",\\"textContent\\":\\"{text}\\"}"`}</Code>
        Placeholders: {"{from}"} (Name &lt;email&gt;), {"{from_email}"}, {"{from_name}"}, {"{to}"}, {"{subject}"}, {"{html}"}, {"{text}"}, and {"{key}"} in the header.
      </>,
    ],
  },
  webhook: {
    blurb: "Posts the email as signed JSON to n8n, Make, Zapier or your own endpoint, which sends it however you like.",
    steps: () => [
      <>
        Save the hook URL and a signing secret:
        <Code>{`npx wrangler secret put DIGEST_WEBHOOK_URL
openssl rand -hex 32 | npx wrangler secret put DIGEST_WEBHOOK_SECRET`}</Code>
      </>,
      <>
        Check the <code className="text-fg">X-Shorthop-Signature</code> header on the receiving side. docs/SETUP.md (Signed webhook) has the code.
      </>,
    ],
  },
  off: {
    blurb: "No digest and no alert emails. Problems still show on the status page.",
    steps: () => [],
  },
};

function status(p: MailProviderDTO, active: string) {
  if (p.id === "off") return active === "off" ? <Badge tone="accent">In use</Badge> : null;
  if (p.id === active) return p.problem ? <Badge tone="warn">In use · not ready</Badge> : <Badge tone="good">In use</Badge>;
  return p.problem ? <Badge>Needs setup</Badge> : <Badge tone="good">Ready</Badge>;
}

/** Settings → Weekly digest → Set up email: pick a provider, with steps for each. */
export function MailSetup({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: MAIL_QUERY_KEY, queryFn: () => call(api.settings.mail.$get()), enabled: open });
  const [draft, setDraft] = useState<Pick<MailSetupDTO, "provider" | "from" | "mailgunDomain" | "mailgunRegion"> | null>(null);

  useEffect(() => {
    if (open && q.data && draft === null) {
      const { provider, from, mailgunDomain, mailgunRegion } = q.data;
      setDraft({ provider, from, mailgunDomain, mailgunRegion });
    }
    if (!open) setDraft(null);
  }, [open, q.data, draft]);

  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: MAIL_QUERY_KEY });
    void qc.invalidateQueries({ queryKey: keys.settings });
  };

  const save = useMutation({
    mutationFn: (d: NonNullable<typeof draft>) =>
      call(
        api.settings.mail.$put({
          json: { provider: d.provider as DigestProvider, from: senderFor(d), ...(d.provider === "mailgun" ? { mailgunDomain: d.mailgunDomain, mailgunRegion: d.mailgunRegion } : {}) },
        }),
      ),
    onSuccess: (r) => {
      refreshAll();
      if (r.problem) toast.warning("Saved, but it can't send yet", { description: r.problem });
      else toast.success("Email settings saved", { description: "Use “Send test” to check it end to end." });
      onOpenChange(false);
    },
    onError: (e) => toast.error(e.message),
  });

  const reset = useMutation({
    mutationFn: () => call(api.settings.mail.$delete()),
    onSuccess: async () => {
      // Refetch before clearing the draft, or the effect refills it from the cached override.
      await qc.refetchQueries({ queryKey: MAIL_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: keys.settings });
      setDraft(null);
      toast.success("Back to the settings in wrangler.jsonc");
    },
    onError: (e) => toast.error(e.message),
  });

  const data = q.data;
  const selected = data?.providers.find((p) => p.id === draft?.provider);
  const guide = selected ? GUIDES[selected.id] : null;
  const fromDomain = draft?.from.split("@")[1] || "your-domain.com";
  const steps = guide && data && draft ? guide.steps({ domain: fromDomain, from: draft.from || `digest@${fromDomain}`, to: data.to }) : [];
  const parsed = draft ? mailSettingsSchema.safeParse({ ...draft, from: senderFor(draft) }) : null;
  const fromError = parsed && !parsed.success ? (parsed.error.issues.find((i) => i.path[0] === "from")?.message ?? null) : null;
  const mailgunError = parsed && !parsed.success ? (parsed.error.issues.find((i) => i.path[0] === "mailgunDomain")?.message ?? null) : null;
  const unchanged =
    data && draft && data.customized && draft.provider === data.provider && draft.from.trim() === data.from && (draft.provider !== "mailgun" || (draft.mailgunDomain === data.mailgunDomain && draft.mailgunRegion === data.mailgunRegion));

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Set up email" description="Pick the service that sends the weekly digest and alerts. API keys stay in Wrangler secrets and are never shown or stored here." wide>
      {!data || !draft ? (
        <div className="flex justify-center py-12">{q.isError ? <Notice tone="danger">{q.error.message}</Notice> : <Spinner />}</div>
      ) : (
        <div className="space-y-4 text-sm">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Email service" onKeyDown={(e) => moveChoice(e, data.providers, draft.provider, (id) => setDraft({ ...draft, provider: id }))}>
            {data.providers.map((p) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={draft.provider === p.id}
                tabIndex={draft.provider === p.id ? 0 : -1}
                data-provider={p.id}
                onClick={() => setDraft({ ...draft, provider: p.id })}
                className={cn(
                  "flex min-h-16 min-w-0 flex-col items-start justify-between gap-1.5 rounded-md border p-3 text-left transition-colors",
                  draft.provider === p.id ? "border-accent bg-accent-soft" : "border-line hover:bg-bg",
                )}
              >
                <span className="font-medium text-fg">{p.name}</span>
                {status(p, data.provider)}
              </button>
            ))}
          </div>

          {selected && guide ? (
            <div className="space-y-4 rounded-md border border-line p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="text-muted">{guide.blurb}</p>
                {guide.docs ? (
                  <a href={guide.docs} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
                    {selected.name} docs <ArrowUpRight className="size-3.5" />
                  </a>
                ) : null}
              </div>

              {steps.length ? (
                <ol className="list-decimal space-y-3 pl-5 text-muted marker:text-subtle">
                  {steps.map((step, i) => (
                    <li key={i} className="pl-1 leading-relaxed">
                      {step}
                    </li>
                  ))}
                </ol>
              ) : null}

              {selected.secrets.length ? (
                <div className="flex flex-wrap items-center gap-2">
                  {selected.secrets.map((s) => (
                    <Badge key={s.name} tone={s.set ? "good" : "neutral"}>
                      <span className="font-mono">{s.name}</span> {s.set ? "set" : "missing"}
                    </Badge>
                  ))}
                  <Button variant="ghost" size="sm" onClick={() => void q.refetch()} loading={q.isFetching}>
                    <RefreshCw /> Check again
                  </Button>
                </div>
              ) : null}

              {selected.id !== "off" ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  {selected.id !== "webhook" ? (
                    <Field label="Send from" htmlFor="mail-from" hint="An address on the domain you verified." error={draft.from ? fromError : null}>
                      <Input id="mail-from" type="email" value={draft.from} placeholder={`digest@${fromDomain}`} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
                    </Field>
                  ) : null}
                  <Field label="Send to" htmlFor="mail-to" hint="Set by DIGEST_TO in wrangler.jsonc.">
                    <Input id="mail-to" value={data.to} readOnly disabled />
                  </Field>
                  {selected.id === "mailgun" ? (
                    <>
                      <Field label="Mailgun domain" htmlFor="mail-mg-domain" error={draft.mailgunDomain ? mailgunError : null}>
                        <Input id="mail-mg-domain" value={draft.mailgunDomain} placeholder={`mg.${fromDomain}`} onChange={(e) => setDraft({ ...draft, mailgunDomain: e.target.value })} />
                      </Field>
                      <Field label="Region" htmlFor="mail-mg-region">
                        <Select id="mail-mg-region" value={draft.mailgunRegion} onChange={(e) => setDraft({ ...draft, mailgunRegion: e.target.value as "us" | "eu" })}>
                          <option value="us">US</option>
                          <option value="eu">EU</option>
                        </Select>
                      </Field>
                    </>
                  ) : null}
                </div>
              ) : null}

              {selected.problem && selected.id !== "off" ? <Notice>Not ready yet: {selected.problem}</Notice> : null}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-2">
            {data.customized ? (
              <Button variant="ghost" onClick={() => reset.mutate()} loading={reset.isPending}>
                <RotateCcw /> Use wrangler.jsonc ({data.defaults.provider})
              </Button>
            ) : (
              <span className="text-xs text-muted">Now using the settings in wrangler.jsonc.</span>
            )}
            <Button onClick={() => save.mutate(draft)} loading={save.isPending} disabled={Boolean(unchanged) || (parsed !== null && !parsed.success)}>
              {draft.provider === "off" ? "Turn email off" : `Use ${selected?.name ?? draft.provider}`}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
