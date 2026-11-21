// Advanced tracking on the link page: the click log (each click with every
// detail the Worker recorded) and the dialog that switches it on. IP
// addresses appear only for people with "See IP addresses", and recording
// them needs the GDPR warning accepted first (src/shared/tracking.ts).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Copy, Download, Ellipsis, Radar, Settings2, Trash2 } from "lucide-react";
import { Fragment, lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import {
  BROWSER_DETAILS_WARNING,
  DEFAULT_TRACKING_RETENTION,
  IP_TRACKING_WARNING,
  pixelTag,
  PURPOSE_MAX,
  PURPOSE_MIN,
  TRACKING_RETENTION_DAYS,
  type TrackedClickDTO,
  type TrackingMode,
  type TrackingNotify,
  type TrackingRetention,
} from "../../../shared/tracking";
import type { LinkDTO } from "../../../shared/types";
import { api, call, downloadFile, keys } from "../../api";
import { countryName, date, num, sourceLabel, when, whenFull } from "../../lib/format";
import { useCan } from "../../lib/me";
import { copy } from "../../lib/utils";
import { RowsSkeleton } from "../parts";

// The globe (cobe) loads only when the map is shown.
const ClickMap = lazy(() => import("./ClickMap"));
import { Badge, Button, Checkbox, Dialog, ErrorState, errorText, IconButton, Menu, Notice, Section, Segmented, Select, Switch, Table, TD, TH, Textarea, type MenuItem } from "../ui";

const PAGE = 100;
const MAX = 500;
type EventFilter = "all" | "click" | "open" | "bot";
type View = "list" | "map";

export const clicksKey = (domain: string, slug: string) => [...keys.link(domain, slug), "clicks"] as const;

function useClicks(link: LinkDTO, event: EventFilter, limit: number, enabled: boolean) {
  const { domain, slug } = link;
  return useQuery({
    queryKey: [...clicksKey(domain, slug), event, limit],
    queryFn: () => call(api.links[":domain"][":slug"].clicks.$get({ param: { domain, slug }, query: { event, limit: String(limit) } })),
    enabled,
    // A tracked link is usually watched for one person's click: refresh while the page is open.
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  });
}

const RETENTION_LABEL: Record<TrackingRetention, string> = { 7: "7 days", 30: "30 days", 90: "90 days", 365: "1 year" };

function modeText(link: LinkDTO): string {
  const t = link.tracking;
  if (!t) return "Off";
  return `${t.mode === "ip" ? "With IP addresses" : "Without IP addresses"}${t.browser ? ", browser details" : ""}, kept ${RETENTION_LABEL[t.retentionDays]}`;
}

/** The fact line on the link page ("Settings as facts"). */
export function trackingFact(link: LinkDTO): ReactNode {
  return link.tracking ? modeText(link) : <span className="ui-ld-fact-quiet">Off</span>;
}

// ---- The click log ----

function Flags({ k }: { k: TrackedClickDTO }) {
  const out: ReactNode[] = [];
  if (k.event === "bot") out.push(<Badge key="bot" tone="warn">{k.botName || "Bot"}</Badge>);
  if (k.event === "open") out.push(<Badge key="open" tone="good">{k.botName ? `Email opened via ${k.botName.replace(/ image proxy$/, "")}` : "Email opened"}</Badge>);
  if (k.flags.tor) out.push(<Badge key="tor" tone="danger">Tor</Badge>);
  if (k.flags.knownVpn) out.push(<Badge key="kv" tone="danger">{`VPN: ${k.flags.knownVpn.replace(/^.*\(([^)]+)\)\s*$/, "$1").slice(0, 32)}`}</Badge>);
  else if (k.flags.datacenter) out.push(<Badge key="dc" tone="warn">Hosting network</Badge>);
  else if (k.flags.vpnSuspected) out.push(<Badge key="vpn" tone="warn">VPN?</Badge>);
  if (k.flags.privateRelay) out.push(<Badge key="relay">Relay</Badge>);
  return out.length ? <span className="ui-tk-flags">{out}</span> : null;
}

function place(k: TrackedClickDTO): string {
  return [k.city, k.region && k.region !== k.city ? k.region : "", countryName(k.country)].filter(Boolean).join(", ");
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  if (children === "" || children === null || children === undefined) return null;
  return (
    <div className="ui-tk-detail">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const joined = (...parts: (string | number | null | undefined)[]) => parts.filter((p) => p !== "" && p !== null && p !== undefined).join(" · ");

function ClickDetails({ k, canSeeIp }: { k: TrackedClickDTO; canSeeIp: boolean }) {
  const d = k.details;
  return (
    <dl className="ui-tk-details">
      <Detail label="Time">{whenFull(k.at)} ({new Date(k.at * 1000).toISOString().replace("T", " ").slice(0, 19)} UTC)</Detail>
      <Detail label="IP address">{k.ip ?? (k.hasIp ? (canSeeIp ? "Can't be decrypted (the encryption key changed)" : "Recorded; needs See IP addresses") : "Not recorded")}</Detail>
      <Detail label="Visitor">{`${k.visitor}, ${k.visitorVisits === 1 ? "one visit" : `${k.visitorVisits} visits`} (same browser and network)`}</Detail>
      <Detail label="Location">{joined(k.city, k.postalCode, k.region, countryName(k.country), k.continent)}</Detail>
      <Detail label="Coordinates">{k.latitude !== null && k.longitude !== null ? `${k.latitude}, ${k.longitude} (city level, from the IP)` : ""}</Detail>
      <Detail label="IP time zone">{k.timezone}</Detail>
      <Detail label="Network">{joined(k.asOrganization, k.asn ? `AS${k.asn}` : "")}</Detail>
      <Detail label="Host name">{k.hostname ? `${k.hostname}${k.hasIp ? "" : " (domain only: the full name can contain the IP address)"}` : ""}</Detail>
      {k.event === "open" ? <Detail label="Event">{k.botName ? `Email opened through the ${k.botName}: the location, network and device are the proxy's, not the reader's` : "Email opened (the pixel was loaded)"}</Detail> : null}
      <Detail label="Signals">
        {joined(
          k.flags.knownVpn ? `On the public list of VPN providers: ${k.flags.knownVpn}` : "",
          k.flags.tor ? "Tor exit node" : "",
          k.flags.datacenter ? "Hosting or datacenter network (VPN, proxy or scanner likely)" : "",
          k.flags.privateRelay ? "Relay (iCloud Private Relay or Cloudflare WARP)" : "",
          k.tzMismatch ? `Browser clock (${d?.timezone || "other zone"}) differs from the IP's zone: VPN or proxy likely` : "",
        ) || "None"}
      </Detail>
      <Detail label="Device">{joined(k.device, k.deviceModel)}</Detail>
      <Detail label="System">{joined(k.os, k.osVersion)}</Detail>
      <Detail label="Browser">{joined(k.browser, k.browserVersion)}</Detail>
      <Detail label="Languages">{k.languages}</Detail>
      <Detail label="Came from">{k.referrer || sourceLabel(k.source || "direct")}</Detail>
      <Detail label="Source">{joined(sourceLabel(k.source || "direct"), k.qr ? "QR code" : "")}</Detail>
      {d ? (
        <>
          <Detail label="Screen">{joined(d.screen, d.dpr ? `${d.dpr}× pixels` : "", d.viewport ? `window ${d.viewport}` : "")}</Detail>
          <Detail label="Browser time zone">{joined(d.timezone, d.tzOffset !== null ? `UTC${d.tzOffset >= 0 ? "+" : "−"}${Math.abs(d.tzOffset / 60)}` : "")}</Detail>
          <Detail label="Hardware">{joined(d.platform, d.cores ? `${d.cores} cores` : "", d.memory ? `${d.memory} GB memory or more` : "", d.touch ? `${d.touch} touch points` : "")}</Detail>
          <Detail label="Connection">{d.connection}</Detail>
          <Detail label="Preferences">{joined(d.colorScheme ? `${d.colorScheme} mode` : "", d.dnt ? "Do Not Track" : "", d.gpc ? "Global Privacy Control" : "")}</Detail>
        </>
      ) : null}
      <Detail label="User agent">
        <code className="ui-tk-ua">{k.userAgent}</code>
      </Detail>
      <Detail label="Connection to Cloudflare">{joined(k.colo, k.httpProtocol, k.tlsVersion, k.rttMs !== null ? `${k.rttMs} ms round trip` : "")}</Detail>
    </dl>
  );
}

export function ClickLog({ link, onSettings }: { link: LinkDTO; onSettings?: () => void }) {
  const can = useCan();
  const { domain, slug } = link;
  const qc = useQueryClient();
  const [event, setEvent] = useState<EventFilter>("all");
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState<string | null>(null);
  const [view, setView] = useState<View>("list");
  const [confirmClear, setConfirmClear] = useState(false);
  const allowed = can("clicks.view");
  const q = useClicks(link, event, limit, allowed && Boolean(link.tracking));
  const edits = can("links.edit");

  const clear = useMutation({
    mutationFn: () => call(api.links[":domain"][":slug"].clicks.$delete({ param: { domain, slug } })),
    onSuccess: (r) => {
      setConfirmClear(false);
      void qc.invalidateQueries({ queryKey: clicksKey(domain, slug) });
      toast.success(`${num(r.deleted)} ${r.deleted === 1 ? "click" : "clicks"} deleted`);
    },
    onError: (e) => toast.error(errorText(e) ?? "That didn’t work. Try again."),
  });
  const removeOne = useMutation({
    mutationFn: (id: string) => call(api.links[":domain"][":slug"].clicks[":id"].$delete({ param: { domain, slug, id } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: clicksKey(domain, slug) }),
    onError: (e) => toast.error(errorText(e) ?? "That didn’t work. Try again."),
  });

  if (!allowed) return null;

  if (!link.tracking) {
    return (
      <Section id="clicks" title="Click log" sub="Advanced tracking is off for this link.">
        <div className="ui-tk-off">
          <p>
            Switch it on to see each click on its own: the exact time, city and postal code, network operator, Tor and VPN hints, device model and versions, the full referrer, and repeat visits from the same browser.
            Optionally the IP address, and a few values from the browser itself (screen, time zone). Everything comes from Cloudflare and the visitor’s browser; no tracking service is involved.
          </p>
          <div className="ui-tk-off-actions">
            {edits && onSettings ? (
              <Button icon={Radar} onClick={onSettings}>
                Set up advanced tracking…
              </Button>
            ) : null}
            <GuideLink>Read the guide first</GuideLink>
          </div>
        </div>
      </Section>
    );
  }

  const data = q.data;
  const menu: (MenuItem | "separator")[] = [
    { label: "Export CSV", icon: Download, onSelect: () => void downloadFile(`/_admin/api/links/${encodeURIComponent(domain)}/${encodeURIComponent(slug)}/clicks.csv?event=${event}`).catch((e: unknown) => toast.error(errorText(e) ?? "Export failed")) },
    ...(edits && onSettings ? [{ label: "Tracking settings…", icon: Settings2, onSelect: onSettings }] : []),
    ...(edits ? ["separator" as const, { label: "Delete the click log…", icon: Trash2, danger: true, onSelect: () => setConfirmClear(true) }] : []),
  ];

  let body: ReactNode;
  if (q.isPending) body = <RowsSkeleton rows={4} />;
  else if (q.isError) body = <ErrorState what="The click log" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} compact />;
  else if (!data?.clicks.length) body = <p className="ui-rows-empty">{event === "all" ? "No clicks yet. They appear here within seconds of happening." : event === "click" ? "No clicks by people yet." : event === "open" ? "No email opens yet. Put the pixel below into an email." : "No bot visits yet."}</p>;
  else if (view === "map")
    body = (
      <Suspense fallback={<RowsSkeleton rows={4} />}>
        <ClickMap clicks={data.clicks} />
      </Suspense>
    );
  else
    body = (
      <>
        <Table label="Each click on this link" dense className="ui-tk-table">
          <thead>
            <tr>
              <TH>
                <span className="ui-sr">Details</span>
              </TH>
              <TH>Time</TH>
              <TH>Visitor</TH>
              <TH>Location</TH>
              <TH>Network</TH>
              <TH>Device</TH>
              <TH>Came from</TH>
              {link.tracking.mode === "ip" || data.clicks.some((k) => k.hasIp) ? <TH>IP address</TH> : null}
            </tr>
          </thead>
          <tbody>
            {data.clicks.map((k) => {
              const expanded = open === k.id;
              const showIpCol = link.tracking?.mode === "ip" || data.clicks.some((c) => c.hasIp);
              return (
                <Fragment key={k.id}>
                  <tr className={expanded ? "is-open" : undefined}>
                    <TD>
                      <IconButton size="sm" variant="ghost" icon={expanded ? ChevronDown : ChevronRight} label={expanded ? "Hide details" : "Show every detail"} aria-expanded={expanded} onClick={() => setOpen(expanded ? null : k.id)} />
                    </TD>
                    <TD className="ui-ld-nowrap">{when(k.at)}</TD>
                    <TD className="ui-ld-nowrap">
                      <span title={`${k.visitorVisits} ${k.visitorVisits === 1 ? "visit" : "visits"} from this browser and network`}>{k.visitor}</span>
                      {k.visitorVisits > 1 ? <span className="ui-ld-quiet"> ×{k.visitorVisits}</span> : null}
                    </TD>
                    <TD>{place(k) || "Unknown"}</TD>
                    <TD>
                      <span className="ui-ld-quiet" title={k.hostname || undefined}>{k.asOrganization || (k.asn ? `AS${k.asn}` : "Unknown")}</span> <Flags k={k} />
                    </TD>
                    <TD className="ui-ld-quiet">{joined(k.deviceModel || k.device, joined(k.os, k.osVersion), joined(k.browser, k.browserVersion.split(".")[0]))}</TD>
                    <TD className="ui-ld-quiet ui-ld-ref" title={k.referrer || undefined}>
                      {k.referrer ? k.referrer.replace(/^https?:\/\//, "") : sourceLabel(k.source || "direct")}
                    </TD>
                    {showIpCol ? <TD className="ui-ld-nowrap ui-tk-ip">{k.ip ?? (k.hasIp ? <span className="ui-ld-quiet">Hidden</span> : <span className="ui-ld-quiet">–</span>)}</TD> : null}
                  </tr>
                  {expanded ? (
                    <tr className="ui-tk-expanded">
                      <td colSpan={showIpCol ? 8 : 7}>
                        <ClickDetails k={k} canSeeIp={data.canSeeIp} />
                        {edits ? (
                          <Button size="sm" variant="ghost" icon={Trash2} loading={removeOne.isPending && removeOne.variables === k.id} onClick={() => removeOne.mutate(k.id)}>
                            Delete this click
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </Table>
        {data.more ? (
          limit < MAX ? (
            <Button size="sm" className="ui-tk-more" loading={q.isFetching} onClick={() => setLimit((l) => Math.min(MAX, l + PAGE))}>
              Show more
            </Button>
          ) : (
            <p className="ui-ld-quiet ui-tk-more">The newest {MAX} are shown. Export CSV for all of them.</p>
          )
        ) : null}
      </>
    );

  const t = link.tracking;
  const summary = data
    ? `${num(data.people)} ${data.people === 1 ? "click" : "clicks"} by ${num(data.visitors)} ${data.visitors === 1 ? "visitor" : "visitors"}, ${data.opens ? `${num(data.opens)} email ${data.opens === 1 ? "open" : "opens"}, ` : ""}${num(data.bots)} ${data.bots === 1 ? "bot" : "bots"}. `
    : "";
  const origin = (() => {
    try {
      return new URL(link.shortUrl).origin;
    } catch {
      return "";
    }
  })();
  const pixel = pixelTag(origin, slug);
  return (
    <Section
      id="clicks"
      title={
        <>
          Click log <Badge tone={t.mode === "ip" ? "warn" : "neutral"}>{t.mode === "ip" ? "With IP" : "Advanced"}</Badge>
        </>
      }
      sub={`${summary}Kept ${RETENTION_LABEL[t.retentionDays]}${t.since ? `, since ${date(t.since)}` : ""}. Refreshes every 30 seconds.`}
      aside={
        <div className="ui-tk-tools">
          <Segmented<View>
            label="View"
            size="sm"
            value={view}
            onChange={setView}
            options={[
              { value: "list", label: "List" },
              { value: "map", label: "Map" },
            ]}
          />
          <Segmented<EventFilter>
            label="Show"
            size="sm"
            value={event}
            onChange={(v) => {
              setEvent(v);
              setLimit(PAGE);
            }}
            options={[
              { value: "all", label: "All" },
              { value: "click", label: "People" },
              { value: "open", label: "Opens" },
              { value: "bot", label: "Bots" },
            ]}
          />
          <Menu label="Click log actions" trigger={<IconButton label="Click log actions" icon={Ellipsis} variant="secondary" size="sm" />} items={menu} />
        </div>
      }
    >
      {t.purpose ? (
        <p className="ui-tk-purpose">
          <span className="ui-ld-quiet">Purpose:</span> {t.purpose} <GuideLink>Guide</GuideLink>
        </p>
      ) : null}
      {t.mode === "ip" && data && !data.canSeeIp ? <Notice className="ui-tk-note">IP addresses are recorded on this link but hidden from you: that needs the See IP addresses permission.</Notice> : null}
      {body}
      {t.pixel ? <details className="ui-tk-pixel">
        <summary>Track email opens with this link’s pixel</summary>
        <p className="ui-ld-quiet">
          Paste this into the HTML of an email. When it’s opened and images load, an “open” appears here, with the same details as a click (and an email, if you chose one). Gmail and Yahoo load images through their own servers, so their opens show the time but not the reader’s place or device; Apple Mail may load images in advance, before anyone reads the email. A pixel loaded by a web page counts as a bot, not an open.
        </p>
        <Notice tone="warn">In the EU, a tracking pixel in an email generally needs the recipient’s consent (ePrivacy Directive Art. 5(3)), whatever the legal basis for the rest of the data. Use it only where you have that consent.</Notice>
        <code className="ui-tk-pixel-code">{pixel}</code>
        <Button size="sm" icon={Copy} onClick={() => void copy(pixel)}>
          Copy the pixel
        </Button>
      </details> : null}
      <Dialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        size="sm"
        title="Delete the click log?"
        description="Every recorded click on this link is deleted for good, with its IP address and browser details. Tracking stays on; the statistics above aren't affected."
        footer={
          <>
            <Button onClick={() => setConfirmClear(false)}>Cancel</Button>
            <Button variant="danger" loading={clear.isPending} onClick={() => clear.mutate()}>
              Delete the click log
            </Button>
          </>
        }
      />
    </Section>
  );
}

// ---- Settings ----

type Choice = "off" | TrackingMode;

/** The workspace's rules for Advanced tracking (Settings → Access & security). */
export function useTrackingPolicy(enabled = true) {
  return useQuery({ queryKey: ["tracking", "policy"], queryFn: () => call(api.tracking.policy.$get()), enabled, staleTime: 60_000 });
}

/** "Read the guide" for Advanced tracking, opening in place of the dialog's page. */
export function GuideLink({ section, children, onClick }: { section?: string; children?: ReactNode; onClick?: () => void }) {
  return (
    <Link to={`/tracking-guide${section ? `#${section}` : ""}`} className="ui-text-button" onClick={onClick}>
      {children ?? "Read the guide"}
    </Link>
  );
}

/** The choices in the tracking form, before they're saved. */
export interface TrackingDraft {
  mode: Choice;
  retention: TrackingRetention;
  browser: boolean;
  pixel: boolean;
  notify: TrackingNotify;
  purpose: string;
  /** The GDPR warning accepted in this form (IP mode). */
  ack: boolean;
}

export function trackingDraft(t?: LinkDTO["tracking"]): TrackingDraft {
  return {
    mode: t?.mode ?? "off",
    retention: t?.retentionDays ?? DEFAULT_TRACKING_RETENTION,
    browser: t?.browser ?? false,
    pixel: t?.pixel ?? false,
    notify: t?.notify ?? "off",
    purpose: t?.purpose ?? "",
    ack: false,
  };
}

/** What the API takes (PUT …/tracking, or `tracking` when creating a link); null is off. */
export function trackingPayload(d: TrackingDraft) {
  if (d.mode === "off") return null;
  return { mode: d.mode, retentionDays: d.retention, browser: d.browser, pixel: d.pixel, notify: d.notify, purpose: d.purpose.trim(), ...(d.mode === "ip" && d.ack ? { acknowledged: true } : {}) };
}

export type TrackingPolicyDTO = NonNullable<ReturnType<typeof useTrackingPolicy>["data"]>["policy"];

/**
 * Why the draft can't be saved yet, or null when it can. `accepted`: the link
 * already records IP addresses with the warning accepted. Until the rules
 * have loaded, only "off" can be saved. The API checks all of it again.
 */
export function trackingProblem(d: TrackingDraft, policy: TrackingPolicyDTO | undefined, canIp: boolean, accepted = false): string | null {
  if (d.mode === "off") return null;
  if (!policy) return "The workspace’s tracking rules haven’t loaded yet.";
  if (!policy.enabled) return "An admin has turned Advanced tracking off for this workspace.";
  if (d.mode === "ip" && !policy.allowIp) return "This workspace doesn’t allow recording IP addresses.";
  if (d.mode === "ip" && !canIp) return "Recording IP addresses needs the See IP addresses permission.";
  if (d.mode === "ip" && !accepted && !d.ack) return "Accept the GDPR warning to record IP addresses.";
  if (policy.requirePurpose && d.purpose.trim().length < PURPOSE_MIN) return `Say why this link is tracked (at least ${PURPOSE_MIN} characters).`;
  if (d.browser && !policy.allowBrowser) return "Browser details aren’t allowed in this workspace.";
  if (d.pixel && !policy.allowPixel) return "The email-open pixel isn’t allowed in this workspace.";
  return null;
}

/** One line for a collapsed section: what the draft will do. */
export function draftSummary(d: TrackingDraft): string {
  if (d.mode === "off") return "Off · a log of each click";
  return `${d.mode === "ip" ? "With IP addresses" : "Without IP addresses"}${d.browser ? ", browser details" : ""}${d.pixel ? ", email pixel" : ""}, kept ${RETENTION_LABEL[d.retention]}`;
}

/** The tracking choices, on the link page's dialog and in "Create a new link". */
export function TrackingFields({
  value: d,
  onChange,
  policy,
  policyError,
  accepted = false,
  ackBy,
  ackAt,
  onLeave,
}: {
  value: TrackingDraft;
  onChange: (d: TrackingDraft) => void;
  policy: TrackingPolicyDTO | undefined;
  policyError?: ReactNode;
  /** The link already records IP addresses with the warning accepted. */
  accepted?: boolean;
  ackBy?: string | null;
  ackAt?: number | null;
  /** Called when a link leaves for the guide, so a form around this can close. */
  onLeave?: () => void;
}) {
  const can = useCan();
  const canIp = can("clicks.ip");
  const set = <K extends keyof TrackingDraft>(k: K, v: TrackingDraft[K]) => onChange({ ...d, [k]: v });
  const off = policy ? !policy.enabled : false;
  const ipAllowed = policy ? policy.allowIp : false;
  const purposeShort = d.mode !== "off" && Boolean(policy?.requirePurpose) && d.purpose.trim().length < PURPOSE_MIN;

  // A retention the rules no longer allow drops to the longest they do.
  useEffect(() => {
    if (policy && d.retention > policy.maxRetentionDays) onChange({ ...d, retention: policy.maxRetentionDays });
  }, [policy, d, onChange]);

  return (
    <div className="ui-tk-form">
      {policyError}
      {off ? <Notice tone="warn">An admin has turned Advanced tracking off for this workspace. You can still switch it off, and read or delete clicks already recorded.</Notice> : null}
      <Segmented<Choice>
        label="Tracking"
        value={d.mode}
        onChange={(m) => set("mode", m)}
        options={[
          { value: "off", label: "Off" },
          { value: "details", label: "Without IP" },
          { value: "ip", label: "With IP addresses" },
        ]}
      />
      {d.mode === "off" ? (
        <p className="ui-ld-quiet">
          This link records only the usual statistics: no IP addresses and no individual click log. <GuideLink onClick={onLeave}>What Advanced tracking records</GuideLink>
        </p>
      ) : (
        <>
          <p className="ui-ld-quiet">
            {d.mode === "ip"
              ? "Every detail of each click, and the visitor’s IP address, stored encrypted and shown only to people with See IP addresses."
              : "Every detail of each click: exact time, city, postal code, network, Tor and VPN hints, device model, versions, languages, the full referrer and repeat visits. The IP address itself isn’t stored."}{" "}
            <GuideLink onClick={onLeave}>How to use it lawfully</GuideLink>
          </p>
          {d.mode === "ip" && policy && !ipAllowed ? (
            <Notice tone="warn">This workspace doesn’t allow recording IP addresses. An admin can change that in Settings → Access & security. Without IP still shows everything else.</Notice>
          ) : d.mode === "ip" && !canIp ? (
            <Notice tone="warn">Recording IP addresses needs the See IP addresses permission. Ask an admin.</Notice>
          ) : d.mode === "ip" ? (
            <Notice tone="warn" title="IP addresses can break the GDPR">
              {IP_TRACKING_WARNING.map((p) => (
                <p key={p}>{p}</p>
              ))}
              {accepted ? (
                <p className="ui-ld-quiet">
                  Accepted{ackBy ? ` by ${ackBy}` : ""}
                  {ackAt ? ` on ${whenFull(ackAt)}` : ""}.
                </p>
              ) : (
                <Checkbox checked={d.ack} onCheckedChange={(v) => set("ack", v)} label="I understand, and I’m responsible for recording IP addresses on this link" />
              )}
            </Notice>
          ) : null}
          <Textarea
            label={policy?.requirePurpose ? "Purpose (required)" : "Purpose"}
            value={d.purpose}
            onChange={(e) => set("purpose", e.target.value.slice(0, PURPOSE_MAX))}
            rows={2}
            placeholder="For example: to see whether the candidate I sent my offer to opened it, so I know when to follow up."
            hint={`Why this link is tracked, kept with the setting. The GDPR asks you to be able to say it. ${d.purpose.trim().length}/${PURPOSE_MAX}`}
            error={purposeShort && d.purpose.length > 0 ? `At least ${PURPOSE_MIN} characters.` : undefined}
          />
          <Select
            label="Keep each click for"
            value={String(d.retention)}
            onChange={(e) => set("retention", Number(e.target.value) as TrackingRetention)}
            options={TRACKING_RETENTION_DAYS.filter((r) => !policy || r <= policy.maxRetentionDays).map((r) => ({ value: String(r), label: RETENTION_LABEL[r] }))}
            hint={`Then it’s deleted by the daily cleanup. Shorter is safer.${policy && policy.maxRetentionDays < 365 ? ` This workspace allows ${RETENTION_LABEL[policy.maxRetentionDays]} at most.` : ""}`}
          />
          <Switch
            checked={d.browser}
            onCheckedChange={(v) => set("browser", v)}
            disabled={policy ? !policy.allowBrowser && !d.browser : true}
            label="Browser details"
            description={policy && !policy.allowBrowser ? "Not allowed in this workspace." : BROWSER_DETAILS_WARNING}
          />
          <Switch
            checked={d.pixel}
            onCheckedChange={(v) => set("pixel", v)}
            disabled={policy ? !policy.allowPixel && !d.pixel : true}
            label="Email-open pixel"
            description={
              policy && !policy.allowPixel
                ? "Not allowed in this workspace."
                : "An invisible image for your emails that records each open. In the EU it generally needs the recipient’s consent (ePrivacy Art. 5(3))."
            }
          />
          <Select
            label="Email me"
            value={d.notify}
            onChange={(e) => set("notify", e.target.value as TrackingNotify)}
            options={[
              { value: "off", label: "Never" },
              { value: "first", label: "On the first click (and the first open) by a person" },
              { value: "every", label: "On every click and open by a person (at most every 10 minutes)" },
            ]}
            hint="Sent to the digest address (DIGEST_TO). Bots, previews and email scanners never trigger it. Webhooks: the Tracked click event in Settings."
          />
        </>
      )}
    </div>
  );
}

export function TrackingDialog({ link, open, onOpenChange }: { link: LinkDTO; open: boolean; onOpenChange: (open: boolean) => void }) {
  const can = useCan();
  const qc = useQueryClient();
  const t = link.tracking;
  const policyQ = useTrackingPolicy(open);
  const policy = policyQ.data?.policy;
  const [draft, setDraft] = useState<TrackingDraft>(() => trackingDraft(t));
  const accepted = t?.mode === "ip" && t.ackAt !== null;

  useEffect(() => {
    if (open) setDraft(trackingDraft(t));
  }, [open, t]);

  const save = useMutation({
    mutationFn: () =>
      call(
        api.links[":domain"][":slug"].tracking.$put({
          param: { domain: link.domain, slug: link.slug },
          json: trackingPayload(draft),
        }),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.link(link.domain, link.slug) });
      void qc.invalidateQueries({ queryKey: keys.allLinks });
      toast.success(draft.mode === "off" ? "Advanced tracking is off" : "Advanced tracking saved", {
        description: draft.mode === "off" ? "Clicks already recorded stay until their retention ends; delete them from the click log." : "The next click shows up in the click log within seconds.",
      });
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorText(e) ?? "That didn’t work. Try again."),
  });

  // "Off" can always be saved, even while the rules are loading or failed to load.
  const blocked = trackingProblem(draft, policy, can("clicks.ip"), accepted) !== null;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Advanced tracking"
      description="A log of each click on this link with every detail Cloudflare and the browser can tell, kept for the time you choose. No tracking service is involved: the network name is looked up through Cloudflare’s public resolver."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={blocked} loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <TrackingFields
        value={draft}
        onChange={setDraft}
        policy={policy}
        policyError={policyQ.isError ? <ErrorState what="This workspace’s tracking rules" error={policyQ.error} onRetry={() => void policyQ.refetch()} compact /> : null}
        accepted={accepted}
        ackBy={t?.ackBy}
        ackAt={t?.ackAt}
        onLeave={() => onOpenChange(false)}
      />
    </Dialog>
  );
}
