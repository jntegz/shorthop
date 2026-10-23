import { useQuery } from "@tanstack/react-query";
import { ArrowDownToLine, ArrowRight, ArrowUpRight, BarChart3, CalendarDays, Link2, Plus, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import type { Period } from "../../shared/types";
import { api, call, keys } from "../api";
import { Breakdown, ClicksChart, StatTiles } from "../components/Charts";
import { DownloadButton } from "../components/DownloadButton";
import { LinkForm } from "../components/LinkForm";
import { PeriodPicker, periodParams, periodQuery } from "../components/PeriodPicker";
import { SystemStatus } from "../components/SystemStatus";
import { CHECK_STYLE } from "../components/CheckBadge";
import { Button, buttonClass, Card, CardHeader, Empty, Notice, PageHeader, Spinner } from "../components/ui";
import { day, hostOf, num } from "../lib/format";
import { linkKey, linkPath, useLinkLabel } from "../lib/links";
import { cn } from "../lib/utils";

/** One line on whether destinations still load, linking to the matching filter. */
function DestinationSummary({ down, warning, total }: { down: number; warning: number; total: number }) {
  if (!total) return null;
  const state = down ? "down" : warning ? "warning" : "ok";
  const Icon = CHECK_STYLE[state].icon;
  const text = down
    ? `${num(down)} ${down === 1 ? "destination isn't" : "destinations aren't"} working`
    : warning
      ? `${num(warning)} ${warning === 1 ? "destination is" : "destinations are"} being rechecked`
      : `All ${num(total)} checked destinations load`;
  return (
    <Link to={state === "ok" ? "/health" : `/health?state=${state}`} className="mx-5 mb-3 flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm hover:border-accent/40">
      <Icon className={cn("size-4 shrink-0", CHECK_STYLE[state].text)} aria-hidden />
      <span className="min-w-0 flex-1 truncate text-fg">{text}</span>
      <ArrowUpRight className="size-3.5 shrink-0 text-subtle" aria-hidden />
    </Link>
  );
}

export function Dashboard() {
  const [period, setPeriod] = useState<Period>({ range: "30d" });
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const label = useLinkLabel();
  const overview = useQuery({ queryKey: keys.overview(period), queryFn: () => call(api.stats.overview.$get({ query: periodQuery(period) })) });
  const misses = useQuery({ queryKey: keys.misses({ range: "7d" }), queryFn: () => call(api.stats.misses.$get({ query: { range: "7d" } })) });
  const o = overview.data;
  const maxTop = Math.max(1, ...(o?.topLinks.map((l) => l.clicks) ?? [1]));
  const humanMisses = misses.data?.rows.filter((r) => r.hits > 0 && !r.probe).slice(0, 5) ?? [];
  const checks = useQuery({ queryKey: keys.checks, queryFn: () => call(api.checks.$get()) });
  const failing = (state: "down" | "warning") => checks.data?.items.filter((i) => i.state === state).length ?? 0;

  return <>
    <PageHeader title="A little link. A bigger picture." description="See where your links go, and who they bring closer."
      actions={<><Link to="/stats" className={buttonClass({ variant: "outline" })}><BarChart3 /> Full statistics</Link><DownloadButton href={`/_admin/api/stats/export.csv?${periodParams(period)}`} title="Export saved daily statistics (completed days)"><ArrowDownToLine /> Export</DownloadButton><Button onClick={() => setCreating(true)}><Plus /> Create link</Button></>} />
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2 text-xs text-muted"><CalendarDays className="size-4" />{o ? `${day(o.from)} – ${day(o.to)}` : "Your link performance"}<span className="rounded-md border border-line bg-surface px-1.5 py-0.5 text-[10px]">UTC</span></div>
      <PeriodPicker value={period} onChange={setPeriod} />
    </div>
    {o && !o.aeAvailable && <div className="mb-5"><Notice tone="accent"><span className="font-medium">Showing saved analytics.</span> Today’s live data is not connected. <Link to="/settings#statistics" className="font-medium underline underline-offset-2">Review setup</Link></Notice></div>}
    {overview.isPending ? <div className="flex justify-center py-24"><Spinner /></div>
      : overview.isError ? <Notice tone="danger">{overview.error.message} <button className="ml-2 underline" onClick={() => void overview.refetch()}>Try again</button></Notice>
      : o ? <div className="space-y-5">
        <StatTiles totals={o.totals} comparison={o.comparison} />
        <ClicksChart series={o.series} liveAvailable={o.aeAvailable} title="Your audience, over time" previous={o.comparison?.series} />
        <div className="grid gap-5 xl:grid-cols-3">
          <Card className="xl:col-span-2">
            <CardHeader title="Your top-performing links" description="Ranked by human clicks in this period" action={<Link to="/links" className="inline-flex items-center gap-1 text-xs font-medium text-accent">All links <ArrowRight className="size-3.5" /></Link>} />
            {!o.topLinks.length ? <Empty icon={<Link2 />} title="Your next connection starts here"><p>Share your first link to start learning about your audience.</p><Button className="mt-4" onClick={() => setCreating(true)}><Plus /> Create a link</Button></Empty>
              : <div className="px-5 pb-3">
                <div className="mb-1 flex justify-between border-b border-line pb-2 text-[10px] font-semibold tracking-wider text-subtle"><span>LINK / DESTINATION</span><span>CLICKS</span></div>
                <ul>{o.topLinks.slice(0, 5).map((l, i) => <li key={linkKey(l.domain, l.slug)} className="border-b border-line last:border-0">
                  <Link to={linkPath(l)} className="group flex items-center gap-3 rounded-lg py-3.5 hover:bg-bg">
                    <span className="w-3 text-[11px] text-subtle">{i + 1}</span>
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-line bg-bg text-accent"><Link2 className="size-4" /></span>
                    <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-fg">{label(l)}</p><p className="mt-0.5 truncate text-xs text-muted">{l.target ? hostOf(l.target) : "Deleted link"}</p></div>
                    <div className="hidden w-20 sm:block"><div className="h-1.5 rounded-full bg-accent-soft"><div className="h-full rounded-full bg-series-1" style={{ width: `${l.clicks / maxTop * 100}%` }} /></div></div>
                    <span className="tabular w-14 text-right text-sm font-semibold">{num(l.clicks)}</span><ArrowUpRight className="size-3.5 text-subtle group-hover:text-accent" />
                  </Link>
                </li>)}</ul>
              </div>}
          </Card>
          <Breakdown title="Traffic sources" description="Where your audience finds you" rows={o.sources} kind="source" limit={5} />
        </div>
        <div className="grid gap-5 lg:grid-cols-3">
          <Breakdown title="Around the world" description="Human clicks by country" rows={o.countries} kind="country" limit={5} />
          <Breakdown title="Devices" description="How your audience connects" rows={o.devices} kind="device" limit={5} />
          <Card>
            <CardHeader title="Link health" description="Destinations · Missing links in the last 7 days" action={<Link to="/health" className="text-accent" aria-label="View link health"><ArrowUpRight className="size-4" /></Link>} />
            {checks.data ? <DestinationSummary down={failing("down")} warning={failing("warning")} total={checks.data.items.length} /> : null}
            {misses.isPending ? <div className="flex justify-center py-8"><Spinner /></div>
              : misses.isError ? <div className="px-5 pb-5 text-sm text-muted">Link health couldn’t load. <button className="text-accent underline" onClick={() => void misses.refetch()}>Retry</button></div>
              : humanMisses.length === 0 ? <Empty icon={<ShieldCheck />} title="Looking good"><p>No missing links in the available data this week.</p></Empty>
              : <ul className="space-y-2 px-5 pb-5">{humanMisses.map((m) => <li key={linkKey(m.domain, m.slug)} className="flex items-center gap-2 rounded-lg bg-bg px-3 py-2 text-sm"><span className="min-w-0 flex-1 truncate font-mono text-xs">{label(m)}</span><span className="tabular font-medium">{num(m.hits)}</span><span className="text-xs text-muted">visits</span></li>)}</ul>}
          </Card>
        </div>
      </div> : null}
    {/* Outside the stats block: it matters most when the stats fail to load. */}
    <div className="mt-5"><SystemStatus /></div>
    <LinkForm open={creating} onOpenChange={setCreating} onSaved={(l) => navigate(linkPath(l))} />
  </>;
}
