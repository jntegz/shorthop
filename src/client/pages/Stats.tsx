import { useQuery } from "@tanstack/react-query";
import { ArrowDownToLine, ArrowLeft, ArrowUpRight, CalendarDays, Link2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import type { Period } from "../../shared/types";
import { api, call, keys } from "../api";
import { Breakdown, ClicksChart, StatTiles } from "../components/Charts";
import { DownloadButton } from "../components/DownloadButton";
import { includesToday, liveInterval, StatsFreshness } from "../components/StatsFreshness";
import { PeriodPicker, periodParams, periodQuery } from "../components/PeriodPicker";
import { Badge, Card, CardHeader, Empty, Notice, PageHeader, Spinner } from "../components/ui";
import { countryName, day, flag, hostOf, num, sourceLabel, when } from "../lib/format";
import { linkKey, linkPath, useLinkLabel } from "../lib/links";

/** Every statistic the link page has, for all links together. */
export function Stats() {
  const [period, setPeriod] = useState<Period>({ range: "30d" });
  const label = useLinkLabel();
  const stats = useQuery({ queryKey: keys.account(period), queryFn: () => call(api.stats.account.$get({ query: periodQuery(period) })), refetchInterval: liveInterval(period) });
  const recent = useQuery({
    queryKey: keys.recent(),
    queryFn: () => call(api.stats.recent.$get({ query: { limit: "50" } })),
    refetchInterval: liveInterval({ range: "7d" }),
  });
  const s = stats.data;
  const maxTop = Math.max(1, ...(s?.topLinks.map((l) => l.clicks) ?? [1]));

  return (
    <>
      <Link to="/" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" /> Overview
      </Link>
      <PageHeader
        title="Full statistics"
        description="Every link together: where your audience comes from, what they use, and when they click."
        actions={
          <DownloadButton href={`/_admin/api/stats/export.csv?${periodParams(period)}`} title="Export saved daily statistics (completed days)">
            <ArrowDownToLine /> Export
          </DownloadButton>
        }
      />
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs text-muted">
          <CalendarDays className="size-4" />
          {s ? `${day(s.from)} – ${day(s.to)}` : "All your links"}
          <span className="rounded-md border border-line bg-surface px-1.5 py-0.5 text-[10px]">UTC</span>
        </div>
        <PeriodPicker value={period} onChange={setPeriod} />
        {s?.aeAvailable && includesToday(period) ? (
          <StatsFreshness
            className="basis-full"
            updatedAt={stats.dataUpdatedAt}
            fetching={stats.isFetching || recent.isFetching}
            onRefresh={() => {
              void stats.refetch();
              void recent.refetch();
            }}
          />
        ) : null}
      </div>

      {s && !s.aeAvailable ? (
        <div className="mb-5">
          <Notice tone="accent">Showing saved analytics. Today’s live data is not connected.</Notice>
        </div>
      ) : null}

      {stats.isPending ? (
        <div className="flex justify-center py-24">
          <Spinner />
        </div>
      ) : stats.isError ? (
        <Notice tone="danger">{stats.error.message}</Notice>
      ) : s ? (
        <div className="space-y-4">
          <StatTiles totals={s.totals} comparison={s.comparison} />
          <ClicksChart series={s.series} liveAvailable={s.aeAvailable} title="All links, over time" previous={s.comparison?.series} />
          <Card>
            <CardHeader title="Top links" description="Ranked by human clicks in this period" />
            {!s.topLinks.length ? (
              <Empty icon={<Link2 />} title="No clicks in this period" />
            ) : (
              <ul className="px-5 pb-3">
                {s.topLinks.map((l, i) => (
                  <li key={linkKey(l.domain, l.slug)} className="border-b border-line last:border-0">
                    <Link to={linkPath(l)} className="group flex items-center gap-3 rounded-lg py-3 hover:bg-bg">
                      <span className="w-5 text-[11px] text-subtle">{i + 1}</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-fg">{label(l)}</p>
                        <p className="mt-0.5 truncate text-xs text-muted">{l.target ? hostOf(l.target) : "Deleted link"}</p>
                      </div>
                      <div className="hidden w-24 sm:block">
                        <div className="h-1.5 rounded-full bg-accent-soft">
                          <div className="h-full rounded-full bg-series-1" style={{ width: `${(l.clicks / maxTop) * 100}%` }} />
                        </div>
                      </div>
                      <span className="tabular w-16 text-right text-sm font-semibold">{num(l.clicks)}</span>
                      <span className="tabular hidden w-20 text-right text-xs text-muted sm:inline">{num(l.uniques)} unique</span>
                      <ArrowUpRight className="size-3.5 text-subtle group-hover:text-accent" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <Breakdown title="Countries" rows={s.dims.country} kind="country" />
            <Breakdown title="Cities" rows={s.dims.city} />
            <Breakdown title="Sources" description="?s= tag, in-app browser or referrer" rows={s.dims.source} kind="source" />
            <Breakdown title="Referrers" description="Most apps and email clients send none" rows={s.dims.referrer} kind="referrer" />
            <Breakdown title="Devices" rows={s.dims.device} kind="device" />
            <Breakdown title="Operating systems" rows={s.dims.os} />
            <Breakdown title="Browsers" rows={s.dims.browser} />
            <Breakdown title="Languages" rows={s.dims.language} kind="language" />
            <Breakdown title="Bots & link previews" description="Still redirected, never counted as clicks" rows={s.dims.bot} metric="bots" />
          </div>
        </div>
      ) : null}

      <Card className="mt-4">
        <CardHeader title="Recent hits" description="All links, last 7 days, newest first" />
        {recent.isPending ? (
          <div className="flex justify-center pb-6">
            <Spinner />
          </div>
        ) : !recent.data?.aeAvailable ? (
          <Empty title="Not available">Recent hits come from Analytics Engine, which isn’t configured here.</Empty>
        ) : recent.data.hits.length === 0 ? (
          <Empty title="No hits in the last 7 days" />
        ) : (
          <div className="overflow-x-auto px-4 pb-4">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="py-1.5 font-medium">Time</th>
                  <th className="py-1.5 font-medium">Link</th>
                  <th className="py-1.5 font-medium">Type</th>
                  <th className="py-1.5 font-medium">Location</th>
                  <th className="py-1.5 font-medium">Device</th>
                  <th className="py-1.5 font-medium">Source</th>
                </tr>
              </thead>
              <tbody>
                {recent.data.hits.map((h, i) => (
                  <tr key={`${h.time}-${i}`} className="border-t border-line">
                    <td className="py-1.5 whitespace-nowrap text-muted">{when(h.time)}</td>
                    <td className="py-1.5 font-mono text-xs break-all">
                      {h.event === "miss" ? (
                        label(h)
                      ) : (
                        <Link to={linkPath(h)} className="text-fg hover:text-accent">
                          {label(h)}
                        </Link>
                      )}
                    </td>
                    <td className="py-1.5">
                      {h.event === "bot" ? <Badge tone="warn">{h.botName || "Bot"}</Badge> : h.event === "miss" ? <Badge>Miss</Badge> : <Badge tone="good">Click</Badge>}
                    </td>
                    <td className="py-1.5">
                      {flag(h.country)} {h.city ? `${h.city}, ` : ""}
                      {countryName(h.country)}
                    </td>
                    <td className="py-1.5 text-muted">
                      {h.device} · {h.os} · {h.browser}
                    </td>
                    <td className="py-1.5">{sourceLabel(h.source)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
