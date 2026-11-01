// Settings → General: short domains (with the guided setup for a new one),
// publishing (republish every link), exports, backup (admins) and the
// Cloudflare foundation.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowUpRight, ChartNoAxesCombined, Check, Cloud, Database, Download, Globe2, HardDriveDownload, LockKeyhole, Mail, RefreshCw, SearchCheck, Trash2 } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { HOSTNAME_RE } from "../../../shared/domains";
import type { DemoDTO, DomainCheckDTO } from "../../../shared/types";
import { api, call, downloadFile, keys } from "../../api";
import { ago, num, when } from "../../lib/format";
import { SETTINGS_HELP } from "../../lib/help";
import { Badge, Button, Checkbox, Dialog, ErrorState, Input, Notice, Skeleton } from "../ui";
import { Code, SettingsSection, Snippet } from "./common";

// ---------------- Short domains ----------------

type StepState = "done" | "attention" | "open";

/** One onboarding step; `status` is the live check result for it, when there is one. */
function Step({ n, title, state, status, children }: { n: number; title: string; state: StepState; status?: ReactNode; children: ReactNode }) {
  return (
    <li className="settings-step" data-state={state}>
      <span className="settings-step-mark" aria-label={state === "done" ? `Step ${n}, done` : state === "attention" ? `Step ${n}, needs attention` : `Step ${n}`}>
        {state === "done" ? <Check aria-hidden /> : state === "attention" ? <AlertTriangle aria-hidden /> : n}
      </span>
      <div className="settings-step-main">
        <h4 className="settings-step-title">{title}</h4>
        {status ? <div className="settings-step-status" data-tone={state === "done" ? "good" : state === "attention" ? "bad" : "info"}>{status}</div> : null}
        <div className="settings-step-body">{children}</div>
      </div>
    </li>
  );
}

/** An external link in running text (opens a new tab; says so to screen readers). */
function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="settings-ext" href={href} target="_blank" rel="noreferrer">
      {children}
      <ArrowUpRight aria-hidden />
      <span className="ui-sr"> (opens in a new tab)</span>
    </a>
  );
}

/**
 * Short domains: the configured list (each can have its data removed), demo
 * data from npm run seed:dev, and a guided, checkable setup for a new one.
 */
export function DomainsSection({
  domains,
  primary,
  adminHost,
  linksPerDomain,
  demo,
}: {
  domains: string[];
  primary: string;
  adminHost: string;
  linksPerDomain: Record<string, number>;
  demo: DemoDTO | null;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");
  // The domain whose data the confirm dialog would delete, what was typed there, and the last one deleted while still configured.
  const [removing, setRemoving] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [removed, setRemoved] = useState<string | null>(null);
  const [deletedSoFar, setDeletedSoFar] = useState(0);
  const typed = draft.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[/?#].*$/, "");
  const valid = HOSTNAME_RE.test(typed);
  const name = valid ? typed : "newdomain.com";
  const configured = domains.includes(name);
  const next = configured ? domains : [...domains, name];
  // Domains that still have links but were removed from SHORT_DOMAINS.
  const retired = Object.keys(linksPerDomain).filter((d) => !domains.includes(d));

  const check = useMutation({
    mutationFn: (domain: string) => call(api.settings.domains.check.$get({ query: { domain } })),
  });
  const result: DomainCheckDTO | undefined = check.data?.domain === name ? check.data : undefined;
  // Later steps only have something to say once the name exists in DNS.
  const known = Boolean(result && !result.error && result.exists);
  const run = (e?: FormEvent) => {
    e?.preventDefault();
    if (valid) check.mutate(typed);
  };
  const checkExisting = (d: string) => {
    setDraft(d);
    check.mutate(d);
  };

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.settings });
    void qc.invalidateQueries({ queryKey: keys.allLinks });
    void qc.invalidateQueries({ queryKey: keys.tags });
    void qc.invalidateQueries({ queryKey: ["stats"] });
  };

  const purge = useMutation({
    // One page of links per call: repeat until the server says it's done.
    mutationFn: async (domain: string) => {
      setDeletedSoFar(0);
      for (;;) {
        const r = await call(api.settings.domains.purge.$post({ json: { domain, confirm: confirmText } }));
        setDeletedSoFar((n) => n + r.deleted);
        if (r.done) return r;
      }
    },
    onSuccess: (_, domain) => {
      setRemoving(null);
      setConfirmText("");
      setRemoved(domains.includes(domain) ? domain : null);
      toast.success(`Deleted everything on ${domain}`);
    },
    onError: (e) => toast.error(e.message),
    onSettled: refresh,
  });

  const clearDemo = useMutation({
    mutationFn: () => call(api.settings.demo.$delete()),
    onSuccess: () => toast.success("Demo data removed"),
    onError: (e) => toast.error(e.message),
    onSettled: refresh,
  });

  const askRemove = (d: string) => {
    setConfirmText("");
    setRemoving(d);
  };
  const removingLinks = removing ? (linksPerDomain[removing] ?? 0) : 0;
  const confirmed = removing !== null && confirmText.trim().toLowerCase() === removing;

  const live = result?.serving === "yes";
  const nsState: StepState = !result ? "open" : result.onCloudflare ? "done" : "attention";
  const recordsState: StepState = !result ? "open" : live ? "done" : result.records.length ? "attention" : "open";
  const configState: StepState = configured || result?.configured ? "done" : "open";
  const deployState: StepState = !result ? "open" : live ? "done" : result.onCloudflare && configured ? "attention" : "open";

  return (
    <SettingsSection
      id="domains"
      title="Short domains"
      sub={adminHost === primary ? "Each domain has its own short links. The primary domain also hosts this admin and the API." : `Each domain has its own short links. This admin and the API are served from ${adminHost}.`}
      help={SETTINGS_HELP.domains}
    >
      {!domains.length ? (
        <Notice className="settings-gap">
          No short domain yet, so links can't be created. Check yours below for the DNS steps, then add it to the Wrangler config. Installed with the Deploy to Cloudflare button? Edit <Code>wrangler.toml</Code> in your copy of the
          repository: set <Code>SHORT_DOMAINS</Code> and add a route for it (its comments show how), then commit, and Workers Builds deploys it. Installed with the setup? Run <Code>npm run setup -- domains</Code>.
        </Notice>
      ) : null}
      <ul className="settings-domains" hidden={!domains.length && !retired.length}>
        {[...domains, ...retired].map((d) => {
          const n = linksPerDomain[d] ?? 0;
          return (
            <li key={d} className="settings-domain">
              <Globe2 aria-hidden className="settings-domain-icon" />
              <span className="settings-domain-name">
                <span translate="no">{d}</span>
                {d === primary ? <span className="settings-domain-role">{d === adminHost ? "Primary · admin & API" : "Primary"}</span> : null}
                {retired.includes(d) ? <Badge tone="danger">Not in SHORT_DOMAINS: links don't redirect</Badge> : null}
              </span>
              <span className="settings-domain-count">
                {num(n)} {n === 1 ? "link" : "links"}
              </span>
              <Button variant="ghost" size="sm" icon={SearchCheck} onClick={() => checkExisting(d)} loading={check.isPending && check.variables === d} aria-label={`Check ${d}`}>
                Check
              </Button>
              <Button variant="ghost" size="sm" icon={Trash2} onClick={() => askRemove(d)} aria-label={`Remove ${d}`}>
                Remove
              </Button>
            </li>
          );
        })}
      </ul>
      {demo ? (
        <Notice
          title="Demo data"
          className="settings-gap"
          action={
            <Button size="sm" onClick={() => clearDemo.mutate()} loading={clearDemo.isPending}>
              Remove demo data
            </Button>
          }
        >
          {num(demo.links)} sample {demo.links === 1 ? "link" : "links"} and made-up statistics on {demo.domain}, from <Code>npm run seed:dev</Code>. It's removed on its own once you add a real domain.
        </Notice>
      ) : null}
      {removed ? (
        <Notice className="settings-gap">
          {removed}'s links, statistics and misses are deleted, but the domain still points at this Worker and answers with the not-found page. To take it off, run <Code>npm run setup -- domains</Code> (or remove it from{" "}
          <Code>SHORT_DOMAINS</Code> and <Code>routes</Code> in wrangler.jsonc), then <Code>npm run deploy</Code>.
        </Notice>
      ) : null}

      <Dialog
        open={removing !== null}
        onOpenChange={(o) => !o && !purge.isPending && setRemoving(null)}
        title={`Remove ${removing ?? ""}?`}
        description={`This deletes ${num(removingLinks)} ${removingLinks === 1 ? "link" : "links"} on this domain, all of its click statistics and its missed paths. It can't be undone: export your links first if you might want them back.`}
        size="sm"
        footer={
          <>
            <Button onClick={() => setRemoving(null)} disabled={purge.isPending}>
              Cancel
            </Button>
            <Button variant="danger" type="submit" form="remove-domain" loading={purge.isPending} disabled={!confirmed}>
              Delete everything
            </Button>
          </>
        }
      >
        <form
          id="remove-domain"
          className="settings-stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (removing && confirmed) purge.mutate(removing);
          }}
        >
          {removing === primary ? (
            <Notice tone="danger">
              This is the primary domain: new links go here by default{primary === adminHost ? ", and it serves this admin" : ""}. To stop using it, make another domain primary (first in <Code>SHORT_DOMAINS</Code>) and deploy.
            </Notice>
          ) : null}
          <Input id="remove-domain-confirm" label={`Type ${removing ?? ""} to confirm`} value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" spellCheck={false} placeholder={removing ?? ""} />
          {purge.isPending ? <p className="settings-note">Deleted {num(deletedSoFar)} links so far…</p> : null}
        </form>
      </Dialog>

      <div className="settings-sub">
        <h3 className="settings-h3">Add a domain</h3>
        <p className="settings-prose">
          Five steps, about 15 minutes of work plus waiting for DNS. Type the domain first: the instructions fill it in. Use <strong>Check setup</strong> at any point to see which steps are done.
        </p>

        <form onSubmit={run} className="settings-domain-form">
          <Input
            id="new-domain"
            label="Domain to add"
            placeholder="newdomain.com"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            error={draft && !valid ? "Enter a domain such as links.example.com" : null}
            hint={configured && valid ? "Already in SHORT_DOMAINS. Check setup shows whether it's live." : "A domain you own, like example.link, or a subdomain like go.example.com."}
          />
          <Button type="submit" icon={SearchCheck} disabled={!valid} loading={check.isPending}>
            Check setup
          </Button>
        </form>

        <div aria-live="polite">
          {check.isError ? <Notice tone="danger" className="settings-gap">{check.error.message}</Notice> : null}
          {result?.error ? <Notice tone="danger" className="settings-gap">{result.error}</Notice> : null}
          {result && !result.error ? (
            <p className="settings-note settings-gap">
              Checked {result.domain} at {when(result.checkedAt)}. {live ? <strong className="settings-good">It's live.</strong> : "Steps marked with a check are done."}
            </p>
          ) : null}
        </div>

        <ol className="settings-steps">
          <Step n={1} title="Add the domain to Cloudflare" state={nsState === "done" ? "done" : "open"}>
            <p>
              Sign in to the Cloudflare account that runs this Worker. On the account home, choose <strong>Onboard a domain</strong>, enter <Code>{result?.zone && result.zone !== name ? result.zone : name}</Code> and continue with the{" "}
              <strong>Free</strong> plan.
            </p>
            <p>
              Cloudflare scans the existing DNS records. Check the list against your current DNS, especially <strong>MX</strong> and <strong>TXT</strong> records if the domain receives email, then continue.
            </p>
            <p className="settings-small">Is it a subdomain like go.example.com? Add the parent domain (example.com) instead. Already a Cloudflare domain in this account? Skip to step 3.</p>
          </Step>

          <Step
            n={2}
            title="Point the nameservers to Cloudflare"
            state={nsState}
            status={
              !result || result.error ? undefined : !result.exists ? (
                <>DNS says {name} doesn't exist. Is it registered, and spelled correctly?</>
              ) : result.onCloudflare ? (
                <>Done: {result.zone} uses Cloudflare ({result.nameservers.join(", ")}).</>
              ) : result.nameservers.length ? (
                <>Not yet: {result.zone} still uses {result.nameservers.join(", ")}. Replace them at your registrar. If you just did, wait: it can take up to 24 hours.</>
              ) : (
                <>No nameservers found for {name} yet.</>
              )
            }
          >
            <p>
              Cloudflare shows two nameservers on the domain's <strong>Overview</strong> page, for example <Code>ada.ns.cloudflare.com</Code> and <Code>bob.ns.cloudflare.com</Code> (yours will differ).
            </p>
            <p>
              Sign in where you bought the domain (your registrar). Under <strong>Nameservers</strong> (sometimes “DNS servers”), choose custom nameservers, remove the existing ones and enter Cloudflare's two exactly as shown. Not sure who
              the registrar is? <Ext href={`https://lookup.icann.org/en/lookup?name=${encodeURIComponent(result?.zone ?? name)}`}>Look it up</Ext>
            </p>
            <p>
              <strong>DNSSEC:</strong> if it's on at the registrar, turn it off <em>before</em> changing the nameservers, or the domain can stop working. Turn it back on later in Cloudflare (DNS → Settings).
            </p>
            <p>Cloudflare emails you when the domain is Active. That's often within an hour, at most 24 hours.</p>
          </Step>

          <Step
            n={3}
            title={`Free up ${name} in DNS`}
            state={recordsState}
            status={
              !known || !result ? undefined : live ? (
                <>Done: {name} points to this Worker.</>
              ) : result.records.length ? (
                <>
                  {name} has {result.records.map((r) => `${r.type} ${r.value}`).join(", ")}
                  {result.onCloudflare ? " (behind Cloudflare, proxied records show Cloudflare's addresses)" : ""}. Make sure nothing in the DNS list below still claims {name}.
                </>
              ) : (
                <>{name} has no A, AAAA or CNAME records. Nothing to delete.</>
              )
            }
          >
            <p>
              In Cloudflare, open <Code>{result?.zone ?? name}</Code> → <strong>DNS → Records</strong>. Delete every <strong>A</strong>, <strong>AAAA</strong> and <strong>CNAME</strong> record whose name is <Code>{name}</Code>
              {name.split(".").length === 2 ? (
                <>
                  {" "}
                  (it may be shown as <Code>@</Code>)
                </>
              ) : null}
              . The Worker needs this name for itself, and Cloudflare can't attach it while a CNAME is there.
            </p>
            <p>
              Keep <strong>MX</strong> and <strong>TXT</strong> records: email and domain verifications don't conflict. Records on other names (like www) can stay too.
            </p>
            <p>Don't add a record for the Worker yourself. The deploy in step 5 creates the DNS record and the HTTPS certificate.</p>
            <p className="settings-small">
              Moving from another shortener? Import the links first, then delete its record right before step 5, so the links switch over with only a minute of downtime.
            </p>
          </Step>

          <Step n={4} title="Add it to the Worker configuration" state={configState} status={configState === "done" ? <>Done: {name} is in SHORT_DOMAINS.</> : undefined}>
            <p>
              Run <Code>npm run setup -- domains</Code>, or edit <Code>wrangler.jsonc</Code> yourself: add it to <Code>SHORT_DOMAINS</Code> (the first entry stays the primary domain):
            </p>
            <Snippet text={`"SHORT_DOMAINS": "${next.join(",")}",`} />
            <p>and give every domain a route:</p>
            <Snippet text={`"routes": [\n${next.map((d) => `  { "pattern": "${d}", "custom_domain": true }`).join(",\n")}\n],`} />
            <p className="settings-small">
              To try it locally first, put <Code>SHORT_DOMAINS={next.join(",")}</Code> in .dev.vars and restart npm run dev. Locally you reach a domain's links by sending the header <Code>X-Shorthop-Domain: {name}</Code>.
            </p>
          </Step>

          <Step n={5} title="Deploy and check" state={deployState} status={!known || !result ? undefined : <>{result.servingDetail}</>}>
            <p>
              Run <Code>npm run deploy</Code>. Cloudflare attaches {name} to the Worker and issues its certificate; allow a few minutes. Then press <strong>Check setup</strong> again, or open{" "}
              <Ext href={`https://${name}/health`}>https://{name}/health</Ext>: it should say “ok”.
            </p>
            <p>
              Recommended: in Cloudflare → {result?.zone ?? name} → <strong>SSL/TLS → Edge Certificates</strong>, turn on <strong>Always Use HTTPS</strong>.
            </p>
            <p className="settings-small">
              Bringing links over from another shortener: import them (Import links), then verify with <Code>npx tsx scripts/check-slugs.ts --per-domain</Code>.
            </p>
          </Step>
        </ol>
      </div>
    </SettingsSection>
  );
}

// ---------------- Publishing ----------------

export function PublishingSection({ resyncing, onResync }: { resyncing: number | null; onResync: () => void }) {
  return (
    <SettingsSection id="publishing" title="Publishing" sub="Refresh your links across the global network if a recent change has not appeared." help={SETTINGS_HELP.publishing}>
      <Button icon={RefreshCw} onClick={onResync} loading={resyncing !== null}>
        {resyncing !== null ? `Republishing… ${num(resyncing)}` : "Republish all links"}
      </Button>
    </SettingsSection>
  );
}

// ---------------- Exports ----------------

/** An export button: fetches `href` with the admin session, then saves it. */
export function DownloadButton({ href, title, size, children }: { href: string; title?: string; size?: "sm" | "md"; children: ReactNode }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      icon={Download}
      size={size}
      title={title}
      loading={busy}
      onClick={() => {
        setBusy(true);
        downloadFile(href)
          .catch((e: unknown) => toast.error(e instanceof Error ? e.message : "Export failed"))
          .finally(() => setBusy(false));
      }}
    >
      {children}
    </Button>
  );
}

export function ExportsSection() {
  return (
    <SettingsSection id="exports" title="Exports" sub="Download your links and their daily statistics." help={SETTINGS_HELP.exports}>
      <div className="settings-actions">
        <DownloadButton href="/_admin/api/export/links.csv">Links (CSV)</DownloadButton>
        <DownloadButton href="/_admin/api/export/links.json" title="Every link with its settings, for importing into another workspace">
          Links with settings (JSON)
        </DownloadButton>
        <DownloadButton href="/_admin/api/stats/export.csv?range=all">Daily stats per link (CSV)</DownloadButton>
      </div>
    </SettingsSection>
  );
}

// ---------------- Backup (admins) ----------------

function errorMessage(error: unknown): string {
  if (error instanceof TypeError) return "Couldn’t reach the server. Check your connection.";
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong.";
}

/**
 * Everything the workspace holds, without secrets, as one ZIP built in the
 * browser (the Worker hands it over a table page at a time). Admins only;
 * people's details only when ticked, by someone who sees revenue.
 */
export function BackupSection() {
  const info = useQuery({ queryKey: ["backup"], queryFn: () => call(api.backup.$get()) });
  const [personal, setPersonal] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  const run = async () => {
    if (!info.data) return;
    try {
      const { strToU8, zipSync } = await import("fflate");
      const files: Record<string, Uint8Array> = {};
      const counts: Record<string, number> = {};
      for (const t of info.data.tables) {
        if (t.personalOnly && !personal) continue;
        const rows: unknown[] = [];
        let offset: number | null = 0;
        while (offset !== null) {
          setProgress(`${t.name}: ${num(rows.length)} rows`);
          const page: { rows: unknown[]; next: number | null } = await call(api.backup[":table"].$get({ param: { table: t.name }, query: { offset: String(offset), personal: personal ? "1" : "0" } }));
          rows.push(...page.rows);
          offset = page.next;
        }
        counts[t.name] = rows.length;
        files[`tables/${t.name}.json`] = strToU8(JSON.stringify(rows));
      }
      setProgress("links with their settings");
      files["links.json"] = strToU8(JSON.stringify(await call(api.export["links.json"].$get())));
      files["kv.json"] = strToU8(JSON.stringify(info.data.kv, null, 1));
      files["manifest.json"] = strToU8(JSON.stringify({ ...info.data.manifest, createdAt: new Date().toISOString(), personal, tables: counts }, null, 1));
      const blob = new Blob([zipSync(files, { level: 6 }) as BlobPart], { type: "application/zip" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `shorthop-backup-${new Date().toISOString().slice(0, 10)}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      toast.success("Backup downloaded", { description: `${num(Object.values(counts).reduce((x, y) => x + y, 0))} rows in ${Object.keys(counts).length} tables.` });
    } catch (err) {
      toast.error(`The backup stopped: ${errorMessage(err)}`);
    } finally {
      setProgress(null);
    }
  };

  return (
    <SettingsSection
      id="backup"
      title="Backup"
      sub="Everything this workspace holds, as one ZIP: links and their history, statistics, websites, payments and settings. Passwords, API keys and webhook or payment secrets are never included."
    >
      <div className="settings-stack">
        {info.isError && !info.data ? <ErrorState compact what="Backup" error={info.error} onRetry={() => void info.refetch()} retrying={info.isFetching} /> : null}
        {info.data?.canPersonal ? (
          <Checkbox
            label="Include people's details"
            description="Customers' emails and ids, and visitor ids. Keep a backup with them as safely as the workspace itself."
            checked={personal}
            onCheckedChange={setPersonal}
          />
        ) : null}
        <div className="settings-actions">
          <Button variant="primary" icon={HardDriveDownload} onClick={() => void run()} loading={progress !== null} disabled={!info.data}>
            Download backup
          </Button>
          <span className="settings-note" aria-live="polite">
            {progress ? `${progress}…` : null}
          </span>
        </div>
        <p className="settings-note">
          To restore links into this or another workspace, import <Code>links.json</Code> from the ZIP (Import → a file). A full restore is in docs/SETUP.md, "Restore a backup".
        </p>
        {info.isPending ? (
          <Skeleton className="ui-skel-text" style={{ width: "70%" }} />
        ) : info.data ? (
          info.data.scheduled ? (
            <Notice>
              Weekly copies go to your R2 bucket on Sunday mornings (UTC); the newest eight are kept.
              {info.data.lastScheduled ? ` Last: ${ago(info.data.lastScheduled.at)}, ${num(info.data.lastScheduled.rows)} rows.` : " None yet."}
            </Notice>
          ) : (
            <p className="settings-note">Weekly copies to R2: bind a bucket as BACKUPS in wrangler.jsonc (R2 needs a subscription in the Cloudflare dashboard; its free allowance covers this).</p>
          )
        ) : null}
      </div>
    </SettingsSection>
  );
}

// ---------------- Cloudflare foundation ----------------

const FEATURES = [
  { icon: Globe2, name: "Global delivery", detail: "Workers + Static Assets", benefit: "Edge redirects and free static asset requests.", href: "https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/" },
  { icon: Database, name: "Links & history", detail: "D1 + Workers KV", benefit: "Free storage allowances, plus automatic D1 recovery history.", href: "https://developers.cloudflare.com/d1/platform/pricing/" },
  { icon: ChartNoAxesCombined, name: "Audience insights", detail: "Analytics Engine", benefit: "Country, device, and source insights without tracking cookies.", href: "https://developers.cloudflare.com/analytics/analytics-engine/pricing/" },
  { icon: LockKeyhole, name: "Private workspace", detail: "Cloudflare Access", benefit: "Optional, recommended: identity-based admin access in front of the password. Free for up to 50 users.", href: "https://www.cloudflare.com/plans/" },
  { icon: Mail, name: "Weekly digest and alerts", detail: "Email Service (or another provider) + Cron", benefit: "With Email Service, free delivery to a verified address in your account.", href: "https://developers.cloudflare.com/email-service/platform/pricing/" },
  { icon: Cloud, name: "Operational visibility", detail: "Workers Logs + Traces", benefit: "Inspect errors and requests within Cloudflare’s included allowances.", href: "https://developers.cloudflare.com/workers/platform/pricing/" },
];

export function CloudflareSection() {
  return (
    <SettingsSection
      id="cloudflare"
      title="Your Cloudflare foundation"
      sub="The services this app runs on, with their free plans or included allowances. Usage counts toward your account's limits."
      aside={<span className="settings-aside-note">Free-tier guide</span>}
      help={SETTINGS_HELP.cloudflare}
    >
      <ul className="settings-features">
        {FEATURES.map(({ icon: Icon, name, detail, benefit, href }) => (
          <li key={name}>
            <a className="settings-feature" href={href} target="_blank" rel="noreferrer">
              <span className="settings-feature-head">
                <Icon aria-hidden className="settings-feature-icon" />
                <span className="settings-feature-name">{name}</span>
                <ArrowUpRight aria-hidden className="settings-feature-out" />
              </span>
              <span className="settings-feature-detail">{detail}</span>
              <span className="settings-feature-benefit">{benefit}</span>
              <span className="ui-sr"> (Cloudflare pricing, opens in a new tab)</span>
            </a>
          </li>
        ))}
      </ul>
      <p className="settings-note">
        Free allowances have usage limits and are shared across your account. This is a capability guide, not a live usage or billing report. Review usage in your Cloudflare dashboard before changing plans.
      </p>
    </SettingsSection>
  );
}
