import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Copy, ExternalLink, Gauge, History, Lock, Pencil, QrCode, Trash2 } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { describeRouting } from "../../shared/routing";
import type { Period } from "../../shared/types";
import { api, call, keys } from "../api";
import { Breakdown, ClicksChart, StatTiles } from "../components/Charts";
import { useRestoreDeleted } from "../components/DeletedLinks";
import { DestinationCheck } from "../components/DestinationCheck";
import { LinkHistory } from "../components/LinkHistory";
import { RoutingResults } from "../components/RoutingResults";
import { LinkForm } from "../components/LinkForm";
import { includesToday, liveInterval, StatsFreshness } from "../components/StatsFreshness";
import { PeriodPicker, periodQuery } from "../components/PeriodPicker";
import { Badge, Button, Card, CardHeader, Dialog, Empty, Notice, PageHeader, Spinner } from "../components/ui";
import { countryName, date, flag, num, sourceLabel, when } from "../lib/format";
import { linkPath, useLinkLabel } from "../lib/links";
import { useCan } from "../lib/me";
import { copy } from "../lib/utils";
import { StateBadge } from "./Links";

/** "37 of 100 visits used", red once the limit is reached. */
function CapBadge({ domain, slug, limit }: { domain: string; slug: string; limit: number }) {
  const q = useQuery({ queryKey: keys.cap(domain, slug), queryFn: () => call(api.links[":domain"][":slug"].cap.$get({ param: { domain, slug } })) });
  const full = q.data ? q.data.count >= limit : false;
  return (
    <span className={full ? "inline-flex items-center gap-1 font-medium text-danger" : "inline-flex items-center gap-1"} title="Bots and link previews don't count">
      <Gauge className="size-3" aria-hidden />
      {q.data ? `${num(q.data.count)} of ${num(limit)} visits used${full ? ": limit reached" : ""}` : `Limit ${num(limit)} visits`}
    </span>
  );
}

// QR rendering and scan testing load only when the studio opens.
const QrStudio = lazy(() => import("../components/QrStudio").then((m) => ({ default: m.QrStudio })));

export function LinkDetail() {
  const params = useParams();
  const domain = params.domain ?? "";
  const slug = params.slug ?? "";
  const labelOf = useLinkLabel();
  const label = labelOf({ domain, slug });
  const [period, setPeriod] = useState<Period>({ range: "30d" });
  const [editing, setEditing] = useState(false);
  /** Opens the editor with "Link no longer working" already switched on. */
  const [markBroken, setMarkBroken] = useState(false);
  const [qr, setQr] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const linkQ = useQuery({
    queryKey: keys.link(domain, slug),
    queryFn: () => call(api.links[":domain"][":slug"].$get({ param: { domain, slug } })),
    retry: (count, err) => !(err instanceof Error && "status" in err && err.status === 404) && count < 2,
  });
  const can = useCan();
  const edits = can("links.edit");
  const showStats = can("stats.view");
  const { hash } = useLocation();
  const loaded = Boolean(linkQ.data);
  // "Statistics" on the links list opens this page at #stats; Link health's "Fix" at #edit.
  useEffect(() => {
    if (loaded && hash === "#stats") requestAnimationFrame(() => document.getElementById("stats")?.scrollIntoView({ behavior: "smooth" }));
    if (loaded && hash === "#edit") {
      if (edits) setEditing(true);
      navigate({ hash: "" }, { replace: true });
    }
  }, [loaded, hash, navigate, edits]);
  const stats = useQuery({
    queryKey: keys.linkStats(domain, slug, period),
    queryFn: () => call(api.stats.links[":domain"][":slug"].$get({ param: { domain, slug }, query: periodQuery(period) })),
    refetchInterval: liveInterval(period),
    enabled: showStats,
  });
  // Links pointing visitors here while marked "no longer working"; shown before a delete.
  const dependents = useQuery({
    queryKey: [...keys.link(domain, slug), "dependents"],
    queryFn: () => call(api.links[":domain"][":slug"].dependents.$get({ param: { domain, slug } })),
    enabled: confirmDelete,
  });
  const recent = useQuery({
    queryKey: keys.recent(domain, slug),
    queryFn: () => call(api.stats.recent.$get({ query: { domain, slug, limit: "25" } })),
    refetchInterval: liveInterval({ range: "7d" }),
    enabled: showStats,
  });

  const toggle = useMutation({
    mutationFn: (active: boolean) => call(api.links[":domain"][":slug"].$patch({ param: { domain, slug }, json: { active } })),
    onSuccess: (data) => {
      qc.setQueryData(keys.link(domain, slug), data);
      void qc.invalidateQueries({ queryKey: keys.allLinks });
      toast.success(data.link.active ? "Link enabled" : "Link disabled", { description: "Takes effect worldwide within about a minute." });
    },
    onError: (e) => toast.error(e.message),
  });

  const undelete = useRestoreDeleted();
  const remove = useMutation({
    mutationFn: () => call(api.links[":domain"][":slug"].$delete({ param: { domain, slug } })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.allLinks });
      void qc.invalidateQueries({ queryKey: keys.deleted });
      toast.success(`${label} deleted`, {
        description: "You can bring it back from Recently deleted on the Links page.",
        // This page is gone by then; the restored link reappears in the list.
        action: { label: "Undo", onClick: () => undelete.mutate({ domain, slug }) },
      });
      navigate("/links");
    },
    onError: (e) => toast.error(e.message),
  });

  if (linkQ.isPending) {
    return (
      <div className="flex justify-center py-24">
        <Spinner />
      </div>
    );
  }
  if (linkQ.isError) {
    return (
      <Card>
        <Empty title="Link not found">
          <Link to="/links" className="text-accent hover:underline">
            Back to links
          </Link>
        </Empty>
      </Card>
    );
  }

  const link = linkQ.data.link;
  const s = stats.data;

  return (
    <>
      <Link to="/links" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" /> Links
      </Link>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {label}
            <StateBadge link={link} />
            {link.source === "import" ? <Badge>Imported</Badge> : null}
          </span>
        }
        description={
          <span className="flex flex-col gap-1">
            <a href={link.target} target="_blank" rel="noreferrer noopener" className="inline-flex max-w-full items-center gap-1 break-all hover:text-fg">
              {link.target} <ExternalLink className="size-3 shrink-0" />
            </a>
            {link.title ? <span className="text-fg">{link.title}</span> : null}
            {link.broken ? (
              <span>
                Marked as no longer working.{" "}
                {link.replacement ? (
                  <>
                    Visitors are pointed to{" "}
                    <Link to={linkPath(link.replacement)} className="font-medium text-accent hover:underline">
                      {labelOf(link.replacement)}
                    </Link>
                    .
                  </>
                ) : (
                  "Visitors are sent to the site set in Settings."
                )}
              </span>
            ) : null}
          </span>
        }
        actions={
          <>
            <Button variant="outline" onClick={() => void copy(link.shortUrl)}>
              <Copy /> Copy
            </Button>
            <Button variant="outline" onClick={() => setQr(true)}>
              <QrCode /> QR
            </Button>
            {edits ? (
              <>
                <Button variant="outline" onClick={() => setEditing(true)}>
                  <Pencil /> Edit
                </Button>
                <Button variant="outline" onClick={() => toggle.mutate(!link.active)} loading={toggle.isPending}>
                  {link.active ? "Disable" : "Enable"}
                </Button>
              </>
            ) : null}
            <Button variant="outline" onClick={() => document.getElementById("history")?.scrollIntoView({ behavior: "smooth" })}>
              <History /> History
            </Button>
            {can("links.delete") ? (
              <Button variant="ghost" size="icon" aria-label="Delete link" onClick={() => setConfirmDelete(true)}>
                <Trash2 />
              </Button>
            ) : null}
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
        <span>Created {date(link.createdAt)}</span>
        <span>Updated {date(link.updatedAt)}</span>
        {link.expiresAt ? <span>Expires {when(link.expiresAt)}</span> : null}
        <span>UTM {link.utm ? (link.utmTemplate ? "custom template" : "default template") : "off"}</span>
        {link.routing ? <span>Smart routing: {describeRouting(link.routing)}</span> : null}
        {link.preview ? <span title={link.preview.title}>Custom social preview</span> : null}
        {link.protected ? (
          <span className="inline-flex items-center gap-1">
            <Lock className="size-3" aria-hidden /> Password protected
          </span>
        ) : null}
        {link.maxClicks ? <CapBadge domain={link.domain} slug={link.slug} limit={link.maxClicks} /> : null}
        {link.passQuery ? <span>Passes query params</span> : null}
        {link.tags.map((t) => (
          <Badge key={t} tone="accent">
            {t}
          </Badge>
        ))}
      </div>
      <DestinationCheck
        link={link}
        onMarkBroken={() => {
          setMarkBroken(true);
          setEditing(true);
        }}
      />
      {link.notes ? <p className="mb-4 rounded-lg bg-surface-2 px-3 py-2 text-sm whitespace-pre-wrap text-fg">{link.notes}</p> : null}

      {showStats ? (
        <>
      <div id="stats" className="mb-4 flex scroll-mt-6 flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-fg">Statistics</h2>
        <PeriodPicker value={period} onChange={setPeriod} />
        {stats.data?.aeAvailable && includesToday(period) ? (
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
        <div className="mb-4">
          <Notice>Today’s live numbers aren’t available (Analytics Engine not configured). Completed days are shown.</Notice>
        </div>
      ) : null}

      {stats.isPending ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : stats.isError ? (
        <Notice tone="danger">{stats.error.message}</Notice>
      ) : s ? (
        <div className="space-y-4">
          <StatTiles
            totals={s.totals}
            extra={link.importedClicks !== null ? { label: "Clicks before import", value: num(link.importedClicks), note: "As reported by the previous shortener" } : undefined}
            comparison={s.comparison}
          />
          <ClicksChart series={s.series} liveAvailable={s.aeAvailable} previous={s.comparison?.series} />
          {link.routing ? <RoutingResults routing={link.routing} rows={s.dims.route} period={period} from={s.from} onPeriod={setPeriod} /> : null}
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
        <CardHeader title="Recent hits" description="Last 7 days, newest first" />
        {recent.isPending ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : recent.isError ? (
          <div className="px-5 pb-5">
            <Notice tone="danger">{recent.error.message}</Notice>
          </div>
        ) : !recent.data.aeAvailable ? (
          <Empty title="Not available">Recent hits come from Analytics Engine, which isn’t configured here.</Empty>
        ) : recent.data.hits.length === 0 ? (
          <Empty title="No hits in the last 7 days" />
        ) : (
          <div className="overflow-x-auto px-4 pb-4">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="py-1.5 font-medium">Time</th>
                  <th className="py-1.5 font-medium">Type</th>
                  <th className="py-1.5 font-medium">Location</th>
                  <th className="py-1.5 font-medium">Device</th>
                  <th className="py-1.5 font-medium">Source</th>
                  <th className="py-1.5 font-medium">Referrer</th>
                </tr>
              </thead>
              <tbody>
                {recent.data.hits.map((h, i) => (
                  <tr key={`${h.time}-${i}`} className="border-t border-line">
                    <td className="py-1.5 whitespace-nowrap text-muted">{when(h.time)}</td>
                    <td className="py-1.5">{h.event === "bot" ? <Badge tone="warn">{h.botName || "Bot"}</Badge> : <Badge tone="good">Click</Badge>}</td>
                    <td className="py-1.5">
                      {flag(h.country)} {h.city ? `${h.city}, ` : ""}
                      {countryName(h.country)}
                    </td>
                    <td className="py-1.5 text-muted">
                      {h.device} · {h.os} · {h.browser}
                    </td>
                    <td className="py-1.5">{sourceLabel(h.source)}</td>
                    <td className="py-1.5 text-muted">{h.referrer || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

        </>
      ) : null}

      <LinkHistory link={link} />

      {edits ? <LinkForm
        open={editing}
        onOpenChange={(o) => {
          setEditing(o);
          if (!o) setMarkBroken(false);
        }}
        link={link}
        markBroken={markBroken}
      /> : null}
      {qr ? (
        <Suspense fallback={null}>
          <QrStudio open onOpenChange={setQr} link={link} label={label} />
        </Suspense>
      ) : null}
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete} title={`Delete ${label}?`} description="The short link stops working and its slug becomes free. Stats already collected stay in the rollups. You can restore it from Recently deleted for 90 days; to stop a link temporarily, disable it instead.">
        {dependents.data?.links.length ? (
          <div className="mb-4">
            <Notice tone="warn">
              {dependents.data.links.map((l) => labelOf(l)).join(", ")} {dependents.data.links.length === 1 ? "uses" : "use"} this link as a replacement. After deleting it, their visitors are sent to the site set in Settings instead.
            </Notice>
          </div>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setConfirmDelete(false)}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => remove.mutate()} loading={remove.isPending}>
            Delete link
          </Button>
        </div>
      </Dialog>
    </>
  );
}
