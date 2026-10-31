// A website's guide (/sites/:id/guide): how to install, check,
// set goals, credit short links, connect payments, identify customers and
// choose a privacy mode, with this site's own snippets. Anchors: #install,
// #check, #goals, #links, #payments, #customers, #visitors (the dashboard's
// Goals section links to #goals). Look: sitepages.css.

import { Settings2 } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { PROVIDER_INFO, PROVIDERS, type SiteDTO } from "../../../shared/sites";
import { useDomains } from "../../lib/links";
import { useCan } from "../../lib/me";
import { Button, ErrorState, Section } from "../ui";
import { sitePages } from "../sites/common";
import { C, Code, isNotFound, PageHead, SectionsSkeleton, useHashScroll, useSitePage } from "./parts";
import { SiteMissing } from "./SiteMissing";

const TOC = [
  { id: "install", label: "Install the script" },
  { id: "check", label: "Check it works" },
  { id: "goals", label: "Goals" },
  { id: "links", label: "Short links" },
  { id: "payments", label: "Payments" },
  { id: "customers", label: "Customers" },
  { id: "visitors", label: "Visitors and privacy" },
];

/** How to set up and use one tracked website, with its own snippets filled in. */
export function SiteGuidePage() {
  const { id, site } = useSitePage();
  const can = useCan();
  const manage = can("sites.manage");
  const { primary } = useDomains();
  const origin = `https://${primary || window.location.host}`;
  useHashScroll(site.isSuccess);
  const s = site.data;

  const settings: ReactNode = manage ? <Link className="ui-text-button" to={sitePages.settings(id)}>Settings and setup</Link> : "Settings and setup";

  return (
    <div className="ui-page sitepage-page">
      <PageHead
        id={id}
        name={s?.name ?? (site.isError ? "Website" : undefined)}
        title="Guide"
        sub={
          s
            ? `How to track ${s.domains[0]}: install, goals, short links, payments and customers. The examples are filled in for this site.`
            : "How to install the script, set goals, connect payments and identify customers."
        }
        tools={
          manage ? (
            <Button asChild variant="secondary">
              <Link to={sitePages.settings(id)}>
                <Settings2 aria-hidden />
                Settings and setup
              </Link>
            </Button>
          ) : null
        }
      />
      {site.isPending ? (
        <SectionsSkeleton />
      ) : isNotFound(site.error) ? (
        <SiteMissing />
      ) : site.isError ? (
        <ErrorState what="This website’s guide" error={site.error} onRetry={() => void site.refetch()} retrying={site.isFetching} />
      ) : s ? (
        <div className="sitepage-withtoc">
          <nav aria-label="On this page" className="sitepage-toc">
            <ul>
              {TOC.map((t) => (
                <li key={t.id}>
                  <a href={`#${t.id}`}>{t.label}</a>
                </li>
              ))}
            </ul>
          </nav>
          <div className="sitepage-doc">
            <Install site={s} origin={origin} settings={settings} />
            <Check site={s} />
            <Goals />
            <ShortLinks site={s} settings={settings} />
            <Payments settings={settings} />
            <Customers />
            <Visitors site={s} settings={settings} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Install({ site, origin, settings }: { site: SiteDTO; origin: string; settings: ReactNode }) {
  return (
    <Section id="install" title="Install the script" sub="One tag in the <head> of every page. It’s small, sets no cookies, and counts single-page-app navigation on its own.">
      <div className="sitepage-prose">
        <Code label="script tag">{`<script defer src="${origin}/_t/script.js" data-site="${site.id}"></script>`}</Code>
        <p>Every page you want counted needs it, including landing pages and the page people return to after paying. Step-by-step instructions for WordPress, Webflow, Shopify, Next.js and others are in {settings}.</p>
        <h3 className="sitepage-h3">If your site has a Content Security Policy</h3>
        <p>A <C>Content-Security-Policy</C> header blocks the script without any visible error. Add your short domain to these two directives:</p>
        <Code label="CSP directives">{`script-src 'self' ${origin}; connect-src 'self' ${origin}`}</Code>
        <h3 className="sitepage-h3">Ad blockers</h3>
        <p>Some blockers stop analytics loaded from another domain. To avoid that, serve the script through {site.domains[0]} itself; the rewrite rules are in {settings}.</p>
      </div>
    </Section>
  );
}

function Check({ site }: { site: SiteDTO }) {
  return (
    <Section id="check" title="Check it works">
      <div className="sitepage-prose">
        <ol>
          <li>Open {site.domains[0]} in a normal browser window once the tag is live.</li>
          <li>The install check in Settings and setup turns green within seconds, and the visit appears on the dashboard.</li>
          <li>
            Nothing arriving? Open the site with <C>?sh_debug=1</C> added to the address. The browser console says if the script turned itself off, for example because <C>data-site</C> is missing. If it didn’t, look for the <C>/_t/e</C> request in the Network tab: blocked means a CSP or an ad blocker, and 403 means the page isn’t on {site.domains.join(" or ")}.
          </li>
        </ol>
        <p>Visits from localhost aren’t counted unless the tag has <C>data-allow-localhost</C>. To leave out your own visits, use “Stop counting this browser” in Settings and setup.</p>
      </div>
    </Section>
  );
}

function Goals() {
  return (
    <Section id="goals" title="Goals" sub="The actions that matter on your site: a signup, a demo request, a pricing page seen. They’re set in your site’s HTML or code, not here; each one appears on the dashboard the first time it happens.">
      <div className="sitepage-prose">
        <h3 className="sitepage-h3">When someone clicks</h3>
        <p>Add <C>data-sh-goal</C> to a button or link. Extra <C>data-sh-goal-*</C> attributes become properties of the goal.</p>
        <Code label="click goal">{`<button data-sh-goal="signup">Start free trial</button>

<a href="/demo" data-sh-goal="demo_request" data-sh-goal-plan="pro">Book a demo</a>`}</Code>
        <h3 className="sitepage-h3">When something scrolls into view</h3>
        <p>Add <C>data-sh-scroll</C>. It fires once, when half of the element is visible. Change that with <C>-threshold</C> (0 to 1) and require it to stay visible with <C>-delay</C> (milliseconds).</p>
        <Code label="scroll goal">{`<section data-sh-scroll="pricing_seen">…</section>

<section data-sh-scroll="testimonials_read" data-sh-scroll-threshold="0.8" data-sh-scroll-delay="2000">…</section>`}</Code>
        <h3 className="sitepage-h3">From your code</h3>
        <p>For anything else, such as a form that submitted successfully, call <C>shorthop("goal", …)</C>. The first line makes calls safe even before the script has loaded.</p>
        <Code label="goal from code">{`window.shorthop = window.shorthop || function () { (shorthop.q = shorthop.q || []).push(arguments); };

form.addEventListener("submit", () => shorthop("goal", "newsletter", { list: "weekly" }));`}</Code>
        <h3 className="sitepage-h3">Names and properties</h3>
        <ul>
          <li>Use short, stable names like <C>signup</C> or <C>demo_request</C>. Names are cut at 64 characters.</li>
          <li>Up to 10 properties per goal. Property names use letters, digits, <C>_</C> and <C>-</C>; values are cut at 60 characters.</li>
          <li>Don’t put emails or other personal data in goal names or properties. To link a visitor to a customer, use identify (below).</li>
        </ul>
        <p>Goals show in the dashboard’s Goals section, with conversion rates, and can be steps in a funnel. Clicks on checkout links and on links to other sites are recorded on their own; they need no goal.</p>
      </div>
    </Section>
  );
}

function ShortLinks({ site, settings }: { site: SiteDTO; settings: ReactNode }) {
  return (
    <Section id="links" title="Short links" sub={`Short links that point to ${site.domains[0]} are credited automatically, on every short domain. There’s nothing to add to the links.`}>
      <div className="sitepage-prose">
        <p>When someone clicks one, the redirect adds a signed <C>sh_c</C> parameter. The script reads it on the first page, removes it from the address bar, and credits the visit, and any payment it leads to, to that link. The parameter is valid for 7 days after the click.</p>
        <p>
          Each link’s page shows the visits and revenue it brought. To stop crediting short links for this site, turn off “Credit short links” in {settings}.{site.tagLinks ? "" : " It’s off for this site right now."}
        </p>
      </div>
    </Section>
  );
}

function Payments({ settings }: { settings: ReactNode }) {
  return (
    <Section id="payments" title="Payments" sub={`Connect your payment provider in Settings and setup. Supported: ${PROVIDERS.map((p) => PROVIDER_INFO[p].label).join(", ")}.`}>
      <div className="sitepage-prose">
        <p>Each provider has its own step-by-step guide and a “Check connection” button in {settings}. Once connected, each payment arrives through the provider’s webhook and is matched to the visit that led to it.</p>
        <h3 className="sitepage-h3">Hosted checkout links</h3>
        <p>Stripe Payment Links, Lemon Squeezy, Dodo, Creem and Gumroad links on your pages, and Paddle.js and FastSpring checkouts, are tagged by the script automatically. Nothing to change.</p>
        <h3 className="sitepage-h3">Checkouts your server creates</h3>
        <p>Read the visit reference in the browser with <C>shorthop.ref()</C>, send it to your server, and put it in the checkout’s metadata. Settings and setup shows the exact field for each provider.</p>
        <Code label="checkout example">{`const res = await fetch("/api/checkout", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ plan: "pro", ref: window.shorthop?.ref() }),
});`}</Code>
        <h3 className="sitepage-h3">The page after payment</h3>
        <p>Let the return URL carry the provider’s id, for example Stripe’s <C>?session_id={"{CHECKOUT_SESSION_ID}"}</C>. The script reports it, which matches payments the reference couldn’t.</p>
      </div>
    </Section>
  );
}

function Customers() {
  return (
    <Section id="customers" title="Customers" sub="Tell the script who a visitor is after they sign in, so payments can also be matched by email and a customer’s visits stay together.">
      <div className="sitepage-prose">
        <Code label="identify">{`shorthop("identify", { email: user.email, id: user.id, name: user.name });`}</Code>
        <p>From the browser this only fills in an email that isn’t known yet. To set it for sure, send it from your server with the API in Settings and setup.</p>
      </div>
    </Section>
  );
}

function Visitors({ site, settings }: { site: SiteDTO; settings: ReactNode }) {
  const mode = site.idMode === "cookieless" ? "Cookieless" : site.idMode === "consent" ? "After consent" : "Recognise returning visitors";
  return (
    <Section id="visitors" title="Visitors and privacy" sub={`This site is set to “${mode}”. Change it under Visitor identification in Settings and setup.`}>
      <div className="sitepage-prose">
        <ul>
          <li>
            <strong>Cookieless:</strong> nothing is stored in the browser and no consent banner is needed. A visitor is only recognised within one day, so a payment is credited to a visit of the same day, or through the checkout reference. A short-link click on an earlier day isn’t credited.
          </li>
          <li>
            <strong>Recognise returning visitors:</strong> one random ID in localStorage (not a cookie) recognises the visitor across days, so a payment is credited to the visit that brought them, within the lookback window ({site.lookbackDays} days). Safari removes it after 7 days without a visit. In the EU this needs consent.
          </li>
          <li>
            <strong>After consent:</strong> cookieless until your consent banner calls <C>shorthop("consent", true)</C>, then like the option above.
          </li>
        </ul>
        <p>
          No consent banner of your own? Add <C>data-consent-banner</C> to the script tag and it asks with a small Accept / Decline bar (<C>data-consent-text="…"</C> changes the sentence). The choice is remembered, and a “Cookie settings” link calling <C>shorthop("consent-settings")</C> shows the bar again so visitors can change it. Visitors can also see or clear what’s kept, <C>sh_consent</C> and <C>sh_vid</C>, in their browser’s site data for your domain.
        </p>
        <p>Visitors who send Global Privacy Control or Do Not Track are counted cookieless when “Respect Global Privacy Control” is on in {settings}.</p>
        <p>
          Every mode records the same about a visit: the pages, where it came from, approximate location (country, region, city, continent and time zone) and the network’s operator as Cloudflare reports them, device, browser, language, screen size class, reading time, scroll depth and page speed. No IP address is stored. Mention these in your site’s privacy notice.
        </p>
      </div>
    </Section>
  );
}
