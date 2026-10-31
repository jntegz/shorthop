// The link's settings as facts: a compact two-column list. The destination
// check sits here too, laid out so its actions go under the text on narrow
// screens.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BellRing, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { DOWN_AFTER_FAILS, problemText, STATE_LABEL, type CheckState } from "../../../shared/link-check";
import { describeRouting } from "../../../shared/routing";
import { IMPORT_SOURCE_LABEL, type LinkDTO } from "../../../shared/types";
import { api, call, keys } from "../../api";
import { ago, date, num, when, whenFull } from "../../lib/format";
import { linkKey, linkPath, useLinkLabel } from "../../lib/links";
import { useCan } from "../../lib/me";
import { Badge, Button, type BadgeTone, errorText, Section, Skeleton, TextButton } from "../ui";
import { linkCheckKey, useCap, useLinkCheck, useLinkRevenueYear } from "./data";
import { moneyShort } from "../parts";

export const CHECK_TONE: Record<CheckState, BadgeTone> = { down: "danger", warning: "warn", ok: "good", blocked: "neutral", unchecked: "neutral" };

function Fact({ label, children, wide, id }: { label: string; children: ReactNode; wide?: boolean; id?: string }) {
  return (
    <div className={wide ? "ui-ld-fact is-wide" : "ui-ld-fact"} id={id}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

// ---- Destination check ----

export function CheckFact({ link, onMarkBroken }: { link: LinkDTO; onMarkBroken: () => void }) {
  const can = useCan();
  const { domain, slug } = link;
  const qc = useQueryClient();
  const label = useLinkLabel();
  const q = useLinkCheck(link);
  const run = useMutation({
    mutationFn: () => call(api.checks.links[":domain"][":slug"].$post({ param: { domain, slug } })),
    onSuccess: (r) => {
      qc.setQueryData(linkCheckKey(link), r);
      void qc.invalidateQueries({ queryKey: keys.checks, exact: true });
      void qc.invalidateQueries({ queryKey: keys.allLinks });
      const c = r.check;
      if (c?.state === "ok") toast.success("The destination loads", { description: c.ms !== null ? `Answered in ${num(c.ms)} ms.` : undefined });
      else if (c?.state === "blocked") toast.info("The site refuses automated checks", { description: "People can usually still open it." });
      else if (c) toast.error(problemText(c.problem, c.httpStatus) || STATE_LABEL[c.state]);
    },
    onError: (e) => toast.error(errorText(e) ?? "That didn’t work. Try again."),
  });
  const setChecks = useMutation({
    mutationFn: (on: boolean) => call(api.links[":domain"][":slug"].$patch({ param: { domain, slug }, json: on ? { monitor: true } : { monitor: false } })),
    onSuccess: (data, on) => {
      qc.setQueryData(keys.link(domain, slug), data);
      void qc.invalidateQueries({ queryKey: keys.allLinks });
      void qc.invalidateQueries({ queryKey: keys.checks, exact: true });
      if (on) {
        toast.success("Automatic checks turned on", {
          description: q.data?.automatic ? "It's checked within 30 minutes, or press Check now." : "Automatic checking is off under Link health, so press Check now, or turn it on there.",
        });
      } else {
        toast.success("Automatic checks turned off", { description: "The link keeps redirecting visitors as before." });
      }
    },
    onError: (e) => toast.error(errorText(e) ?? "That didn’t work. Try again."),
  });

  const data = q.data;
  const c = data?.check ?? null;
  const state: CheckState | null = data && !data.monitored && !c ? null : (c?.state ?? "unchecked");
  const others = c?.links.filter((l) => !(l.domain === domain && l.slug === slug)) ?? [];
  const failing = c?.state === "down" || c?.state === "warning";
  const edits = can("links.edit");

  let body: ReactNode;
  if (q.isPending) body = <Skeleton className="ui-skel-text" style={{ width: 260 }} />;
  else if (q.isError)
    body = (
      <p className="ui-ld-fact-bad">
        The check couldn’t load. {errorText(q.error)}{" "}
        <TextButton onClick={() => void q.refetch()}>Try again</TextButton>
      </p>
    );
  else if (!data!.monitored) body = <p>{data!.reason}</p>;
  else if (!c || c.state === "unchecked")
    body = <p>{data!.automatic ? "Not checked yet. It’s checked within 30 minutes, or press Check now." : "Not checked yet. Automatic checking is off: press Check now, or turn it on under Link health."}</p>;
  else
    body = (
      <>
        <p>
          {c.state === "ok"
            ? `Loads${c.httpStatus ? ` with HTTP ${c.httpStatus}` : ""}${c.ms !== null ? ` in ${num(c.ms)} ms` : ""}`
            : c.state === "blocked"
              ? `${problemText(c.problem, c.httpStatus)}. People can usually still open it`
              : problemText(c.problem, c.httpStatus)}
          {c.checkedAt ? <span className="ui-ld-fact-quiet">, checked {ago(c.checkedAt)}</span> : null}.
        </p>
        {failing ? (
          <p className={c.state === "down" ? "ui-ld-fact-bad" : "ui-ld-fact-warn"}>
            {c.state === "down"
              ? `Failing since ${ago(c.since!)}${c.lastOkAt ? `, last worked ${ago(c.lastOkAt)}` : ""}.`
              : data!.automatic
                ? `${c.fails} of ${DOWN_AFTER_FAILS} failed checks. Rechecked ${c.nextAt ? ago(c.nextAt) : "soon"} before it counts as not working.`
                : `${c.fails} of ${DOWN_AFTER_FAILS} failed checks. Automatic checking is off, so it’s only rechecked when someone presses Check now.`}
          </p>
        ) : null}
        {c.finalUrl ? (
          <p className="ui-ld-fact-quiet ui-ld-fact-url">
            Redirects {c.hops === 1 ? "once" : `${c.hops} times`} and ends at {c.finalUrl}
          </p>
        ) : null}
        {others.length ? (
          <p className="ui-ld-fact-quiet">
            Same destination as{" "}
            {others.slice(0, 3).map((l, i) => (
              <span key={linkKey(l.domain, l.slug)}>
                {i ? ", " : ""}
                <Link to={linkPath(l)} className="ui-ld-fact-link">{label(l)}</Link>
              </span>
            ))}
            {others.length > 3 ? ` and ${others.length - 3} more` : ""}: checked once for all of them.
          </p>
        ) : null}
      </>
    );

  const actions = data ? (
    <>
      {(link.neverCheck || (data.scope === "selected" && !link.monitor)) && edits ? (
        <Button size="sm" icon={BellRing} onClick={() => setChecks.mutate(true)} loading={setChecks.isPending}>
          Turn automatic checks on
        </Button>
      ) : null}
      {link.active && link.monitor && data.scope === "selected" && edits ? (
        <Button size="sm" variant="ghost" onClick={() => setChecks.mutate(false)} loading={setChecks.isPending}>
          Turn automatic checks off
        </Button>
      ) : null}
      {data.monitored && failing && !link.broken && edits ? (
        <Button size="sm" onClick={onMarkBroken}>
          Mark as no longer working
        </Button>
      ) : null}
      {data.monitored && can("health.manage") ? (
        <Button size="sm" icon={RefreshCw} onClick={() => run.mutate()} loading={run.isPending}>
          Check now
        </Button>
      ) : null}
    </>
  ) : null;

  return (
    <Fact label="Destination check" wide id="check">
      <div className="ui-ld-check">
        <div className="ui-ld-check-text">
          {state && data?.monitored ? <Badge tone={CHECK_TONE[state]}>{STATE_LABEL[state]}</Badge> : null}
          {body}
          <p className="ui-ld-fact-quiet">Checks only look at the destination. Turning them on or off never changes where visitors go.</p>
        </div>
        {actions ? <div className="ui-ld-check-actions">{actions}</div> : null}
      </div>
    </Fact>
  );
}

// ---- Small facts ----

function CapFact({ link }: { link: LinkDTO }) {
  const q = useCap(link.domain, link.slug, Boolean(link.maxClicks));
  const limit = link.maxClicks!;
  const full = q.data ? q.data.count >= limit : false;
  return (
    <Fact label="Visit limit">
      {q.data ? (
        <span className={full ? "ui-ld-fact-bad" : undefined}>
          {num(q.data.count)} of {num(limit)} visits used{full ? ": limit reached" : ""}
        </span>
      ) : q.isError ? (
        `${num(limit)} visits (the count couldn’t load)`
      ) : (
        <>{num(limit)} visits</>
      )}
      <span className="ui-ld-fact-sub">Bots and link previews don’t count.</span>
    </Fact>
  );
}

function YearRevenueFact({ link }: { link: LinkDTO }) {
  const q = useLinkRevenueYear(link.domain, link.slug, true);
  const r = q.data;
  if (q.isError && !r)
    return (
      <Fact label="Revenue, last 12 months">
        <span className="ui-ld-fact-bad">Couldn’t load. </span>
        <TextButton onClick={() => void q.refetch()}>Try again</TextButton>
      </Fact>
    );
  if (!r || !r.bySite.length) return null;
  const byCurrency = new Map<string, { revenue: number; payments: number }>();
  for (const s of r.bySite) {
    const cur = byCurrency.get(s.currency) ?? { revenue: 0, payments: 0 };
    byCurrency.set(s.currency, { revenue: cur.revenue + s.revenue, payments: cur.payments + s.payments });
  }
  return (
    <Fact label="Revenue, last 12 months">
      <span className="ui-ld-fact-num">
        {[...byCurrency.entries()]
          .filter(([, v]) => v.revenue !== 0)
          .map(([c, v]) => moneyShort(v.revenue, c, true))
          .join(" + ") || "None yet"}
      </span>
      <span className="ui-ld-fact-sub">
        {num(r.payments)} {r.payments === 1 ? "payment" : "payments"} from {num(r.sessions)} {r.sessions === 1 ? "visit" : "visits"} on {r.bySite.length === 1 ? r.bySite[0]!.name : `${r.bySite.length} websites`}. The Revenue number above covers only the chosen period.
      </span>
    </Fact>
  );
}

export function Facts({
  link,
  onEdit,
  onMarkBroken,
  onShare,
  activeShares,
}: {
  link: LinkDTO;
  onEdit?: () => void;
  onMarkBroken: () => void;
  onShare?: () => void;
  activeShares: number;
}) {
  const can = useCan();
  const label = useLinkLabel();
  const expired = link.expiresAt !== null && link.expiresAt * 1000 < Date.now();
  return (
    <Section title="Settings" className="ui-ld-facts" id="settings" aside={onEdit ? <TextButton onClick={onEdit}>Edit settings</TextButton> : undefined}>
      <dl className="ui-ld-facts-list">
        <CheckFact link={link} onMarkBroken={onMarkBroken} />
        <Fact label="Destination" wide>
          <a href={link.target} target="_blank" rel="noreferrer noopener" className="ui-ld-fact-link ui-ld-fact-url">
            {link.target}
            <span className="ui-sr"> (opens in a new tab)</span>
          </a>
        </Fact>
        {link.title ? <Fact label="Title">{link.title}</Fact> : null}
        <Fact label="Tags">
          {link.tags.length ? (
            <span className="ui-ld-tags">
              {link.tags.map((t) => (
                <Link key={t} to={`/links?${new URLSearchParams({ tag: t })}`} className="ui-ld-tag">
                  {t}
                </Link>
              ))}
            </span>
          ) : (
            <span className="ui-ld-fact-quiet">None</span>
          )}
        </Fact>
        <Fact label="UTM tags">
          {link.utm ? (link.utmTemplate ? <>Custom template<span className="ui-ld-fact-sub ui-ld-fact-url">{link.utmTemplate}</span></> : "The workspace default") : <span className="ui-ld-fact-quiet">Off</span>}
        </Fact>
        <Fact label="Smart routing">{link.routing ? describeRouting(link.routing) : <span className="ui-ld-fact-quiet">Off: everyone goes to the destination</span>}</Fact>
        <Fact label="Password">{link.protected ? "Protected: visitors enter a password first" : <span className="ui-ld-fact-quiet">None</span>}</Fact>
        {link.maxClicks ? <CapFact link={link} /> : <Fact label="Visit limit"><span className="ui-ld-fact-quiet">No limit</span></Fact>}
        <Fact label="Expires">
          {link.expiresAt ? <span className={expired ? "ui-ld-fact-warn" : undefined}>{expired ? `Expired ${whenFull(link.expiresAt)}` : whenFull(link.expiresAt)}</span> : <span className="ui-ld-fact-quiet">Never</span>}
        </Fact>
        <Fact label="Social preview">{link.preview ? <>Custom: “{link.preview.title}”</> : <span className="ui-ld-fact-quiet">From the destination</span>}</Fact>
        <Fact label="Query parameters">{link.passQuery ? "Passed on to the destination" : <span className="ui-ld-fact-quiet">Not passed on</span>}</Fact>
        {can("stats.view") && can("links.edit") ? (
          <Fact label="Shared statistics">
            {activeShares ? `${activeShares} working ${activeShares === 1 ? "page" : "pages"}` : <span className="ui-ld-fact-quiet">Not shared</span>}
            {onShare ? (
              <>
                {" "}
                <TextButton onClick={onShare}>{activeShares ? "Manage" : "Share"}</TextButton>
              </>
            ) : null}
          </Fact>
        ) : null}
        {can("revenue.view") ? <YearRevenueFact link={link} /> : null}
        {link.broken ? (
          <Fact label="No longer working">
            {link.replacement ? (
              <>
                Visitors are pointed to <Link to={linkPath(link.replacement)} className="ui-ld-fact-link">{label(link.replacement)}</Link>
              </>
            ) : (
              "Visitors are sent to the site set in Settings"
            )}
          </Fact>
        ) : null}
        <Fact label="Created">
          {date(link.createdAt)}
          {link.source === "import" ? <span className="ui-ld-fact-sub">{link.importFrom && link.importFrom !== "csv" ? `Imported from ${IMPORT_SOURCE_LABEL[link.importFrom]}` : "Imported"}</span> : null}
        </Fact>
        <Fact label="Last changed">
          <span title={whenFull(link.updatedAt)}>{when(link.updatedAt)}</span>
        </Fact>
        {link.notes ? (
          <Fact label="Notes" wide>
            <p className="ui-ld-fact-notes">{link.notes}</p>
          </Fact>
        ) : null}
      </dl>
    </Section>
  );
}
