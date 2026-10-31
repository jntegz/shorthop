// The link page (/links/:domain/:slug). The order answers "how is this link
// doing" first: identity (short URL, destination, status) → period → KPI
// strip driving the chart → where clicks came from → breakdowns → latest
// hits → settings as facts → history. Copy and Edit (secondary: the
// sidebar's Create link is the one primary in view); everything else is in
// the More menu.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Copy, Ellipsis, ExternalLink, History, Pencil, Power, QrCode, Share2, Trash2 } from "lucide-react";
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import type { LinkDTO } from "../../../shared/types";
import { api, call, keys } from "../../api";
import { PeakHours } from "../hits/PeakHours";
import { useRestoreDeleted } from "../links/Deleted";
import { LinkForm } from "../../components/LinkForm";
import { LinkPower } from "../../components/LinkPower";
import { ShareStats, useShares } from "../../components/ShareStats";
import { includesToday, StatsFreshness } from "../hits/freshness";
import { linkPath, linkState, useLinkLabel } from "../../lib/links";
import { useCan } from "../../lib/me";
import { copy } from "../../lib/utils";
import { usePeriod, type Metric } from "../data";
import { PeriodBar, RowsSkeleton } from "../parts";
import { Badge, Button, Columns, Dialog, ErrorState, errorText, IconButton, Menu, Notice, Skeleton, StatStripSkeleton, useFocusFirstField, type MenuItem } from "../ui";
import { isNotFound, useDependents, useLink, useLinkCheck, useLinkMoney, useLinkRecent, useLinkStats } from "./data";
import { Facts } from "./Facts";
import { LinkPageHistory } from "./History";
import { DevicesPanel, EmptyPeriod, LatestHits, LinkChart, LinkKpis, MoneyPanel, OtherPanel, PlacesPanel, rangeText, RoutingPanel, SourcesPanel, useLinkBuckets } from "./Stats";

// QR rendering and scan testing load only when the studio opens.
const QrStudio = lazy(() => import("../../components/QrStudio").then((m) => ({ default: m.QrStudio })));

const reduceMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
function scrollToId(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "start" });
}

/** The tab title names the link; the Shell sets "All links" first, so this runs after it. */
function useLinkTitle(label: string) {
  useEffect(() => {
    const before = document.title;
    queueMicrotask(() => {
      document.title = `${label} · Shorthop`;
    });
    return () => {
      document.title = before;
    };
  }, [label]);
}

function BackLink() {
  return (
    <Link to="/links" className="ui-ld-back">
      <ArrowLeft aria-hidden /> All links
    </Link>
  );
}

/** A badge only when the state is news (Disabled, Expired, Replaced, Retired), as on the links list; a working link gets none. */
function StatusBadge({ link }: { link: LinkDTO }) {
  const s = linkState(link);
  if (s === "active") return null;
  if (s === "expired") return <Badge tone="warn">Expired</Badge>;
  if (s === "broken") return <Badge>{link.replacement ? "Replaced" : "Retired"}</Badge>;
  return <Badge>Disabled{link.offRedirect ? ", redirects" : ""}</Badge>;
}

const bare = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

// ---- States ----

function PageSkeleton() {
  return (
    <div className="ui-page ui-ld" aria-busy aria-label="Loading the link">
      <BackLink />
      <header className="ui-ld-head">
        <div className="ui-ld-id">
          <Skeleton className="ui-ld-skel-h1" />
          <Skeleton className="ui-skel-text" style={{ width: "min(420px, 80%)" }} />
        </div>
      </header>
      <Skeleton className="ui-ld-skel-period" />
      <StatStripSkeleton count={4} aria-hidden />
      <Skeleton className="ui-skel-chart" style={{ height: 232 }} />
    </div>
  );
}

function NotFound({ domain, slug }: { domain: string; slug: string }) {
  const label = useLinkLabel()({ domain, slug });
  const can = useCan();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  useLinkTitle("Link not found");
  return (
    <div className="ui-page ui-ld">
      <BackLink />
      <div className="ui-state">
        <h1 className="ui-h1 ui-ld-slug" translate="no">{label}</h1>
        <p className="ui-state-title">There’s no link at this address.</p>
        <div className="ui-state-body">
          <p>It may have been deleted (Recently deleted on the links page keeps it for 90 days), or the address has a typo.</p>
        </div>
        <div className="ui-ld-state-actions">
          <Button asChild variant={can("links.create") ? "secondary" : "primary"}>
            <Link to="/links">Back to all links</Link>
          </Button>
          {can("links.create") ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              Create {label}
            </Button>
          ) : null}
        </div>
      </div>
      {can("links.create") ? <LinkForm open={creating} onOpenChange={setCreating} initialSlug={slug} initialDomain={domain} onSaved={(l) => navigate(linkPath(l))} /> : null}
    </div>
  );
}

// ---- Page ----

export function LinkPage() {
  const params = useParams();
  const domain = params.domain ?? "";
  const slug = params.slug ?? "";
  const q = useLink(domain, slug);
  if (q.isPending) return <PageSkeleton />;
  if (q.isError) {
    if (isNotFound(q.error)) return <NotFound domain={domain} slug={slug} />;
    return (
      <div className="ui-page ui-ld">
        <BackLink />
        <ErrorState what="This link" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      </div>
    );
  }
  return <Loaded link={q.data.link} />;
}

function Loaded({ link }: { link: LinkDTO }) {
  const { domain, slug } = link;
  const labelOf = useLinkLabel();
  const label = labelOf(link);
  useLinkTitle(label);
  const can = useCan();
  const edits = can("links.edit");
  const showStats = can("stats.view");
  const canShare = showStats && edits;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { hash } = useLocation();

  const [period, setPeriod] = usePeriod();
  const [picked, setPicked] = useState<Metric>("clicks");
  const [editing, setEditing] = useState(false);
  /** Opens the editor with "Link no longer working" already switched on. */
  const [markBroken, setMarkBroken] = useState(false);
  const [qr, setQr] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [power, setPower] = useState(false);
  const [sharing, setSharing] = useState(false);
  useFocusFirstField(editing);

  const stats = useLinkStats(domain, slug, period, showStats);
  const recent = useLinkRecent(domain, slug, showStats);
  const dependents = useDependents(domain, slug, confirmDelete);
  const shares = useShares(domain, slug, canShare);
  const activeShares = shares.data?.shares.filter((x) => x.status === "active").length ?? 0;
  const money = useLinkMoney(domain, slug, period);
  const check = useLinkCheck(link).data?.check ?? null;
  const s = stats.data;
  const metric: Metric = picked === "revenue" && money.state !== "ready" ? "clicks" : picked;
  const chart = useLinkBuckets(s, money);

  // "Statistics" on the links list opens this page at #stats; Link health's "Fix" at #edit.
  useEffect(() => {
    if (hash === "#stats" || hash === "#history" || hash === "#settings") requestAnimationFrame(() => scrollToId(hash.slice(1)));
    if (hash === "#edit") {
      if (edits) setEditing(true);
      navigate({ hash: "" }, { replace: true });
    }
  }, [hash, navigate, edits]);

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
    onError: (e) => toast.error(errorText(e) ?? "That didn’t work. Try again."),
  });

  const markAsBroken = () => {
    setMarkBroken(true);
    setEditing(true);
  };

  const menu: (MenuItem | "separator")[] = [
    { label: "QR code", icon: QrCode, onSelect: () => setQr(true) },
    ...(canShare ? [{ label: "Share statistics…", icon: Share2, onSelect: () => setSharing(true) }] : []),
    ...(edits ? [{ label: link.active ? "Disable…" : "Enable…", icon: Power, onSelect: () => setPower(true) }] : []),
    { label: "History", icon: History, onSelect: () => scrollToId("history") },
    ...(can("links.delete") ? ["separator" as const, { label: "Delete link…", icon: Trash2, danger: true, onSelect: () => setConfirmDelete(true) }] : []),
  ];

  // What a visitor gets right now, when it isn't simply the destination.
  let state: ReactNode = null;
  if (link.broken) {
    state = (
      <Notice tone="info" className="ui-ld-notice" title="Marked as no longer working.">
        {link.replacement ? (
          <>
            Visitors are pointed to <Link to={linkPath(link.replacement)}>{labelOf(link.replacement)}</Link>.
          </>
        ) : (
          "Visitors see a short notice, then go to the site set in Settings."
        )}
      </Notice>
    );
  } else if (!link.active) {
    state = (
      <Notice
        tone="warn"
        className="ui-ld-notice"
        title="Turned off."
        action={edits ? <Button size="sm" icon={Power} onClick={() => setPower(true)}>Enable…</Button> : undefined}
      >
        {link.offRedirect === "home" ? (
          "Visitors are sent to the main site."
        ) : link.offRedirect ? (
          <>
            Visitors are sent to <Link to={linkPath(link.offRedirect)}>{labelOf(link.offRedirect)}</Link>.
          </>
        ) : (
          "Visitors see the “not found” page."
        )}{" "}
        Automatic checks are paused.
      </Notice>
    );
  } else if (check && (check.state === "down" || check.state === "warning")) {
    state = (
      <Notice
        tone={check.state === "down" ? "danger" : "warn"}
        className="ui-ld-notice"
        title={check.state === "down" ? "The destination isn’t loading." : "The destination failed its last check."}
        action={<Button size="sm" onClick={() => scrollToId("check")}>See the check</Button>}
      >
        {check.state === "down" ? "Visitors who click this link likely see an error page." : "It’s rechecked before it counts as not working."}
      </Notice>
    );
  }

  const empty = s ? s.totals.clicks + s.totals.bots === 0 : false;
  const routed = (s?.dims.route ?? []).some((r) => r.clicks > 0);

  return (
    <div className="ui-page ui-ld">
      <BackLink />

      <header className="ui-ld-head">
        <div className="ui-ld-id">
          <div className="ui-ld-title-row">
            <h1 className="ui-h1 ui-ld-slug" translate="no">{label}</h1>
            <StatusBadge link={link} />
          </div>
          <p className="ui-ld-urls">
            <span className="ui-ld-short" translate="no">{bare(link.shortUrl)}</span>
            <a href={link.target} target="_blank" rel="noreferrer noopener" className="ui-ld-dest" title={link.target}>
              <span className="ui-ld-arrow" aria-hidden>→</span>
              <span className="ui-sr">Destination: </span>
              {/* The icon is glued to the URL's last word so a wrap never leaves it alone on a line. */}
              <span className="ui-ld-dest-text" translate="no">
                {bare(link.target)}
                <span className="ui-ld-dest-icon">
                  {"\u2060"}
                  <ExternalLink aria-hidden />
                </span>
              </span>
              <span className="ui-sr"> (opens in a new tab)</span>
            </a>
          </p>
          {link.title ? <p className="ui-ld-name">{link.title}</p> : null}
        </div>
        <div className="ui-ld-tools">
          <Button icon={Copy} onClick={() => void copy(link.shortUrl)}>
            Copy
          </Button>
          {edits ? (
            <Button icon={Pencil} onClick={() => setEditing(true)}>
              Edit
            </Button>
          ) : null}
          <Menu label="More actions" trigger={<IconButton label="More actions" icon={Ellipsis} variant="secondary" />} items={menu} />
        </div>
      </header>

      {state}

      {showStats ? (
        <div id="stats" className="ui-ld-stats">
          <PeriodBar value={period} onChange={setPeriod} custom className="ui-ld-period-row">
            {stats.isError ? null : s ? (
              <>
                <span>{rangeText(s)}, UTC.</span>{" "}
                {s.aeAvailable ? (
                  includesToday(period) ? (
                    <StatsFreshness
                      className="ui-fresh"
                      updatedAt={stats.dataUpdatedAt}
                      fetching={stats.isFetching || recent.isFetching}
                      onRefresh={() => {
                        void stats.refetch();
                        void recent.refetch();
                      }}
                    />
                  ) : null
                ) : (
                  <span className="ui-range-note">Saved days only; today’s clicks appear tomorrow.</span>
                )}
              </>
            ) : (
              <Skeleton className="ui-skel-text" style={{ width: 200 }} />
            )}
          </PeriodBar>

          {stats.isError ? (
            <ErrorState what="This link’s statistics" error={stats.error} onRetry={() => void stats.refetch()} retrying={stats.isFetching} />
          ) : !s || !chart ? (
            <div aria-busy aria-label="Loading statistics">
              <StatStripSkeleton count={money.state === "hidden" ? 3 : 4} aria-hidden />
              <Skeleton className="ui-skel-chart" style={{ height: 232 }} />
              <div className="ui-columns ui-ld-columns">
                <section className="ui-panel"><RowsSkeleton rows={4} /></section>
                <section className="ui-panel"><RowsSkeleton rows={4} /></section>
              </div>
            </div>
          ) : (
            <>
              {/* Period notices sit right after the PeriodBar, on every page. */}
              {empty ? <EmptyPeriod s={s} period={period} onPeriod={setPeriod} /> : null}
              <LinkKpis s={s} link={link} money={money} metric={metric} onMetric={setPicked} period={period} />
              {empty ? null : (
                <>
                  <LinkChart s={s} chart={chart} metric={metric} money={money} />
                  {/* Routing results lead when something was routed; otherwise a one-line summary after the lists. */}
                  {link.routing && routed ? <RoutingPanel routing={link.routing} rows={s.dims.route} period={period} from={s.from} onPeriod={setPeriod} /> : null}
                  <Columns className="ui-ld-columns">
                    <SourcesPanel s={s} />
                    {money.state === "ready" || money.state === "loading" || money.state === "error" ? <MoneyPanel money={money} period={period} domain={domain} slug={slug} /> : <PlacesPanel s={s} />}
                    {money.state === "ready" || money.state === "loading" || money.state === "error" ? <PlacesPanel s={s} /> : null}
                    <DevicesPanel s={s} />
                    <OtherPanel s={s} />
                  </Columns>
                  {link.routing && !routed ? <RoutingPanel routing={link.routing} rows={s.dims.route} period={period} from={s.from} onPeriod={setPeriod} /> : null}
                </>
              )}
            </>
          )}

          <LatestHits q={recent} domain={domain} slug={slug} />
          {s?.aeAvailable ? <PeakHours link={{ domain, slug }} /> : null}
        </div>
      ) : null}

      <Facts link={link} onEdit={edits ? () => setEditing(true) : undefined} onMarkBroken={markAsBroken} onShare={canShare ? () => setSharing(true) : undefined} activeShares={activeShares} />

      <LinkPageHistory link={link} />

      {edits ? (
        <LinkForm
          open={editing}
          onOpenChange={(o) => {
            setEditing(o);
            if (!o) setMarkBroken(false);
          }}
          link={link}
          markBroken={markBroken}
        />
      ) : null}
      {edits && power ? <LinkPower link={link} open={power} onOpenChange={setPower} /> : null}
      {canShare && sharing ? <ShareStats link={link} label={label} open={sharing} onOpenChange={setSharing} /> : null}
      {qr ? (
        <Suspense fallback={null}>
          <QrStudio open onOpenChange={setQr} link={link} label={label} />
        </Suspense>
      ) : null}
      <Dialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        size="sm"
        title={`Delete ${label}?`}
        description="The short link stops working and its slug becomes free. Stats already collected stay. You can restore it from Recently deleted for 90 days; to stop a link for a while, disable it instead."
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button variant="danger" onClick={() => remove.mutate()} loading={remove.isPending}>
              Delete link
            </Button>
          </>
        }
      >
        {dependents.data?.links.length ? (
          <Notice tone="warn">
            {dependents.data.links.map((l) => labelOf(l)).join(", ")} {dependents.data.links.length === 1 ? "uses" : "use"} this link as a replacement. After deleting it, their visitors are sent to the site set in Settings instead.
          </Notice>
        ) : dependents.isError ? (
          <Notice tone="warn">Couldn’t check whether other links use this one as a replacement. If any do, their visitors go to the site set in Settings after the delete.</Notice>
        ) : null}
      </Dialog>
    </div>
  );
}
