import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut, Mail, RefreshCw, Settings2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, call, keys } from "../api";
import { CloudflareFeatures } from "../components/CloudflareFeatures";
import { DownloadButton } from "../components/DownloadButton";
import { MailSetup } from "../components/MailSetup";
import { DeadLinkEditor } from "../components/DeadLinkEditor";
import { NotFoundEditor } from "../components/NotFoundEditor";
import { UtmSettings } from "../components/UtmSettings";
import { ShortDomains } from "../components/ShortDomains";
import { Badge, Button, Card, CardHeader, Dialog, Notice, PageHeader, Spinner } from "../components/ui";
import { countryName, day, flag, num, when } from "../lib/format";
import { SETTINGS_HELP } from "../lib/help";

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

export function Settings() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: keys.settings, queryFn: () => call(api.settings.$get()) });
  const [resyncing, setResyncing] = useState<number | null>(null);
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [mailSetup, setMailSetup] = useState(false);

  // Scroll to #section once, when the page first has content.
  const loaded = settings.isSuccess;
  useEffect(() => {
    const target = window.location.hash.slice(1);
    if (loaded && target) requestAnimationFrame(() => document.getElementById(target)?.scrollIntoView());
  }, [loaded]);

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

  if (settings.isPending) {
    return (
      <div className="flex justify-center py-24">
        <Spinner />
      </div>
    );
  }
  if (settings.isError) return <Notice tone="danger">{settings.error.message}</Notice>;
  const s = settings.data;
  const security = s.security;
  const origin = s.publicOrigin;

  return (
    <>
      <PageHeader title="Make it yours" description="Fine-tune your links, reporting, and workspace." />
      <div className="grid gap-5 lg:grid-cols-2">
        <ShortDomains domains={s.domains} primary={s.primaryDomain} adminHost={s.adminHost} linksPerDomain={s.linksPerDomain} demo={s.demo} />
        <CloudflareFeatures />
        <UtmSettings key={s.defaultUtm} defaultUtm={s.defaultUtm} onSaveDefault={(t) => saveUtm.mutate(t)} saving={saveUtm.isPending || resyncing !== null} />

        <NotFoundEditor domain={s.primaryDomain} />

        <DeadLinkEditor domain={s.primaryDomain} />

        <Card>
          <CardHeader title="Publishing" description="Refresh your links across the global network if a recent change has not appeared." info={SETTINGS_HELP.publishing} />
          <div className="px-5 pb-5">
            <Button variant="outline" onClick={() => void runResync()} loading={resyncing !== null}>
              <RefreshCw /> {resyncing !== null ? `Republishing… ${num(resyncing)}` : "Republish all links"}
            </Button>
          </div>
        </Card>

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

        <Card>
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

        <Card>
          <CardHeader title="Exports" info={SETTINGS_HELP.exports} />
          <div className="flex flex-wrap gap-2 px-5 pb-5">
            <DownloadButton href="/_admin/api/export/links.csv">Links (CSV)</DownloadButton>
            <DownloadButton href="/_admin/api/stats/export.csv?range=all">Daily stats per link (CSV)</DownloadButton>
          </div>
        </Card>

        {security ? (
          <Card className="lg:col-span-2">
            <CardHeader
              title="Security"
              description={
                security.mode === "password"
                  ? "Your admin password is the only lock: Cloudflare Access is off."
                  : "Cloudflare Access checks who you are; your admin password confirms it."
              }
              info={SETTINGS_HELP.security}
            />
            <div className="grid gap-6 px-5 pb-5 text-sm md:grid-cols-2">
              <div className="space-y-3">
                {!security.passwordConfigured ? (
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
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted">Signed in as</span>
                  <span className="truncate font-medium text-fg">{security.email}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted">Session ends</span>
                  <span className="font-medium text-fg">{security.sessionExpiresAt ? when(security.sessionExpiresAt) : "—"}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted">Failed logins (24 h)</span>
                  {security.failedLogins24h ? <Badge tone="warn">{num(security.failedLogins24h)}</Badge> : <span className="font-medium text-fg">0</span>}
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted">Locked networks</span>
                  <span className="font-medium text-fg">{num(security.lockedNetworks)}</span>
                </div>
                <div className="flex flex-wrap gap-2 pt-1">
                  <form method="post" action="/_admin/logout">
                    <Button type="submit" variant="outline">
                      <LogOut /> Log out
                    </Button>
                  </form>
                  <Button variant="outline" onClick={() => setConfirmRevoke(true)} disabled={!security.passwordConfigured}>
                    Log out everywhere
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

        <Card className="lg:col-span-2">
          <CardHeader title="API and iOS Shortcut" description="Scripts use the API token (Worker secret API_TOKEN), not this browser session." info={SETTINGS_HELP.api} />
          <div className="space-y-3 px-5 pb-5 text-sm text-muted">
            <p>Create a link from a terminal:</p>
            <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-xs text-fg">{`curl -X POST "${origin}/api/links?format=text" \\
  -H "Authorization: Bearer $SHORTHOP_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://example.com/new-post","slug":"new-post"}'`}</pre>
            <p>
              iOS Shortcut: <strong className="text-fg">Get Contents of URL</strong> → POST to <code className="text-fg">{origin}/api/links?format=text</code> with
              headers <code className="text-fg">Authorization: Bearer …</code> and a JSON body <code className="text-fg">{"{ url: Shortcut Input }"}</code>, then
              <strong className="text-fg"> Copy to Clipboard</strong>. Full steps are in docs/ios-shortcut.md.
            </p>
          </div>
        </Card>
      </div>

      <Dialog
        open={confirmRevoke}
        onOpenChange={setConfirmRevoke}
        title="Log out everywhere?"
        description="Every admin session ends now, including this one. You'll need the password again on every device."
      >
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setConfirmRevoke(false)}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => revoke.mutate()} loading={revoke.isPending}>
            Log out everywhere
          </Button>
        </div>
      </Dialog>

      <MailSetup open={mailSetup} onOpenChange={setMailSetup} />

      <Dialog open={preview !== null} onOpenChange={(o) => !o && setPreview(null)} title={preview?.subject ?? "Digest preview"} wide>
        {preview ? <iframe title="Digest preview" sandbox="" srcDoc={preview.html} className="h-[60vh] w-full rounded-lg border border-line bg-white" /> : null}
      </Dialog>
    </>
  );
}
