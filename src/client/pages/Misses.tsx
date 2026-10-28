import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, EyeOff, RefreshCw, SearchX, Settings2, Trash2, Upload } from "lucide-react";
import Papa from "papaparse";
import { useRef, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import {
  DEFAULT_MISS_POLICY,
  MISS_RETENTION_DAYS,
  NOISE_LIMITS,
  REAL_MISS_LIMITS,
  type MissPolicy,
  type MissRow,
  type Period,
  type RecentHit,
} from "../../shared/types";
import { api, call, keys } from "../api";
import { useCan } from "../lib/me";
import { DownloadButton } from "../components/DownloadButton";
import { HealthTabs } from "../components/HealthTabs";
import { LinkForm } from "../components/LinkForm";
import { LinkPicker } from "../components/LinkPicker";
import { PeriodPicker, periodParams, periodQuery } from "../components/PeriodPicker";
import { Badge, Button, Card, CardHeader, Dialog, Empty, Field, InfoTip, Notice, PageHeader, Pagination, Segmented, Select, SortHeader, Spinner, Switch } from "../components/ui";
import { day, num, when } from "../lib/format";
import { MISSES_HELP, PROBE_HELP } from "../lib/help";
import { linkKey, linkPath, useDomains, useLinkLabel } from "../lib/links";
import { pageOf, savedPageSize, savePageSize, sortRows, type PageSize, type SortDir } from "../lib/table";

type MissSort = "slug" | "hits" | "bots" | "lastSeen";
const MISS_SORT_VALUE: Record<MissSort, (r: MissRow) => string | number> = {
  slug: (r) => r.slug,
  hits: (r) => r.hits,
  bots: (r) => r.bots,
  // A number, so it sorts newest first by default.
  lastSeen: (r) => Date.parse(r.lastSeen) || 0,
};

const retentionLabel = (d: number) => (d === 60 ? "2 months" : d === 90 ? "3 months" : `${d} days`);
const realLimitLabel = (n: number) => (n === 0 ? "No limit" : `${num(n)} paths`);

/** One sentence on what the policy keeps. */
function policySummary(p: MissPolicy): string {
  const kinds = [p.trackHumans ? "human misses" : null, p.trackProbes ? "scanner probes" : null, p.trackBots ? "bot-only misses" : null].filter(Boolean);
  const tracked = kinds.length ? `Tracking ${kinds.join(", ").replace(/, ([^,]*)$/, " and $1")}` : "Not tracking any misses";
  return `${tracked}, kept ${retentionLabel(p.retentionDays)}.`;
}

function KindLimit({ id, label, value, onChange }: { id: string; label: string; value: MissPolicy["probeLimit"]; onChange: (v: MissPolicy["probeLimit"]) => void }) {
  return (
    <Field label={label} htmlFor={id}>
      <Select id={id} value={value} onChange={(e) => onChange(Number(e.target.value) as MissPolicy["probeLimit"])}>
        {NOISE_LIMITS.map((n) => (
          <option key={n} value={n}>
            {n} paths
          </option>
        ))}
      </Select>
    </Field>
  );
}

function TrackingDialog({ open, onOpenChange, policy }: { open: boolean; onOpenChange: (o: boolean) => void; policy: MissPolicy }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState(policy);
  const save = useMutation({
    mutationFn: () => call(api.stats.misses.policy.$put({ json: draft })),
    onSuccess: ({ removed }) => {
      onOpenChange(false);
      toast.success("Miss tracking saved", removed ? { description: `Removed ${num(removed)} stored ${removed === 1 ? "path" : "paths"} outside the new settings.` } : undefined);
      void qc.invalidateQueries({ queryKey: ["stats", "misses"] });
    },
    onError: (e) => toast.error(e.message),
  });
  const set = <K extends keyof MissPolicy>(k: K, v: MissPolicy[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const turnedOff = (["trackHumans", "trackProbes", "trackBots"] as const).some((k) => policy[k] && !draft[k]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Miss tracking" description="Choose which kinds of misses are recorded and how much is kept.">
      <div className="space-y-4">
        <div className="space-y-3 rounded-md border border-line p-4">
          <Switch
            id="track-humans"
            label="Track human misses"
            description="People opening a mistyped, deleted, disabled or expired link. On by default."
            checked={draft.trackHumans}
            onCheckedChange={(v) => set("trackHumans", v)}
          />
          {draft.trackHumans ? (
            <Field label="Keep at most" htmlFor="real-limit" hint="The most recently requested paths are kept.">
              <Select id="real-limit" value={draft.realLimit} onChange={(e) => set("realLimit", Number(e.target.value) as MissPolicy["realLimit"])}>
                {REAL_MISS_LIMITS.map((n) => (
                  <option key={n} value={n}>
                    {realLimitLabel(n)}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
        </div>
        <div className="space-y-3 rounded-md border border-line p-4">
          <Switch
            id="track-probes"
            label="Track scanner probes"
            description="Paths vulnerability scanners try on every site, such as /.env or /wp-login.php."
            checked={draft.trackProbes}
            onCheckedChange={(v) => set("trackProbes", v)}
          />
          {draft.trackProbes ? <KindLimit id="probe-limit" label="Keep the most recent" value={draft.probeLimit} onChange={(v) => set("probeLimit", v)} /> : null}
        </div>
        <div className="space-y-3 rounded-md border border-line p-4">
          <Switch
            id="track-bots"
            label="Track bot-only misses"
            description="Other paths that only bots, scripts and link checkers asked for."
            checked={draft.trackBots}
            onCheckedChange={(v) => set("trackBots", v)}
          />
          {draft.trackBots ? <KindLimit id="bot-limit" label="Keep the most recent" value={draft.botLimit} onChange={(v) => set("botLimit", v)} /> : null}
        </div>
        <Field label="Keep misses for" htmlFor="retention">
          <Select id="retention" value={draft.retentionDays} onChange={(e) => set("retentionDays", Number(e.target.value) as MissPolicy["retentionDays"])}>
            {MISS_RETENTION_DAYS.map((d) => (
              <option key={d} value={d}>
                {retentionLabel(d)}
              </option>
            ))}
          </Select>
        </Field>
        <p className="text-xs text-muted">
          Saving removes stored misses outside these settings right away{turnedOff ? ", including everything of a kind you turn off" : ""}. Removed misses can’t be restored.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            Save
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** How the report counts a recorded miss. */
function MissKind({ hit }: { hit: RecentHit }) {
  if (hit.botName) return <Badge tone="warn">Bot: {hit.botName}</Badge>;
  if (hit.scanner) return <Badge tone="warn">Bot: scanner rule</Badge>;
  return <Badge tone="good">Human</Badge>;
}

/** The raw miss log, so a visit that doesn't show in the report can be traced. Loaded only when opened. */
function LiveMisses() {
  const [open, setOpen] = useState(false);
  const label = useLinkLabel();
  const q = useQuery({
    queryKey: ["stats", "recent", "misses"],
    queryFn: () => call(api.stats.recent.$get({ query: { event: "miss", limit: "50" } })),
    enabled: open,
  });
  return (
    <Card className="mt-6">
      <CardHeader
        title="Latest misses, as recorded"
        description="Last 7 days, newest first, with how each visit is counted. Use it when a visit you expected isn’t in the table."
        info={MISSES_HELP.live}
        action={
          <div className="flex gap-2">
            {open ? (
              <Button variant="outline" size="sm" onClick={() => void q.refetch()} loading={q.isFetching}>
                <RefreshCw /> Refresh
              </Button>
            ) : null}
            <Button variant="outline" size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              {open ? "Hide" : "Show"}
            </Button>
          </div>
        }
      />
      {!open ? null : q.isPending ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : q.isError ? (
        <div className="px-4 pb-4">
          <Notice tone="danger">{q.error.message}</Notice>
        </div>
      ) : q.data.error ? (
        <div className="px-4 pb-4">
          <Notice tone="danger">Couldn’t load recent misses: {q.data.error}</Notice>
        </div>
      ) : !q.data.aeAvailable ? (
        <Empty title="Not available">Recorded misses come from Analytics Engine, which isn’t configured here.</Empty>
      ) : q.data.hits.length === 0 ? (
        <Empty title="No misses in the last 7 days" />
      ) : (
        <div className="overflow-x-auto px-4 pb-4">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="py-1.5 font-medium">Time</th>
                <th className="py-1.5 font-medium">Requested slug</th>
                <th className="py-1.5 font-medium">Counted as</th>
                <th className="py-1.5 font-medium">Device</th>
              </tr>
            </thead>
            <tbody>
              {q.data.hits.map((h, i) => (
                <tr key={`${h.time}-${i}`} className="border-t border-line">
                  <td className="py-1.5 whitespace-nowrap text-muted">{when(h.time)}</td>
                  <td className="py-1.5 font-mono text-xs break-all text-fg">{label(h)}</td>
                  <td className="py-1.5">
                    <MissKind hit={h} />
                  </td>
                  <td className="py-1.5 text-muted">
                    {h.device} · {h.os} · {h.browser}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

type ClearTarget = "all" | "probes" | Pick<MissRow, "domain" | "slug">[];

export function Misses() {
  const [period, setPeriodState] = useState<Period>({ range: "7d" });
  const [showBots, setShowBotsState] = useState(false);
  const [showProbes, setShowProbesState] = useState(false);
  const [sort, setSort] = useState<{ key: MissSort; dir: SortDir }>({ key: "hits", dir: "desc" });
  const [page, setPage] = useState(1);
  const [size, setSizeState] = useState<PageSize>(() => savedPageSize("misses"));
  // A new range, filter or order starts again on page 1.
  const setPeriod = (p: Period) => (setPeriodState(p), setPage(1));
  const setShowBots = (v: boolean) => (setShowBotsState(v), setPage(1));
  const setShowProbes = (v: boolean) => (setShowProbesState(v), setPage(1));
  const setSize = (n: PageSize) => (savePageSize("misses", n), setSizeState(n), setPage(1));
  const sortBy = (key: MissSort) => {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "slug" ? "asc" : "desc" }));
    setPage(1);
  };
  const [confirmClear, setConfirmClear] = useState<"all" | "probes" | null>(null);
  const [tracking, setTracking] = useState(false);
  const [creating, setCreating] = useState<{ domain: string; slug: string } | null>(null);
  const [ignoring, setIgnoring] = useState<Pick<MissRow, "domain" | "slug"> | null>(null);
  const [view, setView] = useState<"misses" | "ignored">("misses");
  const qc = useQueryClient();
  const label = useLinkLabel();
  const can = useCan();
  const q = useQuery({ queryKey: keys.misses(period), queryFn: () => call(api.stats.misses.$get({ query: periodQuery(period) })) });
  const all = q.data?.rows ?? [];
  const policy = q.data?.policy ?? DEFAULT_MISS_POLICY;
  const probes = all.filter((r) => r.probe);
  const botOnly = all.filter((r) => !r.probe && r.hits === 0).length;
  const rows = all.filter((r) => (showProbes || !r.probe) && (showBots || r.hits > 0));
  const sorted = sortRows(rows, MISS_SORT_VALUE[sort.key], sort.dir);
  const paged = pageOf(sorted, page, size);

  const clear = useMutation({
    mutationFn: (target: ClearTarget) =>
      call(
        api.stats.misses.clear.$post({
          json: target === "all" ? {} : target === "probes" ? { probes: true } : { links: target.map(({ domain, slug }) => ({ domain, slug })) },
        }),
      ),
    onSuccess: (_, target) => {
      setConfirmClear(null);
      toast.success(
        target === "all" ? "All misses cleared" : target === "probes" ? "Scanner probes cleared" : target.length === 1 ? `${label(target[0]!)} cleared` : `${target.length} misses cleared`,
      );
      void qc.invalidateQueries({ queryKey: ["stats", "misses"] });
    },
    onError: (e) => toast.error(e.message),
  });

  /**
   * A link was created from a miss row: that miss is fixed, so clear it (from this second on, new misses show again).
   * You stay here, to fix the next one.
   */
  const createdFromMiss = (saved: { domain: string; slug: string }) => {
    if (creating && saved.domain === creating.domain && saved.slug === creating.slug) clearFixed(qc, saved);
    setCreating(null);
  };

  return (
    <>
      <PageHeader
        title="Misses"
        description="Visits to slugs that don't exist, have expired or are switched off."
        actions={
          <>
            <PeriodPicker value={period} onChange={setPeriod} />
            <DownloadButton href={`/_admin/api/stats/misses/export.csv?${periodParams(period)}&probes=${showProbes ? 1 : 0}&bots=${showBots ? 1 : 0}`}>
              <Download /> Export CSV
            </DownloadButton>
          </>
        }
      />
      <HealthTabs />
      {q.data ? (
        <div className="mb-4">
          <Segmented
            label="Show"
            value={view}
            onChange={setView}
            options={[
              { value: "misses", label: "Misses" },
              { value: "ignored", label: `Ignored (${num(q.data.ignored)})` },
            ]}
          />
        </div>
      ) : null}
      {view === "ignored" && q.data ? (
        <IgnoredList onCreate={setCreating} />
      ) : (
      <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface px-4 py-3 text-sm">
        <span className="text-muted">{policySummary(policy)}</span>
        {can("settings.manage") ? (
          <Button variant="outline" size="sm" onClick={() => setTracking(true)} disabled={!q.data}>
            <Settings2 /> Tracking settings
          </Button>
        ) : null}
      </div>
      {q.data && !q.data.aeAvailable ? (
        <div className="mb-4">
          <Notice>Today’s misses aren’t available (Analytics Engine not configured). Completed days are shown.</Notice>
        </div>
      ) : null}
      <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-2">
        {policy.trackProbes || probes.length ? (
          <label className="inline-flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={!showProbes} onChange={(e) => setShowProbes(!e.target.checked)} className="accent-[var(--accent)]" />
            Hide scanner probes{probes.length ? ` (${num(probes.length)})` : ""}
          </label>
        ) : null}
        {policy.trackBots || botOnly ? (
          <label className="inline-flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={!showBots} onChange={(e) => setShowBots(!e.target.checked)} className="accent-[var(--accent)]" />
            Hide bot-only misses{botOnly ? ` (${num(botOnly)})` : ""}
          </label>
        ) : null}
        <div className="ml-auto flex flex-wrap gap-2">
          {probes.length ? (
            <Button variant="outline" size="sm" onClick={() => setConfirmClear("probes")}>
              Clear scanner probes
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onClick={() => setConfirmClear("all")} disabled={all.length === 0}>
            <Trash2 /> Clear all
          </Button>
        </div>
      </div>
      {q.isPending ? (
        <div className="flex justify-center py-24">
          <Spinner />
        </div>
      ) : q.isError ? (
        <Notice tone="danger">{q.error.message}</Notice>
      ) : rows.length === 0 ? (
        <Card>
          <Empty icon={<SearchX />} title="No misses in this period">
            {all.length ? "Only scanner probes and bots missed. Untick the filters above to see them." : "Every human visit landed on a working link."}
          </Empty>
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b border-line text-left text-xs text-muted">
              <tr>
                <SortHeader label="Requested slug" active={sort.key === "slug"} dir={sort.dir} onSort={() => sortBy("slug")} />
                <SortHeader label="Human visits" className="text-right" active={sort.key === "hits"} dir={sort.dir} onSort={() => sortBy("hits")} />
                <SortHeader label="Bots" className="text-right" active={sort.key === "bots"} dir={sort.dir} onSort={() => sortBy("bots")} />
                <SortHeader label="Last seen" active={sort.key === "lastSeen"} dir={sort.dir} onSort={() => sortBy("lastSeen")} />
                <th className="px-4 py-2.5 font-medium">Why it missed</th>
                <th className="px-4 py-2.5">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {paged.rows.map((r) => (
                <tr key={linkKey(r.domain, r.slug)} className="border-b border-line last:border-0">
                  <td className="px-4 py-2.5 font-mono text-xs break-all text-fg">{label(r)}</td>
                  <td className="tabular px-4 py-2.5 text-right font-medium">{num(r.hits)}</td>
                  <td className="tabular px-4 py-2.5 text-right text-muted">{num(r.bots)}</td>
                  <td className="px-4 py-2.5 text-xs whitespace-nowrap text-muted">{day(r.lastSeen)}</td>
                  <td className="px-4 py-2.5">
                    {r.link === "disabled" ? (
                      <span className="text-xs text-muted">Link is disabled</span>
                    ) : r.link === "expired" ? (
                      <Badge tone="warn">Link expired</Badge>
                    ) : r.link === "active" ? (
                      <span className="text-xs text-muted">Created since</span>
                    ) : r.probe ? (
                      <span className="inline-flex items-center gap-1">
                        <Badge tone="warn">Scanner probe</Badge>
                        <InfoTip help={PROBE_HELP} />
                      </span>
                    ) : r.suggestion ? (
                      <span className="text-xs text-muted">
                        Case differs from{" "}
                        <Link to={linkPath({ domain: r.domain, slug: r.suggestion })} className="font-mono text-accent hover:underline">
                          {label({ domain: r.domain, slug: r.suggestion })}
                        </Link>
                      </span>
                    ) : (
                      <span className="text-xs text-muted">No such link</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-1">
                      {r.link === "none" ? (
                        r.probe || !can("links.create") ? null : (
                          <Button variant="outline" size="sm" onClick={() => setCreating({ domain: r.domain, slug: r.slug })}>
                            Create link
                          </Button>
                        )
                      ) : (
                        <Link to={linkPath(r)} className="text-xs text-accent hover:underline">
                          Open
                        </Link>
                      )}
                      {r.link === "none" ? (
                        <Button variant="ghost" size="icon-sm" aria-label={`Ignore ${label(r)}`} title="Ignore: stop listing this path" onClick={() => setIgnoring(r)}>
                          <EyeOff />
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Clear ${label(r)}`}
                        title="Clear: delete its counts. New visits show up again right away (unusual paths, such as most scanner probes: from tomorrow, UTC)."
                        onClick={() => clear.mutate([r])}
                        disabled={clear.isPending}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {rows.length ? (
        <Pagination
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
      <LiveMisses />
      </>
      )}
      {ignoring ? <IgnoreDialog miss={ignoring} onClose={() => setIgnoring(null)} /> : null}
      <Dialog
        open={confirmClear !== null}
        onOpenChange={(o) => !o && setConfirmClear(null)}
        title={confirmClear === "probes" ? "Clear all scanner probes?" : "Clear all misses?"}
        description={
          confirmClear === "probes"
            ? "Deletes the stored counts of every scanner probe, in every date range, including probes not listed here. Real misses stay. Probes requested later today show again from tomorrow (UTC). This can’t be undone."
            : "Deletes the stored counts for every missed path, in every date range. New visits are counted again right away. This can’t be undone."
        }
      >
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setConfirmClear(null)}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => confirmClear && clear.mutate(confirmClear)} loading={clear.isPending}>
            Clear
          </Button>
        </div>
      </Dialog>
      {tracking ? <TrackingDialog open onOpenChange={setTracking} policy={policy} /> : null}
      {can("links.create") ? (
        <LinkForm
          open={creating !== null}
          onOpenChange={(o) => !o && setCreating(null)}
          initialSlug={creating?.slug ?? ""}
          initialDomain={creating?.domain ?? ""}
          onSaved={(l) => void createdFromMiss(l)}
        />
      ) : null}
    </>
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
    onError: (e) => toast.error(e.message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Ignore ${label(miss)}?`} description="Ignored paths leave this list and their visits aren’t counted. You can bring them back from the Ignored tab.">
      <div className="space-y-3">
        <label className="flex gap-3 rounded-md border border-line p-3 text-sm has-[:checked]:border-accent">
          <input type="radio" name="ignore-mode" checked={mode === "ignore"} onChange={() => setMode("ignore")} className="mt-0.5 accent-[var(--accent)]" />
          <span>
            <span className="font-medium text-fg">Just ignore it</span>
            <span className="mt-0.5 block text-xs text-muted">Visitors keep getting the not-found page.</span>
          </span>
        </label>
        {can("links.create") ? (
          <label className="flex gap-3 rounded-md border border-line p-3 text-sm has-[:checked]:border-accent">
            <input type="radio" name="ignore-mode" checked={mode === "send"} onChange={() => setMode("send")} className="mt-0.5 accent-[var(--accent)]" />
            <span className="min-w-0 flex-1">
              <span className="font-medium text-fg">Send visitors to one of my links</span>
              <span className="mt-0.5 block text-xs text-muted">Creates {label(miss)} with the same destination as the link you choose.</span>
              {mode === "send" ? (
                <span className="mt-2 block">
                  <LinkPicker id="ignore-send" value={pick?.key ?? ""} onChange={(key, l) => setPick(l ? { key, target: l.target } : null)} />
                </span>
              ) : null}
            </span>
          </label>
        ) : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={mode === "send" && !pick}>
            {mode === "ignore" ? "Ignore" : "Create link"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

const keyToLink = (key: string) => ({ domain: key.slice(0, key.indexOf("/")), slug: key.slice(key.indexOf("/") + 1) });

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
    onError: (e) => toast.error(e.message),
  });
  const clearAll = useMutation({
    mutationFn: () => call(api.stats.misses.ignored.clear.$post()),
    onSuccess: (res) => {
      toast.success(`${num(res.unignored)} paths are listed again`, { description: "New visits to them show up as misses." });
      setConfirmClear(false);
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });
  const importCsv = useMutation({
    mutationFn: async (links: IgnoredLink[]) => {
      for (let i = 0; i < links.length; i += IMPORT_BATCH) await call(api.stats.misses.ignore.$post({ json: { links: links.slice(i, i + IMPORT_BATCH) } }));
      return links.length;
    },
    onSuccess: (n) => toast.success(`${num(n)} paths ignored`),
    onError: (e) => toast.error(`Import stopped: ${e.message}`, { description: "Paths before the error were ignored." }),
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

  if (q.isPending) return <div className="flex justify-center py-24"><Spinner /></div>;
  if (q.isError) return <Notice tone="danger">{q.error.message}</Notice>;
  const rows = q.data.rows;
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
        <input
          ref={file}
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) pick(f);
            e.target.value = "";
          }}
        />
        <Button variant="outline" size="sm" onClick={() => file.current?.click()} loading={importCsv.isPending}>
          <Upload /> Import CSV
        </Button>
        {rows.length ? (
          <>
            <DownloadButton href="/_admin/api/stats/misses/ignored.csv" size="sm">
              <Download /> Export CSV
            </DownloadButton>
            <Button variant="outline" size="sm" onClick={() => setConfirmClear(true)}>
              <Trash2 /> Clear all
            </Button>
          </>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <Card>
          <Empty icon={<EyeOff />} title="Nothing is ignored">
            Ignore a miss to hide it for good, or import a CSV with a path column (domain and ignored_on are optional).
          </Empty>
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead className="border-b border-line text-left text-xs text-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">Path</th>
                <th className="px-4 py-2.5 font-medium">Ignored on</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={linkKey(r.domain, r.slug)} className="border-b border-line last:border-0">
                  <td className="px-4 py-2.5 font-mono text-xs break-all text-fg">{label(r)}</td>
                  <td className="px-4 py-2.5 text-xs whitespace-nowrap text-muted">{day(r.since)}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-1">
                      {can("links.create") ? (
                        <Button variant="outline" size="sm" onClick={() => { unignore.mutate(r); onCreate(r); }}>
                          Create link
                        </Button>
                      ) : null}
                      <Button variant="ghost" size="sm" onClick={() => unignore.mutate(r)} disabled={unignore.isPending}>
                        Un-ignore
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <Dialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title={`Un-ignore all ${num(rows.length)} paths?`}
        description="Each of them shows up as a miss again the next time it's visited. Their old counts were deleted when they were ignored and don't come back. Export the list first if you may want it again."
      >
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setConfirmClear(false)}>Cancel</Button>
          <Button variant="danger" onClick={() => clearAll.mutate()} loading={clearAll.isPending}>Un-ignore all</Button>
        </div>
      </Dialog>
    </>
  );
}
