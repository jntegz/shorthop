// Recent hits. Opens on the live map; the list of individual hits is the
// second view (?view=list), with its filters in the URL. Nothing here is
// stored: Cloudflare keeps raw hits for 90 days.

import { useQuery } from "@tanstack/react-query";
import { Search, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { IMPORT_SLUG_RE } from "../../../shared/slug";
import { api, call, keys } from "../../api";
import { countryName, sourceLabel, when } from "../../lib/format";
import { linkPath, useDomains, useLinkLabel } from "../../lib/links";
import { Button, Empty, ErrorState, Segmented, Select, Skeleton, Table, TD, TH, TextButton } from "../ui";
import { liveInterval, StatsFreshness } from "./freshness";
// The page opens on the map, so the globe (cobe, about 6 kB) comes with it rather than after it.
import { LiveMap } from "./LiveMap";
import { NeedsLiveData } from "./NeedsLiveData";

const WINDOWS = [
  { value: "1", label: "Last hour" },
  { value: "24", label: "Last 24 hours" },
  { value: "168", label: "Last 7 days" },
  { value: "720", label: "Last 30 days" },
];
const LIMITS = ["50", "100", "200"] as const;
const DEFAULTS = { hours: "168", limit: "50" } as const;

type View = "map" | "list";

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

export function HitsPage() {
  const [params, setParams] = useSearchParams();
  // The live map comes first; the list is one click away.
  const view: View = params.get("view") === "list" ? "list" : "map";
  const setView = (v: View) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (v === "list") next.set("view", "list");
        else next.delete("view");
        return next;
      },
      { replace: true },
    );
  return (
    <div className="ui-page hits-page">
      <header className="ui-head">
        <div className="ui-head-main">
          <h1 className="ui-h1">Recent hits</h1>
          <p className="ui-head-sub hits-intro">
            {view === "map"
              ? "Where people are opening your links right now, to the nearest city. Refreshes every 30 seconds while you’re here."
              : "The latest visits to your short links, one row each, straight from Cloudflare Analytics Engine. Nothing is saved: Cloudflare keeps raw hits for 90 days."}
          </p>
        </div>
        <div className="ui-head-tools">
          <Segmented<View>
            label="View"
            value={view}
            onChange={setView}
            options={[
              { value: "map", label: "Live map", short: "Map" },
              { value: "list", label: "List" },
            ]}
          />
        </div>
      </header>
      {view === "map" ? <LiveMap /> : <HitList />}
    </div>
  );
}

function HitList() {
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
  const cleanDraft = draft.trim().replace(/^\/+/, "");
  const draftBad = cleanDraft !== "" && !IMPORT_SLUG_RE.test(cleanDraft);
  const applySlug = (e: FormEvent) => {
    e.preventDefault();
    if (draftBad) return;
    setParam("slug", cleanDraft);
  };
  const filtered = [...params.keys()].some((k) => k !== "view");
  const clear = () => {
    setDraft("");
    setParams({ view: "list" }, { replace: true });
  };
  const hits = recent.data?.hits ?? [];
  const countries = [...new Set([country, ...hits.map((h) => h.country)].filter(Boolean))].sort((a, b) => countryName(a).localeCompare(countryName(b)));
  const unavailable = recent.data ? !recent.data.aeAvailable : false;

  if (unavailable) return <NeedsLiveData />;

  return (
    <>
      <div className="hits-filters" role="search" aria-label="Filter hits">
        <form onSubmit={applySlug} className="hits-search">
          <label htmlFor="hits-slug" className="ui-sr">
            Filter by slug
          </label>
          <Search aria-hidden className="hits-search-icon" />
          <input
            id="hits-slug"
            type="search"
            className="ui-input"
            placeholder="Exact slug, then Enter…"
            value={draft}
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
            onChange={(e) => {
              setDraft(e.target.value);
              if (!e.target.value) setParam("slug", "");
            }}
            aria-invalid={draftBad || undefined}
            aria-describedby={draftBad ? "hits-slug-error" : undefined}
          />
          {draftBad ? (
            <p id="hits-slug-error" className="hits-search-error">
              A slug starts with a letter or digit, then letters, digits, “.”, “~”, “-” or “_”.
            </p>
          ) : null}
        </form>
        <div className="hits-fields">
          {multiple ? (
            <Select label="Domain" hideLabel className="hits-pill" value={domain} onChange={(e) => setParam("domain", e.target.value)} options={[{ value: "", label: "All domains" }, ...domains.map((d) => ({ value: d, label: d }))]} />
          ) : null}
          <Select
            label="Type"
            hideLabel
            className="hits-pill"
            value={event}
            onChange={(e) => setParam("event", e.target.value)}
            options={[
              { value: "", label: "Every type" },
              { value: "click", label: "Clicks" },
              { value: "bot", label: "Bots and previews" },
              { value: "miss", label: "Misses" },
            ]}
          />
          <Select label="Country" hideLabel className="hits-pill" value={country} onChange={(e) => setParam("country", e.target.value)} options={[{ value: "", label: "Any country" }, ...countries.map((c) => ({ value: c, label: countryName(c) }))]} />
          <Select
            label="Device"
            hideLabel
            className="hits-pill"
            value={device}
            onChange={(e) => setParam("device", e.target.value)}
            options={[
              { value: "", label: "Any device" },
              { value: "desktop", label: "Desktop" },
              { value: "mobile", label: "Mobile" },
              { value: "tablet", label: "Tablet" },
            ]}
          />
          <Select label="Time window" hideLabel className="hits-pill" value={hours} onChange={(e) => setParam("hours", e.target.value, DEFAULTS.hours)} options={WINDOWS} />
          <Select label="Rows" hideLabel className="hits-pill" value={limit} onChange={(e) => setParam("limit", e.target.value, DEFAULTS.limit)} options={LIMITS.map((l) => ({ value: l, label: `Latest ${l}` }))} />
        </div>
      </div>

      <div className="hits-meta">
        <StatsFreshness updatedAt={recent.dataUpdatedAt} fetching={recent.isFetching} onRefresh={() => void recent.refetch()} />
        {filtered ? (
          <TextButton onClick={clear}>
            <X aria-hidden className="hits-inline-icon" />
            Clear filters
          </TextButton>
        ) : null}
      </div>

      {recent.isPending ? (
        <HitsSkeleton />
      ) : recent.isError || recent.data.error ? (
        <ErrorState what="Recent hits" error={recent.isError ? recent.error : new Error(recent.data.error)} onRetry={() => void recent.refetch()} retrying={recent.isFetching} />
      ) : hits.length === 0 ? (
        filtered ? (
          <Empty title="No hits match these filters" action={<Button icon={X} onClick={clear}>Clear filters</Button>}>
            Try a longer time window, or clear the filters to see every hit.
          </Empty>
        ) : (
          <Empty title="No hits in this window">Visits to your short links show up here within a minute or two.</Empty>
        )
      ) : (
        <Table label="Recent hits, newest first" className="is-stack hits-table">
          <thead>
            <tr>
              <TH>Time</TH>
              <TH>Link</TH>
              <TH>Type</TH>
              <TH>Location</TH>
              <TH>Device</TH>
              <TH>Source</TH>
              <TH>Referrer</TH>
            </tr>
          </thead>
          <tbody>
            {hits.map((h, i) => (
              <tr key={`${h.time}-${i}`} data-event={h.event}>
                <TD className="hits-time" data-lead="">
                  {when(h.time)}
                </TD>
                <TD className="hits-link" data-title="">
                  {h.event === "miss" ? <span>{label(h)}</span> : <Link to={linkPath(h)}>{label(h)}</Link>}
                </TD>
                <TD data-label="Type" className="hits-type">
                  {h.event === "bot" ? (h.botName ? `Bot · ${h.botName}` : "Bot") : h.event === "miss" ? (h.scanner ? "Miss · scanner" : "Miss") : "Click"}
                </TD>
                <TD data-label="Location">
                  {h.country ? (
                    <button type="button" className="hits-cell-btn" title="Show only this country" onClick={() => setParam("country", h.country)}>
                      {h.city ? `${h.city}, ` : ""}
                      {countryName(h.country)}
                    </button>
                  ) : (
                    "—"
                  )}
                </TD>
                <TD data-label="Device" className="hits-dim">
                  {[cap(h.device), h.os, h.browser].filter(Boolean).join(" · ") || "—"}
                </TD>
                <TD data-label="Source">{sourceLabel(h.source || "direct")}</TD>
                <TD data-label="Referrer" className="hits-ref hits-dim" title={h.referrer || undefined}>
                  {h.referrer || "—"}
                </TD>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}

function HitsSkeleton() {
  return (
    <div className="hits-skel" aria-busy aria-label="Loading hits">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="hits-skel-row">
          <Skeleton className="ui-skel-text" style={{ width: 92 }} />
          <Skeleton className="ui-skel-text" style={{ width: `${30 - (i % 3) * 6}%` }} />
          <Skeleton className="ui-skel-text" style={{ width: `${22 + (i % 4) * 4}%` }} />
        </div>
      ))}
    </div>
  );
}
