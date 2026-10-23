import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BarChart3, Globe2, Link2, Mail, Plug, RefreshCw, Settings2, ShieldCheck } from "lucide-react";
import { useLocation, useNavigate } from "react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, call, keys } from "../api";
import { CloudflareFeatures } from "../components/CloudflareFeatures";
import { DownloadButton } from "../components/DownloadButton";
import { MailSetup } from "../components/MailSetup";
import { DeadLinkEditor } from "../components/DeadLinkEditor";
import { NotFoundEditor } from "../components/NotFoundEditor";
import { AccountCard } from "../components/AccountCard";
import { ApiCard } from "../components/ApiCard";
import { ApiKeys } from "../components/ApiKeys";
import { PeopleCard } from "../components/PeopleCard";
import { UtmSettings } from "../components/UtmSettings";
import { Webhooks } from "../components/Webhooks";
import { ShortDomains } from "../components/ShortDomains";
import { Badge, Button, Card, CardHeader, Dialog, Notice, PageHeader, Spinner } from "../components/ui";
import { countryName, day, flag, num, when } from "../lib/format";
import { SETTINGS_HELP } from "../lib/help";
import { useCan, useMe } from "../lib/me";
import { cn } from "../lib/utils";

/** Republishes links to KV, page by page: all of them, or only those on the default UTM template. */
async function resyncAll(onProgress: (n: number) => void, scope: "all" | "default-utm" = "all"): Promise<number> {
  let after: string | undefined;
  let total = 0;
  do {
    const res = await call(api.resync.$post({ query: { after, scope } }));
    total += res.published;
    onProgress(total);
    after = res.next ?? undefined;
  } while (after);
  return total;
}

/** "14 Oct – 20 Oct", or one day. */
function span(from: string, to: string): string {
  return from === to ? day(from) : `${day(from)} – ${day(to)}`;
}

type SettingsTab = "general" | "links" | "reports" | "integrations" | "access";

const TAB_LABELS: Record<SettingsTab, { label: string; icon: typeof Globe2 }> = {
  general: { label: "General", icon: Globe2 },
  links: { label: "Links", icon: Link2 },
  reports: { label: "Statistics & email", icon: BarChart3 },
  integrations: { label: "API & webhooks", icon: Plug },
  access: { label: "Access & security", icon: ShieldCheck },
};
const TABS = Object.keys(TAB_LABELS) as SettingsTab[];

/** Card anchors used across the admin, and the tab each lives on. */
const TAB_OF: Record<string, SettingsTab> = {
  ...Object.fromEntries(TABS.map((t) => [t, t])),
  domains: "general",
  publishing: "general",
  exports: "general",
  cloudflare: "general",
  utm: "links",
  "not-found": "links",
  "dead-link": "links",
  statistics: "reports",
  digest: "reports",
  api: "integrations",
  "api-keys": "integrations",
  webhooks: "integrations",
  account: "access",
  people: "access",
  security: "access",
};

function SettingsTabs({ tabs, value, onChange }: { tabs: SettingsTab[]; value: SettingsTab; onChange: (t: SettingsTab) => void }) {
  // On a phone the bar scrolls sideways: keep the open tab in view.
  useEffect(() => {
    document.getElementById(`settings-tab-${value}`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [value]);
  return (
    <div role="tablist" aria-label="Settings sections" className="mb-6 flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map((t, i) => {
        const { label, icon: Icon } = TAB_LABELS[t];
        const on = t === value;
        return (
          <button
            key={t}
            id={`settings-tab-${t}`}
            type="button"
            role="tab"
            aria-selected={on}
            aria-controls={`settings-panel-${t}`}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(t)}
            onKeyDown={(e) => {
              const next = e.key === "ArrowRight" ? (i + 1) % tabs.length : e.key === "ArrowLeft" ? (i - 1 + tabs.length) % tabs.length : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1;
              if (next === -1) return;
              e.preventDefault();
              onChange(tabs[next]!);
              requestAnimationFrame(() => document.getElementById(`settings-tab-${tabs[next]}`)?.focus());
            }}
            className={cn(
              "-mb-px flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors",
              on ? "border-accent text-accent" : "border-transparent text-muted hover:text-fg",
            )}
          >
            <Icon className="size-4" aria-hidden />
            {label}
          </button>
        );
      })}
    </div>
  );
}

export function Settings() {
  const qc = useQueryClient();
  const meQ = useMe();
  const me = meQ.data;
  const can = useCan();
  const manage = can("settings.manage");
  const apiUse = can("api.use");
  const admin = me?.role === "admin";
  // Workspace settings: people without that permission see only their account (and their API keys).
  const settings = useQuery({ queryKey: keys.settings, queryFn: () => call(api.settings.$get()), enabled: manage });
  const tabs = TABS.filter((t) => t === "access" || (t === "integrations" ? manage || apiUse : manage));
  const [resyncing, setResyncing] = useState<number | null>(null);
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [mailSetup, setMailSetup] = useState(false);

  // The tab lives in the address (#links, #access…); a card's anchor (#digest) opens its tab and scrolls to it.
  const { hash } = useLocation();
  const navigate = useNavigate();
  const anchor = hash.slice(1);
  const wanted = TAB_OF[anchor];
  const tab: SettingsTab = wanted && tabs.includes(wanted) ? wanted : (tabs[0] ?? "access");
  const openTab = (t: SettingsTab) => navigate({ hash: t }, { replace: true });
  const ready = Boolean(me) && (!manage || Boolean(settings.data));
  useEffect(() => {
    if (ready && anchor && !(anchor in TAB_LABELS)) requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView());
  }, [ready, anchor]);

  const runResync = async (scope: "all" | "default-utm" = "all") => {
    setResyncing(0);
    try {
      const n = await resyncAll(setResyncing, scope);
      toast.success(`Republished ${num(n)} links`, { description: "Changes reach every data center within about a minute." });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Republish failed");
    } finally {
      setResyncing(null);
    }
  };

  const saveUtm = useMutation({
    mutationFn: (template: string) => call(api.settings.$put({ json: { defaultUtm: template.trim() } })),
    onSuccess: async () => {
      void qc.invalidateQueries({ queryKey: keys.settings });
      toast.success("Default UTM template saved");
      await runResync("default-utm");
    },
    onError: (e) => toast.error(e.message),
  });

  const rollup = useMutation({
    mutationFn: () => call(api.settings.rollup.$post()),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: keys.settings });
      void qc.invalidateQueries({ queryKey: ["stats"] });
      if (r.skipped) toast.warning(r.skipped);
      else if (!r.rolled.length) toast.success("Already up to date", { description: "Every finished day is already saved." });
      else
        toast.success(`Saved ${r.rolled.length} ${r.rolled.length === 1 ? "day" : "days"} of stats`, {
          description: `${span(r.rolled[0]!, r.rolled.at(-1)!)} (UTC) copied from Analytics Engine into the database, where it is kept for good.`,
        });
    },
    onError: (e) => toast.error(e.message),
  });

  const loadPreview = useMutation({
    mutationFn: () => call(api.settings.digest.preview.$get()),
    onSuccess: (p) => setPreview(p),
    onError: (e) => toast.error(e.message),
  });

  const sendTest = useMutation({
    mutationFn: () => call(api.settings.digest.test.$post()),
    onSuccess: (r) => {
      if (r.status === "sent") toast.success("Test digest sent", { description: settings.data?.digestTo });
      else toast.error(`Digest not sent: ${r.reason ?? r.status}`);
    },
    onError: (e) => toast.error(e.message),
  });

  const revoke = useMutation({
    mutationFn: () => call(api.settings.sessions.revoke.$post()),
    onSuccess: () => window.location.assign("/_admin/login"),
    onError: (e) => toast.error(e.message),
  });

  if (meQ.isError) return <Notice tone="danger">{meQ.error.message}</Notice>;
  if (settings.isError) return <Notice tone="danger">{settings.error.message}</Notice>;
  if (!me || (manage && !settings.data)) {
    return (
      <div className="flex justify-center py-24">
        <Spinner />
      </div>
    );
  }
  const s = settings.data;
  const security = s?.security ?? null;
  const origin = me.workspace.publicOrigin;

  return (
    <>
      <PageHeader title="Make it yours" description={manage ? "Fine-tune your links, reporting, and workspace." : "Your account and your access."} />
      <SettingsTabs tabs={tabs} value={tab} onChange={openTab} />
      <div role="tabpanel" id={`settings-panel-${tab}`} aria-labelledby={`settings-tab-${tab}`} className="grid gap-5 lg:grid-cols-2">
        {tab === "general" && s ? (
          <>
            <ShortDomains domains={s.domains} primary={s.primaryDomain} adminHost={s.adminHost} linksPerDomain={s.linksPerDomain} demo={s.demo} />
            <Card id="publishing" className="scroll-mt-6">
              <CardHeader title="Publishing" description="Refresh your links across the global network if a recent change has not appeared." info={SETTINGS_HELP.publishing} />
              <div className="px-5 pb-5">
                <Button variant="outline" onClick={() => void runResync()} loading={resyncing !== null}>
                  <RefreshCw /> {resyncing !== null ? `Republishing… ${num(resyncing)}` : "Republish all links"}
                </Button>
              </div>
            </Card>
            <Card id="exports" className="scroll-mt-6">
              <CardHeader title="Exports" info={SETTINGS_HELP.exports} />
              <div className="flex flex-wrap gap-2 px-5 pb-5">
                <DownloadButton href="/_admin/api/export/links.csv">Links (CSV)</DownloadButton>
                <DownloadButton href="/_admin/api/stats/export.csv?range=all">Daily stats per link (CSV)</DownloadButton>
              </div>
            </Card>
            <CloudflareFeatures />
          </>
        ) : null}
        {tab === "links" && s ? (
          <>
            <UtmSettings key={s.defaultUtm} defaultUtm={s.defaultUtm} onSaveDefault={(t) => saveUtm.mutate(t)} saving={saveUtm.isPending || resyncing !== null} />
            <NotFoundEditor domain={s.primaryDomain} />
            <DeadLinkEditor domain={s.primaryDomain} />
          </>
        ) : null}
        {tab === "reports" && s ? (
          <>
            <Card id="statistics" className="scroll-mt-6">
              <CardHeader title="Statistics" description="Daily summaries preserve your history after individual click records expire." info={SETTINGS_HELP.statistics} />
              <div className="space-y-3 px-5 pb-5 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted">Analytics Engine queries</span>
                  {s.aeAvailable ? <Badge tone="good">Configured</Badge> : <Badge tone="warn">Not configured</Badge>}
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted">Rolled up through</span>
                  <span className="font-medium text-fg">{s.lastRolled ?? "never"}</span>
                </div>
                <p className="text-xs text-muted">
                  {!s.aeAvailable
                    ? "Running the rollup needs an analytics token: run npm run setup -- analytics."
                    : s.rollupPending
                      ? `Running it now saves ${s.rollupPending.days} finished ${s.rollupPending.days === 1 ? "day" : "days"} (${span(s.rollupPending.from, s.rollupPending.to)}, UTC) from Analytics Engine into the database. Today is saved tomorrow, once it is complete. Safe to repeat.`
                      : "Every finished day is saved. Today is saved tomorrow, once it is complete. Nothing to do."}
                </p>
                <Button variant="outline" onClick={() => rollup.mutate()} loading={rollup.isPending} disabled={!s.aeAvailable}>
                  Run rollup now
                </Button>
              </div>
            </Card>

            <Card id="digest" className="scroll-mt-6">
              <CardHeader title="Weekly digest" description="Sent Mondays at 07:00 UTC with last week’s top links." info={SETTINGS_HELP.digest} />
              <div className="space-y-3 px-5 pb-5 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted">Recipient</span>
                  <span className="truncate font-medium text-fg">{s.digestTo}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted">Sent with</span>
                  <span className="flex items-center gap-2 font-medium text-fg">
                    {s.digestProvider}
                    {s.digestProblem ? <Badge tone="warn">Not ready</Badge> : <Badge tone="good">Ready</Badge>}
                  </span>
                </div>
                {s.digestProblem ? <Notice>{s.digestProblem}</Notice> : null}
                <div className="flex items-center justify-between">
                  <span className="text-muted">Last sent</span>
                  <span className="font-medium text-fg">{s.lastDigestWeek ?? "never"}</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant={s.digestProblem ? "primary" : "outline"} onClick={() => setMailSetup(true)}>
                    <Settings2 /> Set up email
                  </Button>
                  <Button variant="outline" onClick={() => loadPreview.mutate()} loading={loadPreview.isPending}>
                    Preview
                  </Button>
                  <Button variant="outline" onClick={() => sendTest.mutate()} loading={sendTest.isPending} disabled={s.digestProblem !== null}>
                    <Mail /> Send test
                  </Button>
                </div>
              </div>
            </Card>

          </>
        ) : null}
        {tab === "integrations" ? (
          <>
            {apiUse ? <ApiKeys me={me} origin={origin} /> : null}
            {apiUse ? <ApiCard origin={origin} tokenSet={me.apiTokenSet} tokenScope={me.apiTokenScope} /> : null}
            {manage ? <Webhooks /> : null}
          </>
        ) : null}
        {tab === "access" ? (
          <>
            <AccountCard me={me} />
            {me.authMode === "password" ? (
              <Card id="people" className="scroll-mt-6 lg:col-span-2">
                <CardHeader title="People" description="Give others their own sign-in and permissions." info={SETTINGS_HELP.people} />
                <div className="px-5 pb-5 text-sm text-muted">
                  <p>
                    Cloudflare Access is off, so everyone who knows the admin password signs in as the owner, and history can't tell people apart. Turn on Cloudflare Access
                    with <span className="font-mono text-xs text-fg">npm run setup -- access</span> to add people with their own passwords and permissions.
                  </p>
                </div>
              </Card>
            ) : admin || me.role === "manager" ? (
              <PeopleCard me={me} />
            ) : null}
            {admin && security ? (
              <Card id="security" className="scroll-mt-6 lg:col-span-2">
                <CardHeader
                  title="Security"
                  description={
                    security.mode === "password"
                      ? "Your admin password is the only lock: Cloudflare Access is off."
                      : "Cloudflare Access checks who someone is; their password confirms it."
                  }
                  info={SETTINGS_HELP.security}
                />
                <div className="grid gap-6 px-5 pb-5 text-sm md:grid-cols-2">
                  <div className="space-y-3">
                    {!me.passwordConfigured ? (
                      <Notice>
                        No admin password is set, so localhost opens without one. The deployed admin stays closed until ADMIN_PASSWORD_HASH is set. To try the login
                        here: run <span className="font-mono text-xs">npm run setup -- local</span> (or{" "}
                        <span className="font-mono text-xs">npx tsx scripts/hash-password.ts --generate</span> and add{" "}
                        <span className="font-mono text-xs">ADMIN_PASSWORD_HASH=…</span> and <span className="font-mono text-xs">SESSION_SECRET=…</span> to .dev.vars), then
                        restart npm run dev.
                      </Notice>
                    ) : null}
                    {security.globalLockedUntil ? (
                      <Notice tone="danger">All logins are paused until {when(security.globalLockedUntil)} after many failed attempts.</Notice>
                    ) : null}
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-muted">Sign-in</span>
                      {security.mode === "password" ? (
                        <Badge tone="warn">Cloudflare Access off</Badge>
                      ) : (
                        <span className="font-medium text-fg">Cloudflare Access + password</span>
                      )}
                    </div>
                    {security.mode === "password" ? (
                      <Notice>
                        Anyone who finds this page can try passwords, slowed only by the lockout. Use a long, random password and add the rate-limit rule from
                        SECURITY.md, or turn Access on with <span className="font-mono text-xs">npm run setup -- access</span>.
                        {security.accessConfigured ? " Access settings are filled in, but ignored while ADMIN_AUTH is \"password\"." : null}
                      </Notice>
                    ) : null}
                    <div className="flex items-center justify-between">
                      <span className="text-muted">Failed logins (24 h)</span>
                      {security.failedLogins24h ? <Badge tone="warn">{num(security.failedLogins24h)}</Badge> : <span className="font-medium text-fg">0</span>}
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted">Locked networks</span>
                      <span className="font-medium text-fg">{num(security.lockedNetworks)}</span>
                    </div>
                    <div className="flex flex-wrap gap-2 pt-1">
                      <Button variant="outline" onClick={() => setConfirmRevoke(true)} disabled={!me.passwordConfigured}>
                        Log out everyone
                      </Button>
                    </div>
                  </div>
                  <div>
                    <p className="mb-2 text-xs font-medium text-muted">Recent logins</p>
                    {security.recent.length ? (
                      <ul className="space-y-1.5">
                        {security.recent.map((e, i) => (
                          <li key={`${e.at}-${i}`} className="flex items-center gap-2">
                            {e.ok ? <Badge tone="good">Success</Badge> : <Badge tone="danger">Failed</Badge>}
                            <span className="text-muted">{when(e.at)}</span>
                            {e.email && e.email !== "admin" ? <span className="min-w-0 truncate text-xs text-fg">{e.email}</span> : null}
                            <span className="ml-auto truncate text-xs text-muted">
                              {e.country ? `${flag(e.country)} ${countryName(e.country)}` : "Unknown"}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-muted">No logins recorded yet.</p>
                    )}
                  </div>
                </div>
              </Card>
            ) : null}

          </>
        ) : null}
      </div>

      <Dialog
        open={confirmRevoke}
        onOpenChange={setConfirmRevoke}
        title="Log out everyone?"
        description="Every session of every person ends now, including this one. Everyone needs their password again on every device."
      >
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setConfirmRevoke(false)}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => revoke.mutate()} loading={revoke.isPending}>
            Log out everyone
          </Button>
        </div>
      </Dialog>

      {manage ? <MailSetup open={mailSetup} onOpenChange={setMailSetup} /> : null}

      <Dialog open={preview !== null} onOpenChange={(o) => !o && setPreview(null)} title={preview?.subject ?? "Digest preview"} wide>
        {preview ? <iframe title="Digest preview" sandbox="" srcDoc={preview.html} className="h-[60vh] w-full rounded-lg border border-line bg-white" /> : null}
      </Dialog>
    </>
  );
}
