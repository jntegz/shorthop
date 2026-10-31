// The website picker (/sites): one scannable table. Busiest first, then sites
// waiting for their first visit, paused ones last (bySiteActivity). With
// exactly one site it opens that site's dashboard; ?list keeps the table.
// Adding a site is a dialog (sitepages/AddSite.tsx); its guide and settings
// are in sitepages/.

import { useQuery } from "@tanstack/react-query";
import { BookOpen, Ellipsis, Plus, Settings2 } from "lucide-react";
import { useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import type { SiteListItem } from "../../../shared/sites";
import { api, call, keys } from "../../api";
import { ago, num } from "../../lib/format";
import { useCan } from "../../lib/me";
import { percent, sitePath } from "../../lib/sites";
import { AddSite } from "../sitepages/AddSite";
import { Badge, Button, ErrorState, IconButton, Menu, Skeleton, Table, TD, TH, TR, type BadgeTone } from "../ui";
import { moneyShort, sitePages, SiteDelta } from "./common";

function bySiteActivity(a: SiteListItem, b: SiteListItem): number {
  const rank = (s: SiteListItem) => (!s.tracking ? 2 : s.lastSeenAt === null ? 1 : 0);
  return rank(a) - rank(b) || b.visitors7d - a.visitors7d || a.name.localeCompare(b.name);
}

/** A badge only when the state is news (paused, waiting, quiet, people online); a site that simply works gets its last visit as plain text. */
function status(s: SiteListItem): { tone: BadgeTone; label: string; note?: string; plain?: boolean } {
  if (!s.tracking) return { tone: "neutral", label: "Paused", note: "Visits aren’t recorded" };
  if (s.online) return { tone: "good", label: `${num(s.online)} online now` };
  if (s.lastSeenAt === null) return { tone: "warn", label: "Install not seen", note: "Waiting for the first visit" };
  const quiet = Date.now() / 1000 - s.lastSeenAt > 2 * 86400;
  if (quiet) return { tone: "warn", label: "Quiet", note: `Last visit ${ago(s.lastSeenAt)}; is the script still on the site?` };
  return { tone: "good", label: "Active", note: `Last visit ${ago(s.lastSeenAt)}`, plain: true };
}

const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const dayLabel = (d: string) => dayFormat.format(new Date(`${d}T12:00:00Z`));

/** The last 7 days of visits as small bars (the Visitors window), today last and lighter (still filling). */
function Trend({ days: all }: { days: SiteListItem["visitsDaily"] }) {
  const days = all.slice(-7);
  const max = Math.max(0, ...days.map((d) => d.visits));
  const total = days.reduce((s, d) => s + d.visits, 0);
  if (!total) return <span className="ui-sites-trend-none">No visits</span>;
  const w = 8;
  const gap = 3;
  const h = 28;
  const peak = days.reduce((best, d) => (d.visits > best.visits ? d : best), days[0]!);
  return (
    <svg className="ui-sites-trend" width={days.length * (w + gap) - gap} height={h} role="img" aria-label={`${num(total)} visits in 7 days, most on ${dayLabel(peak.day)} (${num(peak.visits)})`}>
      {days.map((d, i) => {
        const bh = d.visits ? Math.max(2, (d.visits / max) * h) : 1;
        return (
          <rect key={d.day} x={i * (w + gap)} y={h - bh} width={w} height={bh} rx={1.5} className={i === days.length - 1 ? "is-today" : d.visits ? undefined : "is-zero"}>
            <title>{`${dayLabel(d.day)}${i === days.length - 1 ? " (today, so far)" : ""}: ${num(d.visits)} ${d.visits === 1 ? "visit" : "visits"}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

function SiteRow({ s, first, money, manage }: { s: SiteListItem; first: boolean; money: boolean; manage: boolean }) {
  const navigate = useNavigate();
  const st = status(s);
  const waiting = s.tracking && s.lastSeenAt === null;
  const sold = s.revenue30d !== 0 || s.revenuePrev30d !== 0 || s.customers30d > 0;
  const conversion = s.visitors30d ? Math.min(1, s.customers30d / s.visitors30d) : 0;
  return (
    <TR
      focusable
      first={first}
      className="ui-sites-row"
      data-paused={!s.tracking || undefined}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a, button, [role=menu]")) return;
        navigate(sitePath(s.id));
      }}
    >
      <TD className="ui-sites-name">
        <Link to={sitePath(s.id)} data-row-link className="ui-sites-link">{s.name}</Link>
        <span className="ui-table-sub" title={s.domains.join(", ")} translate="no">
          {s.domains[0]}
          {s.domains.length > 1 ? ` +${s.domains.length - 1}` : ""}
        </span>
        <span className="ui-sites-status-inline">{st.plain ? null : <Badge tone={st.tone}>{st.label}</Badge>}</span>
      </TD>
      <TD className="ui-sites-status">
        {st.plain ? <span className="ui-sites-status-plain">{st.note}</span> : <Badge tone={st.tone}>{st.label}</Badge>}
        {st.note && !st.plain ? <span className="ui-table-sub">{st.note}</span> : null}
      </TD>
      <TD numeric className="ui-sites-visitors">
        {waiting ? (
          <span className="ui-site-quiet">–</span>
        ) : (
          <>
            <span className="ui-sites-big">{num(s.visitors7d)}</span>
            <span className="ui-sites-sub">
              <SiteDelta current={s.visitors7d} previous={s.visitorsPrev7d} />
            </span>
          </>
        )}
      </TD>
      <TD className="ui-sites-trendcell">{waiting ? <span className="ui-sites-trend-none">Waiting for the first visit</span> : <Trend days={s.visitsDaily} />}</TD>
      <TD className="ui-sites-source">
        {s.topSource ? (
          <>
            <span className="ui-site-trunc" title={s.topSource.name}>{s.topSource.name}</span>
            <span className="ui-table-sub">{percent(s.topSource.share)} of visits</span>
          </>
        ) : (
          <span className="ui-site-quiet">–</span>
        )}
      </TD>
      {money ? (
        <TD numeric className="ui-sites-revenue">
          {sold ? (
            <>
              <span className="ui-sites-big">{moneyShort(s.revenue30d, s.currency)}</span>
              <span className="ui-sites-sub">
                <SiteDelta kind="money" current={s.revenue30d} previous={s.revenuePrev30d} currency={s.currency} />
              </span>
            </>
          ) : (
            <span className="ui-site-quiet">No sales</span>
          )}
        </TD>
      ) : null}
      {money ? (
        <TD numeric className="ui-sites-customers">
          {s.customers30d ? (
            <>
              <span className="ui-sites-big">{num(s.customers30d)}</span>
              <span className="ui-sites-sub">
                <span className="ui-table-sub">{percent(conversion)} of visitors paid</span>
              </span>
            </>
          ) : (
            <span className="ui-site-quiet">{sold ? "None new" : "–"}</span>
          )}
        </TD>
      ) : null}
      <TD className="ui-sites-more">
        <Menu
          label={`${s.name}: more`}
          trigger={<IconButton label={`More for ${s.name}`} icon={Ellipsis} size="sm" />}
          items={[
            { label: waiting ? "Install guide" : "Guide", icon: BookOpen, onSelect: () => navigate(sitePages.guide(s.id)) },
            ...(manage ? [{ label: "Settings and setup", icon: Settings2, onSelect: () => navigate(sitePages.settings(s.id)) }] : []),
          ]}
        />
      </TD>
    </TR>
  );
}

/**
 * Two windows, each named once: the list API counts traffic over the last
 * 7 days and money over the last 30. The columns are grouped by window under one
 * group head each, so a row reads as "this week's traffic, this month's
 * money"; under 1024 the group row goes and each head carries its window.
 */
function Head({ money }: { money: boolean }) {
  return (
    <thead>
      <tr className="ui-sites-groups">
        <td colSpan={2} />
        <th scope="colgroup" colSpan={3} className="ui-sites-group">Last 7 days</th>
        {money ? <th scope="colgroup" colSpan={2} className="ui-sites-group">Last 30 days</th> : null}
        <td />
      </tr>
      <tr>
        <TH className="ui-sites-name">Website</TH>
        <TH className="ui-sites-status">Status</TH>
        <TH numeric className="ui-sites-visitors">Visitors<span className="ui-sites-win">, 7 days</span></TH>
        <TH className="ui-sites-trendcell">Visits per day</TH>
        <TH className="ui-sites-source">Top source</TH>
        {money ? <TH numeric className="ui-sites-revenue">Revenue<span className="ui-sites-win">, 30 days</span></TH> : null}
        {money ? <TH numeric className="ui-sites-customers">New customers</TH> : null}
        <TH className="ui-sites-more"><span className="ui-sr">Actions</span></TH>
      </tr>
    </thead>
  );
}

export function SitesPage() {
  const can = useCan();
  const [params] = useSearchParams();
  const sites = useQuery({ queryKey: keys.sites, queryFn: () => call(api.sites.$get()), refetchInterval: 60_000 });
  const list = [...(sites.data?.sites ?? [])].sort(bySiteActivity);
  const money = can("revenue.view");
  const manage = can("sites.manage");
  const [adding, setAdding] = useState(false);
  if (list.length === 1 && !params.has("list")) return <Navigate to={sitePath(list[0]!.id)} replace />;
  const tracking = list.filter((s) => s.tracking).length;
  return (
    <div className="ui-page ui-sites">
      <header className="ui-head">
        <div className="ui-head-main">
          <h1 className="ui-h1">Websites</h1>
          <p className="ui-range">
            {sites.data ? (
              list.length ? (
                `${num(list.length)} ${list.length === 1 ? "website" : "websites"}, ${num(tracking)} tracking. Traffic over the last 7 days, money over the last 30, in each site’s own currency.`
              ) : (
                "Traffic and revenue of the sites you own."
              )
            ) : sites.isError ? null : (
              <Skeleton className="ui-skel-text" style={{ width: 320 }} />
            )}
          </p>
        </div>
        {/* Stays while the list loads or fails; only the empty state, which has the same action as its one primary, hides it. */}
        {manage && !(sites.data && !list.length) ? (
          <div className="ui-head-tools">
            <Button icon={Plus} onClick={() => setAdding(true)}>
              Add a website
            </Button>
          </div>
        ) : null}
      </header>
      {sites.isPending ? (
        <Table label="Websites, loading">
          <Head money={money} />
          <tbody aria-busy>
            {[0, 1, 2].map((i) => (
              <tr key={i}>
                <td className="ui-sites-name"><Skeleton className="ui-skel-text" style={{ width: 150 }} /><Skeleton className="ui-skel-text" style={{ width: 100 }} /></td>
                <td className="ui-sites-status"><Skeleton className="ui-skel-text" style={{ width: 70 }} /></td>
                <td className="ui-sites-visitors"><Skeleton className="ui-skel-text" style={{ width: 50, marginLeft: "auto" }} /></td>
                <td className="ui-sites-trendcell"><Skeleton className="ui-skel-text" style={{ width: 74, height: 24 }} /></td>
                <td className="ui-sites-source"><Skeleton className="ui-skel-text" style={{ width: 90 }} /></td>
                {money ? <td className="ui-sites-revenue"><Skeleton className="ui-skel-text" style={{ width: 60, marginLeft: "auto" }} /></td> : null}
                {money ? <td className="ui-sites-customers"><Skeleton className="ui-skel-text" style={{ width: 40, marginLeft: "auto" }} /></td> : null}
                <td className="ui-sites-more" />
              </tr>
            ))}
          </tbody>
        </Table>
      ) : sites.isError ? (
        <ErrorState what="Your websites" error={sites.error} onRetry={() => void sites.refetch()} retrying={sites.isFetching} />
      ) : !list.length ? (
        <div className="ui-state">
          <p className="ui-state-title">See which links bring paying customers.</p>
          <div className="ui-state-body">
            <p>Add a site you own and it gets its own analytics: visitors, pages, channels and campaigns. Connect Stripe or another provider and every sale is credited to the visit, channel and short link that brought it. No cookies are needed.</p>
          </div>
          {manage ? (
            <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>
              Add your first website
            </Button>
          ) : (
            <p className="ui-state-body">An owner or admin can add one.</p>
          )}
        </div>
      ) : (
        <Table label="Websites" rowNav className="ui-sites-table">
          <Head money={money} />
          <tbody>
            {list.map((s, i) => (
              <SiteRow key={s.id} s={s} first={i === 0} money={money} manage={manage} />
            ))}
          </tbody>
        </Table>
      )}
      {manage ? <AddSite open={adding} onOpenChange={setAdding} /> : null}
    </div>
  );
}
