// The Advanced tracking guide (/tracking-guide): what each setting records,
// what to do before switching it on, how to read the click log, email opens,
// people's requests about their data, what not to use it for, the workspace's
// rules and the limits of the data. Linked from the tracking dialog, the
// click log and Settings → Access & security. Look: sitepages.css (the
// website guide's layout), docs.css.

import type { ReactNode } from "react";
import { Link } from "react-router";
import type { TrackingRetention } from "../../../shared/tracking";
import { useMe } from "../../lib/me";
import { useTrackingPolicy } from "../link/Tracking";
import { C, useHashScroll } from "../sitepages/parts";
import { Badge, Notice, Section, Table, TD, TH } from "../ui";

const TOC = [
  { id: "what", label: "What it is" },
  { id: "modes", label: "What each setting records" },
  { id: "before", label: "Before you switch it on" },
  { id: "setup", label: "Set it up for a link" },
  { id: "reading", label: "Reading the click log" },
  { id: "opens", label: "Email opens" },
  { id: "requests", label: "When someone asks about their data" },
  { id: "dont", label: "What not to use it for" },
  { id: "rules", label: "This workspace’s rules" },
  { id: "limits", label: "Accuracy and limits" },
];

const RETENTION_LABEL: Record<TrackingRetention, string> = { 7: "7 days", 30: "30 days", 90: "90 days", 365: "1 year" };

function Yes({ children = "Yes" }: { children?: ReactNode }) {
  return <Badge tone="good">{children}</Badge>;
}
function No({ children = "No" }: { children?: ReactNode }) {
  return <span className="ui-ld-quiet">{children}</span>;
}

export function TrackingGuidePage() {
  const me = useMe();
  useHashScroll(Boolean(me.data));
  return (
    <div className="ui-page sitepage-page">
      <header className="ui-head">
        <div className="ui-head-main">
          <h1 className="ui-h1">Advanced tracking guide</h1>
          <p className="ui-head-sub">For everyone who switches on a link’s click log: what it records, how to use it lawfully and how to read what it shows. Not legal advice: when in doubt, ask whoever handles data protection for you.</p>
        </div>
      </header>
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
          <What />
          <Modes />
          <Before />
          <Setup />
          <Reading />
          <Opens />
          <Requests />
          <Dont />
          <Rules />
          <Limits />
        </div>
      </div>
    </div>
  );
}

function What() {
  return (
    <Section id="what" title="What it is" sub="A log of each click on one link, with every detail the request carries. Off for every link until someone switches it on.">
      <div className="sitepage-prose">
        <p>
          Ordinary statistics count clicks and group them (countries, devices, sources) without keeping individual visits or IP addresses. Advanced tracking keeps each click on its own for a while, so you can see that a particular link was opened, when, roughly from where and on what. That is useful when a link went to few people: an offer to one candidate, a proposal to one client, a document shared with a team. It also helps to look into abuse of a link.
        </p>
        <p>Everything comes from Cloudflare (which already handles every request) and, if you allow it, from the visitor’s browser. No other company is asked about anyone.</p>
        <p>Because it is about individual visits, it is personal data under the GDPR even without IP addresses. Use it on purpose, for a reason you could explain to the person on the other end.</p>
      </div>
    </Section>
  );
}

function Modes() {
  return (
    <Section id="modes" title="What each setting records">
      <div className="sitepage-prose">
        <Table label="What is recorded with each setting" dense>
          <thead>
            <tr>
              <TH>Data</TH>
              <TH>Without IP</TH>
              <TH>With IP addresses</TH>
            </tr>
          </thead>
          <tbody>
            <tr>
              <TD>Exact time, link, source (LinkedIn, QR, a ?s= tag), the full address of the page the click came from</TD>
              <TD><Yes /></TD>
              <TD><Yes /></TD>
            </tr>
            <tr>
              <TD>City, region, postal code, the city’s coordinates, time zone (worked out by Cloudflare from the IP)</TD>
              <TD><Yes /></TD>
              <TD><Yes /></TD>
            </tr>
            <tr>
              <TD>Network operator and its number (ASN), signals for Tor, VPN providers, hosting networks and relays</TD>
              <TD><Yes /></TD>
              <TD><Yes /></TD>
            </tr>
            <tr>
              <TD>The network’s name for the address (reverse DNS)</TD>
              <TD><Yes>Domain only</Yes></TD>
              <TD><Yes>Whole name</Yes></TD>
            </tr>
            <tr>
              <TD>Device, model, system and browser with versions, languages, the full browser identification</TD>
              <TD><Yes /></TD>
              <TD><Yes /></TD>
            </tr>
            <tr>
              <TD>Repeat visits: the same browser on the same network gets the same number (V1, V2…)</TD>
              <TD><Yes /></TD>
              <TD><Yes /></TD>
            </tr>
            <tr>
              <TD>The IP address (encrypted; visible only with the See IP addresses permission)</TD>
              <TD><No /></TD>
              <TD><Yes /></TD>
            </tr>
          </tbody>
        </Table>
        <h3 className="sitepage-h3">Options on top of either mode</h3>
        <ul>
          <li>
            <strong>Browser details</strong>: people see a page for a fraction of a second that reads screen and window size, the browser’s time zone, languages, processor cores, memory, touch support, connection type, colour scheme and Do Not Track / Global Privacy Control, then goes on. A browser clock that disagrees with the IP’s time zone is shown as a VPN hint.
          </li>
          <li>
            <strong>Email-open pixel</strong>: an invisible image for your emails; each time it loads, an “open” is logged with the same details as a click.
          </li>
          <li>
            <strong>Email me</strong>: on the first click (and first open) by a person, or on every one, at most every 10 minutes.
          </li>
        </ul>
        <p>
          Never recorded, on purpose: anything that tricks the browser into revealing more (WebRTC address leaks, GPS prompts), and device fingerprints (canvas, WebGL, audio). Bots, link previews and email scanners are logged as bots, never as people.
        </p>
      </div>
    </Section>
  );
}

function Before() {
  return (
    <Section id="before" title="Before you switch it on" sub="A short checklist. The GDPR asks you to be able to show you thought about each point.">
      <div className="sitepage-prose">
        <ol>
          <li>
            <strong>Know your purpose and write it down.</strong> The Purpose field is there for that (this workspace may require it). “To see whether the candidate opened my offer, so I know when to follow up” is a purpose; “just in case” is not.
          </li>
          <li>
            <strong>Pick a legal basis.</strong> Usually legitimate interest (GDPR Art. 6(1)(f)): your interest has to be real, the tracking necessary for it, and it mustn’t outweigh the person’s interests. Write that weighing down once (a short legitimate-interest assessment). Otherwise, ask for consent.
          </li>
          <li>
            <strong>Take the least you need.</strong> Choose Without IP unless you really need the address (for example to investigate abuse). Choose the shortest retention that does the job. Leave browser details and the pixel off unless your purpose needs them.
          </li>
          <li>
            <strong>Tell people.</strong> Your privacy notice has to say that some links keep a detailed record of each visit, what it holds (the table above), how long, and who to ask about it. Shorthop’s <a href="https://github.com/jntegz/shorthop/blob/main/docs/PRIVACY.md#advanced-tracking" target="_blank" rel="noreferrer">privacy guide</a> has wording to start from. Link to the notice where you share tracked links (an email signature works).
          </li>
          <li>
            <strong>Consent for the pixel and browser details.</strong> Reading information from someone’s device, which both do, generally needs their consent in the EU (ePrivacy Directive Art. 5(3)), whatever your basis for the rest.
          </li>
          <li>
            <strong>Be ready to answer requests</strong> (below), within a month.
          </li>
        </ol>
        <Notice tone="warn" title="Recording IP addresses">
          An IP address is personal data and can often be tied to a household or a company. Record it only with a reason you’ve written down, keep it as short as you can, and remember that whoever has See IP addresses can read it. An admin has to allow it for the workspace first.
        </Notice>
      </div>
    </Section>
  );
}

function Setup() {
  return (
    <Section id="setup" title="Set it up for a link">
      <div className="sitepage-prose">
        <ol>
          <li>For a new link, open Advanced tracking in Create a new link. For an existing one, open the link’s page and choose More → Advanced tracking… (or Set up advanced tracking in its Click log section).</li>
          <li>Choose Without IP, or With IP addresses where allowed. IP mode asks you to accept a GDPR warning once per link.</li>
          <li>Write the purpose, choose how long to keep clicks, and switch on browser details, the pixel and emails only if you need them.</li>
          <li>Save. The next click appears in the Click log within seconds; the log refreshes every 30 seconds while the page is open.</li>
          <li>When you no longer need it, switch tracking off, and delete the log if you don’t need what it holds (Click log → ⋯ → Delete the click log). Otherwise each click is deleted when its retention ends.</li>
        </ol>
        <p>
          To use it from a script or an AI assistant: <C>PUT /api/links/:domain/:slug/tracking</C> and <C>GET /api/links/:domain/:slug/clicks</C> (see the <Link to="/api-docs">API reference</Link>). The assistant tool never returns IP addresses.
        </p>
      </div>
    </Section>
  );
}

function Reading() {
  return (
    <Section id="reading" title="Reading the click log">
      <div className="sitepage-prose">
        <ul>
          <li>
            <strong>People, Opens, Bots</strong>: filter what you see. A bot is anything automated: LinkedIn’s or Slack’s preview, an email security scanner opening links before the recipient does, a search engine, a script. A click a few seconds after you sent an email, from Microsoft or Google’s network, is usually a scanner, not the person.
          </li>
          <li>
            <strong>Visitor numbers</strong> (V1, V2…): the same browser on the same network. ×3 means three visits. A new phone, another browser or another Wi-Fi is a new number, so one person can have several.
          </li>
          <li>
            <strong>VPN: name</strong>: the network belongs to a VPN provider on a public list. <strong>Hosting network</strong>: a datacenter, often a VPN, a proxy or a bot. <strong>VPN?</strong>: the browser’s clock disagrees with where the IP is. <strong>Tor</strong>: the Tor network. <strong>Relay</strong>: iCloud Private Relay or Cloudflare WARP, used by many ordinary iPhone and Mac users. In each case the location is the network’s, not the person’s.
          </li>
          <li>
            <strong>Location</strong> is where the network says the address is: usually the right city, sometimes the operator’s hub. Mobile networks may show a city far away. It is never a street address.
          </li>
          <li>
            <strong>Map</strong> shows the same clicks on a globe; the list beside it, the places.
          </li>
          <li>Each click opens to show every detail, and can be deleted on its own. Export CSV gives you all of them.</li>
        </ul>
      </div>
    </Section>
  );
}

function Opens() {
  return (
    <Section id="opens" title="Email opens" sub="Switch on the pixel for the link, then copy it from the Click log into your email’s HTML.">
      <div className="sitepage-prose">
        <ul>
          <li>An open is logged when the email is displayed with images. Many people block images; then nothing is logged even though they read it.</li>
          <li>Gmail and Yahoo load images through their own servers: you get the time, but the place and device are Google’s or Yahoo’s (shown as “via Gmail”). Gmail may also keep a copy, so later opens aren’t always logged.</li>
          <li>Apple Mail’s privacy protection loads images in advance, when the email arrives: an open from Apple doesn’t prove anyone read it.</li>
          <li>Outlook and other mail programs load the image themselves, so their opens show the reader’s network.</li>
          <li>The pixel is public: if it’s put on a web page, those loads are logged as bots (“Embedded on …”), not as opens.</li>
          <li>In the EU you generally need the recipient’s consent for a tracking pixel. Don’t put it in emails to people who haven’t agreed to it.</li>
        </ul>
      </div>
    </Section>
  );
}

function Requests() {
  return (
    <Section id="requests" title="When someone asks about their data" sub="People may ask what you hold about them, or ask you to delete it. Answer within a month (GDPR Art. 12(3)).">
      <div className="sitepage-prose">
        <ul>
          <li>
            <strong>With their IP address</strong> (they can find it on any “what is my IP” page): <C>POST /api/clicks/by-ip</C> lists their clicks on every tracked link, and <C>POST /api/clicks/by-ip/erase</C> deletes them. Both need the See IP addresses permission and only find links in IP mode.
          </li>
          <li>
            <strong>Without it</strong>: look in the link’s click log by time, place and device, and delete the matching clicks one by one, or the whole log.
          </li>
          <li>Visits aren’t tied to a name, so you may not be able to tell which are theirs. You can say so; you don’t have to collect more to find out.</li>
          <li>To object to tracking in future, switch tracking off for the links they get from you.</li>
        </ul>
      </div>
    </Section>
  );
}

function Dont() {
  return (
    <Section id="dont" title="What not to use it for">
      <div className="sitepage-prose">
        <ul>
          <li>Finding out where someone lives or is, or who is behind an anonymous account.</li>
          <li>Following a person’s movements over time, or watching an employee, a partner or anyone else without their knowledge.</li>
          <li>Combining the log with other data to identify people who didn’t expect it.</li>
          <li>Sending tracked links or pixels under a false pretext to get someone to reveal their location.</li>
        </ul>
        <p>Besides breaking the GDPR, that can be stalking or harassment under criminal law. Admins can turn the feature off for the whole workspace at any time.</p>
      </div>
    </Section>
  );
}

function Rules() {
  const q = useTrackingPolicy();
  const me = useMe().data;
  const p = q.data?.policy;
  return (
    <Section id="rules" title="This workspace’s rules" sub="Set by admins in Settings → Access & security. They apply to every click as it’s recorded.">
      <div className="sitepage-prose">
        {p ? (
          <ul>
            <li>Advanced tracking: {p.enabled ? "allowed" : "turned off"}</li>
            <li>IP addresses: {p.allowIp ? "allowed, for people with See IP addresses" : "not allowed"}</li>
            <li>Browser details: {p.allowBrowser ? "allowed" : "not allowed"}</li>
            <li>Email-open pixel: {p.allowPixel ? "allowed" : "not allowed"}</li>
            <li>Longest retention: {RETENTION_LABEL[p.maxRetentionDays]}</li>
            <li>Purpose: {p.requirePurpose ? "required" : "optional"}</li>
          </ul>
        ) : (
          <p>Loading the rules…</p>
        )}
        {me?.role === "admin" ? (
          <p>
            Change them in <Link to="/settings#tracking-rules">Settings → Access & security</Link>.
          </p>
        ) : null}
      </div>
    </Section>
  );
}

function Limits() {
  return (
    <Section id="limits" title="Accuracy and limits">
      <div className="sitepage-prose">
        <ul>
          <li>VPN and proxy detection are hints. A VPN that isn’t on the public list looks like an ordinary network; an office network may look like hosting.</li>
          <li>Several people behind one office or mobile network can share an address and a visitor number.</li>
          <li>Retention is counted per click from when it happened. A tightened workspace rule shortens what is already stored.</li>
          <li>Ordinary statistics (counts, countries, sources) keep working whether tracking is on or off.</li>
        </ul>
      </div>
    </Section>
  );
}
