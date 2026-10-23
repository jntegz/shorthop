import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, BarChart3, CornerUpRight, Copy, Gauge, Lock, Split, Download, Link2, Plus, Search, QrCode, X } from "lucide-react";
import { lazy, Suspense, useDeferredValue, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import type { LinkDTO, LinkListItem, ListPeriod } from "../../shared/types";
import { api, call, keys } from "../api";

import { problemText } from "../../shared/link-check";
import { describeRouting } from "../../shared/routing";
import { CheckBadge } from "../components/CheckBadge";
import { DeletedLinks } from "../components/DeletedLinks";
import { DownloadButton } from "../components/DownloadButton";
import { LinkForm } from "../components/LinkForm";
import { Badge, Button, buttonClass, Card, Empty, Input, Notice, PageHeader, Pagination, Select, SortHeader, Spinner } from "../components/ui";
import { ago, hostOf, num } from "../lib/format";
import { linkKey, linkPath, linkState, useDomains, useLinkLabel } from "../lib/links";
import { useCan } from "../lib/me";
import { pageOf, parsePageSize, savedPageSize, savePageSize, sortRows, type PageSize, type SortDir } from "../lib/table";
import { copy } from "../lib/utils";

// QR rendering, scan testing and zipping load only when used.
const QrStudio = lazy(() => import("../components/QrStudio").then((module) => ({ default: module.QrStudio })));
const BulkQr = lazy(() => import("../components/BulkQr").then((module) => ({ default: module.BulkQr })));

type Status = "all" | "active" | "disabled" | "expired" | "broken" | "failing";
type Sort = "created" | "updated" | "slug" | "target" | "total" | "clicks" | "status";

const PERIODS: { value: ListPeriod; label: string; short: string }[] = [
  { value: "7d", label: "Last 7 days", short: "7d" },
  { value: "14d", label: "Last 14 days", short: "14d" },
  { value: "30d", label: "Last 30 days", short: "30d" },
  { value: "90d", label: "Last 3 months", short: "3 mo" },
  { value: "180d", label: "Last 6 months", short: "6 mo" },
  { value: "365d", label: "Last 12 months", short: "12 mo" },
  { value: "all", label: "All time", short: "all time" },
];

/** The value each sortable column orders by. "clicks" is the selected period. */
const SORT_VALUE: Record<Sort, (l: LinkListItem) => string | number> = {
  created: (l) => l.createdAt,
  updated: (l) => l.updatedAt,
  slug: (l) => l.slug,
  target: (l) => hostOf(l.target) + l.target,
  total: (l) => l.clicksTotal,
  clicks: (l) => l.clicksPeriod,
  status: (l) => linkState(l),
};
const SORTS = Object.keys(SORT_VALUE) as Sort[];
const TEXT_SORTS: ReadonlySet<Sort> = new Set(["slug", "target", "status"]);

export function StateBadge({ link }: { link: Pick<LinkDTO, "domain" | "active" | "expiresAt" | "broken" | "replacement"> }) {
  const label = useLinkLabel();
  const s = linkState(link);
  if (s === "active") return <Badge tone="good">Active</Badge>;
  if (s === "expired") return <Badge tone="warn">Expired</Badge>;
  // Marked "no longer working" on purpose: the short link still works, so no warning colour.
  if (s === "broken") {
    return link.replacement ? (
      <Badge title={`Visitors are pointed to ${label(link.replacement)}`}>
        <CornerUpRight className="size-3" aria-hidden /> Replaced
      </Badge>
    ) : (
      <Badge title="Visitors see a short notice, then go to the site set in Settings">
        <Archive className="size-3" aria-hidden /> Retired
      </Badge>
    );
  }
  return <Badge>Disabled</Badge>;
}

export function Links() {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get("q") ?? "");
  const q = useDeferredValue(search.trim());
  const tag = params.get("tag") ?? "";
  const domain = params.get("domain") ?? "";
  const { domains, multiple } = useDomains();
  const label = useLinkLabel();
  const status = (params.get("status") as Status | null) ?? "all";
  const sortParam = SORTS.find((s) => s === params.get("sort")) ?? "created";
  const period = PERIODS.find((p) => p.value === params.get("period")) ?? PERIODS[0]!;
  // With "all time" the period column is the total column.
  const sort: Sort = sortParam === "clicks" && period.value === "all" ? "total" : sortParam;
  const dir: SortDir = params.get("dir") === "asc" || params.get("dir") === "desc" ? (params.get("dir") as SortDir) : TEXT_SORTS.has(sort) ? "asc" : "desc";
  const size = parsePageSize(params.get("size")) ?? savedPageSize("links");
  const pageParam = Number(params.get("page") ?? 1);
  const [creating, setCreating] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);
  const [bulkQr, setBulkQr] = useState(false);
  const [qrLink, setQrLink] = useState<LinkListItem | null>(null);
  const urlSearch = params.get("q") ?? "";
  useEffect(() => setSearch(urlSearch), [urlSearch]);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const can = useCan();

  const setParam = (k: string, v: string, def: string) => {
    const next = new URLSearchParams(params);
    if (v === def) next.delete(k);
    else next.set(k, v);
    if (k !== "page") next.delete("page");
    if (k === "sort") next.delete("dir");
    setParams(next, { replace: true });
  };
  const sortBy = (key: Sort) => {
    const next = new URLSearchParams(params);
    next.delete("page");
    if (key === sort) next.set("dir", dir === "asc" ? "desc" : "asc");
    else {
      next.set("sort", key);
      next.delete("dir");
    }
    setParams(next, { replace: true });
  };
  const setSize = (n: PageSize) => {
    savePageSize("links", n);
    setParam("size", String(n), "");
  };

  const query = { q: q || undefined, tag: tag || undefined, domain: domain || undefined, status, period: period.value };
  const links = useQuery({
    queryKey: keys.links(query),
    queryFn: () => call(api.links.$get({ query })),
    placeholderData: (prev) => prev,
  });
  const tags = useQuery({ queryKey: keys.tags, queryFn: () => call(api.tags.$get()) });

  const toggle = useMutation({
    mutationFn: (l: LinkListItem) =>
      call(api.links[":domain"][":slug"].$patch({ param: { domain: l.domain, slug: l.slug }, json: { active: !l.active } })),
    onSuccess: ({ link }) => {
      toast.success(link.active ? `${label(link)} enabled` : `${label(link)} disabled`);
      void qc.invalidateQueries({ queryKey: keys.allLinks });
    },
    onError: (e) => toast.error(e.message),
  });

  const list = links.data?.links ?? [];
  const filtered = Boolean(q || tag || domain || status !== "all");
  const sorted = useMemo(() => sortRows(list, SORT_VALUE[sort], dir), [list, sort, dir]);
  const paged = pageOf(sorted, pageParam, size);

  return (
    <>
      <PageHeader
        title="Your links"
        description="Every destination, beautifully connected. Create, organize, and share."
        actions={
          <>
            <Button variant="outline" onClick={() => setShowDeleted(true)}>
              <ArchiveRestore /> Recently deleted
            </Button>
            <Button variant="outline" onClick={() => setBulkQr(true)} disabled={!list.length}>
              <QrCode /> QR codes
            </Button>
            <DownloadButton href="/_admin/api/export/links.csv">
              <Download /> Export CSV
            </DownloadButton>
            {can("links.create") ? (
              <Button onClick={() => setCreating(true)}>
                <Plus /> Create link
              </Button>
            ) : null}
          </>
        }
      />

      <div className="mb-5 flex flex-wrap gap-2 rounded-2xl border border-line bg-surface p-3">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" />
          <Input
            type="search"
            placeholder="Search your links…"
            className="pl-9"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setParam("q", e.target.value.trim(), "");
            }}
            aria-label="Search links"
          />
        </div>
        {multiple ? (
          <Select className="w-auto" value={domain} onChange={(e) => setParam("domain", e.target.value, "")} aria-label="Filter by domain">
            <option value="">All domains</option>
            {domains.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </Select>
        ) : null}
        <Select className="w-auto" value={tag} onChange={(e) => setParam("tag", e.target.value, "")} aria-label="Filter by tag">
          <option value="">All tags</option>
          {tags.data?.tags.map((t) => (
            <option key={t.tag} value={t.tag}>
              {t.tag} ({t.count})
            </option>
          ))}
        </Select>
        <Select className="w-auto" value={status} onChange={(e) => setParam("status", e.target.value, "all")} aria-label="Filter by status">
          <option value="all">Any status</option>
          <option value="active">Active</option>
          <option value="disabled">Disabled</option>
          <option value="expired">Expired</option>
          <option value="broken">Replaced or retired</option>
          <option value="failing">Destination problems</option>
        </Select>
        <Select className="w-auto" value={sort} onChange={(e) => setParam("sort", e.target.value, "created")} aria-label="Sort">
          <option value="created">Newest</option>
          <option value="updated">Recently edited</option>
          <option value="total">Most total clicks</option>
          {period.value === "all" ? null : <option value="clicks">Most clicks: {period.label.toLowerCase()}</option>}
          <option value="slug">Slug A–Z</option>
          <option value="target">Destination A–Z</option>
          <option value="status">Status</option>
        </Select>
        <Select className="w-auto" value={period.value} onChange={(e) => setParam("period", e.target.value, "7d")} aria-label="Clicks period">
          {PERIODS.map((p) => (
            <option key={p.value} value={p.value}>
              Clicks: {p.label.toLowerCase()}
            </option>
          ))}
        </Select>
      </div>

      <div className="mb-3 flex items-center justify-between gap-3 text-xs text-muted" aria-live="polite">
        <span>{links.isPending ? "Finding your links…" : `${list.length} ${list.length === 1 ? "link" : "links"}${filtered ? " found" : " in your workspace"}`}{links.isFetching && !links.isPending ? " · Updating…" : ""}</span>
        {filtered ? <button className="inline-flex items-center gap-1 text-accent" onClick={() => { setSearch(""); setParams({}); }}><X className="size-3" /> Clear filters</button> : null}
      </div>
      {links.isError ? (
        <Notice tone="danger">{links.error.message}</Notice>
      ) : links.isPending ? (
        <div className="flex justify-center py-24">
          <Spinner />
        </div>
      ) : list.length === 0 ? (
        <Card>
          <Empty icon={<Link2 />} title={filtered ? "No links match" : "No links yet"}>
            <p>{filtered ? "Try a different search or clear your filters." : "Turn a long URL into your next meaningful connection."}</p>
            {!filtered && can("links.create") && <Button className="mt-4" onClick={() => setCreating(true)}><Plus /> Create your first link</Button>}
          </Empty>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full table-fixed text-sm">
            <thead className="hidden border-b border-line bg-bg text-left text-[11px] text-muted md:table-header-group">
              <tr>
                <SortHeader label="Link" className="w-[25%] py-3.5" active={sort === "slug"} dir={dir} onSort={() => sortBy("slug")} />
                <SortHeader label="Destination" className="w-[25%] py-3.5" active={sort === "target"} dir={dir} onSort={() => sortBy("target")} />
                <SortHeader label="Total clicks" className="text-right" active={sort === "total"} dir={dir} onSort={() => sortBy("total")} />
                {period.value === "all" ? null : (
                  <SortHeader label={period.label} className="hidden text-right lg:table-cell" active={sort === "clicks"} dir={dir} onSort={() => sortBy("clicks")} />
                )}
                <SortHeader label="Status" active={sort === "status"} dir={dir} onSort={() => sortBy("status")} />
                <SortHeader label="Created" className="hidden py-3.5 xl:table-cell" active={sort === "created"} dir={dir} onSort={() => sortBy("created")} />
                <th className="w-52 px-2 py-2.5 xl:w-72">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {paged.rows.map((l) => (
                <tr
                  key={linkKey(l.domain, l.slug)}
                  className="group flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-3 last:border-0 hover:bg-surface-2/60 md:table-row md:p-0"
                  onClick={() => navigate(linkPath(l))}
                >
                  <td className="min-w-0 basis-full md:basis-auto md:px-4 md:py-5">
                    <div className="flex items-center gap-1.5">
                      <Link to={linkPath(l)} className="min-w-0 truncate font-semibold text-accent hover:underline" onClick={(e) => e.stopPropagation()}>
                        {label(l)}
                      </Link>
                      {l.source === "import" ? <Badge>Imported</Badge> : null}
                      {l.protected ? (
                        <span title="Password protected" className="text-muted">
                          <Lock className="size-3.5" aria-label="Password protected" />
                        </span>
                      ) : null}
                      {l.maxClicks ? (
                        <span title={`Opens at most ${l.maxClicks.toLocaleString("en")} times`} className="text-muted">
                          <Gauge className="size-3.5" aria-label="Visit limit" />
                        </span>
                      ) : null}
                      {l.routing ? (
                        <Badge tone="accent" title={`Smart routing: ${describeRouting(l.routing)}`}>
                          <Split className="size-3" aria-hidden /> Smart
                        </Badge>
                      ) : null}
                    </div>
                    {l.title ? <div className="mt-1 max-w-56 truncate text-xs text-muted">{l.title}</div> : null}
                    {l.tags.length ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {l.tags.map((t) => (
                          <Badge key={t} tone="accent">
                            {t}
                          </Badge>
                        ))}
                      </div>
                    ) : null}
                  </td>
                  <td className="min-w-0 basis-full md:basis-auto md:px-4 md:py-5">
                    <div className="max-w-xs truncate text-muted" title={l.target}>
                      <span className="text-fg">{hostOf(l.target)}</span>
                      {l.target.slice(l.target.indexOf(hostOf(l.target)) + hostOf(l.target).length)}
                    </div>
                  </td>
                  <td className="tabular md:px-4 md:py-5 md:text-right">
                    <span className="font-medium text-fg">{num(l.clicksTotal)}</span>
                    <span className="text-xs text-muted md:hidden"> clicks{period.value === "all" ? "" : ` · ${num(l.clicksPeriod)} in ${period.short}`}</span>
                  </td>
                  {period.value === "all" ? null : <td className="tabular hidden text-muted md:px-4 md:py-5 md:text-right lg:table-cell">{num(l.clicksPeriod)}</td>}
                  <td className="md:px-4 md:py-5">
                    <div className="flex flex-wrap items-start gap-1 md:flex-col">
                      <StateBadge link={l} />
                      {l.check && (l.check.state === "down" || l.check.state === "warning") && linkState(l) === "active" ? (
                        <Link
                          to={`/health?state=${l.check.state}`}
                          onClick={(e) => e.stopPropagation()}
                          title={problemText(l.check.problem, l.check.httpStatus)}
                          className="rounded-full focus-visible:outline-offset-1"
                        >
                          <CheckBadge state={l.check.state} label={l.check.state === "down" ? "Destination down" : "Destination issue"} />
                        </Link>
                      ) : null}
                    </div>
                  </td>
                  <td className="hidden text-xs text-muted md:px-4 md:py-5 xl:table-cell">{ago(l.createdAt)}</td>
                  <td className="ml-auto md:px-2 md:py-5" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-end gap-1">
                      {can("stats.view") ? (
                        <Link
                          to={`${linkPath(l)}#stats`}
                          className={buttonClass({ variant: "outline", size: "sm" })}
                          aria-label={`Statistics for ${label(l)}`}
                          title="Clicks, countries, sources and devices"
                        >
                          <BarChart3 /> <span className="hidden sm:inline">Statistics</span>
                        </Link>
                      ) : null}
                      <Button variant="ghost" size="icon-sm" aria-label={`Copy ${l.shortUrl}`} title="Copy short URL" onClick={() => void copy(l.shortUrl)}>
                        <Copy />
                      </Button>
                      <Button variant="ghost" size="icon-sm" aria-label={`QR code for ${label(l)}`} title="QR code" onClick={() => setQrLink(l)}><QrCode /></Button>
                      {can("links.edit") ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="hidden xl:inline-flex"
                          onClick={() => toggle.mutate(l)}
                          disabled={toggle.isPending && toggle.variables?.slug === l.slug && toggle.variables.domain === l.domain}
                        >
                          {l.active ? "Disable" : "Enable"}
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {list.length ? (
        <Pagination
          page={paged.page}
          pages={paged.pages}
          size={size}
          total={list.length}
          onPage={(p) => {
            setParam("page", String(p), "1");
            window.scrollTo({ top: 0 });
          }}
          onSize={setSize}
        />
      ) : null}

      {qrLink && <Suspense fallback={<div role="status" className="fixed right-6 bottom-24 z-40 rounded-xl border border-line bg-surface p-4 text-sm shadow-lg">Preparing QR code…</div>}><QrStudio open onOpenChange={(open) => !open && setQrLink(null)} link={qrLink} label={label(qrLink)} /></Suspense>}
      {can("links.create") ? <LinkForm open={creating} onOpenChange={setCreating} onSaved={(l) => navigate(linkPath(l))} /> : null}
      <DeletedLinks open={showDeleted} onOpenChange={setShowDeleted} />
      {bulkQr ? (
        <Suspense fallback={null}>
          <BulkQr open onOpenChange={setBulkQr} links={sorted} label={label} filtered={filtered} />
        </Suspense>
      ) : null}
    </>
  );
}
