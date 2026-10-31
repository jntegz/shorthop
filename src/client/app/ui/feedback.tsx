// Loading, empty, error and notice states. Skeletons stand in for content
// (never a lone spinner); errors say what failed and what to do in plain
// words, offer a retry and keep the server's raw answer behind "Details"; notices are one tinted band, never a box with a coloured edge.

import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { ApiError } from "../../api";
import { cn } from "../../lib/utils";
import { Button } from "./button";

export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <span className={cn("ui-skel", className)} style={style} aria-hidden />;
}

/** Lines of text, the last one shorter. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <span className={cn("ui-skel-lines", className)} aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className="ui-skel-text" style={{ width: i === lines - 1 ? "58%" : "100%" }} />
      ))}
    </span>
  );
}

/** Nothing here yet: says why and what to do next, with at most one action. */
export function Empty({ title, children, action, compact, className }: { title: ReactNode; children?: ReactNode; action?: ReactNode; compact?: boolean; className?: string }) {
  return (
    <div className={cn("ui-state", compact && "is-compact", className)}>
      <p className="ui-state-title">{title}</p>
      {children ? <div className="ui-state-body">{children}</div> : null}
      {action}
    </div>
  );
}

const GENERIC = /^(internal( server)? error|bad gateway|service unavailable|gateway timeout|something went wrong\.?)$/i;

/**
 * What went wrong, in words a person can act on. Server faults and generic
 * messages ("Internal error") become a plain cause and a next step; a specific
 * message from the server (a validation answer) is kept. The raw text stays
 * available through `errorDetail` (ErrorState shows it in a disclosure).
 */
export function errorText(error: unknown): string | null {
  if (error instanceof TypeError) return "The admin couldn’t reach the server. Check your connection, then try again.";
  if (!(error instanceof Error)) return null;
  const status = error instanceof ApiError ? error.status : 0;
  if (status === 401) return "Your session ended. Reload the page to sign in again.";
  if (status === 403) return "Your role can’t see this. An owner or admin can change that in Settings.";
  if (status === 404) return "It wasn’t found; it may have been deleted.";
  if (status === 429) return "Too many requests at once. Wait a few seconds, then try again.";
  if (status >= 500 || !error.message || GENERIC.test(error.message.trim())) return "The server ran into a problem. It’s usually brief: try again in a moment. If it keeps happening, look at System status in Settings.";
  return error.message;
}

/** The technical detail behind errorText: status and the server's own words. */
export function errorDetail(error: unknown): string | null {
  if (error instanceof ApiError) return `HTTP ${error.status}${error.message ? `: ${error.message}` : ""}`;
  if (error instanceof Error && error.message) return `${error.name}: ${error.message}`;
  return null;
}

/** "{what} couldn't load." + a human cause and next step + Try again; the raw error behind "Details". */
export function ErrorState({ what, error, onRetry, retrying, compact, className }: { what: string; error?: unknown; onRetry?: () => void; retrying?: boolean; compact?: boolean; className?: string }) {
  const msg = errorText(error);
  const detail = errorDetail(error);
  return (
    <div className={cn("ui-state", compact && "is-compact", className)} role="alert">
      <p className="ui-state-title">{what} couldn’t load.</p>
      {msg ? <p className="ui-state-body">{msg}</p> : null}
      {onRetry ? (
        <Button size="sm" onClick={onRetry} loading={retrying}>
          Try again
        </Button>
      ) : null}
      {detail && detail !== msg ? (
        <details className="ui-state-detail">
          <summary>Details</summary>
          <code>{detail}</code>
        </details>
      ) : null}
    </div>
  );
}

export type NoticeTone = "info" | "good" | "warn" | "danger";
const NOTICE_ICON = { info: Info, good: CheckCircle2, warn: AlertTriangle, danger: XCircle } as const;

/** A one-band message in the page flow. Danger is for things that are broken now. */
export function Notice({ tone = "info", title, children, action, className }: { tone?: NoticeTone; title?: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  const Icon = NOTICE_ICON[tone];
  return (
    <div className={cn("ui-notice", className)} data-tone={tone} role={tone === "danger" ? "alert" : "status"}>
      <Icon className="ui-notice-icon" aria-hidden />
      <div className="ui-notice-text">
        {title ? <p className="ui-notice-title">{title}</p> : null}
        {children ? <div className="ui-notice-body">{children}</div> : null}
      </div>
      {action ? <div className="ui-notice-action">{action}</div> : null}
    </div>
  );
}
