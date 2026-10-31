// The links list (and, with ?status=bio, the Bio pages view): filters in the
// URL, client-side sort and paging, selection, bulk actions, export, QR
// codes, recently deleted, reports and the LinkForm dialog. Quiet chrome, one
// filter row, dense keyboard-first rows.
//
// Keys: / search · j/k or ↑/↓ move · Enter open · x or Space select ·
// . row actions · Esc clear the selection · c create (the shell's, or a bio
// page in the Bio pages view).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArchiveRestore, Download, Ellipsis, Plus, QrCode, Search, Share2, SlidersHorizontal, Tags, X } from "lucide-react";
import { lazy, Suspense, useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import type { LinkListItem, ListPeriod } from "../../../shared/types";
import { api, call, downloadFile, keys } from "../../api";
import { CampaignShare, SharedReports, type ReportSubject } from "../../components/CampaignShare";
import { DeletedLinks } from "./Deleted";
import { LinkForm } from "../../components/LinkForm";
import { TagManager } from "../../components/TagManager";
import { fullNum, hostOf } from "../../lib/format";
import { linkKey, linkPath, linkState, useDomains, useLinkLabel } from "../../lib/links";
import { useCan } from "../../lib/me";
import { PAGE_SIZES, pageOf, parsePageSize, savedPageSize, savePageSize, sortRows, type PageSize, type SortDir } from "../../lib/table";
import { cn, copy } from "../../lib/utils";
import { Button, Checkbox, Empty, ErrorState, errorText, Menu, Pager, Select, Sheet, Skeleton, SortTH, Table, TextButton, TH, type MenuItem } from "../ui";
import { BulkBar } from "./BulkBar";
import { hasStatus, LinkRow, SkeletonRows } from "./parts";

const QrStudio = lazy(() => import("../../components/QrStudio").then((m) => ({ default: m.QrStudio })));
const BulkQr = lazy(() => import("../../components/BulkQr").then((m) => ({ default: m.BulkQr })));

type Status = "all" | "active" | "disabled" | "expired" | "broken" | "failing" | "shared" | "bio";
type Sort = "created" | "updated" | "slug" | "target" | "total" | "clicks" | "status";

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

const PERIODS: { value: ListPeriod; label: string; head: string; short: string }[] = [
  { value: "7d", label: "Last 7 days", head: "7 days", short: "7d" },
  { value: "14d", label: "Last 14 days", head: "14 days", short: "14d" },
  { value: "30d", label: "Last 30 days", head: "30 days", short: "30d" },
  { value: "90d", label: "Last 3 months", head: "3 months", short: "3 mo" },
  { value: "180d", label: "Last 6 months", head: "6 months", short: "6 mo" },
  { value: "365d", label: "Last 12 months", head: "12 months", short: "12 mo" },
  { value: "all", label: "All time", head: "All time", short: "All" },
];

const STATUS_OPTIONS: { value: Status; label: string }[] = [
  { value: "all", label: "Any status" },
  { value: "active", label: "Active" },
  { value: "disabled", label: "Disabled" },
  { value: "expired", label: "Expired" },
  { value: "broken", label: "Replaced or retired" },
  { value: "failing", label: "Destination problems" },
  { value: "shared", label: "Shared statistics" },
  { value: "bio", label: "Bio pages" },
];

function isTyping(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}
const overlayOpen = () => Boolean(document.querySelector("[role=dialog], [role=menu]"));

const COLUMNS_KEY = "nx.links.columns";
type ColumnMemory = Record<string, boolean>;
/** Which optional columns the list had last time (UI memory only, per browser): "period:7d", "status". */
function readColumn(id: string): boolean | null {
  try {
    const v = (JSON.parse(localStorage.getItem(COLUMNS_KEY) ?? "{}") as ColumnMemory)[id];
    return typeof v === "boolean" ? v : null;
  } catch {
    return null;
  }
}
function writeColumn(id: string, on: boolean) {
  try {
    const all = JSON.parse(localStorage.getItem(COLUMNS_KEY) ?? "{}") as ColumnMemory;
    if (all[id] === on) return;
    localStorage.setItem(COLUMNS_KEY, JSON.stringify({ ...all, [id]: on }));
  } catch {
    // Storage off: the skeleton just guesses.
  }
}

export function LinksPage() {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get("q") ?? "");
  const q = useDeferredValue(search.trim());
  const tag = params.get("tag") ?? "";
  const domain = params.get("domain") ?? "";
  const { domains, multiple } = useDomains();
  const label = useLinkLabel();
  const status = (params.get("status") as Status | null) ?? "all";
  const bios = status === "bio";
  const sortParam = SORTS.find((s) => s === params.get("sort")) ?? "created";
  const period = PERIODS.find((p) => p.value === params.get("period")) ?? PERIODS[0]!;
  const sort: Sort = sortParam === "clicks" && period.value === "all" ? "total" : sortParam;
  const dir: SortDir = params.get("dir") === "asc" || params.get("dir") === "desc" ? (params.get("dir") as SortDir) : TEXT_SORTS.has(sort) ? "asc" : "desc";
  const size = parsePageSize(params.get("size")) ?? savedPageSize("links");
  const pageParam = Number(params.get("page") ?? 1);
  const [creating, setCreating] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);
  const [bulkQr, setBulkQr] = useState(false);
  const [qrLink, setQrLink] = useState<LinkListItem | null>(null);
  const [managingTags, setManagingTags] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [qrPicked, setQrPicked] = useState(false);
  const [reportOf, setReportOf] = useState<ReportSubject | null>(null);
  const [showReports, setShowReports] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  // "Shorten this page" (bookmarklet) and the PWA share target open the form filled in.
  const shared =
    params.get("new") === "1" || params.has("url") || params.has("text")
      ? { url: params.get("url") || params.get("text") || "", title: params.get("title") ?? "" }
      : null;
  const [prefill, setPrefill] = useState<{ url: string; title: string } | null>(null);
  useEffect(() => {
    if (!shared) return;
    const url = /https?:\/\/\S+/.exec(shared.url)?.[0] ?? shared.url;
    setPrefill({ url, title: shared.title });
    setCreating(true);
    const next = new URLSearchParams(params);
    for (const k of ["new", "url", "title", "text"]) next.delete(k);
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shared?.url, shared?.title]);
  const urlSearch = params.get("q") ?? "";
  useEffect(() => setSearch(urlSearch), [urlSearch]);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const can = useCan();
  const seesClicks = can("stats.view");
  const canEdit = can("links.edit");
  const creates = can("links.create");

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
  /** Clear search and filters; the Bio pages view stays the Bio pages view. */
  const clearFilters = () => {
    setSearch("");
    setParams(bios ? { status: "bio" } : {});
  };

  const query = { q: q || undefined, tag: tag || undefined, domain: domain || undefined, status, period: period.value };
  const links = useQuery({
    queryKey: keys.links(query),
    queryFn: () => call(api.links.$get({ query })),
    placeholderData: (prev) => prev,
  });
  const tags = useQuery({ queryKey: keys.tags, queryFn: () => call(api.tags.$get()) });

  const toggle = useMutation({
    mutationFn: (l: Pick<LinkListItem, "domain" | "slug" | "active">) =>
      call(api.links[":domain"][":slug"].$patch({ param: { domain: l.domain, slug: l.slug }, json: { active: !l.active } })),
    onSuccess: ({ link }) => {
      // The list offers undo instead of a confirmation.
      toast.success(link.active ? `${label(link)} enabled` : `${label(link)} disabled`, {
        action: { label: "Undo", onClick: () => toggle.mutate({ domain: link.domain, slug: link.slug, active: link.active }) },
      });
      void qc.invalidateQueries({ queryKey: keys.allLinks });
    },
    onError: (e) => toast.error(errorText(e) ?? "That didn’t work. Try again."),
  });

  const list = links.data?.links ?? [];
  /* Narrow screens keep one clicks column: the chosen period's, unless nothing
     in the list was clicked in it; then Total, never a column of zeros. */
  const periodEmpty = list.length > 0 && list.every((l) => !l.clicksPeriod) && list.some((l) => l.clicksTotal > 0);
  const sorted = useMemo(() => sortRows(list, SORT_VALUE[sort], dir), [list, sort, dir]);
  const paged = pageOf(sorted, pageParam, size);
  const searching = Boolean(q || tag || domain);
  const filtered = searching || status !== "all";
  const filterCount = [tag, domain, status !== "all" && !bios ? status : ""].filter(Boolean).length;
  const filterKey = JSON.stringify([q, tag, domain, status]);
  useEffect(() => setPicked(new Set()), [filterKey]);
  const selected = sorted.filter((l) => picked.has(linkKey(l.domain, l.slug)));
  const pageKeys = paged.rows.map((l) => linkKey(l.domain, l.slug));
  const pageAll = pageKeys.length > 0 && pageKeys.every((k) => picked.has(k));
  const pageSome = pageKeys.some((k) => picked.has(k));
  const toggleKeys = (keysToSet: string[], on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      for (const k of keysToSet) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  const canSelect = can("links.edit") || can("links.delete");
  const canReport = can("stats.view") && can("links.edit");
  const exportQuery = new URLSearchParams(Object.entries({ q, tag, domain, status: status === "all" ? "" : status }).filter(([, v]) => v) as [string, string][]).toString();
  const showPeriod = period.value !== "all";
  /* Columns that carry nothing for these rows aren't drawn (decided from the
     loaded list): the period's clicks when the whole list has none in it
     (Total stands alone; kept while it is the sort), Status when no row has one. */
  const loadedPeriodCol = seesClicks && showPeriod && (!periodEmpty || sort === "clicks");
  // The skeleton draws the columns the list had last time (this browser), so
  // a "7 days" column doesn't appear while loading and vanish when the rows land.
  const periodCol = links.isPending ? seesClicks && showPeriod && (sort === "clicks" || (readColumn(`period:${period.value}`) ?? true)) : loadedPeriodCol;
  const loadedStatusCol = list.some(hasStatus);
  const statusCol = links.isPending ? (readColumn(bios ? "bio:status" : "status") ?? false) : loadedStatusCol;
  useEffect(() => {
    if (links.isPending) return;
    if (seesClicks && showPeriod) writeColumn(`period:${period.value}`, loadedPeriodCol);
    writeColumn(bios ? "bio:status" : "status", loadedStatusCol);
  }, [links.isPending, seesClicks, showPeriod, period.value, loadedPeriodCol, loadedStatusCol, bios]);
  const noun = bios ? (list.length === 1 ? "bio page" : "bio pages") : list.length === 1 ? "link" : "links";

  // Page keys. Document bubble phase runs before the shell's window listener,
  // so "/" focuses this search instead of opening the command bar.
  const hasSelection = picked.size > 0;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape" && hasSelection && !overlayOpen() && !isTyping(e.target)) {
        setPicked(new Set());
        return;
      }
      if (isTyping(e.target) || overlayOpen()) return;
      if (e.key === "/") {
        e.preventDefault();
        e.stopPropagation();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.key === "c" && bios && creates) {
        e.preventDefault();
        e.stopPropagation();
        setCreating(true);
      } else if (["j", "k", "ArrowDown"].includes(e.key) && (document.activeElement === document.body || document.activeElement?.id === "ui-main")) {
        const row = tableRef.current?.querySelector<HTMLElement>('tr[data-row][tabindex="0"]');
        if (row) {
          e.preventDefault();
          row.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [bios, creates, hasSelection]);

  /** Row keys the shared Table doesn't know: x selects, "." opens the row's actions. */
  const onTableKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement;
    const row = target.closest<HTMLTableRowElement>("tr[data-row]");
    if (!row || !tableRef.current?.contains(row)) return;
    if (target !== row) {
      // Focus left on a row control (after its menu closed): arrows go back to the row.
      if (["ArrowDown", "ArrowUp", "j", "k"].includes(e.key) && !target.closest("[role=menu]")) row.focus();
      return;
    }
    if (e.key === "x") {
      e.preventDefault();
      row.querySelector<HTMLElement>("[data-row-select]")?.click();
    } else if (e.key === "." || e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      setMenuKey(row.dataset.key ?? null);
    }
  };

  const onSearchKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || (e.key === "Enter" && search.trim())) {
      const row = tableRef.current?.querySelector<HTMLElement>('tr[data-row][tabindex="0"]');
      if (row) {
        e.preventDefault();
        row.focus();
      }
    } else if (e.key === "Escape" && !search) {
      e.currentTarget.blur();
    }
  };

  const exportAll = () => {
    downloadFile(`/_admin/api/export/links.csv${exportQuery ? `?${exportQuery}` : ""}`).catch((e: unknown) => toast.error(errorText(e) ?? "The export failed."));
  };
  const pageMenu: (MenuItem | "separator")[] = [
    { label: filtered ? `QR codes for these ${fullNum(list.length)}` : "QR codes for every link", icon: QrCode, disabled: !list.length, onSelect: () => setBulkQr(true) },
    { label: filtered ? "Export these as CSV" : "Export CSV", icon: Download, onSelect: exportAll },
    "separator",
    ...(canEdit ? [{ label: "Manage tags", icon: Tags, onSelect: () => setManagingTags(true) }] : []),
    ...(canReport ? [{ label: "Shared reports", icon: Share2, onSelect: () => setShowReports(true) }] : []),
    { label: "Recently deleted", icon: ArchiveRestore, onSelect: () => setShowDeleted(true) },
  ];

  const tagOptions = [{ value: "", label: tags.isError && !tags.data ? "Tags couldn’t load" : "All tags" }, ...(tags.data?.tags.map((t) => ({ value: t.tag, label: `${t.tag} (${t.count})` })) ?? [])];
  const fields = (compact: boolean) => (
    <>
      <Select label="Status" hideLabel={compact} value={status} onChange={(e) => setParam("status", e.target.value, "all")} options={STATUS_OPTIONS} className="links-f-status" />
      <Select label="Tag" hideLabel={compact} value={tag} onChange={(e) => setParam("tag", e.target.value, "")} options={tagOptions} className="links-f-tag" />
      {multiple ? (
        <Select label="Domain" hideLabel={compact} value={domain} onChange={(e) => setParam("domain", e.target.value, "")} options={[{ value: "", label: "All domains" }, ...domains.map((d) => ({ value: d, label: d }))]} className="links-f-domain" />
      ) : null}
      <Select
        label="Sort"
        hideLabel={compact}
        value={sort}
        onChange={(e) => setParam("sort", e.target.value, "created")}
        className="links-f-sort"
        options={[
          { value: "created", label: "Newest" },
          { value: "updated", label: "Recently edited" },
          ...(seesClicks ? [{ value: "total", label: "Most clicks, all time" }] : []),
          ...(seesClicks && showPeriod ? [{ value: "clicks", label: `Most clicks, ${period.head}` }] : []),
          { value: "slug", label: "Slug A–Z" },
          { value: "target", label: "Destination A–Z" },
          { value: "status", label: "Status" },
        ]}
      />
      {seesClicks ? (
        <Select
          label="Clicks period"
          hideLabel={compact}
          value={period.value}
          onChange={(e) => setParam("period", e.target.value, "7d")}
          options={PERIODS.map((p) => ({ value: p.value, label: compact ? `Clicks: ${p.head}` : p.label }))}
          className="links-f-period"
        />
      ) : null}
    </>
  );

  const loading = links.isPending;
  const failed = links.isError && !links.data;
  const noBios = bios && !loading && !failed && list.length === 0;

  return (
    <div className="ui-page links-page">
      <header className="ui-head links-head">
        <div className="ui-head-main">
          <h1 className="ui-h1">{bios ? "Bio pages" : "All links"}</h1>
          {bios ? (
            <p className="ui-head-sub links-intro">One short address that shows a page of buttons. Buttons that are your own links count their clicks and sales on those links.</p>
          ) : (
            <p className="ui-head-sub">Every short link in this workspace.</p>
          )}
        </div>
        <div className="ui-head-tools">
          <Menu label="More for this list" items={pageMenu} trigger={<Button icon={Ellipsis} aria-label="More: export, QR codes, tags, reports, recently deleted">More</Button>} />
          {/* Not while the empty state offers the same action as its one primary. */}
          {bios && creates && !(noBios && !searching) ? (
            <Button icon={Plus} kbd="C" onClick={() => setCreating(true)} aria-keyshortcuts="c" className="links-create-bio">
              <span className="links-create-long">Create bio page</span>
              <span className="links-create-short" aria-hidden>Bio page</span>
            </Button>
          ) : null}
        </div>
      </header>

      <div className="links-filters" role="search">
        <div className="links-search">
          <label htmlFor="links-q" className="ui-sr">Search {bios ? "bio pages" : "links"}</label>
          <Search aria-hidden className="links-search-icon" />
          <input
            ref={searchRef}
            id="links-q"
            name="q"
            type="search"
            className="ui-input"
            placeholder={bios ? "Search bio pages…" : "Search links…"}
            value={search}
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
            aria-keyshortcuts="/"
            onKeyDown={onSearchKey}
            onChange={(e) => {
              setSearch(e.target.value);
              setParam("q", e.target.value.trim(), "");
            }}
          />
          {search ? null : <kbd aria-hidden className="links-search-kbd">/</kbd>}
        </div>
        <div className="links-fields">{fields(true)}</div>
        <Button icon={SlidersHorizontal} className="links-filters-btn" onClick={() => setFiltersOpen(true)} aria-haspopup="dialog">
          Filters{filterCount ? <span className="links-count-pill">{filterCount}<span className="ui-sr"> active</span></span> : null}
        </Button>
      </div>

      <div className="links-meta">
        <p className="links-meta-count" aria-live="polite">
          {failed || (!loading && !list.length) ? null : loading ? (
            <Skeleton className="ui-skel-text" style={{ width: 150 }} />
          ) : (
            <>
              <span className="links-meta-n">{fullNum(list.length)}</span>
              <span>
                {noun}
                {searching || (filtered && !bios) ? (list.length === 1 ? " matches" : " match") : ""}
                {showPeriod && seesClicks && !periodCol ? <span className="links-meta-note">, none clicked in the {period.label.toLowerCase()}</span> : null}
              </span>
              {links.isFetching ? <span className="links-updating"> · Updating…</span> : null}
            </>
          )}
        </p>
        <p className="links-meta-actions">
          {canReport && tag ? <TextButton onClick={() => setReportOf({ scope: "tag", tag })}>Share a report on “{tag}”</TextButton> : null}
          {canSelect && list.length > paged.rows.length && selected.length < list.length ? <TextButton onClick={() => toggleKeys(sorted.map((l) => linkKey(l.domain, l.slug)), true)}>Select all {fullNum(list.length)}</TextButton> : null}
          {list.length && (searching || (filtered && !bios)) ? (
            <TextButton onClick={clearFilters}>
              <X aria-hidden className="links-inline-icon" />
              Clear filters
            </TextButton>
          ) : null}
          {list.length ? (
            <span className="links-keys" aria-hidden>
              <kbd>j</kbd>
              <kbd>k</kbd> move <kbd>↵</kbd> open {canSelect ? <><kbd>x</kbd> select </> : null}<kbd>.</kbd> actions
            </span>
          ) : null}
        </p>
      </div>

      {failed ? (
        <ErrorState what={bios ? "Your bio pages" : "Your links"} error={links.error} onRetry={() => void links.refetch()} retrying={links.isFetching} />
      ) : !loading && list.length === 0 ? (
        bios && !searching ? (
          <Empty
            title="No bio pages yet"
            action={creates ? <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>Create a bio page</Button> : undefined}
          >
            A bio page puts your links behind one short address for a profile, a video description or a printed card. Each button can be one of your own short links, so its clicks and sales are counted.
          </Empty>
        ) : filtered ? (
          <Empty title={bios ? "No bio pages match" : "No links match these filters"} action={<Button icon={X} onClick={clearFilters}>Clear filters</Button>}>
            {q ? <>Nothing matches “{q}”{tag || domain || (status !== "all" && !bios) ? " with these filters" : ""}. </> : null}
            Try a different search, or clear the filters to see every {bios ? "bio page" : "link"}.
          </Empty>
        ) : (
          <Empty title="No links yet" action={creates ? <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>Create your first link</Button> : undefined}>
            Short links you create show up here with their clicks, tags and status.
          </Empty>
        )
      ) : (
        <div ref={tableRef} className="links-table-wrap" onKeyDown={onTableKey} aria-busy={loading || undefined}>
          <Table label={bios ? "Bio pages" : "Links"} rowNav className={cn("links-table", periodCol && "has-period")}>
            <thead>
              <tr>
                {canSelect ? (
                  <TH className="links-c-check">
                    <Checkbox label="Select the links on this page" hideLabel checked={pageAll ? true : pageSome ? "indeterminate" : false} onCheckedChange={(on) => toggleKeys(pageKeys, on)} disabled={loading} />
                  </TH>
                ) : null}
                <SortTH label={bios ? "Bio page" : "Link"} className="links-c-link" active={sort === "slug"} dir={dir} onSort={() => sortBy("slug")} />
                <SortTH label="Destination" className="links-c-dest" active={sort === "target"} dir={dir} onSort={() => sortBy("target")} />
                <TH className="links-c-tags">Tags</TH>
                {statusCol ? <SortTH label="Status" className="links-c-status" active={sort === "status"} dir={dir} onSort={() => sortBy("status")} /> : null}
                {periodCol ? <SortTH label={period.head} short={period.short} numeric className="links-c-num links-c-period" active={sort === "clicks"} dir={dir} onSort={() => sortBy("clicks")} /> : null}
                {seesClicks ? <SortTH label={showPeriod ? "Total" : "Clicks"} short={periodCol ? "All" : undefined} numeric className={periodCol ? "links-c-num links-c-total" : "links-c-num"} active={sort === "total"} dir={dir} onSort={() => sortBy("total")} /> : null}
                <TH className="links-c-menu"><span className="ui-sr">Actions</span></TH>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <SkeletonRows rows={10} canSelect={canSelect} seesClicks={seesClicks} showPeriod={periodCol} statusCol={statusCol} />
              ) : (
                paged.rows.map((l, i) => {
                  const key = linkKey(l.domain, l.slug);
                  return (
                    <LinkRow
                      key={key}
                      l={l}
                      first={i === 0}
                      bios={bios}
                      canSelect={canSelect}
                      checked={picked.has(key)}
                      onCheck={(on) => toggleKeys([key], on)}
                      seesClicks={seesClicks}
                      showPeriod={periodCol}
                      statusCol={statusCol}
                      periodLabel={period.label}
                      canEdit={canEdit}
                      toggling={toggle.isPending && toggle.variables?.slug === l.slug && toggle.variables.domain === l.domain}
                      onCopy={() => void copy(l.shortUrl)}
                      onQr={() => setQrLink(l)}
                      onToggle={() => toggle.mutate(l)}
                      onTag={(t) => setParam("tag", t, "")}
                      menuOpen={menuKey === key}
                      onMenuOpenChange={(o) => setMenuKey(o ? key : null)}
                    />
                  );
                })
              )}
            </tbody>
          </Table>
        </div>
      )}

      <BulkBar
        selected={selected}
        tags={tags.data?.tags.map((t) => t.tag) ?? []}
        onClear={() => setPicked(new Set())}
        onQr={() => setQrPicked(true)}
        onShare={canReport ? () => setReportOf({ scope: "set", links: selected.map(({ domain, slug }) => ({ domain, slug })) }) : undefined}
      />

      {!loading && list.length > PAGE_SIZES[0] ? (
        <Pager
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

      <Sheet open={filtersOpen} onOpenChange={setFiltersOpen} title="Filter and sort" footer={<>{filtered && !(bios && !searching) ? <Button icon={X} onClick={() => { clearFilters(); setFiltersOpen(false); }}>Clear filters</Button> : null}<Button variant="primary" onClick={() => setFiltersOpen(false)}>Show {loading ? "" : `${fullNum(list.length)} `}{noun}</Button></>}>
        <div className="links-sheet-fields">{fields(false)}</div>
      </Sheet>
      <CampaignShare subject={reportOf} open={reportOf !== null} onOpenChange={(o) => !o && setReportOf(null)} />
      <SharedReports open={showReports} onOpenChange={setShowReports} />
      {qrLink ? (
        <Suspense fallback={<div role="status" className="links-preparing">Preparing QR code…</div>}>
          <QrStudio open onOpenChange={(open) => !open && setQrLink(null)} link={qrLink} label={label(qrLink)} />
        </Suspense>
      ) : null}
      {creates ? (
        <LinkForm
          open={creating}
          onOpenChange={(o) => {
            setCreating(o);
            if (!o) setPrefill(null);
          }}
          initialTarget={prefill?.url}
          initialTitle={prefill?.title}
          asBio={bios && !prefill}
          onSaved={(l) => navigate(linkPath(l))}
        />
      ) : null}
      <TagManager open={managingTags} onOpenChange={setManagingTags} />
      {qrPicked ? (
        <Suspense fallback={null}>
          <BulkQr open onOpenChange={setQrPicked} links={selected} label={label} filtered />
        </Suspense>
      ) : null}
      <DeletedLinks open={showDeleted} onOpenChange={setShowDeleted} />
      {bulkQr ? (
        <Suspense fallback={null}>
          <BulkQr open onOpenChange={setBulkQr} links={sorted} label={label} filtered={filtered} />
        </Suspense>
      ) : null}
    </div>
  );
}

