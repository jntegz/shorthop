import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, SearchX, Settings2, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import {
  DEFAULT_MISS_POLICY,
  MISS_RETENTION_DAYS,
  NOISE_LIMITS,
  REAL_MISS_LIMITS,
  type MissPolicy,
  type MissRow,
  type Range,
} from "../../shared/types";
import { api, call, keys } from "../api";
import { DownloadButton } from "../components/DownloadButton";
import { LinkForm } from "../components/LinkForm";
import { Badge, Button, Card, Dialog, Empty, Field, InfoTip, Notice, PageHeader, Pagination, RANGE_OPTIONS, Segmented, Select, SortHeader, Spinner, Switch } from "../components/ui";
import { day, num } from "../lib/format";
import { PROBE_HELP } from "../lib/help";
import { linkKey, linkPath, useLinkLabel } from "../lib/links";
import { pageOf, savedPageSize, savePageSize, sortRows, type PageSize, type SortDir } from "../lib/table";

type MissSort = "slug" | "hits" | "bots" | "lastSeen";
const MISS_SORT_VALUE: Record<MissSort, (r: MissRow) => string | number> = {
  slug: (r) => r.slug,
  hits: (r) => r.hits,
  bots: (r) => r.bots,
  // A number, so it sorts newest first by default.
  lastSeen: (r) => Date.parse(r.lastSeen) || 0,
};

const retentionLabel = (d: number) => (d === 180 ? "6 months" : `${d} days`);
const realLimitLabel = (n: number) => (n === 0 ? "No limit" : `${num(n)} paths`);

/** One sentence on what the policy keeps. */
function policySummary(p: MissPolicy): string {
  const noise = p.trackNoise
    ? `Scanner probes and bot-only misses: last ${p.noiseLimit} paths.`
    : "Scanner probes and bot-only misses aren’t tracked.";
  return `${noise} Real misses: kept ${retentionLabel(p.retentionDays)}, ${p.realLimit ? `up to ${num(p.realLimit)} paths` : "no limit on paths"}.`;
}

function TrackingDialog({ open, onOpenChange, policy }: { open: boolean; onOpenChange: (o: boolean) => void; policy: MissPolicy }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState(policy);
  const save = useMutation({
    mutationFn: () => call(api.stats.misses.policy.$put({ json: draft })),
    onSuccess: ({ removed }) => {
      onOpenChange(false);
      toast.success("Miss tracking saved", removed ? { description: `Removed ${num(removed)} stored ${removed === 1 ? "path" : "paths"} outside the new limits.` } : undefined);
      void qc.invalidateQueries({ queryKey: ["stats", "misses"] });
    },
    onError: (e) => toast.error(e.message),
  });
  const set = <K extends keyof MissPolicy>(k: K, v: MissPolicy[K]) => setDraft((d) => ({ ...d, [k]: v }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Miss tracking" description="Choose what gets recorded and how much is kept.">
      <div className="space-y-5">
        <div className="space-y-3 rounded-xl border border-line p-4">
          <Switch
            id="track-noise"
            label="Track scanner probes and bot-only misses"
            description="Off: requests for paths like /.env or /wp-login.php, and misses from bots, aren’t recorded at all."
            checked={draft.trackNoise}
            onCheckedChange={(v) => set("trackNoise", v)}
          />
          {draft.trackNoise ? (
            <Field label="Keep the most recent" htmlFor="noise-limit">
              <Select id="noise-limit" value={draft.noiseLimit} onChange={(e) => set("noiseLimit", Number(e.target.value) as MissPolicy["noiseLimit"])}>
                {NOISE_LIMITS.map((n) => (
                  <option key={n} value={n}>
                    {n} paths
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
        </div>
        <div className="space-y-3 rounded-xl border border-line p-4">
          <p className="text-sm font-medium text-fg">Real misses</p>
          <Field label="Keep for" htmlFor="retention">
            <Select id="retention" value={draft.retentionDays} onChange={(e) => set("retentionDays", Number(e.target.value) as MissPolicy["retentionDays"])}>
              {MISS_RETENTION_DAYS.map((d) => (
                <option key={d} value={d}>
                  {retentionLabel(d)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Keep at most" htmlFor="real-limit" hint="The most recently requested paths are kept.">
            <Select id="real-limit" value={draft.realLimit} onChange={(e) => set("realLimit", Number(e.target.value) as MissPolicy["realLimit"])}>
              {REAL_MISS_LIMITS.map((n) => (
                <option key={n} value={n}>
                  {realLimitLabel(n)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <p className="text-xs text-muted">Saving removes stored misses outside these limits right away. Removed misses can’t be restored.</p>
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

export function Misses() {
  const [range, setRangeState] = useState<Range>("7d");
  const [showBots, setShowBotsState] = useState(false);
  const [showProbes, setShowProbesState] = useState(false);
  const [sort, setSort] = useState<{ key: MissSort; dir: SortDir }>({ key: "hits", dir: "desc" });
  const [page, setPage] = useState(1);
  const [size, setSizeState] = useState<PageSize>(() => savedPageSize("misses"));
  const setRange = (r: Range) => (setRangeState(r), setPage(1));
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
  const navigate = useNavigate();
  const qc = useQueryClient();
  const label = useLinkLabel();
  const q = useQuery({ queryKey: keys.misses(range), queryFn: () => call(api.stats.misses.$get({ query: { range } })) });
  const all = q.data?.rows ?? [];
  const policy = q.data?.policy ?? DEFAULT_MISS_POLICY;
  const probes = all.filter((r) => r.probe);
  const rows = all.filter((r) => (showProbes || !r.probe) && (showBots || r.hits > 0));
  const sorted = sortRows(rows, MISS_SORT_VALUE[sort.key], sort.dir);
  const paged = pageOf(sorted, page, size);

  const clear = useMutation({
    mutationFn: (links: Pick<MissRow, "domain" | "slug">[] | null) =>
      call(api.stats.misses.clear.$post({ json: links ? { links: links.map(({ domain, slug }) => ({ domain, slug })) } : {} })),
    onSuccess: (_, links) => {
      setConfirmClear(null);
      toast.success(links === null ? "All misses cleared" : links.length === 1 ? `${label(links[0]!)} cleared` : `${links.length} misses cleared`);
      void qc.invalidateQueries({ queryKey: ["stats", "misses"] });
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <>
      <PageHeader
        title="Keep every connection working"
        description="Find visits to missing, expired, or disabled links and help your audience reach the right place."
        actions={
          <>
            <Segmented label="Date range" value={range} onChange={setRange} options={RANGE_OPTIONS} />
            <DownloadButton href={`/_admin/api/stats/misses/export.csv?range=${range}&probes=${showProbes ? 1 : 0}&bots=${showBots ? 1 : 0}`}>
              <Download /> Export CSV
            </DownloadButton>
          </>
        }
      />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface px-4 py-3 text-sm">
        <span className="text-muted">{policySummary(policy)}</span>
        <Button variant="outline" size="sm" onClick={() => setTracking(true)} disabled={!q.data}>
          <Settings2 /> Tracking settings
        </Button>
      </div>
      {q.data && !q.data.aeAvailable ? (
        <div className="mb-4">
          <Notice>Today’s misses aren’t available (Analytics Engine not configured). Completed days are shown.</Notice>
        </div>
      ) : null}
      <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-2">
        {policy.trackNoise ? (
          <>
            <label className="inline-flex items-center gap-2 text-sm text-muted">
              <input type="checkbox" checked={!showProbes} onChange={(e) => setShowProbes(!e.target.checked)} className="accent-[var(--accent)]" />
              Hide scanner probes{probes.length ? ` (${num(probes.length)})` : ""}
            </label>
            <label className="inline-flex items-center gap-2 text-sm text-muted">
              <input type="checkbox" checked={!showBots} onChange={(e) => setShowBots(!e.target.checked)} className="accent-[var(--accent)]" />
              Hide bot-only misses
            </label>
          </>
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
                      <Badge>Link is disabled</Badge>
                    ) : r.link === "expired" ? (
                      <Badge tone="warn">Link expired</Badge>
                    ) : r.link === "active" ? (
                      <Badge tone="good">Link exists now</Badge>
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
                        r.probe ? null : (
                          <Button variant="outline" size="sm" onClick={() => setCreating({ domain: r.domain, slug: r.slug })}>
                            Create link
                          </Button>
                        )
                      ) : (
                        <Link to={linkPath(r)} className="text-xs text-accent hover:underline">
                          Open
                        </Link>
                      )}
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
      <Dialog
        open={confirmClear !== null}
        onOpenChange={(o) => !o && setConfirmClear(null)}
        title={confirmClear === "probes" ? `Clear ${num(probes.length)} scanner probes?` : "Clear all misses?"}
        description={`Deletes the stored counts${confirmClear === "probes" ? " for these paths" : " for every missed path, in every date range"}. New visits are counted again right away. After clearing more than 50 paths at once, or for unusual paths such as most scanner probes, counting resumes tomorrow (UTC). This can’t be undone.`}
      >
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setConfirmClear(null)}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => clear.mutate(confirmClear === "probes" ? probes : null)} loading={clear.isPending}>
            Clear
          </Button>
        </div>
      </Dialog>
      {tracking ? <TrackingDialog open onOpenChange={setTracking} policy={policy} /> : null}
      <LinkForm
        open={creating !== null}
        onOpenChange={(o) => !o && setCreating(null)}
        initialSlug={creating?.slug ?? ""}
        initialDomain={creating?.domain ?? ""}
        onSaved={(l) => navigate(linkPath(l))}
      />
    </>
  );
}
