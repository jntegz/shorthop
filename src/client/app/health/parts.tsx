// Pieces shared by Link health's two pages (Health.tsx, Misses.tsx): the tab
// row between them, check states and their badge, the (i) help popover, the
// freshness line, the link picker, and the misses period kept in the URL.
// Look: health.css.

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Clock, Info, RefreshCw, ShieldQuestion, XCircle, type LucideIcon } from "lucide-react";
import { Popover } from "radix-ui";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { STATE_LABEL, type CheckState } from "../../../shared/link-check";
import { RANGES, type LinkDTO, type Period, type Range } from "../../../shared/types";
import { api, call, keys } from "../../api";
import type { Help } from "../../lib/help";
import { ago } from "../../lib/format";
import { linkKey, linkState, useLinkLabel } from "../../lib/links";
import { useCan } from "../../lib/me";
import { cn } from "../../lib/utils";
import { Badge, Select, type BadgeTone } from "../ui";

// ---- Check states ----

export const CHECK_STYLE: Record<CheckState, { tone: BadgeTone; icon: LucideIcon }> = {
  down: { tone: "danger", icon: XCircle },
  warning: { tone: "warn", icon: AlertTriangle },
  ok: { tone: "good", icon: CheckCircle2 },
  blocked: { tone: "neutral", icon: ShieldQuestion },
  unchecked: { tone: "neutral", icon: Clock },
};

/** Worst first: the order problems are listed in. */
export const STATE_ORDER: readonly CheckState[] = ["down", "warning", "unchecked", "blocked", "ok"];

/**
 * A destination check's state. A working one is news only by contrast, so it
 * reads as quiet text, not a badge (DESIGN §6 "Badges only for news").
 * `label` overrides the default wording.
 */
export function CheckBadge({ state, label }: { state: CheckState; label?: string }) {
  if (state === "ok") return <span className="health-ok">{label ?? STATE_LABEL.ok}</span>;
  return <Badge tone={CHECK_STYLE[state].tone}>{label ?? STATE_LABEL[state]}</Badge>;
}

// ---- The tab row: Destinations · Missed visits ----

const TABS = [
  { to: "/health", label: "Destinations", hint: "Do your links still lead somewhere?" },
  { to: "/misses", label: "Missed visits", hint: "Visits to links that don't exist" },
] as const;

/** The two halves of Link health: destinations that fail, and visits that miss. Real links (routes), drawn as the underline tabs. */
export function HealthTabs({ badge }: { badge?: { to: (typeof TABS)[number]["to"]; count: number } }) {
  const { pathname } = useLocation();
  const at = pathname.replace(/^\/_admin/, "").replace(/\/$/, "");
  return (
    <nav aria-label="Link health" className="ui-tabs-row health-tabs">
      <div className="ui-tablist">
        {TABS.map(({ to, label, hint }) => {
          const current = at === to;
          return (
            <Link key={to} to={to} title={hint} className="ui-tab" data-state={current ? "active" : undefined} aria-current={current ? "page" : undefined}>
              {label}
              {badge?.to === to && badge.count > 0 ? (
                <span className="health-tab-alert">
                  {badge.count}
                  <span className="ui-sr"> not working</span>
                </span>
              ) : null}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

// ---- (i) help ----

/** An (i) button that opens a longer explanation (lib/help.ts) in a popover. Click, tap or keyboard; Esc closes. */
export function HelpTip({ help, className }: { help: Help; className?: string }) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className={cn("health-help", className)} aria-label={`About ${help.title}`} title={`About ${help.title}`}>
          <Info aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="health-pop" side="bottom" align="start" sideOffset={6} collisionPadding={12} aria-label={help.title}>
          <p className="health-pop-title">{help.title}</p>
          <p className="health-pop-body">{help.body}</p>
          {help.example ? <code className="health-pop-example">{help.example}</code> : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ---- Freshness ----

/** "Updated 20 seconds ago · {note} · Refresh". */
export function Freshness({ updatedAt, fetching, onRefresh, note, className }: { updatedAt: number; fetching: boolean; onRefresh: () => void; note?: ReactNode; className?: string }) {
  // Re-render now and then so "20 seconds ago" stays true.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);
  if (!updatedAt) return null;
  return (
    <p className={cn("health-fresh", className)} aria-live="polite">
      <span>{fetching ? "Updating…" : `Updated ${ago(Math.floor(updatedAt / 1000))}`}</span>
      {note ? (
        <>
          <span aria-hidden>·</span>
          {note}
        </>
      ) : null}
      <button type="button" className="ui-text-button health-refresh" onClick={onRefresh} disabled={fetching}>
        <RefreshCw aria-hidden className={cn(fetching && "is-spinning")} />
        Refresh
      </button>
    </p>
  );
}

// ---- System health (alert email address) ----

/** The workspace's system checks (people who manage settings): here only for where alerts are sent. */
export function useSystemHealth() {
  const enabled = useCan()("settings.manage");
  return useQuery({ queryKey: keys.health, queryFn: () => call(api.settings.health.$get()), refetchInterval: 5 * 60_000, staleTime: 60_000, enabled });
}

// ---- Link picker ----

/**
 * A choice of your links that work right now (the same list as the link
 * form's replacement picker); "" for none. The current choice stays listed
 * even when it no longer works (disabled, replaced, expired), so the picker
 * doesn't look empty.
 */
export function LinkPicker({
  id,
  label,
  hideLabel,
  value,
  onChange,
  exclude = [],
  className,
}: {
  id: string;
  label: string;
  hideLabel?: boolean;
  value: string;
  onChange: (key: string, link: LinkDTO | null) => void;
  /** Links not to offer, as linkKeys. */
  exclude?: string[];
  className?: string;
}) {
  const linkLabel = useLinkLabel();
  const candidates = useQuery({
    queryKey: keys.links({ picker: true }),
    queryFn: () => call(api.links.$get({ query: { sort: "slug", period: "7d" } })),
  });
  const options = (candidates.data?.links ?? []).filter(
    (l) => linkKey(l.domain, l.slug) === value || (linkState(l) === "active" && !exclude.includes(linkKey(l.domain, l.slug))),
  );
  return (
    <Select
      id={id}
      label={label}
      hideLabel={hideLabel}
      className={className}
      value={value}
      disabled={candidates.isPending}
      onChange={(e) => onChange(e.target.value, options.find((l) => linkKey(l.domain, l.slug) === e.target.value) ?? null)}
      options={[
        { value: "", label: candidates.isPending ? "Loading links…" : candidates.isError && !candidates.data ? "Your links couldn’t load" : "Choose a link" },
        ...options.map((l) => ({ value: linkKey(l.domain, l.slug), label: `${linkLabel(l)}${l.title ? ` · ${l.title}` : ""}` })),
      ]}
    />
  );
}

/** "alt.example/guide" back to its parts. */
export const keyToLink = (key: string) => ({ domain: key.slice(0, key.indexOf("/")), slug: key.slice(key.indexOf("/") + 1) });

// ---- Misses period, kept in the URL ----

/** Like next/data.ts usePeriod, but the misses page starts on 7 days, as before. */
export function useMissPeriod(): [Period, (p: Period) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get("range") ?? "";
  const range: Range = (RANGES as readonly string[]).includes(raw) ? (raw as Range) : "7d";
  const period: Period = range === "custom" ? { range, from: params.get("from") ?? undefined, to: params.get("to") ?? undefined } : { range };
  const set = (p: Period) => {
    const next = new URLSearchParams(params);
    next.delete("from");
    next.delete("to");
    next.delete("page");
    if (p.range === "7d") next.delete("range");
    else next.set("range", p.range);
    if (p.range === "custom" && p.from && p.to) {
      next.set("from", p.from);
      next.set("to", p.to);
    }
    setParams(next, { replace: true });
  };
  return [period, set];
}
