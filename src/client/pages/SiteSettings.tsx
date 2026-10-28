import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, BookOpen, Bot, CheckCircle2, Copy, EyeOff, Loader2, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { ATTRIBUTION_INFO, ATTRIBUTION_MODELS, LOOKBACK_DAYS, type AttributionModel, type IdMode, type SiteDTO } from "../../shared/sites";
import { api, ApiError, call, keys } from "../api";
import { PaymentProviders } from "../components/PaymentProviders";
import { SetupGuide } from "../components/SetupGuide";
import { Button, Card, CardHeader, Combobox, Field, Input, Notice, PageHeader, Segmented, Select, Spinner, Switch, Textarea } from "../components/ui";
import { useDomains } from "../lib/links";
import { ago } from "../lib/format";
import { currencyOptions, timeZones } from "../lib/sites";
import { copy } from "../lib/utils";

export function SiteSettings() {
  const { id = "" } = useParams();
  const site = useQuery({ queryKey: keys.site(id), queryFn: () => call(api.sites[":id"].$get({ param: { id } })) });
  const { domains, primary } = useDomains();
  // Which short domain the snippets name. Every short domain serves the script, so this only changes what's copied.
  const [host, setHost] = useState("");
  const origin = `https://${(domains.includes(host) ? host : primary) || window.location.host}`;

  if (site.isPending) return <div className="flex justify-center py-24"><Spinner /></div>;
  if (site.isError) return <Notice tone="danger">{site.error.message}</Notice>;
  const s = site.data;

  return (
    <>
      <Link to={`/sites/${id}`} className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" /> {s.name}
      </Link>
      <PageHeader
        title="Settings & setup"
        description={`Track ${s.domains[0]}, connect payments and choose how revenue is credited.`}
        actions={
          <>
            <TrackingToggle site={s} />
            <Link to={`/sites/${id}/guide`} className="inline-flex h-9 items-center gap-2 rounded-md border border-line bg-surface px-3 text-sm font-medium hover:bg-surface-2">
              <BookOpen className="size-4" /> Guide
            </Link>
          </>
        }
      />
      {!s.tracking ? (
        <div className="mb-6">
          <Notice>Tracking is paused. Visits aren’t recorded and short links aren’t tagged. Payments are still recorded. The script can stay on your site.</Notice>
        </div>
      ) : null}
      <div className="space-y-6">
        <InstallCard site={s} origin={origin} domains={domains} onDomain={setHost} />
        <PaymentProviders site={s} />
        <SetupGuide site={s} origin={origin} />
        <GeneralCard site={s} />
        <ApiCard site={s} origin={origin} />
        <DeleteCard site={s} />
      </div>
    </>
  );
}

function Code({ children, label }: { children: string; label?: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md border border-line bg-surface-2 p-3 pr-12 font-mono text-xs leading-relaxed text-fg">{children}</pre>
      <Button size="icon-sm" variant="ghost" className="absolute top-1.5 right-1.5" aria-label={`Copy ${label ?? "code"}`} onClick={() => void copy(children, "Copied")}>
        <Copy />
      </Button>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      {children}
    </div>
  );
}

/** Where each platform takes code for the page head. */
const PLATFORMS: { value: string; label: string; steps: string; code?: (origin: string, id: string) => string }[] = [
  { value: "html", label: "HTML", steps: "Paste the tag inside <head> on every page, or in the shared layout or template your pages use." },
  {
    value: "next",
    label: "Next.js",
    steps: "App Router: add it to app/layout.tsx. Pages Router: pages/_document.tsx (or _app.tsx with next/script).",
    code: (origin, id) => `import Script from "next/script";

// in the root layout's <head> (or <body>)
<Script defer src="${origin}/_t/script.js" data-site="${id}" strategy="afterInteractive" />`,
  },
  { value: "wordpress", label: "WordPress", steps: "With a plugin like WPCode: Code Snippets → Header & Footer → Header, paste, save. Or in your (child) theme's header.php before </head>." },
  { value: "shopify", label: "Shopify", steps: "Online Store → Themes → … → Edit code → layout/theme.liquid, paste just before </head>, save." },
  { value: "webflow", label: "Webflow", steps: "Site settings → Custom code → Head code, paste, save and publish. (Custom code needs a paid site plan.)" },
  { value: "framer", label: "Framer", steps: "Site Settings → General → Custom Code → End of <head> tag, paste, then publish." },
  { value: "wix", label: "Wix", steps: "Settings → Custom code → + Add custom code, paste, place it in Head, load on all pages." },
  { value: "squarespace", label: "Squarespace", steps: "Settings → Advanced → Code injection → Header, paste, save." },
  { value: "ghost", label: "Ghost", steps: "Settings → Code injection → Site header, paste, save." },
];

/** "Waiting for the first visit…" until a visit arrives, then when the latest one came. */
function InstallCheck({ site }: { site: SiteDTO }) {
  const status = useQuery({
    queryKey: keys.siteData(site.id, "install-status", {}),
    queryFn: () => call(api.sites[":id"]["install-status"].$get({ param: { id: site.id } })),
    refetchInterval: (q) => (q.state.data?.lastSeenAt ? 60_000 : 5_000),
  });
  const s = status.data;
  const url = `https://${site.domains[0]}/?sh_debug=1`;
  if (!s) return null;
  return s.lastSeenAt ? (
    <div className="flex items-start gap-2 rounded-md border border-good/30 bg-good-soft px-3 py-2.5 text-sm">
      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-good" aria-hidden />
      <p>
        <span className="font-medium">Installed.</span> Latest visit {ago(s.lastSeenAt)}
        {s.hostname ? ` on ${s.hostname}` : ""}; {s.visits24h} visit{s.visits24h === 1 ? "" : "s"} in the last 24 hours.
      </p>
    </div>
  ) : (
    <div className="flex items-start gap-2 rounded-md border border-line bg-surface-2 px-3 py-2.5 text-sm" role="status">
      <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted" aria-hidden />
      <p>
        <span className="font-medium">Waiting for the first visit…</span> Open{" "}
        <a href={url} target="_blank" rel="noreferrer" className="font-medium underline">{site.domains[0]}</a> once the tag is live; this turns green within seconds. With ?sh_debug=1 the browser console says why a visit isn't sent.
      </p>
    </div>
  );
}

/** Pauses or resumes recording visits, without removing the script or the site's data. */
function TrackingToggle({ site }: { site: SiteDTO }) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (tracking: boolean) => call(api.sites[":id"].$patch({ param: { id: site.id }, json: { tracking } })),
    onSuccess: (updated) => {
      qc.setQueryData(keys.site(site.id), updated);
      void qc.invalidateQueries({ queryKey: keys.sites });
      void qc.invalidateQueries({ queryKey: keys.site(site.id) });
      toast.success(updated.tracking ? "Tracking on" : "Tracking paused", {
        description: updated.tracking ? "New visits are recorded again." : "Visits aren't recorded until you turn it back on. Payments still are.",
      });
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <div className="inline-flex h-9 items-center rounded-md border border-line bg-surface px-3">
      <Switch id="site-tracking" checked={save.isPending ? !site.tracking : site.tracking} onCheckedChange={(v) => save.mutate(v)} label="Tracking" />
    </div>
  );
}

function InstallCard({ site, origin, domains, onDomain }: { site: SiteDTO; origin: string; domains: string[]; onDomain: (d: string) => void }) {
  const [platform, setPlatform] = useState("html");
  const snippet = `<script defer src="${origin}/_t/script.js" data-site="${site.id}"></script>`;
  const guide = PLATFORMS.find((p) => p.value === platform) ?? PLATFORMS[0]!;
  const proxied = `<script defer src="/stats/script.js" data-site="${site.id}" data-api="/stats/e"></script>`;
  const nextRewrites = `// next.config.js — serve the tracker from your own domain
async rewrites() {
  return [
    { source: "/stats/script.js", destination: "${origin}/_t/script.js" },
    { source: "/stats/e", destination: "${origin}/_t/e" },
  ];
}`;
  const goals = `<button data-sh-goal="signup" data-sh-goal-plan="pro">Sign up</button>
<section data-sh-scroll="pricing_seen" data-sh-scroll-threshold="0.5">…</section>

<script>
  // Or from code; calls made before the script loads are kept.
  window.shorthop = window.shorthop || function () { (shorthop.q = shorthop.q || []).push(arguments); };
  shorthop("goal", "newsletter", { list: "weekly" });
  shorthop("identify", { email: user.email, id: user.id }); // after sign-in
</script>`;
  const csp = `script-src 'self' ${origin}; connect-src 'self' ${origin}`;
  const banner = `<script defer src="${origin}/_t/script.js" data-site="${site.id}" data-consent-banner></script>

<!-- In your footer, so visitors can change their choice: -->
<a href="#" onclick="shorthop('consent-settings'); return false">Cookie settings</a>`;
  const consent = `// When the consent banner reports the visitor's choice:
shorthop("consent", true);  // keep a first-party id across days
shorthop("consent", false); // back to cookieless; the stored id is removed`;
  return (
    <Card>
      <CardHeader title="1. Install the script" description="Paste it into the <head> of every page. It's small, sets no cookies, and counts single-page-app navigation too." />
      <div className="space-y-5 px-4 pb-5">
        {domains.length > 1 ? (
          <Field label="Load the script from" htmlFor="install-domain" hint="Any of your short domains works, and short links on all of them are credited. Pick one you'll keep: if it's removed, the script stops loading.">
            <Select id="install-domain" value={new URL(origin).hostname} onChange={(e) => onDomain(e.target.value)} className="max-w-xs">
              {domains.map((d) => <option key={d} value={d}>{d}</option>)}
            </Select>
          </Field>
        ) : null}
        <Code label="script tag">{snippet}</Code>
        <InstallCheck site={site} />
        <Section title="Where it goes">
          <Select aria-label="Platform" value={platform} onChange={(e) => setPlatform(e.target.value)} className="max-w-xs">
            {PLATFORMS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </Select>
          <p className="text-sm text-muted">{guide.steps}</p>
          {guide.code ? <Code label={`${guide.label} example`}>{guide.code(origin, site.id)}</Code> : null}
        </Section>
        <Section title="Content Security Policy">
          <p className="text-sm text-muted">If your site sends a Content-Security-Policy header, the browser blocks the script and its requests until you allow this domain. Add it to these two directives, next to what's already there:</p>
          <Code label="CSP directives">{csp}</Code>
          <p className="text-xs text-muted">No CSP header? Nothing to do. Serving the script through your own domain (below) is covered by 'self'.</p>
        </Section>
        <Section title="Goals and sign-ins">
          <Code label="goal example">{goals}</Code>
          <p className="text-xs text-muted">From the browser, identify() can only fill in an email that isn't known yet. To set it for sure (for email matching), use the API below.</p>
        </Section>
        {site.idMode === "consent" ? (
          <Section title="Consent">
            <p className="text-sm text-muted">No banner yet? Add data-consent-banner and the script asks with a small Accept / Decline bar until the visitor chooses. data-consent-text="…" replaces its sentence.</p>
            <Code label="built-in banner">{banner}</Code>
            <p className="text-sm text-muted">Already have a consent banner? Report its answer instead:</p>
            <Code label="consent example">{consent}</Code>
            <p className="text-xs text-muted">Until consent, visits are counted cookieless. The answer is remembered in the browser, so call it again only when the visitor changes their mind.</p>
          </Section>
        ) : null}
        <Section title="Avoid ad blockers (optional)">
          <p className="text-sm text-muted">Some blockers stop third-party analytics. Serve the script through your own domain:</p>
          <Code label="proxied script tag">{proxied}</Code>
          <Code label="Next.js rewrites">{nextRewrites}</Code>
        </Section>
        <Section title="Your own visits">
          <div className="flex flex-wrap items-center gap-3">
            <a href={`https://${site.domains[0]}/?sh_ignore=1`} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-2 rounded-md border border-line bg-surface px-3 text-sm font-medium hover:bg-surface-2">
              <EyeOff className="size-4" /> Stop counting this browser
            </a>
            <span className="text-xs text-muted">Opens {site.domains[0]} with ?sh_ignore=1 (a note confirms it). Do it once per browser and device; ?sh_ignore=0 counts it again.</span>
          </div>
        </Section>
        <p className="text-xs text-muted">Testing locally? Add a site with the domain localhost and the attribute data-allow-localhost.</p>
      </div>
    </Card>
  );
}

function GeneralCard({ site }: { site: SiteDTO }) {
  const qc = useQueryClient();
  const [form, setForm] = useState(site);
  useEffect(() => setForm(site), [site]);
  const [paths, setPaths] = useState(site.excludePaths.join("\n"));
  const set = <K extends keyof SiteDTO>(k: K, v: SiteDTO[K]) => setForm((f) => ({ ...f, [k]: v }));
  const save = useMutation({
    mutationFn: () =>
      call(
        api.sites[":id"].$patch({
          param: { id: site.id },
          json: {
            name: form.name,
            domains: form.domains,
            timezone: form.timezone,
            currency: form.currency,
            idMode: form.idMode,
            respectGpc: form.respectGpc,
            attributionModel: form.attributionModel,
            lookbackDays: form.lookbackDays,
            excludePaths: paths.split("\n").map((p) => p.trim()).filter(Boolean),
            tagLinks: form.tagLinks,
            notifyPayments: form.notifyPayments,
            serverEmailsOnly: form.serverEmailsOnly,
            spikeAlerts: form.spikeAlerts,
            dailyDigest: form.dailyDigest,
            digestHour: form.digestHour,
          },
        }),
      ),
    onSuccess: () => {
      toast.success("Saved");
      void qc.invalidateQueries({ queryKey: keys.sites });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't save"),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <Card>
      <CardHeader title="Site settings" />
      <form onSubmit={submit} className="space-y-5 px-4 pb-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="gs-name"><Input id="gs-name" value={form.name} onChange={(e) => set("name", e.target.value)} /></Field>
          <Field label="Domains" htmlFor="gs-domains" hint="Comma-separated. Subdomains are included.">
            <Input id="gs-domains" value={form.domains.join(", ")} onChange={(e) => set("domains", e.target.value.split(",").map((d) => d.trim()).filter(Boolean))} />
          </Field>
          <Field label="Time zone" htmlFor="gs-tz">
            <Select id="gs-tz" value={form.timezone} onChange={(e) => set("timezone", e.target.value)}>
              {[...new Set([form.timezone, ...timeZones()])].map((tz) => <option key={tz} value={tz}>{tz}</option>)}
            </Select>
          </Field>
          <Field label="Currency" htmlFor="gs-cur" hint="Changing it converts every recorded payment again. Currencies marked “no daily rate” only count payments made in that same currency.">
            <Combobox id="gs-cur" value={form.currency} onChange={(v) => v && set("currency", v)} options={currencyOptions()} placeholder="Type a code or name…" />
          </Field>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium">Visitor identification</p>
          <Segmented<IdMode> label="Visitor identification" value={form.idMode} onChange={(v) => set("idMode", v)} options={[{ value: "cookieless", label: "Cookieless" }, { value: "consent", label: "After consent" }, { value: "persistent", label: "Recognise returning visitors" }]} />
          <p className="text-xs text-muted">
            {form.idMode === "cookieless"
              ? "Nothing is stored in the visitor's browser and no consent banner is needed. Visitors are counted per day, so a payment is linked to visits of the same day, or through the checkout reference. A short-link click on an earlier day isn't credited."
              : form.idMode === "consent"
                ? "Cookieless until the visitor accepts, in the script's built-in banner or yours calling shorthop(\"consent\", true); from then on a random ID in localStorage recognises the visitor across days. Visitors who decline stay cookieless."
                : "A random ID in localStorage recognises a visitor across days, so a payment days later is credited to the visit that first brought them. In the EU this needs the visitor's consent; update your privacy notice."}
          </p>
          {form.idMode !== "cookieless" ? (
            <Switch id="gs-gpc" checked={form.respectGpc} onCheckedChange={(v) => set("respectGpc", v)} label="Respect Global Privacy Control and Do Not Track" description="Those visitors are counted cookieless." />
          ) : null}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Credit revenue to" htmlFor="gs-model" hint={ATTRIBUTION_INFO[form.attributionModel].description}>
            <Select id="gs-model" value={form.attributionModel} onChange={(e) => set("attributionModel", e.target.value as AttributionModel)}>
              {ATTRIBUTION_MODELS.map((m) => <option key={m} value={m}>{ATTRIBUTION_INFO[m].label}</option>)}
            </Select>
          </Field>
          <Field label="Lookback window" htmlFor="gs-lookback" hint="Visits older than this before the payment aren't credited.">
            <Select id="gs-lookback" value={form.lookbackDays} onChange={(e) => set("lookbackDays", Number(e.target.value))}>
              {[...new Set([form.lookbackDays, ...LOOKBACK_DAYS])].sort((a, b) => a - b).map((d) => <option key={d} value={d}>{d} days</option>)}
            </Select>
          </Field>
        </div>

        <Switch id="gs-tag" checked={form.tagLinks} onCheckedChange={(v) => set("tagLinks", v)} label="Credit short links" description="Short links to this site carry a signed click token (?sh_c=), so visits and revenue are credited to the link. The script removes it from the address bar." />

        <Switch id="gs-notify" checked={form.notifyPayments} onCheckedChange={(v) => set("notifyPayments", v)} label="Email me about each payment" description="A short email to the weekly digest's recipient with the amount and where the customer came from. Test payments and refunds don't send one." />

        <Switch id="gs-spikes" checked={form.spikeAlerts} onCheckedChange={(v) => set("spikeAlerts", v)} label="Alert me about traffic spikes" description="Checked hourly: an email (and a site.traffic_spike webhook) when a source sends at least 4x its usual hourly visits, 20 or more." />

        <div className="space-y-2">
          <Switch id="gs-daily" checked={form.dailyDigest} onCheckedChange={(v) => set("dailyDigest", v)} label="Daily summary email" description="Yesterday's visitors, revenue, top sources and spikes, to the weekly digest's recipient." />
          {form.dailyDigest ? (
            <Field label="Send at" htmlFor="gs-hour" hint={`In the site's time zone (${form.timezone}).`}>
              <Select id="gs-hour" value={form.digestHour} onChange={(e) => set("digestHour", Number(e.target.value))} className="max-w-[10rem]">
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
              </Select>
            </Field>
          ) : null}
        </div>

        <Switch
          id="gs-server-emails"
          checked={form.serverEmailsOnly}
          onCheckedChange={(v) => set("serverEmailsOnly", v)}
          label="Trust only emails sent from my server"
          description="Match payments by email only to visitors your server identified (POST /api/sites/:id/identify). Emails the browser reports with identify still show on visitor profiles, but anyone can send one, so they no longer credit payments. Turn on once your server identifies signed-in customers."
        />

        <Field label="Don't record these paths" htmlFor="gs-paths" hint="One per line. * matches within a segment, ** anything: /admin/**">
          <Textarea id="gs-paths" rows={3} value={paths} onChange={(e) => setPaths(e.target.value)} className="font-mono text-xs" />
        </Field>

        <div className="flex justify-end"><Button type="submit" loading={save.isPending}>Save settings</Button></div>
      </form>
    </Card>
  );
}

function ApiCard({ site, origin }: { site: SiteDTO; origin: string }) {
  const curl = `curl -X POST ${origin}/api/sites/${site.id}/payments \\
  -H "Authorization: Bearer $SHORTHOP_API_KEY" -H "Content-Type: application/json" \\
  -d '{"id": "order-1001", "amount": 49.00, "currency": "USD", "ref": "<shorthop.ref() from the browser>", "email": "buyer@example.com"}'

# Trusted identify (overwrites what the browser sent)
curl -X POST ${origin}/api/sites/${site.id}/identify \\
  -H "Authorization: Bearer $SHORTHOP_API_KEY" -H "Content-Type: application/json" \\
  -d '{"ref": "<shorthop.ref()>", "email": "buyer@example.com"}'`;
  const prompt = `Add Shorthop revenue analytics to this project.
1. In the <head> of every page add: <script defer src="${origin}/_t/script.js" data-site="${site.id}"></script>
2. Find where checkouts are created (Stripe, Paddle, Lemon Squeezy, Dodo Payments or Creem). Hosted checkout links on our pages are tagged automatically. Where a checkout is created on the server, read the visit reference in the browser with window.shorthop.ref() and pass it through: Stripe client_reference_id "sh_" + ref; Paddle customData.sh_ref; Lemon Squeezy checkout_data.custom.sh_ref; Dodo and Creem metadata.sh_ref.
3. Make the success/return URL carry the provider's id (Stripe: ?session_id={CHECKOUT_SESSION_ID}).
4. After sign-in call window.shorthop("identify", { email, id }).
5. Add data-sh-goal="<name>" to signup and pricing buttons.
${site.idMode === "consent" ? 'The site counts visitors cookieless until consent: where the existing consent banner reports the choice, call window.shorthop("consent", true) or window.shorthop("consent", false). If the site has no consent banner, add data-consent-banner to the script tag instead, and a "Cookie settings" footer link that calls window.shorthop("consent-settings").' : `Don't add cookies or a consent banner for this; the site is ${site.idMode}.`}`;
  return (
    <Card>
      <CardHeader title="Server API" description="For billing without a native connection, and to identify customers from your server. Use a personal API key (Settings → API & webhooks) with Manage websites." />
      <div className="space-y-4 px-4 pb-5">
        <Code label="API examples">{curl}</Code>
        <Button variant="outline" onClick={() => void copy(prompt, "Setup prompt copied")}><Bot /> Copy setup prompt for an AI coding assistant</Button>
      </div>
    </Card>
  );
}

function DeleteCard({ site }: { site: SiteDTO }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const remove = useMutation({
    mutationFn: () => call(api.sites[":id"].$delete({ param: { id: site.id } })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.sites });
      toast.success(`${site.name} deleted`);
      navigate("/sites");
    },
  });
  return (
    <Card>
      <CardHeader title="Delete this website" description="Removes the site with every visit, payment and connection recorded for it. Analytics Engine events expire on their own after 90 days." />
      <div className="px-4 pb-5">
        <Button variant="danger" onClick={() => confirm(`Delete ${site.name} and all its data? This can't be undone.`) && remove.mutate()} loading={remove.isPending}>
          <Trash2 /> Delete website
        </Button>
      </div>
    </Card>
  );
}
