// Breakdown lists of the website dashboard: short links, acquisition, AI
// landing pages, content, location (with networks), devices and goals.

import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Filter } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { GOAL_NAME_RE, type SiteDim, type SiteDTO } from "../../../shared/sites";
import { api, call, keys } from "../../api";
import { num } from "../../lib/format";
import { linkPath, useLinkLabel } from "../../lib/links";
import { DIM_LABELS, percent, viewQuery, type SiteView } from "../../lib/sites";
import { cn } from "../../lib/utils";
import { ribbonParts, SourceRibbon, TabbedPanel } from "../parts";
import { ErrorState, Skeleton } from "../ui";
import { NeedsAE, sitePages, PickRows, RowsSkeleton, rowTitle, splitLink, valueLabel, type Dash, type PickItem } from "./common";

type Pick = (dim: SiteDim, value: string) => void;

function useBreakdown(siteId: string, query: Record<string, string>, enabled = true) {
  return useQuery({
    queryKey: keys.siteData(siteId, "breakdown", query),
    queryFn: () => call(api.sites[":id"].breakdown.$get({ param: { id: siteId }, query: query as Record<string, string> & { dim: SiteDim } })),
    enabled,
  });
}

const PATHY = new Set<SiteDim>(["entry", "exit", "referrer", "hostname"]);

function rowsToItems(rows: { value: string; visitors: number; revenue: number }[], dim: SiteDim, view: SiteView, onPick: Pick, swatch?: Map<string, string>): PickItem[] {
  const pickable = view.filters[dim] === undefined;
  return rows
    .filter((r) => r.visitors > 0 || r.revenue !== 0)
    .map((r) => {
      const label = valueLabel(dim, r.value);
      return {
        key: r.value || "(none)",
        label,
        title: rowTitle(dim, r.value, label),
        value: r.visitors,
        revenue: r.revenue,
        path: PATHY.has(dim),
        quiet: r.value === "(not matched)",
        onPick: pickable && r.value !== "(not matched)" ? () => onPick(dim, r.value) : undefined,
        swatch: swatch?.get(r.value || "(none)"),
      };
    });
}

/** One tab of a breakdown: skeleton, error with retry, or the rows. */
type Sort = "value" | "revenue";

function DimRows({ d, dim, sort, onSort, note, swatch }: { d: Dash; dim: SiteDim; sort: Sort; onSort: (s: Sort) => void; note?: string; swatch?: Map<string, string> }) {
  const site = d.o!.site;
  const data = useBreakdown(d.id, { ...d.query, dim });
  return (
    <>
      {note ? <p className="ui-site-note">{note}</p> : null}
      {data.isPending ? (
        <RowsSkeleton rows={6} />
      ) : data.isError ? (
        <ErrorState compact what={DIM_LABELS[dim]} error={data.error} onRetry={() => void data.refetch()} retrying={data.isFetching} />
      ) : (
        <PickRows items={rowsToItems(data.data.rows, dim, d.view, d.addFilter, swatch)} revenue={d.revenue} currency={site.currency} sort={sort} onSort={onSort} emptyText="No visits in this period." />
      )}
    </>
  );
}

export function DimPanel({ d, title, tabs, notes, labels, lead, swatch }: { d: Dash; title: string; tabs: SiteDim[]; notes?: Partial<Record<SiteDim, string>>; labels?: Partial<Record<SiteDim, string>>; lead?: ReactNode; swatch?: { dim: SiteDim; map: Map<string, string> } }) {
  const [sort, setSort] = useState<"value" | "revenue">("value");
  return (
    <TabbedPanel
      title={title}
      tabs={tabs.map((t) => ({ id: t, label: labels?.[t] ?? DIM_LABELS[t] }))}
      lead={lead}
      render={(tab) => <DimRows d={d} dim={tab as SiteDim} sort={sort} onSort={setSort} note={notes?.[tab as SiteDim]} swatch={swatch?.dim === tab ? swatch.map : undefined} />}
    />
  );
}

/** Your short links that sent visitors here, best earners first; the name opens the link, the funnel icon filters. */
export function LinksPanel({ d }: { d: Dash }) {
  const label = useLinkLabel();
  const site = d.o!.site;
  const data = useBreakdown(d.id, { ...d.query, dim: "link" });
  const rows = (data.data?.rows ?? []).filter((r) => r.value && r.value !== "(not matched)" && (r.visitors > 0 || r.revenue !== 0));
  const linkRevenue = rows.reduce((s, r) => s + r.revenue, 0);
  const total = d.o!.totals.revenue;
  const items: PickItem[] = rows.map((r) => {
    const l = splitLink(r.value);
    return {
      key: r.value,
      label: label(l),
      title: `Open ${label(l)}`,
      value: r.visitors,
      revenue: r.revenue,
      to: linkPath(l),
      action:
        d.view.filters.link === undefined ? (
          <button type="button" className="ui-pick-filter" onClick={() => d.addFilter("link", r.value)} aria-label={`Filter the dashboard by ${label(l)}`} title="Filter the dashboard by this link">
            <Filter aria-hidden />
          </button>
        ) : undefined,
    };
  });
  return (
    <TabbedPanel
      title="Short links"
      tabs={[{ id: "link", label: "Short links" }]}
      render={() => (
        <>
          <p className="ui-site-note">
            {d.revenue && total > 0 && linkRevenue > 0 ? `${percent(Math.min(1, linkRevenue / total))} of this period’s revenue came through them.` : "Clicks on your short links to this site are credited automatically."}
          </p>
          {data.isPending ? (
            <RowsSkeleton rows={5} />
          ) : data.isError ? (
            <ErrorState compact what="Short links" error={data.error} onRetry={() => void data.refetch()} retrying={data.isFetching} />
          ) : (
            <PickRows
              items={items}
              revenue={d.revenue}
              currency={site.currency}
              sort={d.revenue ? "revenue" : "value"}
              emptyText={`No short-link visits in this period. Share a short link that points to ${site.domains[0] ?? "the site"}; its visits${d.revenue ? " and sales" : ""} show up here.`}
            />
          )}
        </>
      )}
    />
  );
}

const ACQ: SiteDim[] = ["channel", "source", "referrer", "campaign", "utm_medium", "utm_term", "utm_content"];
const ACQ_LABELS: Partial<Record<SiteDim, string>> = { channel: "Channels", source: "Sources", referrer: "Referrers", campaign: "Campaigns", utm_medium: "Medium", utm_term: "Keyword", utm_content: "Content" };

/**
 * Where visitors came from, headed by the signature ribbon (visitors by
 * channel), as on the home and the link page. The ribbon reads the same
 * breakdown query as the Channels tab (same key), so it costs no request;
 * the Channels list under it is its legend.
 */
export function AcquisitionPanel({ d }: { d: Dash }) {
  const channels = useBreakdown(d.id, { ...d.query, dim: "channel" });
  const parts = (channels.data?.rows ?? []).filter((r) => r.visitors > 0).map((r) => ({ key: r.value || "(none)", label: valueLabel("channel", r.value), value: r.visitors }));
  const lead = channels.isPending ? (
    <div className="ui-ribbon is-skel">
      <Skeleton className="ui-skel-ribbon" />
    </div>
  ) : parts.length ? (
    <SourceRibbon items={parts} label="Where visitors came from, by channel" />
  ) : null;
  return <DimPanel d={d} title="Where visitors came from" tabs={ACQ} labels={ACQ_LABELS} lead={lead} swatch={{ dim: "channel", map: ribbonParts(parts).swatch }} />;
}
/** Where visitors are, including their network (the provider, from Cloudflare): a lone Networks panel left a half-empty row. */
export const LocationPanel = ({ d }: { d: Dash }) => (
  <DimPanel
    d={d}
    title="Location"
    tabs={["country", "region", "city", "continent", "timezone", "org"]}
    labels={{ country: "Countries", region: "Regions", city: "Cities", continent: "Continents", timezone: "Time zones", org: "Networks" }}
    notes={{ org: "Who runs the visitor’s network, from Cloudflare: usually an internet provider, sometimes a company’s or university’s own network." }}
  />
);
export const DevicesPanel = ({ d }: { d: Dash }) => (
  <DimPanel
    d={d}
    title="Devices and visitors"
    tabs={["device", "screen", "browser", "os", "language", "visitor_type"]}
    labels={{ device: "Devices", screen: "Screens", browser: "Browsers", os: "Systems", language: "Languages", visitor_type: "New vs returning" }}
    notes={{
      visitor_type:
        d.o!.site.idMode === "cookieless"
          ? "Without cookies a visitor is recognised for one day only, so “returning” means they came back the same day."
          : "Returning: the visitor had an earlier visit, on any day.",
    }}
  />
);

// ---- Content: pages and outbound (Analytics Engine), landing and exit pages (D1) ----

const CONTENT_TABS = [
  { id: "pages", label: "Pages" },
  { id: "entry", label: "Landing pages" },
  { id: "exit", label: "Exit pages" },
  { id: "outbound", label: "Outbound" },
];

function EventRows({ d, list, sort, onSort }: { d: Dash; list: "pages" | "outbound"; sort: Sort; onSort: (s: Sort) => void }) {
  const site = d.o!.site;
  const query = { ...d.query, list };
  const data = useQuery({
    queryKey: keys.siteData(d.id, "events", query),
    queryFn: async () => {
      const r = await call(api.sites[":id"].events.$get({ param: { id: d.id }, query: { ...viewQuery(d.view), list } }));
      return { available: r.available, rows: r.rows.map((x) => ({ value: x.value, visitors: x.visitors, sessions: x.count, pageviews: x.count, revenue: x.revenue ?? 0, customers: 0 })) };
    },
  });
  if (data.isPending) return <RowsSkeleton rows={6} />;
  if (data.isError) return <ErrorState compact what={list === "pages" ? "Pages" : "Outbound links"} error={data.error} onRetry={() => void data.refetch()} retrying={data.isFetching} />;
  if (!data.data.available) return <NeedsAE what={list === "pages" ? "Page lists" : "Outbound clicks"} />;
  const items: PickItem[] = data.data.rows
    .filter((r) => r.visitors > 0 || r.pageviews > 0)
    .map((r) => ({ key: r.value, label: r.value || "Unknown", value: list === "outbound" ? r.pageviews : r.visitors, revenue: r.revenue, path: true }));
  return (
    <>
      {list === "pages" ? <p className="ui-site-note">Revenue here is from visits that landed on the page, so it adds up to the total. Not filtered.</p> : null}
      <PickRows items={items} revenue={d.revenue && list === "pages"} currency={site.currency} unit={list === "outbound" ? "Clicks" : "Visitors"} sort={sort} onSort={onSort} emptyText="Nothing in this period." />
    </>
  );
}

/** Pages and outbound clicks need Analytics Engine; without it the panel keeps landing and exit pages (D1) and the dashboard's live-data line names the rest. */
export function ContentPanel({ d }: { d: Dash }) {
  const [sort, setSort] = useState<"value" | "revenue">("value");
  const tabs = d.o!.aeAvailable ? CONTENT_TABS : CONTENT_TABS.filter((t) => t.id === "entry" || t.id === "exit");
  return (
    <TabbedPanel
      key={tabs.length}
      title="Content"
      tabs={tabs}
      render={(tab) => (tab === "pages" || tab === "outbound" ? <EventRows d={d} list={tab} sort={sort} onSort={setSort} /> : <DimRows d={d} dim={tab as SiteDim} sort={sort} onSort={setSort} />)}
    />
  );
}

function AiRows({ d, source, sort, onSort }: { d: Dash; source: string; sort: Sort; onSort: (s: Sort) => void }) {
  const entries = useBreakdown(d.id, { ...d.query, f_channel: "AI", ...(source === "all" ? {} : { f_source: source }), dim: "entry" });
  return (
    <>
      <p className="ui-site-note">AI assistants don’t share what people asked. The page they land on is the closest signal.</p>
      {entries.isPending ? (
        <RowsSkeleton rows={4} />
      ) : entries.isError ? (
        <ErrorState compact what="AI landing pages" error={entries.error} onRetry={() => void entries.refetch()} retrying={entries.isFetching} />
      ) : (
        <PickRows items={rowsToItems(entries.data.rows, "entry", d.view, d.addFilter)} revenue={d.revenue} currency={d.o!.site.currency} sort={sort} onSort={onSort} />
      )}
    </>
  );
}

/** Where visitors from AI assistants landed, per assistant. Hidden when none came or another channel is filtered. */
export function AiPanel({ d }: { d: Dash }) {
  const [sort, setSort] = useState<"value" | "revenue">("value");
  const otherChannel = d.view.filters.channel !== undefined && d.view.filters.channel !== "AI";
  const sources = useBreakdown(d.id, { ...d.query, f_channel: "AI", dim: "source" }, !otherChannel);
  const assistants = (sources.data?.rows ?? []).filter((r) => r.visitors > 0).sort((a, b) => b.visitors - a.visitors).map((r) => r.value);
  if (otherChannel) return null;
  if (sources.isError) {
    return (
      <TabbedPanel title="AI landing pages" tabs={[{ id: "ai", label: "AI" }]} render={() => <ErrorState compact what="AI visits" error={sources.error} onRetry={() => void sources.refetch()} retrying={sources.isFetching} />} />
    );
  }
  if (!assistants.length) return null;
  const tabs = assistants.length > 1 ? [{ id: "all", label: "All AI" }, ...assistants.map((a) => ({ id: a, label: a }))] : [{ id: "all", label: assistants[0]! }];
  return (
    <TabbedPanel
      key={tabs.map((t) => t.id).join("|")}
      title="AI landing pages"
      tabs={tabs}
      render={(t) => <AiRows d={d} source={t} sort={sort} onSort={setSort} />}
    />
  );
}

// ---- Goals ----

export function GoalsPanel({ d }: { d: Dash }) {
  const o = d.o!;
  const query = { ...d.query, list: "goals" as const };
  const data = useQuery({ queryKey: keys.siteData(d.id, "events", query), queryFn: () => call(api.sites[":id"].events.$get({ param: { id: d.id }, query })), enabled: o.aeAvailable });
  const [open, setOpen] = useState<string | null>(null);
  const rows = data.data?.rows ?? [];
  return (
    <TabbedPanel
      title="Goals"
      tabs={[{ id: "goals", label: "Goals" }]}
      aside={<Link className="ui-panel-link" to={sitePages.guide(d.id, "#goals")}>How goals work</Link>}
      render={() => {
        if (!o.aeAvailable || data.data?.available === false) return <NeedsAE what="Goals" />;
        if (data.isPending) return <RowsSkeleton rows={4} />;
        if (data.isError) return <ErrorState compact what="Goals" error={data.error} onRetry={() => void data.refetch()} retrying={data.isFetching} />;
        if (!rows.length)
          return (
            <div className="ui-state is-compact">
              <p className="ui-state-title">No goals completed in this period.</p>
              <p className="ui-state-body">
                Add <code>data-sh-goal="signup"</code> to a button, or call <code>shorthop("goal", "signup")</code>.
              </p>
            </div>
          );
        return (
          <div className="ui-table-scroll">
            <table className="ui-table is-dense ui-site-goals">
              <thead>
                <tr>
                  <th scope="col">Goal</th>
                  <th scope="col" className="is-num">Visitors</th>
                  <th scope="col" className="is-num">Completions</th>
                  <th scope="col" className="is-num">Conversion</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Fragment key={r.value}>
                    <tr>
                      <td>
                        <button type="button" className="ui-site-disclose" aria-expanded={open === r.value} onClick={() => setOpen(open === r.value ? null : r.value)}>
                          <ChevronRight aria-hidden className={cn(open === r.value && "is-open")} />
                          <span className="ui-site-trunc" title={r.value}>{r.value}</span>
                        </button>
                      </td>
                      <td className="is-num is-2">{num(r.visitors)}</td>
                      <td className="is-num">{num(r.count)}</td>
                      <td className="is-num is-2">{o.totals.visitors ? percent(Math.min(1, r.visitors / o.totals.visitors)) : "–"}</td>
                    </tr>
                    {open === r.value ? (
                      <tr className="ui-site-subrow">
                        <td colSpan={4}>
                          <GoalProps d={d} name={r.value} completions={r.count} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        );
      }}
    />
  );
}

function GoalProps({ d, name, completions }: { d: Dash; name: string; completions: number }) {
  const query = { ...d.query, name };
  const valid = GOAL_NAME_RE.test(name);
  const data = useQuery({ queryKey: keys.siteData(d.id, "goal-props", query), queryFn: () => call(api.sites[":id"]["goal-props"].$get({ param: { id: d.id }, query })), enabled: valid });
  if (!valid) return <p className="ui-site-note">Properties can’t be listed for a goal with this name.</p>;
  if (data.isPending) return <Skeleton className="ui-skel-text" style={{ width: 220 }} />;
  if (data.isError) return <ErrorState compact what="Goal properties" error={data.error} onRetry={() => void data.refetch()} />;
  const rows = data.data.rows;
  if (!rows.length) return <p className="ui-site-note">No properties were sent with this goal. Add them as <code>data-sh-goal-plan="pro"</code>.</p>;
  return (
    <dl className="ui-site-props">
      {[...new Set(rows.map((r) => r.key))].map((k) => (
        <div key={k}>
          <dt><code>{k}</code></dt>
          {rows
            .filter((r) => r.key === k)
            .slice(0, 10)
            .map((v) => (
              <dd key={v.value}>
                <span className="ui-site-trunc" title={v.value}>{v.value || "(empty)"}</span>
                <span className="ui-site-num">{num(v.count)}</span>
                <span className="ui-site-num is-quiet">{completions ? percent(Math.min(1, v.count / completions)) : ""}</span>
              </dd>
            ))}
        </div>
      ))}
    </dl>
  );
}

export type { SiteDTO };
