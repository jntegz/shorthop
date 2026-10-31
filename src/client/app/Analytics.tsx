// The analytics home: overview and full statistics on one page. Big numbers,
// open two-column lists; the source ribbon heads the Sources section.

import { ChartBlock, DevicesPanel, EmptyNotice, Header, HealthLine, KpiStrip, LatestHits, MoneyPanel, OtherPanel, PlacesPanel, SourcesPanel, StatsError, TopLinks, useHome } from "./home";
import { PeakHours } from "./hits/PeakHours";
import { SystemStatus } from "./hits/SystemStatus";
import { Columns } from "./ui";

export function Analytics() {
  const h = useHome();
  // A period without a single hit: the notice and the zeros say it; no page of empty charts and lists.
  const empty = h.s ? h.s.totals.clicks + h.s.totals.bots === 0 : false;
  return (
    <div className="ui-page ui-home">
      <Header h={h} />
      {h.stats.isError ? (
        <StatsError h={h} />
      ) : (
        <>
          <EmptyNotice h={h} />
          <KpiStrip h={h} />
          {empty ? (
            <>
              <HealthLine h={h} />
              {h.money?.revenue ? (
                <Columns>
                  <MoneyPanel h={h} tabs="both" />
                </Columns>
              ) : null}
            </>
          ) : (
            <>
              <ChartBlock h={h} height={248} />
              <HealthLine h={h} />
              <Columns>
                <TopLinks h={h} limit={8} />
                <SourcesPanel h={h} limit={8} />
                <MoneyPanel h={h} tabs="both" />
                <PlacesPanel h={h} limit={6} />
                <DevicesPanel h={h} limit={6} />
                <OtherPanel h={h} limit={6} />
              </Columns>
            </>
          )}
          {/* Peak hours read Analytics Engine: drawn only when it's connected (as on the link page). */}
          {h.s?.aeAvailable ? <PeakHours /> : null}
          <LatestHits h={h} />
        </>
      )}
      {/* Outside the stats block: it matters most when the statistics fail to load. */}
      <SystemStatus />
    </div>
  );
}
