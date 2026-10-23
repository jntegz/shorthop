import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Copy, ExternalLink, FlaskConical, Globe2, SearchCheck, Trash2 } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { HOSTNAME_RE } from "../../shared/domains";
import { toast } from "sonner";
import type { DemoDTO, DomainCheckDTO } from "../../shared/types";
import { api, call, keys } from "../api";
import { num, when } from "../lib/format";
import { SETTINGS_HELP } from "../lib/help";
import { cn, copy } from "../lib/utils";
import { Badge, Button, Card, CardHeader, Dialog, Field, Input, Notice } from "./ui";

function Snippet({ text }: { text: string }) {
  return (
    <div className="relative mt-1.5">
      <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 pr-11 font-mono text-xs text-fg">{text}</pre>
      <Button type="button" variant="ghost" size="icon-sm" className="absolute top-1 right-1" aria-label="Copy" title="Copy" onClick={() => void copy(text)}>
        <Copy />
      </Button>
    </div>
  );
}

const Code = ({ children }: { children: ReactNode }) => <span className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[12px] text-fg">{children}</span>;

type StepState = "done" | "attention" | "open";

/** One onboarding step; `status` is the live check result for it, when there is one. */
function Step({ n, title, state, status, children }: { n: number; title: string; state: StepState; status?: ReactNode; children: ReactNode }) {
  return (
    <li className="group relative flex gap-4 pb-6 last:pb-0">
      <span className="absolute top-8 bottom-0 left-[15px] w-px bg-line group-last:hidden" aria-hidden />
      <span
        className={cn(
          "relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border text-sm font-semibold",
          state === "done" && "border-good bg-good text-white",
          state === "attention" && "border-warn bg-warn-soft text-warn",
          state === "open" && "border-line bg-surface text-muted",
        )}
        aria-label={state === "done" ? `Step ${n}, done` : state === "attention" ? `Step ${n}, needs attention` : `Step ${n}`}
      >
        {state === "done" ? <Check className="size-4" strokeWidth={3} /> : state === "attention" ? <AlertTriangle className="size-4" /> : n}
      </span>
      <div className="min-w-0 flex-1 pt-1">
        <p className="font-medium text-fg">{title}</p>
        {status ? (
          <div
            className={cn(
              "mt-2 rounded-lg px-3 py-2 text-xs leading-relaxed",
              state === "done" ? "bg-good-soft text-good" : state === "attention" ? "bg-warn-soft text-warn" : "bg-surface-2 text-muted",
            )}
          >
            {status}
          </div>
        ) : null}
        <div className="mt-2 space-y-2 text-sm leading-relaxed text-muted">{children}</div>
      </div>
    </li>
  );
}

/** Short domains: the configured list, and a guided, checkable setup for a new one. */
export function ShortDomains({
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

  const live = result?.serving === "yes";
  const nsState: StepState = !result ? "open" : result.onCloudflare ? "done" : "attention";
  const recordsState: StepState = !result ? "open" : live ? "done" : result.records.length ? "attention" : "open";
  const configState: StepState = configured || result?.configured ? "done" : "open";
  const deployState: StepState = !result ? "open" : live ? "done" : result.onCloudflare && configured ? "attention" : "open";

  return (
    <Card id="domains" className="scroll-mt-6 lg:col-span-2">
      <CardHeader
        title="Short domains"
        description={adminHost === primary ? "Each domain has its own short links. The primary domain also hosts this admin and the API." : `Each domain has its own short links. This admin and the API are served from ${adminHost}.`}
        info={SETTINGS_HELP.domains}
      />
      <div className="px-5">
        {!domains.length ? (
          <div className="mb-4">
            <Notice>
              No short domain yet, so links can't be created. Check yours below for the DNS steps, then add it to the Wrangler config. Installed with the Deploy to
              Cloudflare button? Edit <Code>wrangler.toml</Code> in your copy of the repository: set <Code>SHORT_DOMAINS</Code> and add a route for it (its comments show
              how), then commit, and Workers Builds deploys it. Installed with the setup? Run <Code>npm run setup -- domains</Code>.
            </Notice>
          </div>
        ) : null}
        <ul className={domains.length || retired.length ? "divide-y divide-line rounded-xl border border-line" : "hidden"}>
          {[...domains, ...retired].map((d) => (
            <li key={d} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
              <Globe2 className="size-4 shrink-0 text-accent" />
              <span className="font-medium text-fg">{d}</span>
              {d === primary ? <Badge tone="accent">{d === adminHost ? <>Primary · admin &amp; API</> : "Primary"}</Badge> : null}
              {retired.includes(d) ? <Badge tone="warn">Not in SHORT_DOMAINS: links don't redirect</Badge> : null}
              <span className="ml-auto text-xs text-muted">
                {num(linksPerDomain[d] ?? 0)} {(linksPerDomain[d] ?? 0) === 1 ? "link" : "links"}
              </span>
              <Button variant="ghost" size="sm" onClick={() => checkExisting(d)} loading={check.isPending && check.variables === d}>
                <SearchCheck /> Check
              </Button>
              <Button variant="ghost" size="sm" className="text-danger" onClick={() => askRemove(d)}>
                <Trash2 /> Remove
              </Button>
            </li>
          ))}
        </ul>
        {demo ? (
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface-2 px-4 py-3 text-sm">
            <FlaskConical className="size-4 shrink-0 text-accent" />
            <p className="min-w-0 flex-1 text-muted">
              <strong className="text-fg">Demo data:</strong> {num(demo.links)} sample {demo.links === 1 ? "link" : "links"} and fake stats on {demo.domain}, from{" "}
              <Code>npm run seed:dev</Code>. It's removed on its own once you add a real domain.
            </p>
            <Button variant="outline" size="sm" onClick={() => clearDemo.mutate()} loading={clearDemo.isPending}>
              Remove demo data
            </Button>
          </div>
        ) : null}
        {removed ? (
          <div className="mt-4">
            <Notice>
              {removed}'s links, stats and misses are deleted, but the domain still points at this Worker and answers with the not-found page. To take it off,
              run <Code>npm run setup -- domains</Code> (or remove it from <Code>SHORT_DOMAINS</Code> and <Code>routes</Code> in wrangler.jsonc), then{" "}
              <Code>npm run deploy</Code>.
            </Notice>
          </div>
        ) : null}
      </div>

      <Dialog
        open={removing !== null}
        onOpenChange={(o) => !o && !purge.isPending && setRemoving(null)}
        title={`Remove ${removing ?? ""}?`}
        description={`This deletes ${num(removingLinks)} ${removingLinks === 1 ? "link" : "links"} on this domain, all of its click stats and its missed paths. It can't be undone; export your links first if you might want them back.`}
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (removing && confirmText.trim().toLowerCase() === removing) purge.mutate(removing);
          }}
        >
          {removing === primary ? (
            <Notice tone="danger">
              This is the primary domain: new links go here by default{primary === adminHost ? ", and it serves this admin" : ""}. To stop using it, make another domain primary
              (first in <Code>SHORT_DOMAINS</Code>) and deploy.
            </Notice>
          ) : null}
          <Field label={`Type ${removing ?? ""} to confirm`} htmlFor="remove-domain-confirm">
            <Input id="remove-domain-confirm" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" spellCheck={false} placeholder={removing ?? ""} />
          </Field>
          {purge.isPending ? <p className="text-xs text-muted">Deleted {num(deletedSoFar)} links so far…</p> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setRemoving(null)} disabled={purge.isPending}>
              Cancel
            </Button>
            <Button type="submit" variant="danger" loading={purge.isPending} disabled={confirmText.trim().toLowerCase() !== removing}>
              Delete everything
            </Button>
          </div>
        </form>
      </Dialog>

      <div className="mt-6 border-t border-line px-5 pt-5 pb-6">
        <h3 className="text-[15px] font-semibold text-fg">Add a domain</h3>
        <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted">
          Five steps, about 15 minutes of work plus waiting for DNS. Type the domain first: the instructions fill it in. Use <strong className="text-fg">Check setup</strong> at any
          point to see which steps are done.
        </p>

        <form onSubmit={run} className="mt-4 flex max-w-xl flex-col gap-2 sm:flex-row sm:items-start">
          <div className="flex-1">
            <Field
              label="Domain to add"
              htmlFor="new-domain"
              error={draft && !valid ? "Enter a domain such as links.example.com" : null}
              hint={configured && valid ? "Already in SHORT_DOMAINS. Check setup shows whether it's live." : "A domain you own, like example.link, or a subdomain like go.example.com."}
            >
              <Input id="new-domain" placeholder="newdomain.com" value={draft} onChange={(e) => setDraft(e.target.value)} autoComplete="off" spellCheck={false} />
            </Field>
          </div>
          <Button type="submit" variant="outline" className="sm:mt-6" disabled={!valid} loading={check.isPending}>
            <SearchCheck /> Check setup
          </Button>
        </form>

        {check.isError ? (
          <div className="mt-4 max-w-3xl">
            <Notice tone="danger">{check.error.message}</Notice>
          </div>
        ) : null}
        {result?.error ? (
          <div className="mt-4 max-w-3xl">
            <Notice tone="danger">{result.error}</Notice>
          </div>
        ) : null}
        {result && !result.error ? (
          <p className="mt-3 text-xs text-muted">
            Checked {result.domain} at {when(result.checkedAt)}.{" "}
            {live ? <span className="font-medium text-good">It's live.</span> : "Steps marked with a check are done."}
          </p>
        ) : null}

        <ol className="mt-6 max-w-3xl">
          <Step n={1} title="Add the domain to Cloudflare" state={nsState === "done" ? "done" : "open"}>
            <p>
              Sign in to the Cloudflare account that runs this Worker. On the account home, choose <strong className="text-fg">Onboard a domain</strong>, enter{" "}
              <Code>{result?.zone && result.zone !== name ? result.zone : name}</Code> and continue with the <strong className="text-fg">Free</strong> plan.
            </p>
            <p>
              Cloudflare scans the existing DNS records. Check the list against your current DNS, especially <strong className="text-fg">MX</strong> and{" "}
              <strong className="text-fg">TXT</strong> records if the domain receives email, then continue.
            </p>
            <p className="text-xs">
              Is it a subdomain like go.example.com? Add the parent domain (example.com) instead. Already a Cloudflare domain in this account? Skip to step 3.
            </p>
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
                <>
                  Not yet: {result.zone} still uses {result.nameservers.join(", ")}. Replace them at your registrar. If you just did, wait: it can take up to 24 hours.
                </>
              ) : (
                <>No nameservers found for {name} yet.</>
              )
            }
          >
            <p>
              Cloudflare shows two nameservers on the domain's <strong className="text-fg">Overview</strong> page, for example <Code>ada.ns.cloudflare.com</Code> and{" "}
              <Code>bob.ns.cloudflare.com</Code> (yours will differ).
            </p>
            <p>
              Sign in where you bought the domain (your registrar). Under <strong className="text-fg">Nameservers</strong> (sometimes “DNS servers”), choose custom nameservers,
              remove the existing ones and enter Cloudflare's two exactly as shown. Not sure who the registrar is?{" "}
              <a
                className="inline-flex items-center gap-0.5 font-medium text-accent hover:underline"
                href={`https://lookup.icann.org/en/lookup?name=${encodeURIComponent(result?.zone ?? name)}`}
                target="_blank"
                rel="noreferrer"
              >
                Look it up <ExternalLink className="size-3" />
              </a>
            </p>
            <p>
              <strong className="text-fg">DNSSEC:</strong> if it's on at the registrar, turn it off <em>before</em> changing the nameservers, or the domain can stop working. Turn it
              back on later in Cloudflare (DNS → Settings).
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
              In Cloudflare, open <Code>{result?.zone ?? name}</Code> → <strong className="text-fg">DNS → Records</strong>. Delete every <strong className="text-fg">A</strong>,{" "}
              <strong className="text-fg">AAAA</strong> and <strong className="text-fg">CNAME</strong> record whose name is <Code>{name}</Code>
              {name.split(".").length === 2 ? <> (it may be shown as <Code>@</Code>)</> : null}. The Worker needs this name for itself, and Cloudflare can't attach it while a
              CNAME is there.
            </p>
            <p>
              Keep <strong className="text-fg">MX</strong> and <strong className="text-fg">TXT</strong> records: email and domain verifications don't conflict. Records on
              other names (like www) can stay too.
            </p>
            <p>
              Don't add a record for the Worker yourself. The deploy in step 5 creates the DNS record and the HTTPS certificate.
            </p>
            <p className="text-xs">
              Moving from another shortener? Import the links first, then delete its record right before step 5, so the links switch over with only a minute of
              downtime.
            </p>
          </Step>

          <Step
            n={4}
            title="Add it to the Worker configuration"
            state={configState}
            status={configState === "done" ? <>Done: {name} is in SHORT_DOMAINS.</> : undefined}
          >
            <p>
              Run <Code>npm run setup -- domains</Code>, or edit <Code>wrangler.jsonc</Code> yourself: add it to <Code>SHORT_DOMAINS</Code> (the first entry stays the
              primary domain):
            </p>
            <Snippet text={`"SHORT_DOMAINS": "${next.join(",")}",`} />
            <p>and give every domain a route:</p>
            <Snippet text={`"routes": [\n${next.map((d) => `  { "pattern": "${d}", "custom_domain": true }`).join(",\n")}\n],`} />
            <p className="text-xs">
              To try it locally first, put <Code>SHORT_DOMAINS={next.join(",")}</Code> in .dev.vars and restart npm run dev. Locally you reach a domain's links by sending
              the header <Code>X-Shorthop-Domain: {name}</Code>.
            </p>
          </Step>

          <Step
            n={5}
            title="Deploy and check"
            state={deployState}
            status={!known || !result ? undefined : <>{result.servingDetail}</>}
          >
            <p>
              Run <Code>npm run deploy</Code>. Cloudflare attaches {name} to the Worker and issues its certificate; allow a few minutes. Then press{" "}
              <strong className="text-fg">Check setup</strong> again, or open{" "}
              <a className="inline-flex items-center gap-0.5 font-medium text-accent hover:underline" href={`https://${name}/health`} target="_blank" rel="noreferrer">
                https://{name}/health <ExternalLink className="size-3" />
              </a>
              : it should say “ok”.
            </p>
            <p>
              Recommended: in Cloudflare → {result?.zone ?? name} → <strong className="text-fg">SSL/TLS → Edge Certificates</strong>, turn on{" "}
              <strong className="text-fg">Always Use HTTPS</strong>.
            </p>
            <p className="text-xs">
              Bringing links over from another shortener: import them (Import links), then verify with{" "}
              <Code>npx tsx scripts/check-slugs.ts --per-domain</Code>.
            </p>
          </Step>
        </ol>
      </div>
    </Card>
  );
}
