import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Bot } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { api, call, keys } from "../api";
import { SETTINGS_HELP } from "../lib/help";
import { Badge, Button, buttonClass, Card, CardHeader, Field, Input, Notice, Spinner } from "./ui";

const TURNSTILE_DASHBOARD = "https://dash.cloudflare.com/?to=/:account/turnstile";

/**
 * Settings → Bot check (admins): the optional Cloudflare Turnstile check on the
 * password pages. Off by default; it turns on only after a test passes.
 */
export function BotCheckCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: keys.turnstile, queryFn: () => call(api.settings.turnstile.$get()) });
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const key = siteKey ?? q.data?.siteKey ?? "";

  const save = useMutation({
    mutationFn: () => call(api.settings.turnstile.$put({ json: { siteKey: key } })),
    onSuccess: (data) => {
      qc.setQueryData(keys.turnstile, data);
      setSiteKey(null);
      toast.success("Site key saved", { description: data.secretSet ? "Now test it to turn the check on." : "Set TURNSTILE_SECRET next, then test it." });
    },
    onError: (e) => toast.error(e.message),
  });
  const turnOff = useMutation({
    mutationFn: () => call(api.settings.turnstile.$delete()),
    onSuccess: (data) => {
      qc.setQueryData(keys.turnstile, data);
      toast.success("Bot check turned off");
    },
    onError: (e) => toast.error(e.message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  const d = q.data;
  const dirty = d ? key.trim() !== d.siteKey : false;
  return (
    <Card id="bot-check" className="scroll-mt-6 lg:col-span-2">
      <CardHeader
        title="Bot check"
        description="Optional Cloudflare Turnstile on the login, forgot-password, invite and reset pages. Off unless you turn it on."
        info={SETTINGS_HELP.botCheck}
        action={d ? d.enabled ? <Badge tone="good">On</Badge> : <Badge>Off</Badge> : null}
      />
      {q.isPending ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : q.isError ? (
        <div className="px-4 pb-4">
          <Notice tone="danger">{q.error.message}</Notice>
        </div>
      ) : (
        <div className="grid gap-6 px-4 pb-4 text-sm md:grid-cols-2">
          <div className="space-y-3">
            <p className="flex items-start gap-2 text-muted">
              <Bot className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
              <span>
                Cloudflare Access already keeps bots away from these pages, and wrong passwords and reset requests are limited. Turn this on only if your Access
                policy lets many people in (for example any email with a one-time PIN).
              </span>
            </p>
            <form onSubmit={submit} className="space-y-3">
              <Field label="Site key" htmlFor="turnstile-site-key" hint="Public. From your Turnstile widget in the Cloudflare dashboard.">
                <Input
                  id="turnstile-site-key"
                  className="font-mono text-xs"
                  placeholder="0x4AAAAAAA…"
                  value={key}
                  onChange={(e) => setSiteKey(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <div className="flex items-center justify-between">
                <span className="text-muted">Secret key (TURNSTILE_SECRET)</span>
                {d!.secretSet ? <Badge tone="good">Set</Badge> : <Badge tone="warn">Not set</Badge>}
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                {dirty || !d!.siteKey ? (
                  <Button type="submit" variant="outline" loading={save.isPending} disabled={!key.trim()}>
                    Save site key
                  </Button>
                ) : null}
                {!dirty && d!.siteKey && d!.secretSet && !d!.enabled ? (
                  // A server page: the widget's script isn't allowed in the admin itself.
                  <a href="/_admin/bot-check" className={buttonClass({})}>
                    Test and turn on
                  </a>
                ) : null}
                {d!.enabled ? (
                  <Button type="button" variant="outline" onClick={() => turnOff.mutate()} loading={turnOff.isPending}>
                    Turn off
                  </Button>
                ) : null}
              </div>
              {dirty && d!.enabled ? <p className="text-xs text-muted">Saving a new site key turns the check off until you test it again.</p> : null}
            </form>
          </div>
          <div>
            <p className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Set it up</p>
            <ol className="list-decimal space-y-1.5 pl-5 text-muted">
              <li>
                In the{" "}
                <a href={TURNSTILE_DASHBOARD} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-0.5 font-medium text-accent hover:underline">
                  Cloudflare dashboard <ArrowUpRight className="size-3" />
                </a>{" "}
                → Turnstile → <strong className="text-fg">Add widget</strong>. Hostname: <code className="font-mono text-xs text-fg">{d!.hostname}</code>. Widget mode:
                Managed.
              </li>
              <li>Paste its site key here and save.</li>
              <li>
                Store its secret key: <code className="font-mono text-xs break-all text-fg">npx wrangler secret put TURNSTILE_SECRET</code>
              </li>
              <li>
                Press <strong className="text-fg">Test and turn on</strong> and complete the check. It turns on only if Cloudflare confirms it, so a wrong key can't lock
                anyone out.
              </li>
            </ol>
          </div>
        </div>
      )}
    </Card>
  );
}
