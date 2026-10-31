// Settings → Weekly digest → Set up email: pick the service that sends the
// digest and alerts, with steps for each.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, RefreshCw, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { mailSettingsSchema, SENDERLESS_PROVIDERS } from "../../../shared/schemas";
import type { DigestProvider, MailProviderDTO, MailSetupDTO } from "../../../shared/types";
import { api, call, keys } from "../../api";
import { Badge, Button, Dialog, ErrorState, Input, Notice, Select, Skeleton, SkeletonText } from "../ui";
import { Code, Snippet } from "./common";

const MAIL_QUERY_KEY = ["settings", "mail"] as const;

interface Guide {
  blurb: string;
  docs?: string;
  steps: (ctx: { domain: string; from: string; to: string }) => ReactNode[];
}

const secretStep = (name: string) => (
  <>
    Save it as a Worker secret (paste the key when asked). It takes effect right away, no deploy needed:
    <Snippet text={`npx wrangler secret put ${name}`} />
  </>
);

const GUIDES: Record<DigestProvider, Guide> = {
  cloudflare: {
    blurb: "Built into Cloudflare, no API key. Free when sending to a verified address in your own account.",
    docs: "https://developers.cloudflare.com/email-service/",
    steps: ({ domain, from, to }) => [
      <>
        Turn on sending for your domain. This adds the SPF and DKIM records to the zone:
        <Snippet text={`npx wrangler email sending enable ${domain}`} />
      </>,
      <>
        Verify <strong>{to}</strong> as a destination address (Email Routing → Destination addresses), and keep the binding in wrangler.jsonc:
        <Snippet
          text={`"send_email": [{
  "name": "DIGEST",
  "destination_address": "${to}",
  "allowed_sender_addresses": ["${from}"]
}]`}
        />
      </>,
      <>
        Deploy: <Code>npm run deploy</Code>
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
        In Emailit → <strong>Email API → Domains</strong>, add <strong>{domain}</strong>, publish the SPF, DKIM and return-path records, then click <strong>Check DNS</strong>.
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
        <Snippet
          text={`npx wrangler secret put DIGEST_CUSTOM_URL
npx wrangler secret put DIGEST_CUSTOM_API_KEY`}
        />
      </>,
      <>
        That's all for a Resend-style API that takes <Code>Authorization: Bearer</Code> and <Code>{"{ from, to, subject, html, text }"}</Code>. Otherwise describe the header and body in wrangler.jsonc vars, then <Code>npm run deploy</Code>. For
        example, Brevo:
        <Snippet
          text={`"DIGEST_CUSTOM_AUTH": "api-key: {key}",
"DIGEST_CUSTOM_BODY": "{\\"sender\\":{\\"email\\":\\"{from_email}\\",\\"name\\":\\"{from_name}\\"},\\"to\\":[{\\"email\\":\\"{to}\\"}],\\"subject\\":\\"{subject}\\",\\"htmlContent\\":\\"{html}\\",\\"textContent\\":\\"{text}\\"}"`}
        />
        Placeholders: {"{from}"} (Name &lt;email&gt;), {"{from_email}"}, {"{from_name}"}, {"{to}"}, {"{subject}"}, {"{html}"}, {"{text}"}, and {"{key}"} in the header.
      </>,
    ],
  },
  webhook: {
    blurb: "Posts the email as signed JSON to n8n, Make, Zapier or your own endpoint, which sends it however you like.",
    steps: () => [
      <>
        Save the hook URL and a signing secret:
        <Snippet
          text={`npx wrangler secret put DIGEST_WEBHOOK_URL
openssl rand -hex 32 | npx wrangler secret put DIGEST_WEBHOOK_SECRET`}
        />
      </>,
      <>
        Check the <Code>X-Shorthop-Signature</Code> header on the receiving side. docs/SETUP.md (Signed webhook) has the code.
      </>,
    ],
  },
  off: {
    blurb: "No digest and no alert emails. Problems still show on the status page.",
    steps: () => [],
  },
};

/** Each provider's state, as a badge only where it says something. */
function status(p: MailProviderDTO, active: string): ReactNode {
  if (p.id === "off") return active === "off" ? <Badge tone="neutral">In use</Badge> : null;
  if (p.id === active) return p.problem ? <Badge tone="warn">In use · not ready</Badge> : <Badge tone="good">In use</Badge>;
  return p.problem ? <span className="settings-provider-note">Needs setup</span> : <span className="settings-provider-note">Ready</span>;
}

/** The provider choice: an ARIA radio group (roving tabindex; arrows move and choose). */
function ProviderPicker({ providers, value, active, onChange }: { providers: MailProviderDTO[]; value: string; active: string; onChange: (id: DigestProvider) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = Math.max(0, providers.findIndex((p) => p.id === value));
  const onKey = (e: KeyboardEvent) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (index + step + providers.length) % providers.length;
    onChange(providers[next]!.id);
    refs.current[next]?.focus();
  };
  return (
    <div className="settings-providers" role="radiogroup" aria-label="Email service" onKeyDown={onKey}>
      {providers.map((p, i) => (
        <button
          key={p.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={i === index}
          tabIndex={i === index ? 0 : -1}
          className="settings-provider"
          onClick={() => onChange(p.id)}
        >
          <span className="settings-provider-name">{p.name}</span>
          {status(p, active)}
        </button>
      ))}
    </div>
  );
}

/** Off and webhook don't use a sender: an empty one keeps DIGEST_FROM from wrangler.jsonc. */
function senderFor(d: { provider: string; from: string }): string {
  return SENDERLESS_PROVIDERS.includes(d.provider) ? "" : d.from.trim();
}

/** Settings → Weekly digest → Set up email: pick a provider, with steps for each. */
export function MailSetupDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
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
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Set up email"
      description="Pick the service that sends the weekly digest and alerts. API keys stay in Wrangler secrets and are never shown or stored here."
      footer={
        data && draft ? (
          <>
            {data.customized ? (
              <Button variant="ghost" icon={RotateCcw} className="settings-foot-start" onClick={() => reset.mutate()} loading={reset.isPending}>
                Use wrangler.jsonc ({data.defaults.provider})
              </Button>
            ) : (
              <span className="settings-note settings-foot-start">Now using the settings in wrangler.jsonc.</span>
            )}
            <Button variant="primary" onClick={() => save.mutate(draft)} loading={save.isPending} disabled={Boolean(unchanged) || (parsed !== null && !parsed.success)}>
              {draft.provider === "off" ? "Turn email off" : `Use ${selected?.name ?? draft.provider}`}
            </Button>
          </>
        ) : undefined
      }
    >
      {q.isError && !data ? (
        <ErrorState compact what="Email settings" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : !data || !draft ? (
        <div className="settings-stack" aria-busy>
          <div className="settings-providers">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="settings-provider-skel" />
            ))}
          </div>
          <SkeletonText lines={4} />
        </div>
      ) : (
        <div className="settings-stack">
          <ProviderPicker providers={data.providers} value={draft.provider} active={data.provider} onChange={(id) => setDraft({ ...draft, provider: id })} />

          {selected && guide ? (
            <div className="settings-guide">
              <div className="settings-subhead">
                <p className="settings-guide-blurb">{guide.blurb}</p>
                {guide.docs ? (
                  <a href={guide.docs} target="_blank" rel="noreferrer" className="ui-panel-link settings-ext">
                    {selected.name} docs
                    <ArrowUpRight aria-hidden />
                    <span className="ui-sr"> (opens in a new tab)</span>
                  </a>
                ) : null}
              </div>

              {steps.length ? (
                <ol className="settings-guide-steps">
                  {steps.map((step, i) => (
                    <li key={i}>{step}</li>
                  ))}
                </ol>
              ) : null}

              {selected.secrets.length ? (
                <div className="settings-actions">
                  {selected.secrets.map((s) => (
                    <Badge key={s.name} tone={s.set ? "good" : "warn"}>
                      <span className="settings-mono">{s.name}</span> {s.set ? "set" : "missing"}
                    </Badge>
                  ))}
                  <Button variant="ghost" size="sm" icon={RefreshCw} onClick={() => void q.refetch()} loading={q.isFetching}>
                    Check again
                  </Button>
                </div>
              ) : null}

              {selected.id !== "off" ? (
                <div className="settings-grid-2">
                  {selected.id !== "webhook" ? (
                    <Input
                      id="mail-from"
                      label="Send from"
                      type="email"
                      hint="An address on the domain you verified."
                      error={draft.from ? fromError : null}
                      value={draft.from}
                      placeholder={`digest@${fromDomain}`}
                      onChange={(e) => setDraft({ ...draft, from: e.target.value })}
                    />
                  ) : null}
                  <Input id="mail-to" label="Send to" hint="Set by DIGEST_TO in wrangler.jsonc." value={data.to} readOnly disabled />
                  {selected.id === "mailgun" ? (
                    <>
                      <Input
                        id="mail-mg-domain"
                        label="Mailgun domain"
                        error={draft.mailgunDomain ? mailgunError : null}
                        value={draft.mailgunDomain}
                        placeholder={`mg.${fromDomain}`}
                        onChange={(e) => setDraft({ ...draft, mailgunDomain: e.target.value })}
                      />
                      <Select
                        id="mail-mg-region"
                        label="Region"
                        value={draft.mailgunRegion}
                        onChange={(e) => setDraft({ ...draft, mailgunRegion: e.target.value as "us" | "eu" })}
                        options={[
                          { value: "us", label: "US" },
                          { value: "eu", label: "EU" },
                        ]}
                      />
                    </>
                  ) : null}
                </div>
              ) : null}

              {selected.problem && selected.id !== "off" ? <Notice tone="warn">Not ready yet: {selected.problem}</Notice> : null}
            </div>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
