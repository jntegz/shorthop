import { useQuery } from "@tanstack/react-query";
import { Activity, Search, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { IMPORT_SLUG_RE } from "../../shared/slug";
import { api, call, keys } from "../api";
import { liveInterval, StatsFreshness } from "../components/StatsFreshness";
import { Badge, Card, Empty, Input, Notice, PageHeader, Select, Spinner } from "../components/ui";
import { countryName, flag, sourceLabel, when } from "../lib/format";
import { linkPath, useDomains, useLinkLabel } from "../lib/links";

const WINDOWS = [
  { hours: "1", label: "Last hour" },
  { hours: "24", label: "Last 24 hours" },
  { hours: "168", label: "Last 7 days" },
  { hours: "720", label: "Last 30 days" },
] as const;
const LIMITS = ["50", "100", "200"] as const;
const DEFAULTS = { hours: "168", limit: "50" } as const;

/**
 * The latest individual hits, read live from Analytics Engine on every load.
 * Nothing here is stored: Cloudflare keeps raw hits for 90 days.
 */
export function RecentHits() {
  const [params, setParams] = useSearchParams();
  const label = useLinkLabel();
  const { domains, multiple } = useDomains();
  const get = (k: string) => params.get(k) ?? "";
  const event = get("event") as "" | "click" | "bot" | "miss";
  const device = get("device") as "" | "desktop" | "mobile" | "tablet";
  const country = get("country");
  const domain = get("domain");
  const slug = get("slug");
  const hours = get("hours") || DEFAULTS.hours;
  const limit = get("limit") || DEFAULTS.limit;
  const [draft, setDraft] = useState(slug);

  const setParam = (k: string, v: string, fallback = "") =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (v && v !== fallback) next.set(k, v);
        else next.delete(k);
        return next;
      },
      { replace: true },
    );

  const query = {
    limit,
    hours,
    ...(event ? { event } : {}),
    ...(device ? { device } : {}),
    ...(country ? { country } : {}),
    ...(domain ? { domain } : {}),
    ...(slug ? { slug } : {}),
  };
  const recent = useQuery({
    queryKey: [...keys.recent(domain, slug), query],
    queryFn: () => call(api.stats.recent.$get({ query })),
    refetchInterval: liveInterval({ range: "7d" }),
  });

  // The link box is applied on Enter, not per keystroke: each change is one Analytics Engine query.
  const applySlug = (e: FormEvent) => {
    e.preventDefault();
    const s = draft.trim().replace(/^\/+/, "");
    if (s && !IMPORT_SLUG_RE.test(s)) return;
    setParam("slug", s);
  };
  const filtered = [...params.keys()].length > 0;
  const hits = recent.data?.hits ?? [];
  const countries = [...new Set([country, ...hits.map((h) => h.country)].filter(Boolean))].sort((a, b) => countryName(a).localeCompare(countryName(b)));

  return (
    <>
      <PageHeader
        title="Recent hits"
        description="The latest visits to your short links, one row each, straight from Cloudflare Analytics Engine. Nothing is saved: Cloudflare keeps raw hits for 90 days."
      />

      <div className="mb-3 flex flex-wrap gap-2 rounded-2xl border border-line bg-surface p-3">
        <form onSubmit={applySlug} className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" />
          <Input
            type="search"
            placeholder="Exact slug, then Enter…"
            className="pl-9"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              if (!e.target.value) setParam("slug", "");
            }}
            aria-label="Filter by slug"
            aria-invalid={draft.trim() !== "" && !IMPORT_SLUG_RE.test(draft.trim().replace(/^\/+/, "")) ? true : undefined}
          />
        </form>
        {multiple ? (
          <Select className="w-auto" value={domain} onChange={(e) => setParam("domain", e.target.value)} aria-label="Filter by domain">
            <option value="">All domains</option>
            {domains.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </Select>
        ) : null}
        <Select className="w-auto" value={event} onChange={(e) => setParam("event", e.target.value)} aria-label="Filter by type">
          <option value="">Every type</option>
          <option value="click">Clicks</option>
          <option value="bot">Bots & previews</option>
          <option value="miss">Misses</option>
        </Select>
        <Select className="w-auto" value={country} onChange={(e) => setParam("country", e.target.value)} aria-label="Filter by country">
          <option value="">Any country</option>
          {countries.map((c) => (
            <option key={c} value={c}>
              {flag(c)} {countryName(c)}
            </option>
          ))}
        </Select>
        <Select className="w-auto" value={device} onChange={(e) => setParam("device", e.target.value)} aria-label="Filter by device">
          <option value="">Any device</option>
          <option value="desktop">Desktop</option>
          <option value="mobile">Mobile</option>
          <option value="tablet">Tablet</option>
        </Select>
        <Select className="w-auto" value={hours} onChange={(e) => setParam("hours", e.target.value, DEFAULTS.hours)} aria-label="Time window">
          {WINDOWS.map((w) => (
            <option key={w.hours} value={w.hours}>
              {w.label}
            </option>
          ))}
        </Select>
        <Select className="w-auto" value={limit} onChange={(e) => setParam("limit", e.target.value, DEFAULTS.limit)} aria-label="Rows">
          {LIMITS.map((l) => (
            <option key={l} value={l}>
              Latest {l}
            </option>
          ))}
        </Select>
      </div>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 text-xs text-muted">
        <StatsFreshness updatedAt={recent.dataUpdatedAt} fetching={recent.isFetching} onRefresh={() => void recent.refetch()} />
        {filtered ? (
          <button
            className="inline-flex items-center gap-1 text-accent"
            onClick={() => {
              setDraft("");
              setParams({}, { replace: true });
            }}
          >
            <X className="size-3" /> Clear filters
          </button>
        ) : null}
      </div>

      <Card>
        {recent.isPending ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : recent.isError || recent.data.error ? (
          <div className="p-5">
            <Notice tone="danger">Couldn’t load recent hits: {recent.isError ? recent.error.message : recent.data.error}</Notice>
          </div>
        ) : !recent.data.aeAvailable ? (
          <Empty title="Not available">Recent hits come from Analytics Engine, which isn’t configured here.</Empty>
        ) : hits.length === 0 ? (
          <Empty icon={<Activity />} title={filtered ? "No hits match these filters" : "No hits in this window"} />
        ) : (
          <div className="overflow-x-auto p-4">
            <table className="w-full min-w-[860px] text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="py-1.5 font-medium">Time</th>
                  <th className="py-1.5 font-medium">Link</th>
                  <th className="py-1.5 font-medium">Type</th>
                  <th className="py-1.5 font-medium">Location</th>
                  <th className="py-1.5 font-medium">Device</th>
                  <th className="py-1.5 font-medium">Source</th>
                  <th className="py-1.5 font-medium">Referrer</th>
                </tr>
              </thead>
              <tbody>
                {hits.map((h, i) => (
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
                      {h.event === "bot" ? (
                        <Badge tone="warn">{h.botName || "Bot"}</Badge>
                      ) : h.event === "miss" ? (
                        <Badge>{h.scanner ? "Miss · scanner" : "Miss"}</Badge>
                      ) : (
                        <Badge tone="good">Click</Badge>
                      )}
                    </td>
                    <td className="py-1.5">
                      {h.country ? (
                        <button className="text-left hover:text-accent" title="Show only this country" onClick={() => setParam("country", h.country)}>
                          {flag(h.country)} {h.city ? `${h.city}, ` : ""}
                          {countryName(h.country)}
                        </button>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="py-1.5 text-muted">
                      {h.device} · {h.os} · {h.browser}
                    </td>
                    <td className="py-1.5">{sourceLabel(h.source)}</td>
                    <td className="max-w-48 truncate py-1.5 text-muted" title={h.referrer}>
                      {h.referrer || "—"}
                    </td>
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
