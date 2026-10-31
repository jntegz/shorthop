// System status at the bottom of the analytics home. Quiet when all is well
// (one line), the checks listed when something needs a look, with each check's
// fix command and setup guide. Under it, the running version and any newer
// release. The sidebar's status line links here (/#status). Look: home.css, "home-".

import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Copy, RefreshCw, Send, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { toast } from "sonner";
import { APP_NAME, REPO_URL } from "../../../shared/brand";
import type { HealthCheck } from "../../../shared/types";
import { api, call, keys } from "../../api";
import { ago, when } from "../../lib/format";
import { useCan } from "../../lib/me";
import { copy } from "../../lib/utils";
import { Badge, Button, ErrorState, Notice, Section, Skeleton, TextButton } from "../ui";

/** Rechecked every 5 minutes while the admin is open, for people who manage the workspace (shares the sidebar's cache). */
export function useSystemHealth() {
  const enabled = useCan()("settings.manage");
  return useQuery({ queryKey: keys.health, queryFn: () => call(api.settings.health.$get()), refetchInterval: 5 * 60_000, staleTime: 60_000, enabled });
}

/** Checks whose failure means short links or the admin itself are broken right now (the sidebar's rule). */
const BROKEN_NOW = new Set(["kv", "d1"]);

/** Red only when redirects or the database fail; a setup still to finish is warn (DESIGN §2.3). */
function tone(c: HealthCheck): "good" | "warn" | "bad" {
  if (c.status === "ok") return "good";
  return c.status === "error" && BROKEN_NOW.has(c.id) ? "bad" : "warn";
}
const ICON = { good: CheckCircle2, warn: AlertTriangle, bad: XCircle } as const;
const SAY = { good: "OK", warn: "Needs a look", bad: "Failing" } as const;

/** A check's fix command (copyable) and its section of the setup manual. */
function CheckHelp({ check }: { check: HealthCheck }) {
  if (!check.fix && !check.docs) return null;
  return (
    <p className="home-check-help">
      {check.fix ? (
        <button type="button" className="home-check-fix" onClick={() => void copy(check.fix!, "Command copied")} title="Copy command">
          <code>{check.fix}</code>
          <Copy aria-hidden />
        </button>
      ) : null}
      {check.docs ? (
        <a href={`${REPO_URL}/blob/main/${check.docs}`} target="_blank" rel="noopener noreferrer" className="ui-panel-link">
          Setup guide<span aria-hidden> ↗</span>
        </a>
      ) : null}
    </p>
  );
}

/** The running version, and a newer release when there is one (GitHub is asked once a day). */
function VersionNotice() {
  const { data: v } = useQuery({ queryKey: keys.version, queryFn: () => call(api.settings.version.$get()), staleTime: 60 * 60_000 });
  if (!v) return null;
  if (!v.updateAvailable)
    return (
      <p className="home-status-version">
        {APP_NAME} {v.current}
        {v.current === v.latest ? ", the latest version." : null}
      </p>
    );
  return (
    <Notice
      title={`${APP_NAME} ${v.latest} is available`}
      className="home-status-update"
      action={
        <>
          <a href={v.url ?? `${REPO_URL}/releases`} target="_blank" rel="noopener noreferrer" className="ui-panel-link">
            What's new<span aria-hidden> ↗</span>
          </a>
          <a href={`${REPO_URL}/blob/main/docs/SETUP.md#updating`} target="_blank" rel="noopener noreferrer" className="ui-panel-link">
            How to update<span aria-hidden> ↗</span>
          </a>
        </>
      }
    >
      You're on {v.current}. Read what's new and the upgrading notes before you update.
    </Notice>
  );
}

/** People who manage the workspace only, as before. */
export function SystemStatus() {
  return useCan()("settings.manage") ? <StatusSection /> : null;
}

function StatusSection() {
  const q = useSystemHealth();
  const h = q.data;
  const [open, setOpen] = useState(false);
  const test = useMutation({
    mutationFn: () => call(api.settings.health["test-alert"].$post()),
    onSuccess: (r) => (r.sent ? toast.success("Alert email sent", { description: h?.alertsTo ?? undefined }) : toast.error(`Not sent: ${r.reason}`)),
    onError: (e) => toast.error(e.message),
  });
  const { hash } = useLocation();
  // The sidebar links here; the shell scrolls to the top on navigation, so scroll once the checks are in.
  // Once per arrival: refetches every few minutes must not scroll the page back.
  const loaded = Boolean(h) || q.isError;
  useEffect(() => {
    if (hash === "#status" && loaded) requestAnimationFrame(() => document.getElementById("status")?.scrollIntoView({ block: "start" }));
  }, [hash, loaded]);

  const actions = (
    <>
      <Button size="sm" variant="secondary" icon={RefreshCw} onClick={() => void q.refetch()} loading={q.isFetching}>
        Check now
      </Button>
      <Button size="sm" variant="secondary" icon={Send} onClick={() => test.mutate()} loading={test.isPending} disabled={!h?.alertsTo} title={h && !h.alertsTo ? "Email alerts are off or not set up, so no alert can be sent" : undefined}>
        Send test alert
      </Button>
    </>
  );
  const sub = h
    ? h.alertsTo
      ? `Checked ${when(h.checkedAt)}. Problems are emailed to ${h.alertsTo} after the daily check (01:15 UTC).`
      : `Checked ${when(h.checkedAt)}. Email alerts are off or not set up, so problems only show here.`
    : "Checks the setup, storage, analytics, scheduled jobs and admin protection.";

  if (q.isPending)
    return (
      <section id="status" className="home-status is-quiet" aria-busy aria-label="System status">
        <Skeleton className="ui-skel-text" style={{ width: 280 }} />
      </section>
    );

  if (q.isError && !h)
    return (
      <Section id="status" title="System status" className="home-status">
        <ErrorState compact what="System status" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      </Section>
    );

  const checks = h!.checks;
  // A check that's off by choice (advisory) is listed, but isn't a problem.
  const problems = checks.filter((c) => c.status !== "ok" && !c.advisory);
  const byChoice = checks.filter((c) => c.status !== "ok" && c.advisory);

  // All well: one quiet line, the checks one click away.
  if (!problems.length && !open)
    return (
      <section id="status" className="home-status is-quiet" aria-label="System status">
        <p className="home-status-line">
          <span className="home-status-dot" data-tone="good" aria-hidden />
          <span>
            {byChoice.length ? `No system check needs a look (${byChoice.length} off by choice)` : `All ${checks.length} system checks pass`}
            <span className="home-status-when">, checked {ago(h!.checkedAt)}</span>.
          </span>
          <TextButton onClick={() => setOpen(true)} aria-expanded={false}>
            Show checks
          </TextButton>
          <TextButton onClick={() => void q.refetch()} disabled={q.isFetching}>
            {q.isFetching ? "Checking…" : "Check now"}
          </TextButton>
        </p>
        <VersionNotice />
      </section>
    );

  return (
    <Section
      id="status"
      title="System status"
      className="home-status"
      sub={
        <>
          {sub}
          {!problems.length ? (
            <>
              {" "}
              <TextButton onClick={() => setOpen(false)} aria-expanded>
                Hide checks
              </TextButton>
            </>
          ) : null}
        </>
      }
      aside={actions}
    >
      <ul className="home-checks">
        {/* What needs a look first, then the rest in their usual order. */}
        {[...problems, ...byChoice, ...checks.filter((c) => c.status === "ok")].map((c) => {
          const t = tone(c);
          const Icon = ICON[t];
          return (
            <li key={c.id} className="home-check" data-tone={t}>
              <Icon className="home-check-icon" aria-hidden />
              <div className="home-check-text">
                <p className="home-check-label">
                  {c.label}
                  <span className="ui-sr">: {SAY[t]}</span>
                  {c.advisory && c.status !== "ok" ? <Badge>By choice</Badge> : null}
                </p>
                <p className="home-check-detail">{c.detail}</p>
                <CheckHelp check={c} />
              </div>
            </li>
          );
        })}
      </ul>
      <VersionNotice />
    </Section>
  );
}
