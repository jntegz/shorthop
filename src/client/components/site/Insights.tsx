// Site insight cards: peak hours, reading engagement, page speed, path to
// purchase and lifetime value by first source. Each reads its own endpoint for the view.

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { VITALS_THRESHOLDS, type EngagementRow, type PeakMetric, type SiteDTO, type VitalsRow } from "../../../shared/sites";
import { api, call, keys } from "../../api";
import { num } from "../../lib/format";
import { dimValue, duration, money, percent, viewQuery, type SiteView } from "../../lib/sites";
import { cn } from "../../lib/utils";
import { Card, CardHeader, Empty, Notice, Segmented, Spinner } from "../ui";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;

/** Tables of pages: on phones each row is the path on its own line, then labelled numbers. */
const ROW = "flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-line py-2.5 sm:table-row sm:py-0";
const PATH_CELL = "basis-full truncate font-medium sm:max-w-[18rem] sm:basis-auto sm:py-2";
const NUM_CELL = "tabular whitespace-nowrap sm:py-2 sm:text-right";

/** A number's column name, shown beside it on phones where the header row is hidden. */
function CellLabel({ children }: { children: string }) {
  return <span className="mr-1 text-xs text-subtle sm:hidden">{children}</span>;
}

function Loading() {
  return <div className="flex justify-center py-10"><Spinner /></div>;
}

/** A note for cookieless sites, whose visitors can only be followed within a day. */
function CookielessNote({ site }: { site: SiteDTO }) {
  if (site.idMode !== "cookieless") return null;
  return (
    <p className="px-4 pb-4 text-xs text-muted">
      This site is cookieless, so a visitor can only be followed within one day. For journeys over several days, switch Visitor identification to "Recognise returning visitors" or "After consent" in Settings.
    </p>
  );
}

// ---- Peak hours ---------------------------------------------------------------------------------

export function PeakHoursCard({ siteId, view, site, revenue }: { siteId: string; view: SiteView; site: SiteDTO; revenue: boolean }) {
  const [metric, setMetric] = useState<PeakMetric>("visits");
  const query = { ...viewQuery(view), metric };
  const data = useQuery({ queryKey: keys.siteData(siteId, "peak-hours", query), queryFn: () => call(api.sites[":id"]["peak-hours"].$get({ param: { id: siteId }, query })) });
  const d = data.data;
  const max = d ? Math.max(0, ...d.cells.flat()) : 0;
  const fmt = (v: number) => (d?.metric === "revenue" ? money(v, site.currency, true) : num(v));
  const isTop = (day: number, hour: number) => d?.top.findIndex((t) => t.day === day && t.hour === hour) ?? -1;
  return (
    <Card>
      <CardHeader
        title="Peak hours"
        description={`When ${metric === "visits" ? "visits start" : "buyers pay"}, by weekday and hour (${site.timezone}).`}
        action={revenue ? (
          <Segmented<PeakMetric> label="Peak hours metric" value={metric} onChange={setMetric} options={[{ value: "visits", label: "Visits" }, { value: "sales", label: "Sales" }, { value: "revenue", label: "Revenue" }]} />
        ) : undefined}
      />
      {data.isPending ? (
        <Loading />
      ) : data.isError ? (
        <div className="px-4 pb-4"><Notice tone="danger">{data.error.message}</Notice></div>
      ) : !d || !d.total ? (
        <Empty title={metric === "visits" ? "No visits in this period" : "No sales in this period"} />
      ) : (
        <div className="px-4 pb-4">
          {/* relative: the cells' screen-reader numbers are absolutely positioned and must stay inside the scroller. */}
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[640px] table-fixed border-separate border-spacing-[3px] text-xs" aria-label={`Peak hours: ${metric}`}>
              <thead>
                <tr>
                  <th className="w-10" />
                  {Array.from({ length: 24 }, (_, h) => (
                    <th key={h} scope="col" className="font-normal text-muted">{h % 3 === 0 ? h : ""}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {d.cells.map((row, day) => (
                  <tr key={day}>
                    <th scope="row" className="pr-1 text-left font-normal text-muted">{DAYS[day]}</th>
                    {row.map((v, hour) => {
                      const rank = isTop(day, hour);
                      const share = max ? v / max : 0;
                      return (
                        <td
                          key={hour}
                          title={`${DAYS[day]} ${hourLabel(hour)}: ${fmt(v)}`}
                          className={cn("h-6 rounded-[3px]", rank >= 0 && "outline-2 outline-offset-1 outline-fg")}
                          style={{ background: v ? `color-mix(in srgb, var(--accent) ${Math.round(12 + share * 88)}%, var(--surface-2))` : "var(--surface-2)" }}
                        >
                          <span className="sr-only">{fmt(v)}</span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-sm">
            <span className="text-muted">Busiest: </span>
            {d.top.map((t, i) => (
              <span key={`${t.day}-${t.hour}`}>
                {i ? ", " : ""}
                <span className="font-medium">{DAYS[t.day]} {hourLabel(t.hour)}</span> <span className="tabular text-muted">({fmt(t.value)})</span>
              </span>
            ))}
            {metric === "visits" && d.top[0] ? <span className="text-muted">. Posting an hour or two before {DAYS[d.top[0].day]} {hourLabel(d.top[0].hour)} catches the rise.</span> : null}
          </p>
        </div>
      )}
    </Card>
  );
}

// ---- Reading engagement -----------------------------------------------------------------------------

type Readers = "all" | "buyers" | "others";

export function EngagementCard({ siteId, view, revenue, aeAvailable }: { siteId: string; view: SiteView; revenue: boolean; aeAvailable: boolean }) {
  const [who, setWho] = useState<Readers>("all");
  const query = viewQuery(view);
  const data = useQuery({ queryKey: keys.siteData(siteId, "engagement", query), queryFn: () => call(api.sites[":id"].engagement.$get({ param: { id: siteId }, query })), enabled: aeAvailable });
  const rows: EngagementRow[] = data.data?.[who] ?? [];
  return (
    <Card>
      <CardHeader
        title="Reading"
        description="Time on each page while the tab was visible and the visitor active, and how far they scrolled."
        action={revenue ? (
          <Segmented<Readers> label="Readers" value={who} onChange={setWho} options={[{ value: "all", label: "Everyone" }, { value: "buyers", label: "Buyers" }, { value: "others", label: "Non-buyers" }]} />
        ) : undefined}
      />
      {!aeAvailable || data.data?.available === false ? (
        <Empty title="Needs Analytics Engine">{data.data?.error ?? "Reading data is read from Analytics Engine; set CF_ANALYTICS_TOKEN."}</Empty>
      ) : data.isPending ? (
        <Loading />
      ) : !rows.length ? (
        <Empty title="No reading data in this period">It's sent when a visitor leaves a page or switches tabs.</Empty>
      ) : (
        <div className="overflow-x-auto px-4 pb-4">
          <table className="block w-full text-sm sm:table">
            <thead className="hidden text-left text-xs text-muted sm:table-header-group">
              <tr>
                <th className="py-1.5 font-medium">Page</th>
                <th className="py-1.5 text-right font-medium">Visits</th>
                <th className="py-1.5 text-right font-medium" title="Half the visits read longer, half shorter">Median time</th>
                <th className="py-1.5 text-right font-medium">Avg scroll</th>
                <th className="py-1.5 text-right font-medium" title="Share of visits that scrolled at least 75% of the page">Read 75%+</th>
              </tr>
            </thead>
            <tbody className="block sm:table-row-group">
              {rows.slice(0, 25).map((r) => (
                <tr key={r.path} className={ROW}>
                  <td className={PATH_CELL} title={r.path}>{r.path}</td>
                  <td className={NUM_CELL}><CellLabel>Visits</CellLabel>{num(r.visits)}</td>
                  <td className={NUM_CELL}><CellLabel>Median</CellLabel>{duration(r.medianSec)}</td>
                  <td className={NUM_CELL}><CellLabel>Scroll</CellLabel>{r.avgScroll ? `${r.avgScroll}%` : "–"}</td>
                  <td className={NUM_CELL}><CellLabel>Read 75%+</CellLabel>{r.avgScroll ? percent(r.deepShare) : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ---- Page speed --------------------------------------------------------------------------------------

type Vital = keyof typeof VITALS_THRESHOLDS;
const VITAL_INFO: Record<Vital, { label: string; short: string; hint: string }> = {
  lcpMs: { label: "Loading (LCP)", short: "Loading", hint: "Largest contentful paint: when the main content appeared." },
  inpMs: { label: "Responsiveness (INP)", short: "Response", hint: "The slowest reaction to a click, tap or key press." },
  cls: { label: "Visual stability (CLS)", short: "Stability", hint: "How much the page jumped around while loading." },
};
const RATING = {
  good: { label: "Good", cls: "text-good", dot: "bg-good" },
  needs: { label: "Needs work", cls: "text-warn", dot: "bg-warn" },
  poor: { label: "Poor", cls: "text-danger", dot: "bg-danger" },
} as const;

function rate(key: Vital, v: number): keyof typeof RATING {
  const [good, poor] = VITALS_THRESHOLDS[key];
  return v <= good ? "good" : v < poor ? "needs" : "poor";
}

function vitalText(key: Vital, v: number | null): string {
  if (v === null) return "–";
  if (key === "cls") return v.toFixed(2);
  return v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${num(v)} ms`;
}

function VitalCell({ k, v }: { k: Vital; v: number | null }) {
  if (v === null) return <span className="text-subtle">–</span>;
  const r = RATING[rate(k, v)];
  return (
    <span className={cn("inline-flex items-center gap-1.5", r.cls)} title={r.label}>
      <span className={cn("size-1.5 rounded-full", r.dot)} aria-hidden />
      {vitalText(k, v)}
    </span>
  );
}

/** Core Web Vitals at the 75th percentile, the way Google judges a page, measured by the tracker on real visits. */
export function PageSpeedCard({ siteId, view, aeAvailable }: { siteId: string; view: SiteView; aeAvailable: boolean }) {
  const query = viewQuery(view);
  const data = useQuery({ queryKey: keys.siteData(siteId, "page-speed", query), queryFn: () => call(api.sites[":id"]["page-speed"].$get({ param: { id: siteId }, query })), enabled: aeAvailable });
  const overall: VitalsRow | null = data.data?.overall ?? null;
  const pages = data.data?.pages ?? [];
  return (
    <Card>
      <CardHeader title="Page speed" description="Core Web Vitals from real visits, at the 75th percentile (three in four loads were this fast or faster). Measured on the page a visit opened." />
      {!aeAvailable || data.data?.available === false ? (
        <Empty title="Needs Analytics Engine">{data.data?.error ?? "Page speed is read from Analytics Engine; set CF_ANALYTICS_TOKEN."}</Empty>
      ) : data.isPending ? (
        <Loading />
      ) : !overall ? (
        <Empty title="No page speed data in this period">The tracker measures it automatically and sends it when a visitor leaves the page. Browsers without the APIs (older Safari) don't report it.</Empty>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2 px-4 pb-4 sm:gap-3">
            {(Object.keys(VITAL_INFO) as Vital[]).map((k) => {
              const v = overall[k];
              const r = v === null ? null : RATING[rate(k, v)];
              return (
                <div key={k} className="min-w-0 rounded-lg border border-line p-2.5 sm:p-3" title={VITAL_INFO[k].hint}>
                  <p className="text-xs text-muted">
                    <span className="sm:hidden">{VITAL_INFO[k].short}</span>
                    <span className="hidden sm:inline">{VITAL_INFO[k].label}</span>
                  </p>
                  <p className="tabular text-lg font-semibold whitespace-nowrap text-fg sm:text-xl">{vitalText(k, v)}</p>
                  <p className={cn("text-xs font-medium", r?.cls ?? "text-subtle")}>{r?.label ?? "Not measured"}</p>
                </div>
              );
            })}
          </div>
          <div className="overflow-x-auto px-4 pb-4">
            <table className="block w-full text-sm sm:table">
              <thead className="hidden text-left text-xs text-muted sm:table-header-group">
                <tr>
                  <th className="py-1.5 font-medium">Page</th>
                  <th className="py-1.5 text-right font-medium">Loads</th>
                  <th className="py-1.5 text-right font-medium">LCP</th>
                  <th className="py-1.5 text-right font-medium">INP</th>
                  <th className="py-1.5 text-right font-medium">CLS</th>
                </tr>
              </thead>
              <tbody className="block sm:table-row-group">
                {pages.slice(0, 25).map((r) => (
                  <tr key={r.path} className={ROW}>
                    <td className={PATH_CELL} title={r.path}>{r.path}</td>
                    <td className={NUM_CELL}><CellLabel>Loads</CellLabel>{num(r.loads)}</td>
                    <td className={NUM_CELL}><CellLabel>LCP</CellLabel><VitalCell k="lcpMs" v={r.lcpMs} /></td>
                    <td className={NUM_CELL}><CellLabel>INP</CellLabel><VitalCell k="inpMs" v={r.inpMs} /></td>
                    <td className={NUM_CELL}><CellLabel>CLS</CellLabel><VitalCell k="cls" v={r.cls} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}

// ---- Path to purchase -----------------------------------------------------------------------------------

export function PurchasePathCard({ siteId, view, site }: { siteId: string; view: SiteView; site: SiteDTO }) {
  const query = viewQuery(view);
  const data = useQuery({ queryKey: keys.siteData(siteId, "purchase-paths", query), queryFn: () => call(api.sites[":id"]["purchase-paths"].$get({ param: { id: siteId }, query })) });
  const d = data.data;
  if (d && !d.customers) return null;
  const hours = d?.medianHoursToBuy ?? null;
  const tiles = d
    ? [
        { label: "Time to buy", value: hours === null ? "–" : hours < 1 ? `${Math.max(1, Math.round(hours * 60))}m` : hours < 48 ? `${Math.round(hours)}h` : `${Math.round(hours / 24)} days`, note: "Median, from the first visit" },
        { label: "Visits before buying", value: d.medianVisits === null ? "–" : String(Math.round(d.medianVisits * 10) / 10), note: "Median, including the visit that bought" },
        { label: "Bought on the first visit", value: percent(d.firstVisitShare), note: `Of ${num(d.customers)} new customer${d.customers === 1 ? "" : "s"}` },
      ]
    : [];
  return (
    <Card>
      <CardHeader title="Path to purchase" description="New customers in this period: how long they took, and where they first came from against the visit credited with the sale." />
      {data.isPending ? (
        <Loading />
      ) : d ? (
        <>
          <div className="grid gap-4 px-4 pb-4 sm:grid-cols-3">
            {tiles.map((t) => (
              <div key={t.label} className="rounded-md border border-line px-4 py-3">
                <p className="text-xs text-muted">{t.label}</p>
                <p className="tabular mt-1 text-xl font-semibold tracking-tight">{t.value}</p>
                <p className="mt-0.5 text-xs text-muted">{t.note}</p>
              </div>
            ))}
          </div>
          <div className="grid gap-4 px-4 pb-4 lg:grid-cols-2">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted">
                  <tr><th className="py-1.5 font-medium">Found by</th><th className="py-1.5 font-medium">Credited to</th><th className="py-1.5 text-right font-medium">Customers</th><th className="py-1.5 text-right font-medium">Revenue</th></tr>
                </thead>
                <tbody>
                  {d.pairs.map((p) => (
                    <tr key={`${p.found}|${p.credited}`} className="border-t border-line">
                      <td className="py-2">{dimValue("source", p.found)}</td>
                      <td className={cn("py-2", p.found === p.credited && "text-muted")}>{p.found === p.credited ? "same" : dimValue("source", p.credited)}</td>
                      <td className="tabular py-2 text-right">{num(p.customers)}</td>
                      <td className="tabular py-2 text-right">{money(p.revenue, site.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted">
                  <tr><th className="py-1.5 font-medium">Landing pages before buying</th><th className="py-1.5 text-right font-medium">Customers</th></tr>
                </thead>
                <tbody>
                  {d.pages.map((p) => (
                    <tr key={p.path} className="border-t border-line">
                      <td className="max-w-[18rem] truncate py-2" title={p.path}>{p.path}</td>
                      <td className="tabular py-2 text-right">{num(p.customers)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <CookielessNote site={site} />
        </>
      ) : null}
    </Card>
  );
}

// ---- Lifetime value -------------------------------------------------------------------------------------------

export function LifetimeValueCard({ siteId, view, site }: { siteId: string; view: SiteView; site: SiteDTO }) {
  const query = viewQuery(view);
  const data = useQuery({ queryKey: keys.siteData(siteId, "customer-value", query), queryFn: () => call(api.sites[":id"]["customer-value"].$get({ param: { id: siteId }, query })) });
  const d = data.data;
  if (d && !d.customers) return null;
  return (
    <Card>
      <CardHeader
        title="Customer value by first source"
        description="Customers whose first payment is in this period, with everything they've paid since (renewals, upgrades and repeat purchases, less refunds), by where their first visit came from."
      />
      {data.isPending ? (
        <Loading />
      ) : d ? (
        <>
          <div className="overflow-x-auto px-4 pb-4">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="py-1.5 font-medium">First source</th>
                  <th className="py-1.5 text-right font-medium">Customers</th>
                  <th className="py-1.5 text-right font-medium">Lifetime revenue</th>
                  <th className="py-1.5 text-right font-medium">Per customer</th>
                  <th className="py-1.5 text-right font-medium" title="Customers who paid more than once">Paid again</th>
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr key={`${r.channel}|${r.source}`} className="border-t border-line">
                    <td className="py-2">
                      <span className="font-medium">{r.source ? dimValue("source", r.source) : "Not matched to a visit"}</span>
                      {r.channel ? <span className="ml-2 text-xs text-muted">{r.channel}</span> : null}
                    </td>
                    <td className="tabular py-2 text-right">{num(r.customers)}</td>
                    <td className="tabular py-2 text-right">{money(r.lifetimeRevenue, site.currency)}</td>
                    <td className="tabular py-2 text-right">{money(r.avgValue, site.currency)}</td>
                    <td className="tabular py-2 text-right">{percent(r.repeatShare)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <CookielessNote site={site} />
        </>
      ) : null}
    </Card>
  );
}
