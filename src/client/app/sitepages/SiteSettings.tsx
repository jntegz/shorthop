// A website's settings and setup (/sites/:id/settings): install (snippet,
// live install check, platforms, CSP, goals, consent, ad blockers, own visits), payment providers, the
// setup guide, site settings (name, domains, time zone, currency, visitor
// identification, attribution, lookback, alerts, digests, excluded paths),
// the server API, privacy (retention, find/export/erase a person, recent
// requests), and deleting the site. Tracking on/off sits in the header.
// Sections carry anchors (#install, #payments, #setup-guide, #general, #api,
// #privacy, #delete). Look: sitepages.css.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Bot, Download, EyeOff, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import { ATTRIBUTION_INFO, ATTRIBUTION_MODELS, CUSTOMER_RETENTION_MONTHS, LOOKBACK_DAYS, type AttributionModel, type IdMode, type PrivacyCountsDTO, type SiteDTO } from "../../../shared/sites";
import { api, ApiError, call, downloadFile, keys } from "../../api";
import { ago } from "../../lib/format";
import { useDomains } from "../../lib/links";
import { useCan } from "../../lib/me";
import { currencyOptions, timeZones } from "../../lib/sites";
import { copy } from "../../lib/utils";
import { Button, Checkbox, Dialog, ErrorState, errorText, Input, Notice, Section, Segmented, Select, Switch, Textarea } from "../ui";
import { sitePages } from "../sites/common";
import { C, Code, ComboField, isNotFound, PageHead, SectionsSkeleton, useHashScroll, useSitePage, zoneOptions } from "./parts";
import { PaymentProviders } from "./providers";
import { SetupGuide } from "./setupGuide";
import { SiteMissing } from "./SiteMissing";

export function SiteSettingsPage() {
  const { id, site } = useSitePage();
  const { domains, primary } = useDomains();
  const can = useCan();
  // Which short domain the snippets name. Every short domain serves the script, so this only changes what's copied.
  const [host, setHost] = useState("");
  const origin = `https://${(domains.includes(host) ? host : primary) || window.location.host}`;
  useHashScroll(site.isSuccess);
  const s = site.data;

  return (
    <div className="ui-page sitepage-page">
      <PageHead
        id={id}
        name={s?.name ?? (site.isError ? "Website" : undefined)}
        title="Settings and setup"
        sub={s ? `Track ${s.domains[0]}, connect payments and choose how revenue is credited.` : "Install the script, connect payments and choose how revenue is credited."}
        tools={
          <>
            {s ? <TrackingToggle site={s} /> : null}
            <Button asChild variant="secondary">
              <Link to={sitePages.guide(id)}>
                <BookOpen aria-hidden />
                Guide
              </Link>
            </Button>
          </>
        }
      />
      {site.isPending ? (
        <SectionsSkeleton count={4} />
      ) : isNotFound(site.error) ? (
        <SiteMissing />
      ) : site.isError ? (
        <ErrorState what="This website’s settings" error={site.error} onRetry={() => void site.refetch()} retrying={site.isFetching} />
      ) : s ? (
        <>
          {!s.tracking ? (
            <Notice tone="warn" className="sitepage-notice" title="Tracking is paused.">
              Visits aren’t recorded and short links aren’t tagged. Payments are still recorded. The script can stay on your site.
            </Notice>
          ) : null}
          <InstallSection site={s} origin={origin} domains={domains} onDomain={setHost} />
          <PaymentProviders site={s} />
          <SetupGuide site={s} origin={origin} />
          <GeneralSection site={s} />
          <ApiSection site={s} origin={origin} />
          {can("revenue.view") ? <PrivacySection site={s} /> : null}
          <DeleteSection site={s} />
        </>
      ) : null}
    </div>
  );
}

const message = (e: unknown) => errorText(e) ?? "Something went wrong";

/** A titled group inside a section: an h3 and its content, no box. */
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="sitepage-group">
      <h3 className="sitepage-h3">{title}</h3>
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
  if (status.isError && !s) {
    return <ErrorState compact what="The install check" error={status.error} onRetry={() => void status.refetch()} retrying={status.isFetching} />;
  }
  if (!s) return null;
  return s.lastSeenAt ? (
    <Notice tone="good" title="Installed.">
      Latest visit {ago(s.lastSeenAt)}
      {s.hostname ? ` on ${s.hostname}` : ""}; {s.visits24h} visit{s.visits24h === 1 ? "" : "s"} in the last 24 hours.
    </Notice>
  ) : (
    <Notice title="Waiting for the first visit…">
      Open{" "}
      <a href={url} target="_blank" rel="noreferrer" className="ui-text-button">
        {site.domains[0]}
      </a>{" "}
      once the tag is live; this turns green within seconds. With <C>?sh_debug=1</C> the browser console says why a visit isn’t sent.
    </Notice>
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
    <div className="sitepage-tracking">
      <Switch id="site-tracking" checked={save.isPending ? !site.tracking : site.tracking} disabled={save.isPending} onCheckedChange={(v) => save.mutate(v)} label="Tracking" />
    </div>
  );
}

function InstallSection({ site, origin, domains, onDomain }: { site: SiteDTO; origin: string; domains: string[]; onDomain: (d: string) => void }) {
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
    <Section id="install" title="Install the script" sub="Paste it into the <head> of every page. It’s small, sets no cookies, and counts single-page-app navigation too.">
      <div className="sitepage-stack">
        {domains.length > 1 ? (
          <Select
            id="install-domain"
            className="sitepage-narrow"
            label="Load the script from"
            hint="Any of your short domains works, and short links on all of them are credited. Pick one you’ll keep: if it’s removed, the script stops loading."
            value={new URL(origin).hostname}
            onChange={(e) => onDomain(e.target.value)}
            options={domains.map((d) => ({ value: d, label: d }))}
          />
        ) : null}
        <Code label="script tag">{snippet}</Code>
        <InstallCheck site={site} />
        <Group title="Where it goes">
          <Select id="install-platform" className="sitepage-narrow" label="Platform" value={platform} onChange={(e) => setPlatform(e.target.value)} options={PLATFORMS.map((p) => ({ value: p.value, label: p.label }))} />
          <p className="sitepage-text">{guide.steps}</p>
          {guide.code ? <Code label={`${guide.label} example`}>{guide.code(origin, site.id)}</Code> : null}
        </Group>
        <Group title="Content Security Policy">
          <p className="sitepage-text">If your site sends a Content-Security-Policy header, the browser blocks the script and its requests until you allow this domain. Add it to these two directives, next to what’s already there:</p>
          <Code label="CSP directives">{csp}</Code>
          <p className="sitepage-note">No CSP header? Nothing to do. Serving the script through your own domain (below) is covered by 'self'.</p>
        </Group>
        <Group title="Goals and sign-ins">
          <Code label="goal example">{goals}</Code>
          <p className="sitepage-note">From the browser, identify() can only fill in an email that isn’t known yet. To set it for sure (for email matching), use the API below.</p>
        </Group>
        {site.idMode === "consent" ? (
          <Group title="Consent">
            <p className="sitepage-text">No banner yet? Add data-consent-banner and the script asks with a small Accept / Decline bar until the visitor chooses. data-consent-text="…" replaces its sentence.</p>
            <Code label="built-in banner">{banner}</Code>
            <p className="sitepage-text">Already have a consent banner? Report its answer instead:</p>
            <Code label="consent example">{consent}</Code>
            <p className="sitepage-note">Until consent, visits are counted cookieless. The answer is remembered in the browser, so call it again only when the visitor changes their mind.</p>
          </Group>
        ) : null}
        <Group title="Avoid ad blockers (optional)">
          <p className="sitepage-text">Some blockers stop third-party analytics. Serve the script through your own domain:</p>
          <Code label="proxied script tag">{proxied}</Code>
          <Code label="Next.js rewrites">{nextRewrites}</Code>
        </Group>
        <Group title="Your own visits">
          <div className="sitepage-row-wrap">
            <Button asChild>
              <a href={`https://${site.domains[0]}/?sh_ignore=1`} target="_blank" rel="noreferrer">
                <EyeOff aria-hidden />
                Stop counting this browser
                <span className="ui-sr"> (opens {site.domains[0]} in a new tab)</span>
              </a>
            </Button>
            <span className="sitepage-note">Opens {site.domains[0]} with ?sh_ignore=1 (a note confirms it). Do it once per browser and device; ?sh_ignore=0 counts it again.</span>
          </div>
        </Group>
        <p className="sitepage-note">Testing locally? Add a site with the domain localhost and the attribute data-allow-localhost.</p>
      </div>
    </Section>
  );
}

const ID_MODE_NOTE: Record<IdMode, string> = {
  cookieless:
    "Nothing is stored in the visitor's browser and no consent banner is needed. Visitors are counted per day, so a payment is linked to visits of the same day, or through the checkout reference. A short-link click on an earlier day isn't credited.",
  consent:
    "Cookieless until the visitor accepts, in the script's built-in banner or yours calling shorthop(\"consent\", true); from then on a random ID in localStorage recognises the visitor across days. Visitors who decline stay cookieless.",
  persistent:
    "A random ID in localStorage recognises a visitor across days, so a payment days later is credited to the visit that first brought them. In the EU this needs the visitor's consent; update your privacy notice.",
};

function GeneralSection({ site }: { site: SiteDTO }) {
  const qc = useQueryClient();
  const [form, setForm] = useState(site);
  useEffect(() => setForm(site), [site]);
  const [paths, setPaths] = useState(site.excludePaths.join("\n"));
  const set = <K extends keyof SiteDTO>(k: K, v: SiteDTO[K]) => setForm((f) => ({ ...f, [k]: v }));
  const zones = useMemo(() => zoneOptions([...new Set([form.timezone, ...timeZones()])]), [form.timezone]);
  const currencies = useMemo(() => currencyOptions(), []);
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
    <Section id="general" title="Site settings">
      <form onSubmit={submit} className="sitepage-form">
        <div className="sitepage-grid2">
          <Input id="gs-name" label="Name" value={form.name} onChange={(e) => set("name", e.target.value)} />
          <Input
            id="gs-domains"
            label="Domains"
            hint="Comma-separated. Subdomains are included."
            value={form.domains.join(", ")}
            onChange={(e) =>
              set(
                "domains",
                e.target.value
                  .split(",")
                  .map((d) => d.trim())
                  .filter(Boolean),
              )
            }
          />
          <ComboField id="gs-tz" label="Time zone" value={form.timezone} onChange={(v) => v && set("timezone", v)} options={zones} placeholder="Type a city or region…" />
          <ComboField
            id="gs-cur"
            label="Currency"
            hint="Changing it converts every recorded payment again. Currencies marked “no daily rate” only count payments made in that same currency."
            value={form.currency}
            onChange={(v) => v && set("currency", v)}
            options={currencies}
            placeholder="Type a code or name…"
          />
        </div>

        <fieldset className="sitepage-fieldset">
          <legend className="ui-field-label">Visitor identification</legend>
          <Segmented<IdMode>
            label="Visitor identification"
            value={form.idMode}
            onChange={(v) => set("idMode", v)}
            options={[
              { value: "cookieless", label: "Cookieless" },
              { value: "consent", label: "After consent", short: "Consent" },
              { value: "persistent", label: "Recognise returning visitors", short: "Returning" },
            ]}
          />
          <p className="ui-field-hint">{ID_MODE_NOTE[form.idMode]}</p>
          {form.idMode !== "cookieless" ? (
            <Checkbox id="gs-gpc" checked={form.respectGpc} onCheckedChange={(v) => set("respectGpc", v)} label="Respect Global Privacy Control and Do Not Track" description="Those visitors are counted cookieless." />
          ) : null}
        </fieldset>

        <div className="sitepage-grid2">
          <Select
            id="gs-model"
            label="Credit revenue to"
            hint={ATTRIBUTION_INFO[form.attributionModel].description}
            value={form.attributionModel}
            onChange={(e) => set("attributionModel", e.target.value as AttributionModel)}
            options={ATTRIBUTION_MODELS.map((m) => ({ value: m, label: ATTRIBUTION_INFO[m].label }))}
          />
          <Select
            id="gs-lookback"
            label="Lookback window"
            hint="Visits older than this before the payment aren’t credited."
            value={String(form.lookbackDays)}
            onChange={(e) => set("lookbackDays", Number(e.target.value))}
            options={[...new Set([form.lookbackDays, ...LOOKBACK_DAYS])].sort((a, b) => a - b).map((d) => ({ value: String(d), label: `${d} days` }))}
          />
        </div>

        <div className="sitepage-checks-list">
          <Checkbox
            id="gs-tag"
            checked={form.tagLinks}
            onCheckedChange={(v) => set("tagLinks", v)}
            label="Credit short links"
            description="Short links to this site carry a signed click token (?sh_c=), so visits and revenue are credited to the link. The script removes it from the address bar."
          />
          <Checkbox
            id="gs-notify"
            checked={form.notifyPayments}
            onCheckedChange={(v) => set("notifyPayments", v)}
            label="Email me about each payment"
            description="A short email to the weekly digest’s recipient with the amount and where the customer came from. Test payments and refunds don’t send one."
          />
          <Checkbox
            id="gs-spikes"
            checked={form.spikeAlerts}
            onCheckedChange={(v) => set("spikeAlerts", v)}
            label="Alert me about traffic spikes"
            description="Checked hourly: an email (and a site.traffic_spike webhook) when a source sends at least 4x its usual hourly visits, 20 or more."
          />
          <div className="sitepage-group">
            <Checkbox id="gs-daily" checked={form.dailyDigest} onCheckedChange={(v) => set("dailyDigest", v)} label="Daily summary email" description="Yesterday’s visitors, revenue, top sources and spikes, to the weekly digest’s recipient." />
            {form.dailyDigest ? (
              <Select
                id="gs-hour"
                className="sitepage-indent sitepage-hour"
                label="Send at"
                hint={`In the site’s time zone (${form.timezone}).`}
                value={String(form.digestHour)}
                onChange={(e) => set("digestHour", Number(e.target.value))}
                options={Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, "0")}:00` }))}
              />
            ) : null}
          </div>
          <Checkbox
            id="gs-server-emails"
            checked={form.serverEmailsOnly}
            onCheckedChange={(v) => set("serverEmailsOnly", v)}
            label="Trust only emails sent from my server"
            description="Match payments by email only to visitors your server identified (POST /api/sites/:id/identify). Emails the browser reports with identify still show on visitor profiles, but anyone can send one, so they no longer credit payments. Turn on once your server identifies signed-in customers."
          />
        </div>

        <Textarea id="gs-paths" className="sitepage-mono-field" label="Don’t record these paths" hint="One per line. * matches within a segment, ** anything: /admin/**" rows={3} value={paths} onChange={(e) => setPaths(e.target.value)} spellCheck={false} />

        <div className="sitepage-actions">
          <Button type="submit" variant="primary" loading={save.isPending}>
            Save settings
          </Button>
        </div>
      </form>
    </Section>
  );
}

function ApiSection({ site, origin }: { site: SiteDTO; origin: string }) {
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
    <Section
      id="api"
      title="Server API"
      sub={
        <>
          For billing without a native connection, and to identify customers from your server. Use a personal API key (
          <Link className="ui-text-button" to="/settings#api">
            Settings → API, MCP and webhooks
          </Link>
          ) with Manage websites.
        </>
      }
    >
      <div className="sitepage-stack">
        <Code label="API examples">{curl}</Code>
        <div>
          <Button icon={Bot} onClick={() => void copy(prompt, "Setup prompt copied")}>
            Copy setup prompt for an AI coding assistant
          </Button>
        </div>
      </div>
    </Section>
  );
}

type PersonKind = "email" | "visitorId" | "paymentId";
const PERSON_KINDS: { value: PersonKind; label: string }[] = [
  { value: "email", label: "Email" },
  { value: "visitorId", label: "Visitor ID" },
  { value: "paymentId", label: "Payment ID" },
];

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
function countsText(c: Partial<PrivacyCountsDTO>): string {
  return [plural(c.identities ?? 0, "identity", "identities"), plural(c.visits ?? 0, "visit"), plural(c.payments ?? 0, "payment"), plural(c.subscriptions ?? 0, "subscription")].join(", ");
}

/** Customer data retention, and requests from visitors and customers (access, export, erasure). */
function PrivacySection({ site }: { site: SiteDTO }) {
  const qc = useQueryClient();
  const requestsKey = keys.siteData(site.id, "privacy-requests", {});
  const requests = useQuery({ queryKey: requestsKey, queryFn: () => call(api.sites[":id"].privacy.requests.$get({ param: { id: site.id } })) });
  const [kind, setKind] = useState<PersonKind>("email");
  const [value, setValue] = useState("");
  const [found, setFound] = useState<{ who: Record<string, string>; counts: PrivacyCountsDTO } | null>(null);
  const [confirmErase, setConfirmErase] = useState(false);
  const who = { [kind]: value.trim() };

  const retention = useMutation({
    mutationFn: (months: number | null) => call(api.sites[":id"].$patch({ param: { id: site.id }, json: { customerRetentionMonths: months } })),
    onSuccess: (updated) => {
      qc.setQueryData(keys.site(site.id), updated);
      toast.success("Saved");
    },
    onError: (e) => toast.error(e.message),
  });
  const lookup = useMutation({
    mutationFn: () => call(api.sites[":id"].privacy.lookup.$post({ param: { id: site.id }, json: who })),
    onSuccess: (counts) => setFound({ who, counts }),
    onError: (e) => toast.error(e.message),
  });
  const exportJson = useMutation({
    mutationFn: (person: Record<string, string>) =>
      downloadFile(`/_admin/api/sites/${site.id}/privacy/export`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(person) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: requestsKey }),
    onError: (e) => toast.error(e.message),
  });
  const erase = useMutation({
    mutationFn: (person: Record<string, string>) => call(api.sites[":id"].privacy.erase.$post({ param: { id: site.id }, json: { ...person, confirm: true } })),
    onSuccess: (res) => {
      setConfirmErase(false);
      setFound(null);
      setValue("");
      void qc.invalidateQueries({ queryKey: ["sites", site.id] });
      toast.success("Erased", { description: res.warnings.join(" "), duration: 15_000 });
    },
    onError: (e) => toast.error(e.message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value.trim()) lookup.mutate();
  };
  const empty = found && !found.counts.identities && !found.counts.visits && !found.counts.payments && !found.counts.subscriptions;
  const kindLabel = PERSON_KINDS.find((k) => k.value === kind)!.label;

  return (
    <Section id="privacy" title="Privacy" sub="How long customer details are kept, and requests from your visitors and customers to see or delete their data.">
      <div className="sitepage-stack">
        <Select
          id="privacy-retention"
          className="sitepage-narrow"
          label="Customer data retention"
          hint="After this, payments lose the customer’s email, customer ID and visitor; amounts stay, so revenue reports still add up. Your payment provider remains the accounting record."
          value={site.customerRetentionMonths === null ? "" : String(site.customerRetentionMonths)}
          disabled={retention.isPending}
          onChange={(e) => retention.mutate(e.target.value ? Number(e.target.value) : null)}
          options={[{ value: "", label: "Keep until the site is deleted" }, ...CUSTOMER_RETENTION_MONTHS.map((m) => ({ value: String(m), label: plural(m / 12, "year") }))]}
        />

        <form onSubmit={submit} className="sitepage-group" aria-labelledby="privacy-find">
          <h3 className="sitepage-h3" id="privacy-find">Find a person</h3>
          <Segmented<PersonKind>
            label="Find by"
            value={kind}
            onChange={(k) => {
              setKind(k);
              setFound(null);
            }}
            options={PERSON_KINDS}
          />
          <div className="sitepage-inline-form">
            <Input
              id="privacy-value"
              label={kindLabel}
              hideLabel
              type={kind === "email" ? "email" : "text"}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setFound(null);
              }}
              placeholder={kind === "email" ? "customer@example.com" : kind === "visitorId" ? "From shorthop.visitor() or a visitor’s profile" : "Such as stripe:charge:pi_…"}
              autoComplete="off"
            />
            <Button type="submit" icon={Search} loading={lookup.isPending} disabled={!value.trim()}>
              Look up
            </Button>
          </div>
          {found ? (
            <div className="sitepage-found" role="status">
              <p>{empty ? "Nothing recorded for them on this site." : `Found ${countsText(found.counts)}${found.counts.activeSubscriptions ? ` (${found.counts.activeSubscriptions} active)` : ""}.`}</p>
              {empty ? null : (
                <div className="sitepage-row-wrap">
                  <Button icon={Download} onClick={() => exportJson.mutate(found.who)} loading={exportJson.isPending}>
                    Export JSON
                  </Button>
                  <Button variant="danger" icon={Trash2} loading={erase.isPending} onClick={() => setConfirmErase(true)}>
                    Erase
                  </Button>
                </div>
              )}
            </div>
          ) : null}
          <p className="sitepage-note">The export has everything stored here. Single page views stay in Cloudflare Analytics Engine, without a name, for about 90 days.</p>
        </form>
        <Dialog
          open={confirmErase && Boolean(found)}
          onOpenChange={setConfirmErase}
          size="sm"
          title={found ? `Erase ${countsText(found.counts)}?` : "Erase?"}
          description="Their visits and identity are deleted, and their payments keep only the amount and date. This can’t be undone."
          footer={
            <>
              <Button onClick={() => setConfirmErase(false)}>Cancel</Button>
              <Button variant="danger" loading={erase.isPending} onClick={() => found && erase.mutate(found.who)}>
                Erase
              </Button>
            </>
          }
        />

        {requests.isError ? (
          <ErrorState compact what="Recent requests" error={requests.error} onRetry={() => void requests.refetch()} retrying={requests.isFetching} />
        ) : requests.data?.requests.length ? (
          <div className="sitepage-group">
            <h3 className="sitepage-h3">Recent requests</h3>
            <ul className="sitepage-rows">
              {requests.data.requests.slice(0, 10).map((r) => (
                <li key={r.id}>
                  <span>
                    {r.kind === "erase" ? "Erased" : "Exported"} {countsText(r.counts)}
                  </span>
                  <span className="sitepage-note">
                    {r.by} · {ago(r.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Section>
  );
}

function DeleteSection({ site }: { site: SiteDTO }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () => call(api.sites[":id"].$delete({ param: { id: site.id } })),
    onError: (e) => toast.error(`${site.name} wasn’t deleted: ${message(e)}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.sites });
      toast.success(`${site.name} deleted`);
      navigate("/sites?list");
    },
  });
  return (
    <Section id="delete" title="Delete this website" sub="Removes the site with every visit, payment and connection recorded for it. Analytics Engine events expire on their own after 90 days.">
      <div>
        <Button variant="danger" icon={Trash2} onClick={() => setConfirming(true)}>
          Delete website
        </Button>
      </div>
      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        size="sm"
        title={`Delete ${site.name} and all its data?`}
        description="Every visit, payment and connection recorded for it is removed. This can’t be undone."
        footer={
          <>
            <Button onClick={() => setConfirming(false)}>Cancel</Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
              Delete website
            </Button>
          </>
        }
      />
    </Section>
  );
}
