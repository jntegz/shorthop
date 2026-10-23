import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, CornerDownRight, RefreshCw } from "lucide-react";
import { Link } from "react-router";
import { toast } from "sonner";
import { DOWN_AFTER_FAILS, problemText, STATE_LABEL } from "../../shared/link-check";
import type { LinkDTO } from "../../shared/types";
import { api, call, keys } from "../api";
import { ago, num } from "../lib/format";
import { LINK_HELP } from "../lib/help";
import { linkKey, linkPath, useLinkLabel } from "../lib/links";
import { cn } from "../lib/utils";
import { CHECK_STYLE, CheckBadge } from "./CheckBadge";
import { Button, Card, InfoTip, Spinner } from "./ui";

/** Link page → whether the destination still loads, with "Check now" and the fixes that apply. */
export function DestinationCheck({ link, onMarkBroken }: { link: LinkDTO; onMarkBroken: () => void }) {
  const { domain, slug } = link;
  const qc = useQueryClient();
  const label = useLinkLabel();
  const q = useQuery({
    // Saving the link can change what's checked; refetch after every save.
    queryKey: [...keys.linkCheck(domain, slug), link.updatedAt],
    queryFn: () => call(api.checks.links[":domain"][":slug"].$get({ param: { domain, slug } })),
  });
  const run = useMutation({
    mutationFn: () => call(api.checks.links[":domain"][":slug"].$post({ param: { domain, slug } })),
    onSuccess: (r) => {
      qc.setQueryData([...keys.linkCheck(domain, slug), link.updatedAt], r);
      void qc.invalidateQueries({ queryKey: keys.checks, exact: true });
      void qc.invalidateQueries({ queryKey: keys.allLinks });
      const c = r.check;
      if (c?.state === "ok") toast.success("The destination loads", { description: c.ms !== null ? `Answered in ${num(c.ms)} ms.` : undefined });
      else if (c?.state === "blocked") toast.info("The site refuses automated checks", { description: "People can usually still open it." });
      else if (c) toast.error(problemText(c.problem, c.httpStatus) || STATE_LABEL[c.state]);
    },
    onError: (e) => toast.error(e.message),
  });
  const turnOn = useMutation({
    mutationFn: () => call(api.links[":domain"][":slug"].$patch({ param: { domain, slug }, json: { monitor: true } })),
    onSuccess: (data) => {
      qc.setQueryData(keys.link(domain, slug), data);
      void qc.invalidateQueries({ queryKey: keys.allLinks });
      void qc.invalidateQueries({ queryKey: keys.checks, exact: true });
      toast.success("Destination checks turned on", { description: "It's checked within 30 minutes, or press Check now." });
    },
    onError: (e) => toast.error(e.message),
  });

  const data = q.data;
  const c = data?.check ?? null;
  const state = data && !data.monitored && !c ? null : (c?.state ?? "unchecked");
  const others = c?.links.filter((l) => !(l.domain === domain && l.slug === slug)) ?? [];
  const failing = c?.state === "down" || c?.state === "warning";

  return (
    <Card className="mb-5">
      <div className="flex flex-wrap items-start gap-4 p-5">
        <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl", state ? CHECK_STYLE[state].soft : "bg-surface-2", state ? CHECK_STYLE[state].text : "text-muted")}>
          {state ? (() => {
            const Icon = CHECK_STYLE[state].icon;
            return <Icon className="size-5" aria-hidden />;
          })() : <BellRing className="size-5" aria-hidden />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[15px] font-semibold tracking-tight text-fg">Destination check</h2>
            <InfoTip help={LINK_HELP.monitor} />
            {state && data?.monitored ? <CheckBadge state={state} /> : null}
          </div>
          {q.isPending ? (
            <div className="mt-2">
              <Spinner className="size-4" />
            </div>
          ) : q.isError ? (
            <p className="mt-1 text-sm text-danger">{q.error.message}</p>
          ) : !data!.monitored ? (
            <p className="mt-1 text-sm text-muted">{data!.reason}</p>
          ) : !c || c.state === "unchecked" ? (
            <p className="mt-1 text-sm text-muted">Not checked yet. It's checked within 30 minutes, or press Check now.</p>
          ) : (
            <div className="mt-1 space-y-1 text-sm text-muted">
              <p>
                {c.state === "ok"
                  ? `Loaded ${c.httpStatus ? `with HTTP ${c.httpStatus} ` : ""}${c.ms !== null ? `in ${num(c.ms)} ms` : ""}`
                  : c.state === "blocked"
                    ? `${problemText(c.problem, c.httpStatus)}. People can usually still open it.`
                    : problemText(c.problem, c.httpStatus)}
                {c.checkedAt ? ` · checked ${ago(c.checkedAt)}` : ""}
              </p>
              {failing ? (
                <p className={c.state === "down" ? "text-danger" : "text-warn"}>
                  {c.state === "down"
                    ? `Failing since ${ago(c.since!)}${c.lastOkAt ? `, last worked ${ago(c.lastOkAt)}` : ""}.`
                    : `${c.fails} of ${DOWN_AFTER_FAILS} failed checks. Rechecked ${c.nextAt ? ago(c.nextAt) : "soon"} before it counts as not working.`}
                </p>
              ) : null}
              {c.finalUrl ? (
                <p className="flex min-w-0 items-center gap-1 text-xs" title={c.finalUrl}>
                  <CornerDownRight className="size-3 shrink-0" aria-hidden />
                  <span className="truncate">
                    Redirects {c.hops === 1 ? "once" : `${c.hops} times`} and ends at {c.finalUrl}
                  </span>
                </p>
              ) : null}
              {others.length ? (
                <p className="text-xs">
                  Same destination as{" "}
                  {others.slice(0, 3).map((l, i) => (
                    <span key={linkKey(l.domain, l.slug)}>
                      {i ? ", " : ""}
                      <Link to={linkPath(l)} className="font-medium text-accent hover:underline">
                        {label(l)}
                      </Link>
                    </span>
                  ))}
                  {others.length > 3 ? ` and ${others.length - 3} more` : ""}: checked once for all of them.
                </p>
              ) : null}
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {data && !link.monitor ? (
            <Button variant="outline" size="sm" onClick={() => turnOn.mutate()} loading={turnOn.isPending}>
              <BellRing /> Turn checks on
            </Button>
          ) : null}
          {data?.monitored && failing && !link.broken ? (
            <Button variant="outline" size="sm" onClick={onMarkBroken}>
              Mark as no longer working
            </Button>
          ) : null}
          {data?.monitored ? (
            <Button variant="outline" size="sm" onClick={() => run.mutate()} loading={run.isPending}>
              {run.isPending ? null : <RefreshCw />} Check now
            </Button>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
