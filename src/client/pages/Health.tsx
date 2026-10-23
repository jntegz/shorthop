import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellOff, CornerDownRight, ExternalLink, Globe2, Power, RefreshCw, Search, Settings2, Wrench, X } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { toast } from "sonner";
import {
  CHECK_EVERY_PRESETS,
  DEFAULT_EVERY_HOURS,
  DOWN_AFTER_FAILS,
  everyText,
  MAX_EVERY_HOURS,
  MIN_EVERY_HOURS,
  okIntervalFor,
  problemText,
  STATE_LABEL,
  type CheckState,
} from "../../shared/link-check";
import type { CheckSettings, TargetCheckDTO } from "../../shared/types";
import { api, call, keys } from "../api";
import { useCan } from "../lib/me";
import { CHECK_STYLE, CheckBadge, STATE_ORDER } from "../components/CheckBadge";
import { HealthTabs } from "../components/HealthTabs";
import { StatsFreshness } from "../components/StatsFreshness";
import { useSystemHealth } from "../components/SystemStatus";
import { Button, buttonClass, Card, CardHeader, Dialog, Empty, Field, InfoTip, Input, Notice, PageHeader, Pagination, Segmented, Select, SortHeader, Spinner, Switch } from "../components/ui";
import { ago, hostOf, num } from "../lib/format";
import { CHECKS_HELP } from "../lib/help";
import { linkKey, linkPath, useLinkLabel } from "../lib/links";
import { pageOf, savedPageSize, savePageSize, sortRows, type PageSize, type SortDir } from "../lib/table";
import { cn } from "../lib/utils";

type Sort = "status" | "target" | "checked";
const SEVERITY = (s: CheckState) => STATE_ORDER.indexOf(s);
const SORT_VALUE: Record<Sort, (i: TargetCheckDTO) => string | number> = {
  // Worst first, and within a state the longest-standing first.
  status: (i) => SEVERITY(i.state) * 1e10 + (i.since ?? 0),
  target: (i) => hostOf(i.target) + i.target,
  checked: (i) => i.checkedAt ?? 0,
};

const TILE_NOTE: Record<CheckState, string> = {
  down: `Failed ${DOWN_AFTER_FAILS}+ checks in a row`,
  warning: "Failed recently, rechecking soon",
  unchecked: "Waiting for the first check",
  blocked: "The site refuses automated checks",
  ok: "Loaded on the last check",
};

/** "example.com" in the foreground, the rest of the URL muted. */
function UrlText({ url, className }: { url: string; className?: string }) {
  const host = hostOf(url);
  const rest = url.slice(url.indexOf(host) + host.length);
  return (
    <span className={cn("block truncate", className)} title={url}>
      <span className="font-medium text-fg">{host}</span>
      <span className="text-muted">{rest === "/" ? "" : rest}</span>
    </span>
  );
}

/** What the last check found, in one or two short lines. */
function Finding({ item, automatic }: { item: TargetCheckDTO; automatic: boolean }) {
  if (item.state === "unchecked") return <span className="text-xs text-muted">{automatic ? "Checked within 30 minutes" : "Not checked yet"}</span>;
  const detail = item.state === "ok" ? (item.httpStatus ? `HTTP ${item.httpStatus}` : "") : problemText(item.problem, item.httpStatus);
  return (
    <span className="block text-xs leading-relaxed text-muted">
      {detail}
      {item.state === "warning" ? ` · ${item.fails} of ${DOWN_AFTER_FAILS} failed checks` : null}
      {(item.state === "down" || item.state === "warning") && item.since ? <> · since {ago(item.since)}</> : null}
    </span>
  );
}

function LinkChips({ links }: { links: TargetCheckDTO["links"] }) {
  const label = useLinkLabel();
  const shown = links.slice(0, 3);
  return (
    <div className="flex min-w-0 flex-wrap gap-1">
      {shown.map((l) => (
        <Link
          key={linkKey(l.domain, l.slug)}
          to={linkPath(l)}
          title={l.title ?? undefined}
          className="max-w-full truncate rounded-md bg-accent-soft px-1.5 py-0.5 text-xs font-medium text-accent hover:underline"
        >
          {label(l)}
        </Link>
      ))}
      {links.length > shown.length ? <span className="px-1 py-0.5 text-xs text-muted">+{links.length - shown.length} more</span> : null}
    </div>
  );
}

type EveryMode = "24" | "72" | "168" | "custom";
const EVERY_OPTIONS: { value: EveryMode; label: string }[] = [...CHECK_EVERY_PRESETS.map((p) => ({ value: String(p.hours) as EveryMode, label: p.label })), { value: "custom", label: "Custom" }];

/** The starting choice for a saved frequency: a preset, or a custom number (in days when it's whole days). */
function everyChoice(hours: number): { mode: EveryMode; amount: string; unit: "hours" | "days" } {
  const preset = CHECK_EVERY_PRESETS.find((p) => p.hours === hours);
  if (preset) return { mode: String(preset.hours) as EveryMode, amount: "2", unit: "days" };
  return hours % 24 === 0 ? { mode: "custom", amount: String(hours / 24), unit: "days" } : { mode: "custom", amount: String(hours), unit: "hours" };
}

function SettingsDialog({
  open,
  onOpenChange,
  settings,
  activate,
  destinations,
  capacityPerDay,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  settings: CheckSettings;
  /** Opened from "Activate automatic checking": starts switched on. */
  activate: boolean;
  destinations: number;
  capacityPerDay: number;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<CheckSettings>(() => (activate ? { ...settings, enabled: true } : settings));
  const initial = everyChoice(settings.everyHours);
  const [mode, setMode] = useState<EveryMode>(initial.mode);
  const [amount, setAmount] = useState(initial.amount);
  const [unit, setUnit] = useState<"hours" | "days">(initial.unit);
  const health = useSystemHealth();
  const alertsTo = health.data?.alertsTo ?? null;

  const customHours = Number(amount) * (unit === "days" ? 24 : 1);
  const everyHours = mode === "custom" ? customHours : Number(mode);
  const everyError =
    mode !== "custom" || !draft.enabled
      ? null
      : !Number.isInteger(customHours) || customHours < MIN_EVERY_HOURS || customHours > MAX_EVERY_HOURS
        ? "Choose between 1 hour and 30 days."
        : null;
  const effective = Math.round(okIntervalFor(destinations, capacityPerDay, (everyHours || DEFAULT_EVERY_HOURS) * 3600) / 3600);

  const save = useMutation({
    mutationFn: () => call(api.checks.settings.$put({ json: { ...draft, everyHours: draft.enabled ? everyHours : settings.everyHours } })),
    onSuccess: () => {
      toast.success(draft.enabled && !settings.enabled ? "Automatic checking is on" : "Check settings saved", {
        description: draft.enabled ? `Each destination is checked ${everyText(effective)}. The first checks start within 30 minutes.` : undefined,
      });
      onOpenChange(false);
      void qc.invalidateQueries({ queryKey: keys.checks });
      void qc.invalidateQueries({ queryKey: keys.health });
    },
    onError: (e) => toast.error(e.message),
  });
  const changed = draft.enabled !== settings.enabled || draft.notify !== settings.notify || (draft.enabled && everyHours !== settings.everyHours);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Destination checks" description="Choose whether destinations are checked on a schedule, how often, and whether you hear about problems.">
      <div className="space-y-5">
        <div className="space-y-4 rounded-xl border border-line p-4">
          <Switch
            id="checks-enabled"
            label="Check destinations automatically"
            description="Every 30 minutes, Shorthop checks whatever is due. Off: destinations are only checked when someone presses Check now."
            checked={draft.enabled}
            onCheckedChange={(v) => setDraft((d) => ({ ...d, enabled: v }))}
            info={CHECKS_HELP.overview}
          />
          {draft.enabled ? (
            <div className="space-y-2 border-t border-line pt-4">
              <p className="text-sm font-medium text-fg">How often</p>
              <Segmented label="How often" value={mode} onChange={setMode} options={EVERY_OPTIONS} />
              {mode === "custom" ? (
                <Field label="Every" htmlFor="checks-every" error={everyError}>
                  <div className="flex gap-2">
                    <Input id="checks-every" type="number" inputMode="numeric" min={1} step={1} className="w-28" value={amount} onChange={(e) => setAmount(e.target.value)} />
                    <Select aria-label="Unit" className="w-32" value={unit} onChange={(e) => setUnit(e.target.value as "hours" | "days")}>
                      <option value="hours">Hours</option>
                      <option value="days">Days</option>
                    </Select>
                  </div>
                </Field>
              ) : null}
              {!everyError && destinations ? (
                <p className="text-xs text-muted">
                  With {num(destinations)} {destinations === 1 ? "destination" : "destinations"}, each is checked {everyText(effective)}.
                  {effective > everyHours ? " That's less often than chosen: the schedule can't check them all more often." : ""} A failed check is repeated after 1 and 4 hours either way.
                </p>
              ) : null}
            </div>
          ) : null}
          <Switch
            id="checks-notify"
            label="Email me when a destination stops working"
            description={alertsTo ? `Sent to ${alertsTo}, once when it fails and once when it works again.` : "Email isn't working yet, so problems only show here."}
            checked={draft.notify}
            onCheckedChange={(v) => setDraft((d) => ({ ...d, notify: v }))}
            info={CHECKS_HELP.email}
          />
          {draft.notify && health.data && !alertsTo ? (
            <Notice>
              Set up email under{" "}
              <Link to="/settings#digest" className="font-medium underline" onClick={() => onOpenChange(false)}>
                Settings → Weekly digest
              </Link>{" "}
              to get these alerts.
            </Notice>
          ) : null}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!changed || Boolean(everyError)}>
            {activate && draft.enabled && !settings.enabled ? "Activate" : "Save"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Ways out for a failing destination: fix the link, mark it, or stop checking. */
function FixDialog({ item, onClose }: { item: TargetCheckDTO; onClose: () => void }) {
  const qc = useQueryClient();
  const label = useLinkLabel();
  const many = item.links.length > 1;
  const patchAll = useMutation({
    mutationFn: async (json: { broken: true } | { monitor: false }) => {
      for (const l of item.links) await call(api.links[":domain"][":slug"].$patch({ param: { domain: l.domain, slug: l.slug }, json }));
      return json;
    },
    onSuccess: (json) => {
      void qc.invalidateQueries({ queryKey: keys.checks });
      void qc.invalidateQueries({ queryKey: keys.allLinks });
      for (const l of item.links) void qc.invalidateQueries({ queryKey: keys.link(l.domain, l.slug) });
      const who = many ? `${item.links.length} links` : label(item.links[0]!);
      if ("broken" in json) {
        toast.success(`${who} marked as no longer working`, {
          description: "Visitors now see the notice page. Choose a replacement link on the link's page to point them somewhere useful.",
        });
      } else {
        toast.success(`Stopped checking ${who}`, { description: "Turn checks back on from the link's settings." });
      }
      onClose();
    },
    onError: (e) => {
      void qc.invalidateQueries({ queryKey: keys.checks });
      toast.error(e.message);
    },
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Fix ${hostOf(item.target)}`} description={problemText(item.problem, item.httpStatus) || STATE_LABEL[item.state]} wide>
      <div className="space-y-5">
        <div className="rounded-xl border border-line bg-bg px-4 py-3">
          <p className="text-xs font-medium text-muted">Destination</p>
          <a href={item.target} target="_blank" rel="noreferrer noopener" className="mt-1 inline-flex max-w-full items-center gap-1 text-sm break-all hover:underline">
            {item.target} <ExternalLink className="size-3 shrink-0" />
          </a>
          {item.finalUrl ? (
            <p className="mt-1 flex items-start gap-1 text-xs break-all text-muted">
              <CornerDownRight className="mt-0.5 size-3 shrink-0" /> Redirects to {item.finalUrl}
            </p>
          ) : null}
          <p className="mt-2 text-xs text-muted">
            Used by {item.links.map((l, i) => <span key={linkKey(l.domain, l.slug)}>{i ? ", " : ""}<span className="font-medium text-fg">{label(l)}</span></span>)}
          </p>
        </div>

        <ol className="space-y-3">
          <li className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line p-4">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-fg">The page moved</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted">Open the link and change its destination. The short link and its stats stay the same.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {item.links.slice(0, 3).map((l) => (
                <Link key={linkKey(l.domain, l.slug)} to={`${linkPath(l)}#edit`} className={buttonClass({ variant: "outline", size: "sm" })} onClick={onClose}>
                  Edit {label(l)}
                </Link>
              ))}
            </div>
          </li>
          <li className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line p-4">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-fg">The page is gone for good</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted">
                Mark {many ? "these links" : "the link"} as no longer working. Visitors see a short notice instead of an error, and you can point them to a replacement link.
              </p>
            </div>
            <Button size="sm" variant="danger" onClick={() => patchAll.mutate({ broken: true })} loading={patchAll.isPending && "broken" in (patchAll.variables ?? {})} disabled={patchAll.isPending}>
              Mark as no longer working
            </Button>
          </li>
          <li className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line p-4">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-fg">It works for people</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted">Some pages need a login or block automated visitors. Stop checking {many ? "these links" : "this link"} so they don't alert again.</p>
            </div>
            <Button size="sm" variant="outline" onClick={() => patchAll.mutate({ monitor: false })} loading={patchAll.isPending && "monitor" in (patchAll.variables ?? {})} disabled={patchAll.isPending}>
              <BellOff /> Stop checking
            </Button>
          </li>
        </ol>
      </div>
    </Dialog>
  );
}

export function Health() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const filter = STATE_ORDER.find((s) => s === params.get("state")) ?? null;
  const [search, setSearch] = useState("");
  const q = useDeferredValue(search.trim().toLowerCase());
  const [sort, setSort] = useState<Sort>("status");
  const [dir, setDir] = useState<SortDir>("asc");
  const [page, setPage] = useState(1);
  const [size, setSizeState] = useState<PageSize>(() => savedPageSize("health"));
  const [settingsOpen, setSettingsOpen] = useState<"settings" | "activate" | null>(null);
  const [fixing, setFixing] = useState<TargetCheckDTO | null>(null);
  const label = useLinkLabel();
  const can = useCan();
  const manage = can("settings.manage");

  const checks = useQuery({ queryKey: keys.checks, queryFn: () => call(api.checks.$get()), refetchInterval: 60_000 });
  const data = checks.data;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.checks });
    void qc.invalidateQueries({ queryKey: keys.allLinks });
  };
  const recheck = useMutation({
    mutationFn: () => call(api.checks.recheck.$post()),
    onSuccess: (r) => {
      refresh();
      if (!r.checked) toast.success("Nothing to recheck", { description: "Every destination with a problem was checked moments ago, or there are none." });
      else toast.success(`Checked ${num(r.checked)} ${r.checked === 1 ? "destination" : "destinations"}`, r.remaining ? { description: `${num(r.remaining)} more will be checked in the next scheduled runs.` } : undefined);
    },
    onError: (e) => toast.error(e.message),
  });
  const checkOne = useMutation({
    mutationFn: (item: TargetCheckDTO) => {
      const l = item.links[0]!;
      return call(api.checks.links[":domain"][":slug"].$post({ param: { domain: l.domain, slug: l.slug } }));
    },
    onSuccess: (r, item) => {
      refresh();
      const state = r.check?.state ?? "unchecked";
      const host = hostOf(item.target);
      if (state === "ok") toast.success(`${host} is working`, { description: r.check?.ms ? `Loaded in ${num(r.check.ms)} ms.` : undefined });
      else if (state === "blocked") toast.info(`${host} refuses automated checks`, { description: "People can usually still open it." });
      else toast.error(`${host}: ${problemText(r.check?.problem ?? null, r.check?.httpStatus ?? null) || STATE_LABEL[state]}`);
    },
    onError: (e) => toast.error(e.message),
  });

  const counts = useMemo(() => {
    const c: Record<CheckState, number> = { down: 0, warning: 0, unchecked: 0, blocked: 0, ok: 0 };
    for (const i of data?.items ?? []) c[i.state]++;
    return c;
  }, [data]);

  const rows = useMemo(() => {
    const items = (data?.items ?? []).filter(
      (i) => (!filter || i.state === filter) && (!q || i.target.toLowerCase().includes(q) || i.links.some((l) => label(l).toLowerCase().includes(q) || l.title?.toLowerCase().includes(q))),
    );
    return sortRows(items, SORT_VALUE[sort], dir);
  }, [data, filter, q, sort, dir, label]);
  const paged = pageOf(rows, page, size);

  const setFilter = (s: CheckState | null) => {
    setPage(1);
    setParams(s && s !== filter ? { state: s } : {}, { replace: true });
  };
  const sortBy = (key: Sort) => {
    setPage(1);
    if (key === sort) setDir(dir === "asc" ? "desc" : "asc");
    else {
      setSort(key);
      setDir(key === "checked" ? "desc" : "asc");
    }
  };
  const problems = counts.down + counts.warning;
  const off = data ? !data.settings.enabled : false;

  return (
    <>
      <PageHeader
        title="Make sure every link still lands"
        description={
          data?.settings.enabled
            ? `Shorthop visits every destination ${everyText(data.settings.everyHours)}, confirms a problem before calling it, and tells you before your audience hits a dead end.`
            : "Turn on automatic checking and Shorthop visits every destination as often as you choose, confirms a problem before calling it, and tells you before your audience hits a dead end."
        }
        actions={
          <>
            {manage ? (
              <Button variant="outline" onClick={() => setSettingsOpen("settings")} disabled={!data}>
                <Settings2 /> Check settings
              </Button>
            ) : null}
            <Button variant={off && manage ? "outline" : "primary"} onClick={() => recheck.mutate()} loading={recheck.isPending} disabled={!data}>
              <RefreshCw /> Check problems now
            </Button>
            {off && manage ? (
              <Button onClick={() => setSettingsOpen("activate")}>
                <Power /> Activate automatic checking
              </Button>
            ) : null}
          </>
        }
      />
      <HealthTabs badge={{ to: "/health", count: counts.down }} />

      {checks.isError ? (
        <Notice tone="danger">{checks.error.message}</Notice>
      ) : !data ? (
        <div className="flex justify-center py-24">
          <Spinner />
        </div>
      ) : (
        <>
          {!data.settings.enabled ? (
            <div className="mb-5">
              <Notice>
                {manage ? (
                  <>
                    Automatic checking is off. Destinations are only checked when you press Check now.{" "}
                    <button type="button" className="font-medium underline underline-offset-2" onClick={() => setSettingsOpen("activate")}>
                      Activate automatic checking
                    </button>
                  </>
                ) : (
                  "Automatic checking is off. Destinations are only checked when someone presses Check now. An admin can turn it on."
                )}
              </Notice>
            </div>
          ) : data.overdue > 25 ? (
            <div className="mb-5">
              <Notice tone="accent">
                {num(data.overdue)} destinations are waiting for a check. The schedule checks up to {num(data.capacityPerDay)} a day, so they catch up over the next{" "}
                {Math.max(1, Math.ceil((data.overdue / data.capacityPerDay) * 24))} hours.
              </Notice>
            </div>
          ) : null}

          <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5" role="group" aria-label="Filter by state">
            {STATE_ORDER.map((s) => {
              const { icon: Icon, text, soft } = CHECK_STYLE[s];
              const active = filter === s;
              return (
                <button
                  key={s}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setFilter(s)}
                  className={cn(
                    "card group flex flex-col items-start gap-3 rounded-2xl border bg-surface p-4 text-left transition-colors hover:border-accent/40",
                    active ? "border-accent ring-2 ring-accent/20" : "border-line",
                    counts[s] === 0 && !active && "opacity-70",
                  )}
                >
                  <span className={cn("flex size-8 items-center justify-center rounded-lg", soft, text)}>
                    <Icon className="size-4" aria-hidden />
                  </span>
                  <span>
                    <span className="block text-2xl font-semibold tracking-tight text-fg tabular">{num(counts[s])}</span>
                    <span className="mt-0.5 block text-sm font-medium text-fg">{STATE_LABEL[s]}</span>
                    <span className="mt-0.5 block text-xs leading-snug text-muted">{TILE_NOTE[s]}</span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="mb-6 space-y-1">
            <StatsFreshness
              updatedAt={checks.dataUpdatedAt}
              fetching={checks.isFetching}
              onRefresh={() => void checks.refetch()}
              note={
                <span>
                  {data.lastRun
                    ? data.lastRun.ok
                      ? `Last scheduled run ${ago(data.lastRun.at)}`
                      : `The last scheduled run failed ${ago(data.lastRun.at)}`
                    : data.settings.enabled
                      ? "The first scheduled run starts within 30 minutes"
                      : "No scheduled runs yet"}
                  {data.settings.enabled ? " · runs every 30 minutes" : " · scheduled checks are off"}
                </span>
              }
            />
            <p className="flex flex-wrap items-center gap-1 text-xs text-muted">
              {data.settings.enabled
                ? `Each working destination is checked ${everyText(data.intervalHours)}, at most ${data.perHostPerRun} pages of one site per run.`
                : "Scheduled checks are off."}
              {data.settings.enabled && data.intervalHours > data.settings.everyHours
                ? ` Spaced out because you have more destinations than the schedule could check ${everyText(data.settings.everyHours)}.`
                : ""}
              {data.excluded ? ` ${num(data.excluded)} ${data.excluded === 1 ? "link has" : "links have"} checks turned off.` : ""}
              <InfoTip help={CHECKS_HELP.limits} />
            </p>
          </div>

          <Card className="overflow-hidden">
            <CardHeader
              title={filter ? STATE_LABEL[filter] : "All destinations"}
              description={
                data.items.length
                  ? `${num(rows.length)} of ${num(data.items.length)} ${data.items.length === 1 ? "destination" : "destinations"}${problems ? `, ${num(problems)} with problems` : ""}`
                  : undefined
              }
              info={CHECKS_HELP.states}
              action={
                data.items.length ? (
                  <div className="flex flex-wrap items-center gap-2">
                    {filter ? (
                      <button type="button" className="inline-flex items-center gap-1 text-xs text-accent" onClick={() => setFilter(null)}>
                        <X className="size-3" /> Show all
                      </button>
                    ) : null}
                    <div className="relative w-56">
                      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" />
                      <Input
                        type="search"
                        className="h-9 pl-9 text-xs"
                        placeholder="Search destinations or links…"
                        aria-label="Search destinations"
                        value={search}
                        onChange={(e) => {
                          setSearch(e.target.value);
                          setPage(1);
                        }}
                      />
                    </div>
                  </div>
                ) : null
              }
            />
            {data.items.length === 0 ? (
              <Empty icon={<Globe2 />} title="No destinations to check">
                <p>
                  Links show up here once “Check that the destination works” is switched on in their settings (it's off for new links). Disabled, expired and “no longer
                  working” links aren't checked.
                </p>
              </Empty>
            ) : rows.length === 0 ? (
              <Empty title={filter ? `No destinations are “${STATE_LABEL[filter].toLowerCase()}”` : "No destinations match"}>
                <p>{filter === "down" || filter === "warning" ? "Every link lands where it should." : "Try another search or state."}</p>
              </Empty>
            ) : (
              <table className="w-full table-fixed border-t border-line text-sm">
                <thead className="hidden bg-bg text-left text-[11px] text-muted md:table-header-group">
                  <tr>
                    <SortHeader label="Destination" active={sort === "target"} dir={dir} onSort={() => sortBy("target")} />
                    <SortHeader label="State" className="w-52" active={sort === "status"} dir={dir} onSort={() => sortBy("status")} />
                    <SortHeader label="Last check" className="hidden w-36 lg:table-cell" active={sort === "checked"} dir={dir} onSort={() => sortBy("checked")} />
                    <th className="w-[17rem] px-4 py-2.5 font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {paged.rows.map((item) => {
                    const busy = checkOne.isPending && checkOne.variables?.target === item.target;
                    const failing = item.state === "down" || item.state === "warning";
                    return (
                      <tr key={item.target} className={cn("flex flex-wrap items-start gap-x-3 gap-y-2 border-b border-line px-4 py-4 last:border-0 md:table-row md:p-0", item.state === "down" && "bg-danger-soft/40")}>
                        <td className="min-w-0 basis-full md:basis-auto md:px-4 md:py-4">
                          <UrlText url={item.target} className="text-sm" />
                          {item.finalUrl ? (
                            <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-muted" title={item.finalUrl}>
                              <CornerDownRight className="size-3 shrink-0" aria-hidden />
                              <span className="truncate">ends at {item.finalUrl}</span>
                            </span>
                          ) : null}
                          <div className="mt-2">
                            <LinkChips links={item.links} />
                          </div>
                        </td>
                        <td className="min-w-0 md:px-4 md:py-4">
                          <CheckBadge state={item.state} />
                          <div className="mt-1">
                            <Finding item={item} automatic={data.settings.enabled} />
                          </div>
                        </td>
                        <td className="hidden text-xs text-muted md:px-4 md:py-4 lg:table-cell">
                          {item.checkedAt ? (
                            <>
                              <span className="block text-fg">{ago(item.checkedAt)}</span>
                              {item.ms !== null ? <span className="block">{num(item.ms)} ms{item.hops ? ` · ${item.hops} ${item.hops === 1 ? "redirect" : "redirects"}` : ""}</span> : null}
                            </>
                          ) : (
                            "Not yet"
                          )}
                        </td>
                        <td className="ml-auto md:px-4 md:py-4">
                          <div className="flex items-center justify-end gap-1">
                            {failing && can("links.edit") ? (
                              <Button size="sm" variant="outline" onClick={() => setFixing(item)}>
                                <Wrench /> Fix
                              </Button>
                            ) : null}
                            <Button size="sm" variant="ghost" onClick={() => checkOne.mutate(item)} loading={busy} disabled={checkOne.isPending && !busy}>
                              {busy ? null : <RefreshCw />} Check now
                            </Button>
                            <a href={item.target} target="_blank" rel="noreferrer noopener" className={buttonClass({ variant: "ghost", size: "icon-sm" })} aria-label={`Open ${item.target}`} title="Open the destination">
                              <ExternalLink />
                            </a>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Card>
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
              onSize={(n) => {
                savePageSize("health", n);
                setSizeState(n);
                setPage(1);
              }}
            />
          ) : null}

          {settingsOpen ? (
            <SettingsDialog
              open
              onOpenChange={(o) => !o && setSettingsOpen(null)}
              settings={data.settings}
              activate={settingsOpen === "activate"}
              destinations={data.items.length}
              capacityPerDay={data.capacityPerDay}
            />
          ) : null}
          {fixing ? <FixDialog item={fixing} onClose={() => setFixing(null)} /> : null}
        </>
      )}
    </>
  );
}
