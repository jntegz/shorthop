import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, BellRing, CheckCircle2, Copy, ExternalLink, RefreshCw, XCircle } from "lucide-react";
import { useEffect } from "react";
import { Link, useLocation } from "react-router";
import { toast } from "sonner";
import { REPO_URL } from "../../shared/brand";
import type { HealthCheck, HealthStatus } from "../../shared/types";
import { api, call, keys } from "../api";
import { when } from "../lib/format";
import { cn } from "../lib/utils";
import { Badge, Button, Card, CardHeader, Spinner } from "./ui";

/** Rechecked every 5 minutes while the admin is open. */
function useSystemHealth() {
  return useQuery({ queryKey: keys.health, queryFn: () => call(api.settings.health.$get()), refetchInterval: 5 * 60_000, staleTime: 60_000 });
}

const ICON: Record<HealthStatus, typeof CheckCircle2> = { ok: CheckCircle2, warn: AlertTriangle, error: XCircle };
const TONE: Record<HealthStatus, string> = { ok: "text-good", warn: "text-warn", error: "text-danger" };

/** A check's fix command (copyable) and its section of the setup manual. */
function CheckHelp({ check }: { check: HealthCheck }) {
  if (!check.fix && !check.docs) return null;
  const copy = () =>
    navigator.clipboard.writeText(check.fix!).then(
      () => toast.success("Command copied"),
      () => toast.error("Couldn't copy the command"),
    );
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      {check.fix ? (
        <button type="button" onClick={copy} className="inline-flex items-center gap-1.5 rounded-md border border-line bg-bg px-2 py-0.5 font-mono text-fg hover:border-accent/40" title="Copy command">
          {check.fix} <Copy className="size-3 text-muted" />
        </button>
      ) : null}
      {check.docs ? (
        <a href={`${REPO_URL}/blob/main/${check.docs}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-accent hover:underline">
          Setup guide <ExternalLink className="size-3" />
        </a>
      ) : null}
    </div>
  );
}

/** Dashboard → System status. */
export function SystemStatus() {
  const q = useSystemHealth();
  const test = useMutation({
    mutationFn: () => call(api.settings.health["test-alert"].$post()),
    onSuccess: (r) => (r.sent ? toast.success("Alert email sent", { description: q.data?.alertsTo ?? undefined }) : toast.error(`Not sent: ${r.reason}`)),
    onError: (e) => toast.error(e.message),
  });
  const h = q.data;
  const { hash } = useLocation();
  // The banner links here; the layout scrolls to the top on navigation.
  // Once per arrival: refetches every few minutes must not scroll the page back.
  const loaded = Boolean(h);
  useEffect(() => {
    if (hash === "#status" && loaded) requestAnimationFrame(() => document.getElementById("status")?.scrollIntoView({ block: "start" }));
  }, [hash, loaded]);

  return (
    <Card id="status">
      <CardHeader
        title="System status"
        description={
          h
            ? h.alertsTo
              ? `Checked ${when(h.checkedAt)}. Problems are emailed to ${h.alertsTo} after the daily check (01:15 UTC).`
              : `Checked ${when(h.checkedAt)}. Email alerts are off or not set up, so problems only show here.`
            : "Checks the setup, storage, analytics, scheduled jobs and admin protection."
        }
        action={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => void q.refetch()} loading={q.isFetching}>
              <RefreshCw /> Check now
            </Button>
            <Button variant="outline" size="sm" onClick={() => test.mutate()} loading={test.isPending} disabled={!h?.alertsTo}>
              <BellRing /> Send test alert
            </Button>
          </div>
        }
      />
      {q.isPending ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : q.isError ? (
        <p className="px-5 pb-5 text-sm text-danger">The status check itself failed: {q.error.message}</p>
      ) : (
        <ul className="divide-y divide-line border-t border-line">
          {h!.checks.map((c) => {
            const Icon = ICON[c.status];
            return (
              <li key={c.id} className="flex items-start gap-3 px-5 py-3 text-sm">
                <Icon className={cn("mt-0.5 size-4 shrink-0", TONE[c.status])} aria-label={c.status} />
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-medium text-fg">
                    {c.label}
                    {c.advisory ? <Badge>By choice</Badge> : null}
                  </p>
                  <p className="text-xs leading-relaxed text-muted">{c.detail}</p>
                  <CheckHelp check={c} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/** Shown above every admin page while a check is failing. */
export function SystemStatusBanner() {
  const { data } = useSystemHealth();
  if (!data || data.status === "ok") return null;
  const problems = data.checks.filter((c) => c.status !== "ok" && !c.advisory);
  return (
    <div role="status" className={cn("mb-5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-4 py-3 text-sm", data.status === "error" ? "border-danger/30 bg-danger-soft" : "border-warn/30 bg-warn-soft")}>
      {data.status === "error" ? <XCircle className="size-4 text-danger" /> : <AlertTriangle className="size-4 text-warn" />}
      <span className="font-medium text-fg">{problems.length === 1 ? `${problems[0]!.label} needs attention.` : `${problems.length} system checks need attention.`}</span>
      <Link to="/#status" className="text-accent underline underline-offset-2">
        See system status
      </Link>
    </div>
  );
}
