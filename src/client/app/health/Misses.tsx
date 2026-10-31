// Link health → Missed visits (/misses): the misses report for a period
// (keys.misses, kept in the URL, 7 days by default), filters for scanner
// probes and bot-only misses, sort and paging, Export CSV, clear one / probes
// / all, create a link from a miss (LinkForm), ignore a miss or send its
// visitors to one of your links, the Ignored list (un-ignore, create, clear,
// CSV export and import with papaparse), Tracking settings, and the latest
// misses as they were recorded.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, EyeOff, RefreshCw, Trash2, Upload } from "lucide-react";
import Papa from "papaparse";
import { useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import {
  DEFAULT_MISS_POLICY,
  MISS_RETENTION_DAYS,
  NOISE_LIMITS,
  REAL_MISS_LIMITS,
  SCANNER_PATHS_PER_DAY,
  type MissPolicy,
  type MissRow,
} from "../../../shared/types";
import { api, call, downloadFile, keys } from "../../api";
import { LinkForm } from "../../components/LinkForm";
import { periodParams, periodQuery } from "../../lib/period";
import { day, fullNum, num, when } from "../../lib/format";
import { MISSES_HELP } from "../../lib/help";
import { linkKey, linkPath, useDomains, useLinkLabel } from "../../lib/links";
import { useCan } from "../../lib/me";
import { PAGE_SIZES, pageOf, savedPageSize, savePageSize, sortRows, type PageSize, type SortDir } from "../../lib/table";
import { cn } from "../../lib/utils";
import { PeriodBar, rangeLabel } from "../parts";
import { Badge, Button, Checkbox, Dialog, Empty, ErrorState, errorText, IconButton, Notice, Pager, Section, Segmented, Select, Skeleton, SortTH, Switch, Table, TD, TextButton, TH, TR, type ButtonProps } from "../ui";
import { HealthTabs, HelpTip, keyToLink, LinkPicker, useMissPeriod } from "./parts";

type MissSort = "slug" | "hits" | "bots" | "lastSeen";
const MISS_SORT_VALUE: Record<MissSort, (r: MissRow) => string | number> = {
  slug: (r) => r.slug,
  hits: (r) => r.hits,
  bots: (r) => r.bots,
  // A number, so it sorts newest first by default.
  lastSeen: (r) => Date.parse(r.lastSeen) || 0,
};

const errorOf = (e: unknown) => errorText(e) ?? (e instanceof Error ? e.message : "That didn’t work. Try again.");
const retentionLabel = (d: number) => (d === 60 ? "2 months" : d === 90 ? "3 months" : `${d} days`);
const realLimitLabel = (n: number) => (n === 0 ? "No limit" : `${num(n)} paths`);
const PROBE_TITLE =
  "Automated scanners request paths like /.env, /wp-login.php or /config.json on every site, looking for leaked secrets or vulnerable software. They get the not-found page; nothing is exposed.";

/** One sentence on what the policy keeps. */
function policySummary(p: MissPolicy): string {
  const kinds = [p.trackHumans ? "human misses" : null, p.trackProbes ? "scanner probes" : null, p.trackBots ? "bot-only misses" : null].filter(Boolean);
  const tracked = kinds.length ? `Tracking ${kinds.join(", ").replace(/, ([^,]*)$/, " and $1")}` : "Not tracking any misses";
  return `${tracked}, kept ${retentionLabel(p.retentionDays)}.`;
}

/** A CSV download through the admin's fetch (it carries the session), busy while it runs. */
function ExportButton({ href, children, ...rest }: { href: string; children: ReactNode } & Omit<ButtonProps, "onClick" | "loading">) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      icon={Download}
      loading={busy}
      onClick={() => {
        setBusy(true);
        downloadFile(href)
          .catch((e: unknown) => toast.error(errorText(e) ?? "The export failed."))
          .finally(() => setBusy(false));
      }}
      {...rest}
    >
      {children}
    </Button>
  );
}

function TrackingDialog({ onClose, policy }: { onClose: () => void; policy: MissPolicy }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState(policy);
  const save = useMutation({
    mutationFn: () => call(api.stats.misses.policy.$put({ json: draft })),
    onSuccess: ({ removed }) => {
      onClose();
      toast.success("Miss tracking saved", removed ? { description: `Removed ${num(removed)} stored ${removed === 1 ? "path" : "paths"} outside the new settings.` } : undefined);
      void qc.invalidateQueries({ queryKey: ["stats", "misses"] });
    },
    onError: (e) => toast.error(errorOf(e)),
  });
  const set = <K extends keyof MissPolicy>(k: K, v: MissPolicy[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const turnedOff = (["trackHumans", "trackProbes", "trackBots"] as const).some((k) => policy[k] && !draft[k]);
  const noiseOptions = NOISE_LIMITS.map((n) => ({ value: String(n), label: `${n} paths` }));

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Miss tracking"
      description="Choose which kinds of misses are recorded and how much is kept."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <div className="health-form">
        <div className="health-group">
          <Switch
            id="track-humans"
            label="Track human misses"
            description="People opening a mistyped, deleted, disabled or expired link. On by default."
            checked={draft.trackHumans}
            onCheckedChange={(v) => set("trackHumans", v)}
          />
          {draft.trackHumans ? (
            <Select
              id="real-limit"
              label="Keep at most"
              hint="The most recently requested paths are kept."
              className="health-limit"
              value={String(draft.realLimit)}
              onChange={(e) => set("realLimit", Number(e.target.value) as MissPolicy["realLimit"])}
              options={REAL_MISS_LIMITS.map((n) => ({ value: String(n), label: realLimitLabel(n) }))}
            />
          ) : null}
        </div>
        <div className="health-group">
          <Switch
            id="track-probes"
            label="Track scanner probes"
            description="Paths vulnerability scanners try on every site, such as /.env or /wp-login.php."
            checked={draft.trackProbes}
            onCheckedChange={(v) => set("trackProbes", v)}
          />
          {draft.trackProbes ? (
            <Select id="probe-limit" label="Keep the most recent" className="health-limit" value={String(draft.probeLimit)} onChange={(e) => set("probeLimit", Number(e.target.value) as MissPolicy["probeLimit"])} options={noiseOptions} />
          ) : null}
        </div>
        <div className="health-group">
          <Switch
            id="track-bots"
            label="Track bot-only misses"
            description="Other paths that only bots, scripts and link checkers asked for."
            checked={draft.trackBots}
            onCheckedChange={(v) => set("trackBots", v)}
          />
          {draft.trackBots ? (
            <Select id="bot-limit" label="Keep the most recent" className="health-limit" value={String(draft.botLimit)} onChange={(e) => set("botLimit", Number(e.target.value) as MissPolicy["botLimit"])} options={noiseOptions} />
          ) : null}
        </div>
        <div className="health-group">
          <Select
            id="retention"
            label="Keep misses for"
            className="health-limit"
            value={String(draft.retentionDays)}
            onChange={(e) => set("retentionDays", Number(e.target.value) as MissPolicy["retentionDays"])}
            options={MISS_RETENTION_DAYS.map((d) => ({ value: String(d), label: retentionLabel(d) }))}
          />
          <p className="health-group-note">
            Saving removes stored misses outside these settings right away{turnedOff ? ", including everything of a kind you turn off" : ""}. Removed misses can’t be restored.
          </p>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * The latest missed requests as they were recorded, with how each was
 * classified: answers "I typed a wrong link, why isn't it in the table?".
 */
function LiveMisses() {
  const [open, setOpen] = useState(false);
  const label = useLinkLabel();
  const q = useQuery({
    queryKey: ["stats", "recent", "misses"],
    queryFn: () => call(api.stats.recent.$get({ query: { event: "miss", limit: "25" } })),
    enabled: open,
  });
  return (
    <Section
      className="health-section health-live"
      title={
        <span className="health-title">
          Latest misses, as recorded
          <HelpTip help={MISSES_HELP.live} />
        </span>
      }
      sub="Last 7 days, newest first. Shows how each request was classified."
      aside={
        <>
          {open ? (
            <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => void q.refetch()} loading={q.isFetching}>
              Refresh
            </Button>
          ) : null}
          <Button size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls="health-live-body">
            {open ? "Hide" : "Show"}
          </Button>
        </>
      }
    >
      <div id="health-live-body" hidden={!open}>
        {!open ? null : q.isPending ? (
          <RowsSkeleton rows={5} />
        ) : q.isError ? (
          <ErrorState what="Recent misses" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} compact />
        ) : q.data.error ? (
          <Notice tone="danger">Couldn’t load recent misses: {q.data.error}</Notice>
        ) : !q.data.aeAvailable ? (
          <Empty title="Not available" compact>
            Recent misses come from Analytics Engine, which isn’t configured here.
          </Empty>
        ) : q.data.hits.length === 0 ? (
          <Empty title="No misses recorded in the last 7 days" compact />
        ) : (
          <Table label="Latest misses" dense className="health-table health-live-table">
            <thead>
              <tr>
                <TH className="health-c-time">Time</TH>
                <TH className="health-c-slug">Requested slug</TH>
                <TH className="health-c-as">Counted as</TH>
                <TH className="health-c-device">Device</TH>
              </tr>
            </thead>
            <tbody>
              {q.data.hits.map((h, i) => (
                <TR key={`${h.time}-${i}`}>
                  <TD className="health-c-time">{when(h.time)}</TD>
                  <TD className="health-c-slug" data-title="">
                    <span className="health-slug">{label(h)}</span>
                  </TD>
                  <TD className="health-c-as">
                    {h.botName ? (
                      <Badge tone="warn">Bot: {h.botName}</Badge>
                    ) : h.scanner ? (
                      <span title={`This visitor missed ${SCANNER_PATHS_PER_DAY} or more different paths that day, so the report counts its visits as bot visits.`}>
                        <Badge tone="warn">Bot: scanner rule</Badge>
                      </span>
                    ) : (
                      <span className="health-quiet">Human</span>
                    )}
                  </TD>
                  <TD className="health-c-device">
                    {h.device} · {h.os} · {h.browser}
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </Section>
  );
}

function RowsSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="health-rows-skel" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="health-row-skel">
          <Skeleton className="ui-skel-text" style={{ width: `${30 + ((i * 17) % 35)}%` }} />
          <Skeleton className="ui-skel-text" style={{ width: 60 }} />
        </div>
      ))}
    </div>
  );
}

/** Why a path missed, in a few words; a badge only for what's news (expired, scanner). */
function WhyMissed({ r }: { r: MissRow }) {
  const label = useLinkLabel();
  if (r.link === "disabled") return <span className="health-quiet">Link is disabled</span>;
  if (r.link === "expired") return <Badge tone="warn">Link expired</Badge>;
  if (r.link === "active") return <span className="health-quiet">Created since</span>;
  if (r.probe)
    return (
      <span title={PROBE_TITLE}>
        <Badge tone="warn">Scanner probe</Badge>
      </span>
    );
  if (r.suggestion)
    return (
      <span className="health-quiet">
        Case differs from{" "}
        <Link to={linkPath({ domain: r.domain, slug: r.suggestion })} className="health-inline-link health-slug">
          {label({ domain: r.domain, slug: r.suggestion })}
        </Link>
      </span>
    );
  return <span className="health-quiet">No such link</span>;
}

export function MissesPage() {
  const [period, setPeriodState] = useMissPeriod();
  const [showBots, setShowBotsState] = useState(false);
  const [showProbes, setShowProbesState] = useState(false);
  const [sort, setSort] = useState<{ key: MissSort; dir: SortDir }>({ key: "hits", dir: "desc" });
  const [page, setPage] = useState(1);
  const [size, setSizeState] = useState<PageSize>(() => savedPageSize("misses"));
  // A new range, filter or order starts again on page 1.
  const setPeriod = (p: typeof period) => (setPeriodState(p), setPage(1));
  const setShowBots = (v: boolean) => (setShowBotsState(v), setPage(1));
  const setShowProbes = (v: boolean) => (setShowProbesState(v), setPage(1));
  const setSize = (n: PageSize) => (savePageSize("misses", n), setSizeState(n), setPage(1));
  const sortBy = (key: MissSort) => {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "slug" ? "asc" : "desc" }));
    setPage(1);
  };
  const [confirmClear, setConfirmClear] = useState<"all" | "probes" | MissRow | null>(null);
  const [tracking, setTracking] = useState(false);
  const [creating, setCreating] = useState<{ domain: string; slug: string } | null>(null);
  const [ignoring, setIgnoring] = useState<Pick<MissRow, "domain" | "slug"> | null>(null);
  const [view, setView] = useState<"misses" | "ignored">("misses");
  const qc = useQueryClient();
  const label = useLinkLabel();
  const can = useCan();
  const creates = can("links.create");
  const q = useQuery({ queryKey: keys.misses(period), queryFn: () => call(api.stats.misses.$get({ query: periodQuery(period) })) });
  const all = q.data?.rows ?? [];
  const policy = q.data?.policy ?? DEFAULT_MISS_POLICY;
  const probes = all.filter((r) => r.probe);
  const botOnly = all.filter((r) => !r.probe && r.hits === 0).length;
  const rows = all.filter((r) => (showProbes || !r.probe) && (showBots || r.hits > 0));
  const sorted = sortRows(rows, MISS_SORT_VALUE[sort.key], sort.dir);
  const paged = pageOf(sorted, page, size);
  const humans = rows.reduce((s, r) => s + r.hits, 0);

  const clear = useMutation({
    mutationFn: (target: "all" | "probes" | Pick<MissRow, "domain" | "slug">[]) =>
      call(
        api.stats.misses.clear.$post({
          json: target === "all" ? {} : target === "probes" ? { probes: true } : { links: target.map(({ domain, slug }) => ({ domain, slug })) },
        }),
      ),
    onSuccess: (_, target) => {
      setConfirmClear(null);
      toast.success(
        target === "all"
          ? "All misses cleared"
          : target === "probes"
            ? "Scanner probes cleared"
            : target.length === 1
              ? `${label(target[0]!)} cleared`
              : `${target.length} misses cleared`,
      );
      void qc.invalidateQueries({ queryKey: ["stats", "misses"] });
    },
    onError: (e) => toast.error(errorOf(e)),
  });

  /**
   * A link was created from a miss row: that miss is fixed, so clear it (from this second on, new misses show again).
   * You stay here, to fix the next one.
   */
  const createdFromMiss = (saved: { domain: string; slug: string }) => {
    if (creating && saved.domain === creating.domain && saved.slug === creating.slug) clearFixed(qc, saved);
    setCreating(null);
  };

  const confirmTitle = confirmClear === "probes" ? "Clear all scanner probes?" : confirmClear === "all" || confirmClear === null ? "Clear all misses?" : `Clear ${label(confirmClear)}?`;
  const confirmText =
    confirmClear === "probes"
      ? "Deletes the stored counts for every scanner probe, in every date range, including ones not listed here. Paths that match a link apart from case are kept. Scanner probes requested later today stay hidden; they show up again from tomorrow (UTC). This can’t be undone."
      : confirmClear === "all" || confirmClear === null
        ? "Deletes the stored counts for every missed path, in every date range. New visits show up again right away. This can’t be undone."
        : "Deletes this path’s stored counts, in every date range. New visits show up again right away (unusual paths, such as most scanner probes: from tomorrow, UTC). This can’t be undone.";

  return (
    <div className="ui-page health-page">
      <header className="ui-head">
        <div className="ui-head-main">
          <h1 className="ui-h1">Link health</h1>
          <p className="ui-head-sub">Visits to slugs that don't exist, have expired or are switched off.</p>
        </div>
        <div className="ui-head-tools">
          <ExportButton href={`/_admin/api/stats/misses/export.csv?${periodParams(period)}&probes=${showProbes ? 1 : 0}&bots=${showBots ? 1 : 0}`}>Export CSV</ExportButton>
        </div>
      </header>
      <HealthTabs />

      <PeriodBar value={period} onChange={setPeriod} custom className="health-period">
        {period.range === "custom" && period.from && period.to ? <>{rangeLabel(period.from, period.to)}, UTC. </> : null}
        {q.data ? policySummary(policy) : null}
        {can("settings.manage") ? (
          <>
            {" "}
            <TextButton onClick={() => setTracking(true)} disabled={!q.data}>
              Tracking settings
            </TextButton>
          </>
        ) : null}
      </PeriodBar>

      {q.data && !q.data.aeAvailable ? <Notice className="health-notice">Today’s misses aren’t available (Analytics Engine not configured). Completed days are shown.</Notice> : null}

      <Section
        className="health-section"
        title={view === "misses" ? "Missed paths" : "Ignored paths"}
        sub={
          view === "ignored"
            ? "Ignored paths leave the list and their visits aren’t counted. Bring one back, or give it a link."
            : q.data && rows.length
              ? `${fullNum(rows.length)} ${rows.length === 1 ? "path" : "paths"}, ${fullNum(humans)} human ${humans === 1 ? "visit" : "visits"}`
              : undefined
        }
        aside={
          q.data ? (
            <Segmented
              label="Show"
              size="sm"
              value={view}
              onChange={setView}
              options={[
                { value: "misses", label: "Misses" },
                { value: "ignored", label: `Ignored (${num(q.data.ignored)})` },
              ]}
            />
          ) : undefined
        }
      >
        {view === "ignored" && q.data ? (
          <IgnoredList onCreate={setCreating} />
        ) : (
          <>
            {q.data && (policy.trackProbes || probes.length || policy.trackBots || botOnly || all.length) ? (
              <div className="health-toolbar">
                <div className="health-toolbar-filters">
                  {policy.trackProbes || probes.length ? (
                    <Checkbox label={`Hide scanner probes${probes.length ? ` (${num(probes.length)})` : ""}`} checked={!showProbes} onCheckedChange={(v) => setShowProbes(!v)} />
                  ) : null}
                  {policy.trackBots || botOnly ? <Checkbox label={`Hide bot-only misses${botOnly ? ` (${num(botOnly)})` : ""}`} checked={!showBots} onCheckedChange={(v) => setShowBots(!v)} /> : null}
                </div>
                <div className="health-toolbar-acts">
                  {probes.length ? (
                    <Button size="sm" onClick={() => setConfirmClear("probes")}>
                      Clear scanner probes
                    </Button>
                  ) : null}
                  <Button size="sm" icon={Trash2} onClick={() => setConfirmClear("all")} disabled={all.length === 0}>
                    Clear all
                  </Button>
                </div>
              </div>
            ) : null}
            {q.isPending ? (
              <RowsSkeleton />
            ) : q.isError ? (
              <ErrorState what="Missed visits" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
            ) : rows.length === 0 ? (
              <Empty title="No misses in this period">{all.length ? "Only scanner probes and bots missed. Untick the filters above to see them." : "Every human visit landed on a working link."}</Empty>
            ) : (
              <Table label="Missed paths" className="health-table health-miss-table">
                <thead>
                  <tr>
                    <SortTH label="Requested slug" className="health-c-slug" active={sort.key === "slug"} dir={sort.dir} onSort={() => sortBy("slug")} />
                    <SortTH label="Human visits" short="Humans" numeric className="health-c-num health-c-hits" active={sort.key === "hits"} dir={sort.dir} onSort={() => sortBy("hits")} />
                    <SortTH label="Bots" numeric className="health-c-num health-c-bots" active={sort.key === "bots"} dir={sort.dir} onSort={() => sortBy("bots")} />
                    <SortTH label="Last seen" className="health-c-seen" active={sort.key === "lastSeen"} dir={sort.dir} onSort={() => sortBy("lastSeen")} />
                    <TH className="health-c-why">Why it missed</TH>
                    <TH className="health-c-act">
                      <span className="ui-sr">Actions</span>
                    </TH>
                  </tr>
                </thead>
                <tbody>
                  {paged.rows.map((r) => (
                    <TR key={linkKey(r.domain, r.slug)}>
                      <TD className="health-c-slug" data-title="">
                        <span className="health-slug">{label(r)}</span>
                      </TD>
                      <TD numeric className="health-c-num" data-lead="">
                        {fullNum(r.hits)}
                        <span className="health-phone-label"> human</span>
                      </TD>
                      <TD numeric className="health-c-num is-2" data-label="Bots">
                        {fullNum(r.bots)}
                        <span className="health-phone-label">{r.bots === 1 ? " bot" : " bots"}</span>
                      </TD>
                      <TD className="health-c-seen" data-label="Last seen">
                        <span className="health-phone-label">Last seen </span>
                        {day(r.lastSeen)}
                      </TD>
                      <TD className="health-c-why" data-label="Why">
                        <WhyMissed r={r} />
                      </TD>
                      <TD className="health-c-act">
                        <div className="health-acts">
                          {r.link === "none" ? (
                            r.probe || !creates ? null : (
                              <Button size="sm" onClick={() => setCreating({ domain: r.domain, slug: r.slug })}>
                                Create link
                              </Button>
                            )
                          ) : (
                            <Link to={linkPath(r)} className="health-inline-link health-open">
                              Open<span className="ui-sr"> {label(r)}</span>
                            </Link>
                          )}
                          {r.link === "none" ? <IconButton size="sm" icon={EyeOff} label={`Ignore ${label(r)}: stop listing this path`} onClick={() => setIgnoring(r)} /> : null}
                          <IconButton
                            size="sm"
                            icon={Trash2}
                            label={`Clear ${label(r)}: delete its counts. New visits show up again right away (unusual paths, such as most scanner probes: from tomorrow, UTC).`}
                            onClick={() => setConfirmClear(r)}
                            disabled={clear.isPending}
                          />
                        </div>
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            )}
            {rows.length > PAGE_SIZES[0] ? (
              <Pager
                page={paged.page}
                pages={paged.pages}
                size={size}
                total={rows.length}
                onPage={(p) => {
                  setPage(p);
                  window.scrollTo({ top: 0 });
                }}
                onSize={setSize}
              />
            ) : null}
          </>
        )}
      </Section>

      <LiveMisses />

      {ignoring ? <IgnoreDialog miss={ignoring} onClose={() => setIgnoring(null)} /> : null}
      <Dialog
        open={confirmClear !== null}
        onOpenChange={(o) => !o && setConfirmClear(null)}
        title={confirmTitle}
        description={confirmText}
        size="sm"
        footer={
          <>
            <Button onClick={() => setConfirmClear(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => clear.mutate(confirmClear === null || confirmClear === "all" || confirmClear === "probes" ? (confirmClear ?? "all") : [confirmClear])} loading={clear.isPending}>
              Clear
            </Button>
          </>
        }
      />
      {tracking ? <TrackingDialog onClose={() => setTracking(false)} policy={policy} /> : null}
      {creates ? (
        <LinkForm open={creating !== null} onOpenChange={(o) => !o && setCreating(null)} initialSlug={creating?.slug ?? ""} initialDomain={creating?.domain ?? ""} onSaved={createdFromMiss} />
      ) : null}
    </div>
  );
}

/** Clears a miss that now has a link (from this second on, new misses show again). */
function clearFixed(qc: ReturnType<typeof useQueryClient>, l: { domain: string; slug: string }) {
  void call(api.stats.misses.clear.$post({ json: { links: [{ domain: l.domain, slug: l.slug }] } }))
    .then(() => qc.invalidateQueries({ queryKey: ["stats", "misses"] }))
    .catch((e: unknown) => toast.error(`Link created, but its miss wasn’t cleared: ${e instanceof Error ? e.message : String(e)}`));
}

/** Ignore a missed path for good, or send its visitors to one of your links instead. */
function IgnoreDialog({ miss, onClose }: { miss: Pick<MissRow, "domain" | "slug">; onClose: () => void }) {
  const qc = useQueryClient();
  const label = useLinkLabel();
  const can = useCan();
  const [mode, setMode] = useState<"ignore" | "send">("ignore");
  const [pick, setPick] = useState<{ key: string; target: string } | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      if (mode === "ignore") return void (await call(api.stats.misses.ignore.$post({ json: { links: [miss] } })));
      await call(api.links.$post({ json: { domain: miss.domain, slug: miss.slug, target: pick!.target } }));
      clearFixed(qc, miss);
    },
    onSuccess: () => {
      toast.success(mode === "ignore" ? `${label(miss)} ignored` : `${label(miss)} now goes where ${label(keyToLink(pick!.key))} goes`);
      void qc.invalidateQueries({ queryKey: ["stats", "misses"] });
      void qc.invalidateQueries({ queryKey: keys.allLinks });
      onClose();
    },
    onError: (e) => toast.error(errorOf(e)),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Ignore ${label(miss)}?`}
      description="Ignored paths leave this list and their visits aren’t counted. You can bring them back from the Ignored tab."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending} disabled={mode === "send" && !pick}>
            {mode === "ignore" ? "Ignore" : "Create link"}
          </Button>
        </>
      }
    >
      <fieldset className="health-choices">
        <legend className="ui-sr">What to do with {label(miss)}</legend>
        <label className={cn("health-choice", mode === "ignore" && "is-on")}>
          <input type="radio" name="ignore-mode" checked={mode === "ignore"} onChange={() => setMode("ignore")} />
          <span className="health-choice-text">
            <span className="health-choice-title">Just ignore it</span>
            <span className="health-choice-desc">Visitors keep getting the not-found page.</span>
          </span>
        </label>
        {can("links.create") ? (
          <div className={cn("health-choice-wrap", mode === "send" && "is-on")}>
            <label className={cn("health-choice", mode === "send" && "is-on")}>
              <input type="radio" name="ignore-mode" checked={mode === "send"} onChange={() => setMode("send")} />
              <span className="health-choice-text">
                <span className="health-choice-title">Send visitors to one of my links</span>
                <span className="health-choice-desc">Creates {label(miss)} with the same destination as the link you choose.</span>
              </span>
            </label>
            {mode === "send" ? (
              <div className="health-choice-more">
                <LinkPicker id="ignore-send" label="Link to send visitors to" value={pick?.key ?? ""} onChange={(key, l) => setPick(l ? { key, target: l.target } : null)} />
              </div>
            ) : null}
          </div>
        ) : null}
      </fieldset>
    </Dialog>
  );
}

type IgnoredLink = { domain: string; slug: string; since?: string };
const IMPORT_BATCH = 500;

/**
 * Ignored paths from a CSV: this tab's own export, the misses export, or any
 * file with a path (or slug) column. Without a domain column, the primary domain.
 */
function ignoredFromCsv(rows: Record<string, string>[], domains: string[], primary: string): { links: IgnoredLink[]; skipped: number } {
  const links = new Map<string, IgnoredLink>();
  let skipped = 0;
  for (const raw of rows) {
    const row = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.trim().toLowerCase(), String(v ?? "").trim()]));
    const domain = (row.domain || primary).toLowerCase();
    const slug = (row.path || row.slug || "").replace(/^\/+/, "");
    const since = /^\d{4}-\d{2}-\d{2}$/.test(row.ignored_on ?? "") ? row.ignored_on : undefined;
    if (!slug || slug.length > 512 || !domains.includes(domain)) {
      skipped++;
      continue;
    }
    links.set(linkKey(domain, slug), { domain, slug, since });
  }
  return { links: [...links.values()], skipped };
}

/** The paths you ignored: bring one back, or give it a link. Clear, export and import the whole list. */
function IgnoredList({ onCreate }: { onCreate: (l: { domain: string; slug: string }) => void }) {
  const qc = useQueryClient();
  const label = useLinkLabel();
  const can = useCan();
  const { domains, primary } = useDomains();
  const file = useRef<HTMLInputElement>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const q = useQuery({ queryKey: ["stats", "misses", "ignored"], queryFn: () => call(api.stats.misses.ignored.$get()) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["stats", "misses"] });
  const unignore = useMutation({
    mutationFn: (l: { domain: string; slug: string }) => call(api.stats.misses.unignore.$post({ json: { links: [l] } })),
    onSuccess: (_, l) => {
      toast.success(`${label(l)} is listed again`, { description: "New visits to it show up as misses." });
      refresh();
    },
    onError: (e) => toast.error(errorOf(e)),
  });
  const clearAll = useMutation({
    mutationFn: () => call(api.stats.misses.ignored.clear.$post()),
    onSuccess: (res) => {
      toast.success(`${num(res.unignored)} paths are listed again`, { description: "New visits to them show up as misses." });
      setConfirmClear(false);
      refresh();
    },
    onError: (e) => toast.error(errorOf(e)),
  });
  const importCsv = useMutation({
    mutationFn: async (links: IgnoredLink[]) => {
      for (let i = 0; i < links.length; i += IMPORT_BATCH) await call(api.stats.misses.ignore.$post({ json: { links: links.slice(i, i + IMPORT_BATCH) } }));
      return links.length;
    },
    onSuccess: (n) => toast.success(`${num(n)} paths ignored`),
    onError: (e) => toast.error(`Import stopped: ${errorOf(e)}`, { description: "Paths before the error were ignored." }),
    onSettled: refresh,
  });
  const pick = (f: File) => {
    Papa.parse<Record<string, string>>(f, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const fields = (res.meta.fields ?? []).map((x) => x.trim().toLowerCase());
        if (!fields.includes("path") && !fields.includes("slug")) {
          toast.error("No path column", { description: "The CSV needs a column named path (or slug). Domain and ignored_on columns are optional." });
          return;
        }
        const { links, skipped } = ignoredFromCsv(res.data, domains, primary);
        if (skipped) toast.warning(`${num(skipped)} rows skipped`, { description: "Empty paths, or domains that aren't your short domains." });
        if (links.length) importCsv.mutate(links);
        else if (!skipped) toast.info("The CSV has no rows");
      },
      error: (err) => toast.error(`Couldn't read the CSV: ${err.message}`),
    });
  };

  const rows = q.data?.rows ?? [];
  return (
    <>
      <div className="health-toolbar">
        <div className="health-toolbar-acts">
          <input
            ref={file}
            type="file"
            accept=".csv,text/csv"
            className="ui-sr"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) pick(f);
              e.target.value = "";
            }}
          />
          <Button size="sm" icon={Upload} onClick={() => file.current?.click()} loading={importCsv.isPending}>
            Import CSV
          </Button>
          {rows.length ? (
            <>
              <ExportButton href="/_admin/api/stats/misses/ignored.csv" size="sm">
                Export CSV
              </ExportButton>
              <Button size="sm" icon={Trash2} onClick={() => setConfirmClear(true)}>
                Clear all
              </Button>
            </>
          ) : null}
        </div>
      </div>
      {q.isPending ? (
        <RowsSkeleton rows={4} />
      ) : q.isError ? (
        <ErrorState what="Ignored paths" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : rows.length === 0 ? (
        <Empty title="Nothing is ignored">Ignore a miss to hide it for good, or import a CSV with a path column (domain and ignored_on are optional).</Empty>
      ) : (
        <Table label="Ignored paths" className="health-table health-ignored-table">
          <thead>
            <tr>
              <TH className="health-c-slug">Path</TH>
              <TH className="health-c-seen">Ignored on</TH>
              <TH className="health-c-act">
                <span className="ui-sr">Actions</span>
              </TH>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <TR key={linkKey(r.domain, r.slug)}>
                <TD className="health-c-slug" data-title="">
                  <span className="health-slug">{label(r)}</span>
                </TD>
                <TD className="health-c-seen" data-label="Ignored on">
                  <span className="health-phone-label">Ignored on </span>
                  {day(r.since)}
                </TD>
                <TD className="health-c-act">
                  <div className="health-acts">
                    {can("links.create") ? (
                      <Button
                        size="sm"
                        onClick={() => {
                          unignore.mutate(r);
                          onCreate(r);
                        }}
                      >
                        Create link
                      </Button>
                    ) : null}
                    <Button size="sm" variant="ghost" onClick={() => unignore.mutate(r)} disabled={unignore.isPending}>
                      Un-ignore<span className="ui-sr"> {label(r)}</span>
                    </Button>
                  </div>
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      )}
      <Dialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title={`Un-ignore all ${num(rows.length)} paths?`}
        description="Each of them shows up as a miss again the next time it's visited. Their old counts were deleted when they were ignored and don't come back. Export the list first if you may want it again."
        size="sm"
        footer={
          <>
            <Button onClick={() => setConfirmClear(false)}>Cancel</Button>
            <Button variant="danger" onClick={() => clearAll.mutate()} loading={clearAll.isPending}>
              Un-ignore all
            </Button>
          </>
        }
      />
    </>
  );
}
