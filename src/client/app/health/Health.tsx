// Link health → Destinations (/health): the checks query (keys.checks, polled
// every minute), Check problems now, Check now per destination, the state
// filter in the URL (?state=down, linked from the links list), search, sort
// and paging, Check settings (automatic checks, which links, how often, email
// alerts) and the Fix dialog (edit, redirect to another link, mark as no
// longer working, stop checking: applied to every link that uses the
// destination).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellOff, CornerDownRight, ExternalLink, Pencil, Power, RefreshCw, Settings2, Wrench, X } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
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
  type CheckScope,
  type CheckState,
} from "../../../shared/link-check";
import type { CheckSettings, TargetCheckDTO } from "../../../shared/types";
import { api, call, keys } from "../../api";
import { ago, fullNum, hostOf, num } from "../../lib/format";
import { CHECKS_HELP } from "../../lib/help";
import { linkKey, linkPath, useLinkLabel } from "../../lib/links";
import { useCan } from "../../lib/me";
import { PAGE_SIZES, pageOf, savedPageSize, savePageSize, sortRows, type PageSize, type SortDir } from "../../lib/table";
import { cn } from "../../lib/utils";
import { Button, Dialog, Empty, ErrorState, errorText, Input, Menu, Notice, Pager, Section, Segmented, Select, Skeleton, SortTH, Switch, Table, TD, TextButton, TH, TR } from "../ui";
import { CHECK_STYLE, CheckBadge, Freshness, HealthTabs, HelpTip, LinkPicker, STATE_ORDER, useSystemHealth } from "./parts";

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

const errorOf = (e: unknown) => errorText(e) ?? (e instanceof Error ? e.message : "That didn’t work. Try again.");

/** "example.com" in ink, the rest of the URL quieter. */
function UrlText({ url }: { url: string }) {
  const host = hostOf(url);
  const rest = url.slice(url.indexOf(host) + host.length);
  return (
    <span className="health-url" title={url}>
      <span className="health-url-host">{host}</span>
      <span className="health-url-rest">{rest === "/" ? "" : rest}</span>
    </span>
  );
}

/** What the last check found, in one short line. */
function Finding({ item, automatic }: { item: TargetCheckDTO; automatic: boolean }) {
  if (item.state === "unchecked") return <span className="health-finding">{automatic ? "Checked within 30 minutes" : "Not checked yet"}</span>;
  const detail = item.state === "ok" ? (item.httpStatus ? `HTTP ${item.httpStatus}` : "") : problemText(item.problem, item.httpStatus);
  const parts = [
    detail,
    item.state === "warning" ? `${item.fails} of ${DOWN_AFTER_FAILS} failed checks` : "",
    (item.state === "down" || item.state === "warning") && item.since ? `since ${ago(item.since)}` : "",
  ].filter(Boolean);
  if (!parts.length) return null;
  return <span className="health-finding">{parts.join(" · ")}</span>;
}

/** The links that use a destination: the first three, then "+N more". */
function UsedBy({ links }: { links: TargetCheckDTO["links"] }) {
  const label = useLinkLabel();
  const [all, setAll] = useState(false);
  const shown = all ? links : links.slice(0, 3);
  return (
    <span className="health-used">
      <span className="health-used-label">Used by</span>{" "}
      {shown.map((l, i) => (
        <span key={linkKey(l.domain, l.slug)}>
          {i ? ", " : ""}
          <Link to={linkPath(l)} title={l.title ?? undefined} className="health-used-link">
            {label(l)}
          </Link>
        </span>
      ))}
      {links.length > shown.length ? (
        <>
          {" "}
          <TextButton className="health-used-more" onClick={() => setAll(true)}>
            +{links.length - shown.length} more
          </TextButton>
        </>
      ) : null}
    </span>
  );
}

const SCOPE_OPTIONS: { value: CheckScope; label: string }[] = [
  { value: "selected", label: "Only links switched on" },
  { value: "all", label: "All links" },
];

type EveryMode = "24" | "72" | "168" | "custom";
const EVERY_OPTIONS: { value: EveryMode; label: string }[] = [...CHECK_EVERY_PRESETS.map((p) => ({ value: String(p.hours) as EveryMode, label: p.label })), { value: "custom", label: "Custom" }];

/** The starting choice for a saved frequency: a preset, or a custom number (in days when it's whole days). */
function everyChoice(hours: number): { mode: EveryMode; amount: string; unit: "hours" | "days" } {
  const preset = CHECK_EVERY_PRESETS.find((p) => p.hours === hours);
  if (preset) return { mode: String(preset.hours) as EveryMode, amount: "2", unit: "days" };
  return hours % 24 === 0 ? { mode: "custom", amount: String(hours / 24), unit: "days" } : { mode: "custom", amount: String(hours), unit: "hours" };
}

function SettingsDialog({
  onClose,
  settings,
  activate,
  destinations,
  capacityPerDay,
}: {
  onClose: () => void;
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
      onClose();
      void qc.invalidateQueries({ queryKey: keys.checks });
      void qc.invalidateQueries({ queryKey: keys.health });
      // The links list badges and the link form follow the scope.
      void qc.invalidateQueries({ queryKey: keys.allLinks });
      void qc.invalidateQueries({ queryKey: keys.me });
    },
    onError: (e) => toast.error(errorOf(e)),
  });
  const changed =
    draft.enabled !== settings.enabled || draft.notify !== settings.notify || draft.scope !== settings.scope || (draft.enabled && everyHours !== settings.everyHours);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Destination checks"
      description="Choose which links are checked, whether on a schedule and how often, and whether you hear about problems."
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending} disabled={!changed || Boolean(everyError)}>
            {activate && draft.enabled && !settings.enabled ? "Activate" : "Save"}
          </Button>
        </>
      }
    >
      <div className="health-form">
        <div className="health-group">
          <Switch
            id="checks-enabled"
            label="Check destinations automatically"
            description={
              <>
                Every 30 minutes, Shorthop checks whatever is due. Off: destinations are only checked when someone presses Check now. <HelpTip help={CHECKS_HELP.overview} />
              </>
            }
            checked={draft.enabled}
            onCheckedChange={(v) => setDraft((d) => ({ ...d, enabled: v }))}
          />
        </div>
        <div className="health-group">
          <p className="health-group-title" id="checks-scope-t">
            Which links <HelpTip help={CHECKS_HELP.scope} />
          </p>
          <Segmented label="Which links" value={draft.scope} onChange={(v) => setDraft((d) => ({ ...d, scope: v }))} options={SCOPE_OPTIONS} className="health-seg" />
          <p className="health-group-note">
            {draft.scope === "all"
              ? "Every link is checked, whether its “Check that the destination works” switch is on or not. Links set to “Never check this link” are skipped."
              : "Only links whose “Check that the destination works” switch is on are checked. It's off for new links."}
          </p>
        </div>
        {draft.enabled ? (
          <div className="health-group">
            <p className="health-group-title">How often</p>
            <Segmented label="How often" value={mode} onChange={setMode} options={EVERY_OPTIONS} className="health-seg" />
            {mode === "custom" ? (
              <div className="health-every">
                <Input id="checks-every" label="Every" type="number" inputMode="numeric" min={1} step={1} className="health-every-n" value={amount} onChange={(e) => setAmount(e.target.value)} error={everyError ?? undefined} />
                <Select
                  label="Unit"
                  className="health-every-unit"
                  value={unit}
                  onChange={(e) => setUnit(e.target.value as "hours" | "days")}
                  options={[
                    { value: "hours", label: "Hours" },
                    { value: "days", label: "Days" },
                  ]}
                />
              </div>
            ) : null}
            {!everyError && destinations && draft.scope === settings.scope ? (
              <p className="health-group-note">
                With {num(destinations)} {destinations === 1 ? "destination" : "destinations"}, each is checked {everyText(effective)}.
                {effective > everyHours ? " That's less often than chosen: the schedule can't check them all more often." : ""} A failed check is repeated after 1 and 4 hours either way.
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="health-group">
          <Switch
            id="checks-notify"
            label="Email me when a destination stops working"
            description={
              <>
                {alertsTo ? `Sent to ${alertsTo}, once when it fails and once when it works again.` : "Email isn't working yet, so problems only show here."} <HelpTip help={CHECKS_HELP.email} />
              </>
            }
            checked={draft.notify}
            onCheckedChange={(v) => setDraft((d) => ({ ...d, notify: v }))}
          />
          {draft.notify && health.data && !alertsTo ? (
            <Notice tone="warn">
              Set up email under{" "}
              <Link to="/settings#digest" className="health-inline-link" onClick={onClose}>
                Settings → Weekly digest
              </Link>{" "}
              to get these alerts.
            </Notice>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}

type FixPatch = { broken: true } | { neverCheck: true } | { target: string };

/** Ways out for a failing destination: fix the link, mark it, or stop checking. Applied to every link that uses it. */
function FixDialog({ item, onClose }: { item: TargetCheckDTO; onClose: () => void }) {
  const [redirectTo, setRedirectTo] = useState<{ key: string; target: string } | null>(null);
  const qc = useQueryClient();
  const label = useLinkLabel();
  const many = item.links.length > 1;
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: keys.checks });
    void qc.invalidateQueries({ queryKey: keys.allLinks });
    for (const l of item.links) void qc.invalidateQueries({ queryKey: keys.link(l.domain, l.slug) });
  };
  const patchAll = useMutation({
    mutationFn: async (json: FixPatch) => {
      // One link at a time; a failure partway says how far it got.
      let done = 0;
      try {
        for (const l of item.links) {
          await call(api.links[":domain"][":slug"].$patch({ param: { domain: l.domain, slug: l.slug }, json }));
          done++;
        }
      } catch (err) {
        if (done === 0) throw err;
        throw new Error(`Changed ${done} of ${item.links.length} links; the rest failed: ${errorOf(err)}`);
      }
      return json;
    },
    onSuccess: (json) => {
      invalidate();
      const who = many ? `${item.links.length} links` : label(item.links[0]!);
      if ("target" in json) {
        toast.success(`${who} now ${many ? "go" : "goes"} to ${json.target}`, { description: "Live worldwide within about a minute." });
      } else if ("broken" in json) {
        toast.success(`${who} marked as no longer working`, {
          description: "Visitors now see the notice page. Choose a replacement link on the link's page to point them somewhere useful.",
        });
      } else {
        toast.success(`Stopped checking ${who}`, { description: "Set to never be checked, even when all links are. Turn checks back on from the link's settings." });
      }
      onClose();
    },
    onError: (e) => {
      invalidate();
      toast.error(errorOf(e));
    },
  });
  const busy = (k: "target" | "broken" | "neverCheck") => patchAll.isPending && k in (patchAll.variables ?? {});

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Fix ${hostOf(item.target)}`} description={problemText(item.problem, item.httpStatus) || STATE_LABEL[item.state]} size="lg" footer={<Button onClick={onClose}>Close</Button>}>
      <dl className="health-facts">
        <div>
          <dt>Destination</dt>
          <dd>
            <a href={item.target} target="_blank" rel="noreferrer noopener" className="health-inline-link health-break">
              {item.target}
              <ExternalLink aria-hidden className="health-inline-icon" />
              <span className="ui-sr"> (opens in a new tab)</span>
            </a>
            {item.finalUrl ? (
              <span className="health-ends health-break">
                <CornerDownRight aria-hidden className="health-inline-icon" /> Redirects to {item.finalUrl}
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Used by</dt>
          <dd>{item.links.map((l) => label(l)).join(", ")}</dd>
        </div>
      </dl>

      <ol className="health-fixes">
        <li>
          <div className="health-fix-text">
            <p className="health-fix-title">The page moved</p>
            <p className="health-fix-desc">Open the link and change its destination. The short link and its stats stay the same.</p>
          </div>
          <div className="health-fix-act">
            {item.links.slice(0, 3).map((l) => (
              <Button key={linkKey(l.domain, l.slug)} asChild size="sm">
                <Link to={`${linkPath(l)}#edit`} onClick={onClose}>
                  <Pencil aria-hidden />
                  Edit {label(l)}
                </Link>
              </Button>
            ))}
          </div>
        </li>
        <li>
          <div className="health-fix-text">
            <p className="health-fix-title">Redirect to another of my links</p>
            <p className="health-fix-desc">
              {many ? "These links take" : "The link takes"} the destination of the link you choose. The short {many ? "links" : "link"} and stats stay the same.
            </p>
          </div>
          <div className="health-fix-act health-fix-pick">
            <LinkPicker
              id="fix-redirect"
              label="Link to redirect to"
              hideLabel
              className="health-picker"
              value={redirectTo?.key ?? ""}
              onChange={(key, l) => setRedirectTo(l ? { key, target: l.target } : null)}
              exclude={item.links.map((l) => linkKey(l.domain, l.slug))}
            />
            <Button size="sm" onClick={() => redirectTo && patchAll.mutate({ target: redirectTo.target })} loading={busy("target")} disabled={!redirectTo || patchAll.isPending}>
              Redirect
            </Button>
          </div>
        </li>
        <li>
          <div className="health-fix-text">
            <p className="health-fix-title">The page is gone for good</p>
            <p className="health-fix-desc">
              Mark {many ? "these links" : "the link"} as no longer working. Visitors see a short notice instead of an error, and you can point them to a replacement link.
            </p>
          </div>
          <div className="health-fix-act">
            <Button size="sm" variant="danger" onClick={() => patchAll.mutate({ broken: true })} loading={busy("broken")} disabled={patchAll.isPending}>
              Mark as no longer working
            </Button>
          </div>
        </li>
        <li>
          <div className="health-fix-text">
            <p className="health-fix-title">It works for people</p>
            <p className="health-fix-desc">Some pages need a login or block automated visitors. Stop checking {many ? "these links" : "this link"} so they don't alert again.</p>
          </div>
          <div className="health-fix-act">
            <Button size="sm" icon={BellOff} onClick={() => patchAll.mutate({ neverCheck: true })} loading={busy("neverCheck")} disabled={patchAll.isPending}>
              Stop checking
            </Button>
          </div>
        </li>
      </ol>
    </Dialog>
  );
}

function SkeletonPage() {
  return (
    <div aria-busy="true" aria-label="Loading destinations">
      <div className="ui-kpis health-states" style={{ "--n": 5 } as React.CSSProperties}>
        {STATE_ORDER.map((s) => (
          <div key={s} className="ui-kpi health-state is-skel">
            <Skeleton className="ui-skel-text" style={{ width: 90 }} />
            <Skeleton className="ui-skel-num" />
            <Skeleton className="ui-skel-text" style={{ width: 130 }} />
          </div>
        ))}
      </div>
      <div className="health-rows-skel">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="health-row-skel">
            <Skeleton className="ui-skel-text" style={{ width: `${40 + ((i * 17) % 30)}%` }} />
            <Skeleton className="ui-skel-text" style={{ width: 110 }} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function HealthPage() {
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
  const navigate = useNavigate();
  const can = useCan();
  const manage = can("settings.manage");
  const edits = can("links.edit");

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
    onError: (e) => toast.error(errorOf(e)),
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
    onError: (e) => toast.error(errorOf(e)),
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
    <div className="ui-page health-page">
      <header className="ui-head">
        <div className="ui-head-main">
          <h1 className="ui-h1">Link health</h1>
          <p className="ui-head-sub">
            {data?.settings.enabled
              ? `Checked ${everyText(data.settings.everyHours)}. Problems are confirmed before you're alerted.`
              : data
                ? "Automatic checking is off. Problems are confirmed before you're alerted."
                : "Do your links still lead somewhere?"}
          </p>
        </div>
        <div className="ui-head-tools">
          {manage ? (
            <Button icon={Settings2} onClick={() => setSettingsOpen("settings")} disabled={!data}>
              Check settings
            </Button>
          ) : null}
          <Button variant={off && manage ? "secondary" : "primary"} icon={RefreshCw} onClick={() => recheck.mutate()} loading={recheck.isPending} disabled={!data}>
            Check problems now
          </Button>
        </div>
      </header>
      <HealthTabs badge={{ to: "/health", count: counts.down }} />

      {checks.isError && !data ? (
        <ErrorState what="Destination checks" error={checks.error} onRetry={() => void checks.refetch()} retrying={checks.isFetching} />
      ) : !data ? (
        <SkeletonPage />
      ) : (
        <>
          {!data.settings.enabled ? (
            <Notice
              className="health-notice"
              action={
                manage ? (
                  <Button size="sm" variant="primary" icon={Power} onClick={() => setSettingsOpen("activate")}>
                    Activate automatic checking
                  </Button>
                ) : undefined
              }
            >
              {manage
                ? "Automatic checking is off. Destinations are only checked when you press Check now."
                : "Automatic checking is off. Destinations are only checked when someone presses Check now. An admin can turn it on."}
            </Notice>
          ) : data.overdue > 25 ? (
            <Notice className="health-notice">
              {num(data.overdue)} destinations are waiting for a check. The schedule checks up to {num(data.capacityPerDay)} a day, so they catch up over the next{" "}
              {Math.max(1, Math.ceil((data.overdue / data.capacityPerDay) * 24))} hours.
            </Notice>
          ) : null}

          <div className="ui-kpis health-states" style={{ "--n": STATE_ORDER.length } as React.CSSProperties} role="group" aria-label="Filter by state">
            {STATE_ORDER.map((s) => {
              const Icon = CHECK_STYLE[s].icon;
              const active = filter === s;
              return (
                <button
                  key={s}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setFilter(s)}
                  className={cn("ui-kpi health-state", counts[s] === 0 && "is-zero")}
                  data-tone={CHECK_STYLE[s].tone}
                  title={active ? "Show every state" : `Show only “${STATE_LABEL[s].toLowerCase()}”`}
                >
                  <span className="ui-kpi-label health-state-label">
                    <Icon aria-hidden className="health-state-icon" />
                    {STATE_LABEL[s]}
                  </span>
                  <span className="ui-kpi-value">{fullNum(counts[s])}</span>
                  <span className="ui-kpi-note">{TILE_NOTE[s]}</span>
                </button>
              );
            })}
          </div>

          <div className="health-meta">
            <Freshness
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
            <p className="health-meta-line">
              {data.settings.enabled
                ? `Each working destination is checked ${everyText(data.intervalHours)}, at most ${data.perHostPerRun} pages of one site per run.`
                : "Scheduled checks are off."}
              {data.settings.enabled && data.intervalHours > data.settings.everyHours
                ? ` Spaced out because you have more destinations than the schedule could check ${everyText(data.settings.everyHours)}.`
                : ""}
              {data.settings.scope === "all" ? " All links are checked." : " Only links switched on are checked."}
              {data.excluded ? ` ${num(data.excluded)} ${data.excluded === 1 ? "link isn't" : "links aren't"} checked${data.settings.scope === "all" ? ": set to never be checked" : ""}.` : ""}{" "}
              <HelpTip help={CHECKS_HELP.limits} />
            </p>
          </div>

          <Section
            className="health-section"
            title={
              <span className="health-title">
                {filter ? STATE_LABEL[filter] : "All destinations"}
                <HelpTip help={CHECKS_HELP.states} />
              </span>
            }
            sub={
              data.items.length
                ? `${fullNum(rows.length)} of ${fullNum(data.items.length)} ${data.items.length === 1 ? "destination" : "destinations"}${problems ? `, ${fullNum(problems)} with problems` : ""}`
                : undefined
            }
            aside={
              data.items.length ? (
                <>
                  {filter ? (
                    <TextButton onClick={() => setFilter(null)}>
                      <X aria-hidden className="health-inline-icon" />
                      Show all
                    </TextButton>
                  ) : null}
                  <Input
                    type="search"
                    label="Search destinations"
                    hideLabel
                    className="health-search"
                    placeholder="Search destinations or links…"
                    autoComplete="off"
                    spellCheck={false}
                    enterKeyHint="search"
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setPage(1);
                    }}
                  />
                </>
              ) : undefined
            }
          >
            {data.items.length === 0 ? (
              <Empty title="No destinations to check">
                {data.settings.scope === "all"
                  ? "Every link shows up here unless it's set to “Never check this link”."
                  : "Links show up here once “Check that the destination works” is switched on in their settings (it's off for new links), or when Check settings is set to check all links."}{" "}
                Disabled, expired and “no longer working” links aren't checked.
              </Empty>
            ) : rows.length === 0 ? (
              <Empty
                title={filter ? `No destinations are “${STATE_LABEL[filter].toLowerCase()}”` : "No destinations match"}
                action={
                  filter ? (
                    <Button icon={X} onClick={() => setFilter(null)}>
                      Show all states
                    </Button>
                  ) : undefined
                }
              >
                {filter === "down" || filter === "warning" ? "Every link lands where it should." : "Try another search or state."}
              </Empty>
            ) : (
              <Table label="Destinations" rowNav className="health-table health-dest-table">
                <thead>
                  <tr>
                    <SortTH label="Destination" className="health-c-dest" active={sort === "target"} dir={dir} onSort={() => sortBy("target")} />
                    <SortTH label="State" className="health-c-state" active={sort === "status"} dir={dir} onSort={() => sortBy("status")} />
                    <SortTH label="Last check" className="health-c-checked" active={sort === "checked"} dir={dir} onSort={() => sortBy("checked")} />
                    <TH className="health-c-act">
                      <span className="ui-sr">Actions</span>
                    </TH>
                  </tr>
                </thead>
                <tbody>
                  {paged.rows.map((item, i) => {
                    const busy = checkOne.isPending && checkOne.variables?.target === item.target;
                    const failing = item.state === "down" || item.state === "warning";
                    const one = item.links.length === 1 ? item.links[0]! : null;
                    return (
                      <TR key={item.target} focusable first={i === 0}>
                        <TD className="health-c-dest">
                          {one ? (
                            <Link to={linkPath(one)} className="health-dest-link" data-row-link="" title={`Open ${label(one)}`}>
                              <UrlText url={item.target} />
                            </Link>
                          ) : (
                            <UrlText url={item.target} />
                          )}
                          {item.finalUrl ? (
                            <span className="health-ends" title={item.finalUrl}>
                              <CornerDownRight aria-hidden className="health-inline-icon" />
                              <span className="health-ends-url">ends at {item.finalUrl}</span>
                            </span>
                          ) : null}
                          <UsedBy links={item.links} />
                        </TD>
                        <TD className="health-c-state">
                          <CheckBadge state={item.state} />
                          <Finding item={item} automatic={data.settings.enabled} />
                        </TD>
                        <TD className={cn("health-c-checked", !item.checkedAt && "is-never")}>
                          {item.checkedAt ? (
                            <>
                              <span className="health-checked-at">
                                <span className="health-phone-label">Checked </span>
                                {ago(item.checkedAt)}
                              </span>
                              {item.ms !== null ? (
                                <span className="health-checked-ms">
                                  {num(item.ms)} ms{item.hops ? ` · ${item.hops} ${item.hops === 1 ? "redirect" : "redirects"}` : ""}
                                </span>
                              ) : null}
                            </>
                          ) : (
                            <span className="health-checked-ms">Not checked yet</span>
                          )}
                        </TD>
                        <TD className="health-c-act">
                          <div className="health-acts">
                            {failing && edits ? (
                              <Button size="sm" icon={Wrench} onClick={() => setFixing(item)}>
                                Fix
                              </Button>
                            ) : null}
                            {edits && one ? (
                              <Button asChild size="sm" variant="ghost" className="health-act-quiet">
                                <Link to={`${linkPath(one)}#edit`} title={`Edit ${label(one)}`}>
                                  <Pencil aria-hidden />
                                  <span className="health-act-label">Edit</span>
                                </Link>
                              </Button>
                            ) : edits && item.links.length > 1 ? (
                              <Menu
                                label={`Edit a link that goes to ${hostOf(item.target)}`}
                                trigger={
                                  <Button size="sm" variant="ghost" className="health-act-quiet" title="Edit one of these links">
                                    <Pencil aria-hidden />
                                    <span className="health-act-label">Edit</span>
                                  </Button>
                                }
                                items={item.links.map((l) => ({ label: label(l), onSelect: () => navigate(`${linkPath(l)}#edit`) }))}
                              />
                            ) : null}
                            <Button
                              size="sm"
                              variant="ghost"
                              className="health-act-quiet"
                              onClick={() => checkOne.mutate(item)}
                              loading={busy}
                              disabled={checkOne.isPending && !busy}
                              title={`Check ${hostOf(item.target)} now`}
                            >
                              {busy ? null : <RefreshCw aria-hidden />}
                              <span className="health-act-label">Check now</span>
                            </Button>
                            <Button asChild size="sm" variant="ghost" className="ui-icon-button">
                              <a href={item.target} target="_blank" rel="noreferrer noopener" aria-label={`Open ${item.target} in a new tab`} title="Open the destination">
                                <ExternalLink aria-hidden />
                              </a>
                            </Button>
                          </div>
                        </TD>
                      </TR>
                    );
                  })}
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
                onSize={(n) => {
                  savePageSize("health", n);
                  setSizeState(n);
                  setPage(1);
                }}
              />
            ) : null}
          </Section>

          {settingsOpen ? (
            <SettingsDialog
              onClose={() => setSettingsOpen(null)}
              settings={data.settings}
              activate={settingsOpen === "activate"}
              destinations={data.items.length}
              capacityPerDay={data.capacityPerDay}
            />
          ) : null}
          {fixing ? <FixDialog item={fixing} onClose={() => setFixing(null)} /> : null}
        </>
      )}
    </div>
  );
}
