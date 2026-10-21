import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BarChart3, Copy, Download, Link2, Plus, Search, QrCode, X } from "lucide-react";
import { lazy, Suspense, useDeferredValue, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import type { LinkDTO, LinkListItem, ListPeriod } from "../../shared/types";
import { api, call, keys } from "../api";

import { DownloadButton } from "../components/DownloadButton";
import { LinkForm } from "../components/LinkForm";
import { Badge, Button, buttonClass, Card, Empty, Input, Notice, PageHeader, Select, Spinner } from "../components/ui";
import { ago, hostOf, num } from "../lib/format";
import { linkKey, linkPath, useDomains, useLinkLabel } from "../lib/links";
import { copy } from "../lib/utils";

const QrDialog = lazy(() => import("../components/QrDialog").then((module) => ({ default: module.QrDialog })));

type Status = "all" | "active" | "disabled" | "expired";
type Sort = "created" | "updated" | "slug" | "clicks";

const PERIODS: { value: ListPeriod; label: string; short: string }[] = [
  { value: "7d", label: "Last 7 days", short: "7d" },
  { value: "14d", label: "Last 14 days", short: "14d" },
  { value: "30d", label: "Last 30 days", short: "30d" },
  { value: "90d", label: "Last 3 months", short: "3 mo" },
  { value: "180d", label: "Last 6 months", short: "6 mo" },
  { value: "365d", label: "Last 12 months", short: "12 mo" },
  { value: "all", label: "All time", short: "all time" },
];

function linkState(l: Pick<LinkDTO, "active" | "expiresAt">): "active" | "disabled" | "expired" {
  if (!l.active) return "disabled";
  if (l.expiresAt !== null && l.expiresAt * 1000 <= Date.now()) return "expired";
  return "active";
}

export function StateBadge({ link }: { link: Pick<LinkDTO, "active" | "expiresAt"> }) {
  const s = linkState(link);
  if (s === "active") return <Badge tone="good">Active</Badge>;
  if (s === "expired") return <Badge tone="warn">Expired</Badge>;
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
  const sort = (params.get("sort") as Sort | null) ?? "created";
  const period = PERIODS.find((p) => p.value === params.get("period")) ?? PERIODS[0]!;
  const [creating, setCreating] = useState(false);
  const [qrLink, setQrLink] = useState<LinkListItem | null>(null);
  const urlSearch = params.get("q") ?? "";
  useEffect(() => setSearch(urlSearch), [urlSearch]);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const setParam = (k: string, v: string, def: string) => {
    const next = new URLSearchParams(params);
    if (v === def) next.delete(k);
    else next.set(k, v);
    setParams(next, { replace: true });
  };

  const query = { q: q || undefined, tag: tag || undefined, domain: domain || undefined, status, sort, period: period.value };
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

  return (
    <>
      <PageHeader
        title="Your links"
        description="Every destination, beautifully connected. Create, organize, and share."
        actions={
          <>
            <DownloadButton href="/_admin/api/export/links.csv">
              <Download /> Export CSV
            </DownloadButton>
            <Button onClick={() => setCreating(true)}>
              <Plus /> Create link
            </Button>
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
        </Select>
        <Select className="w-auto" value={sort} onChange={(e) => setParam("sort", e.target.value, "created")} aria-label="Sort">
          <option value="created">Newest</option>
          <option value="updated">Recently edited</option>
          <option value="clicks">Most clicks</option>
          <option value="slug">Slug A–Z</option>
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
            {!filtered && <Button className="mt-4" onClick={() => setCreating(true)}><Plus /> Create your first link</Button>}
          </Empty>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full table-fixed text-sm">
            <thead className="hidden border-b border-line bg-bg text-left text-[11px] text-muted md:table-header-group">
              <tr>
                <th className="w-[25%] px-4 py-3.5 font-medium">Link</th>
                <th className="w-[25%] px-4 py-3.5 font-medium">Destination</th>
                <th className="px-4 py-2.5 text-right font-medium">Total clicks</th>
                {period.value === "all" ? null : <th className="hidden px-4 py-2.5 text-right font-medium lg:table-cell">{period.label}</th>}
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="hidden px-4 py-3.5 font-medium xl:table-cell">Created</th>
                <th className="w-52 px-2 py-2.5 xl:w-72">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((l) => (
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
                    <StateBadge link={l} />
                  </td>
                  <td className="hidden text-xs text-muted md:px-4 md:py-5 xl:table-cell">{ago(l.createdAt)}</td>
                  <td className="ml-auto md:px-2 md:py-5" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-end gap-1">
                      <Link
                        to={`${linkPath(l)}#stats`}
                        className={buttonClass({ variant: "outline", size: "sm" })}
                        aria-label={`Statistics for ${label(l)}`}
                        title="Clicks, countries, sources and devices"
                      >
                        <BarChart3 /> <span className="hidden sm:inline">Statistics</span>
                      </Link>
                      <Button variant="ghost" size="icon-sm" aria-label={`Copy ${l.shortUrl}`} title="Copy short URL" onClick={() => void copy(l.shortUrl)}>
                        <Copy />
                      </Button>
                      <Button variant="ghost" size="icon-sm" aria-label={`QR code for ${label(l)}`} title="QR code" onClick={() => setQrLink(l)}><QrCode /></Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="hidden xl:inline-flex"
                        onClick={() => toggle.mutate(l)}
                        disabled={toggle.isPending && toggle.variables?.slug === l.slug && toggle.variables.domain === l.domain}
                      >
                        {l.active ? "Disable" : "Enable"}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {qrLink && <Suspense fallback={<div role="status" className="fixed right-6 bottom-24 z-40 rounded-xl border border-line bg-surface p-4 text-sm shadow-lg">Preparing QR code…</div>}><QrDialog open onOpenChange={(open) => !open && setQrLink(null)} shortUrl={qrLink.shortUrl} label={label(qrLink)} /></Suspense>}
      <LinkForm open={creating} onOpenChange={setCreating} onSaved={(l) => navigate(linkPath(l))} />
    </>
  );
}
