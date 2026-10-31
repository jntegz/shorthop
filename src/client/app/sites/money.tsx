// Money on the website dashboard: the path from visit to payment, the
// subscription numbers, how customers bought, what they are worth by first
// source, and the payments list with each buyer's journey.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, RefreshCw, Search } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { SiteDTO, SitePaymentDTO, SiteTotals } from "../../../shared/sites";
import { api, call, downloadFile, keys } from "../../api";
import { countryName, num, whenFull } from "../../lib/format";
import { confidenceMeaning, duration, matchLabel, percent, viewQuery } from "../../lib/sites";
import { savedPageSize, savePageSize, type PageSize } from "../../lib/table";
import { cn } from "../../lib/utils";
import { Badge, Button, Dialog, ErrorState, errorText, Input, Pager, Section, Segmented, Skeleton, type BadgeTone } from "../ui";
import { moneyColumn, moneyShort, RowsSkeleton, SiteDelta, valueLabel, type Dash } from "./common";

// ---- Long tables: the first rows, then "Show all N" (the BreakdownList pattern) ----

const PREVIEW = 5;

function useMore<T>(rows: T[]): { shown: T[]; more: ReactNode } {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, PREVIEW);
  const more =
    rows.length > PREVIEW ? (
      <button type="button" className="ui-more" onClick={() => setAll((v) => !v)} aria-expanded={all}>
        {all ? "Show fewer" : `Show all ${num(rows.length)}`}
      </button>
    ) : null;
  return { shown, more };
}

// ---- Path to money ----

interface Step {
  key: string;
  label: string;
  hint: string;
  value: number;
  previous?: number;
}

/**
 * The period as a journey: everyone who came, who did something, who reached
 * a checkout, who paid. Each step as a share of visitors, plus how many made
 * it from the step before.
 */
export function PathToMoney({ t, p, revenue }: { t: SiteTotals; p: SiteTotals | null; revenue: boolean }) {
  const steps: Step[] = [
    { key: "visitors", label: "Came", hint: "Unique visitors in this period.", value: t.visitors, previous: p?.visitors },
    { key: "goal", label: "Took an action", hint: "Completed at least one goal: a click, a scroll or a shorthop('goal') call.", value: t.goalVisitors, previous: p?.goalVisitors },
  ];
  if (t.checkoutVisitors > 0 || !revenue || t.customers === 0) {
    steps.push({ key: "checkout", label: "Reached checkout", hint: "Clicked a hosted checkout link (Stripe, Lemon Squeezy, Paddle…). Checkouts your server creates aren’t counted here.", value: t.checkoutVisitors, previous: p?.checkoutVisitors });
  }
  if (revenue) steps.push({ key: "paid", label: "Paid", hint: "New customers credited to a visit in this period (renewals aren’t counted).", value: t.customers, previous: p?.customers });
  const base = Math.max(1, t.visitors);
  return (
    <ol className="ui-site-path" style={{ "--n": steps.length } as React.CSSProperties} aria-label={`Path to ${revenue ? "money" : "action"}`}>
      {steps.map((s, i) => {
        const from = i > 0 ? steps[i - 1]!.value : 0;
        const share = Math.min(1, s.value / base);
        return (
          <li key={s.key} className="ui-site-step" title={s.hint}>
            <span className="ui-site-step-label">
              {s.label}
              {i > 0 ? (
                <span className="ui-site-step-from" title="Share of the step before">
                  <span aria-hidden>→ </span>
                  <span className="ui-sr">, from the step before: </span>
                  {from ? percent(Math.min(1, s.value / from)) : "–"}
                </span>
              ) : null}
            </span>
            <span className="ui-site-step-value">{num(s.value)}</span>
            <span className="ui-site-step-bar" aria-hidden>
              <span style={{ width: `${Math.max(s.value ? 1.5 : 0, share * 100)}%` }} />
            </span>
            <span className="ui-site-step-foot">
              <span>{i === 0 ? "Everyone" : `${percent(share)} of visitors`}</span>
              <SiteDelta current={s.value} previous={s.previous} />
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// ---- Subscriptions ----

export function Subscriptions({ d }: { d: Dash }) {
  const site = d.o!.site;
  const data = useQuery({ queryKey: keys.siteData(d.id, "subscriptions", d.query), queryFn: () => call(api.sites[":id"].subscriptions.$get({ param: { id: d.id }, query: d.query })) });
  const s = data.data;
  if (data.isPending) return <div className="ui-site-facts"><Skeleton className="ui-skel-text" style={{ width: 320 }} /></div>;
  if (data.isError && !s) return <ErrorState compact what="Subscriptions" error={data.error} onRetry={() => void data.refetch()} retrying={data.isFetching} />;
  if (!s || (!s.active && !s.started && !s.canceled && !s.renewalRevenue)) return null;
  const facts = [
    { label: "MRR now", value: moneyShort(s.mrr, site.currency, false), note: `${num(s.active)} active` },
    { label: "New subscriptions", value: num(s.started), note: "this period" },
    { label: "Churn", value: percent(s.churnRate), note: `${num(s.canceled)} canceled` },
    { label: "New / renewal revenue", value: `${moneyShort(s.newRevenue, site.currency)} / ${moneyShort(s.renewalRevenue, site.currency)}`, note: "first payments / renewals" },
  ];
  return (
    <dl className="ui-site-facts" aria-label="Subscriptions">
      {facts.map((f) => (
        <div key={f.label}>
          <dt>{f.label}</dt>
          <dd>
            <span className="ui-site-fact-value">{f.value}</span>
            <span className="ui-site-fact-note">{f.note}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ---- How customers bought ----

export function PurchasePath({ d }: { d: Dash }) {
  const site = d.o!.site;
  const data = useQuery({ queryKey: keys.siteData(d.id, "purchase-paths", d.query), queryFn: () => call(api.sites[":id"]["purchase-paths"].$get({ param: { id: d.id }, query: d.query })) });
  const x = data.data;
  const pairs = useMore(x?.pairs ?? []);
  const pages = useMore(x?.pages ?? []);
  if (x && !x.customers) return null;
  const hours = x?.medianHoursToBuy ?? null;
  const pairMoney = moneyColumn((x?.pairs ?? []).map((p) => p.revenue), site.currency);
  return (
    <Section
      title="How customers bought"
      sub="New customers in this period: how long they took, and where they first came from against the visit credited with the sale."
      foldOnPhone={x ? `${num(x.customers)} new ${x.customers === 1 ? "customer" : "customers"}${hours === null ? "" : `, median ${hours < 1 ? `${Math.max(1, Math.round(hours * 60))}m` : hours < 48 ? `${Math.round(hours)}h` : `${Math.round(hours / 24)} days`} to buy`}.` : "Time to buy and first sources."}
    >
      {data.isPending ? (
        <RowsSkeleton rows={4} />
      ) : data.isError ? (
        <ErrorState compact what="This report" error={data.error} onRetry={() => void data.refetch()} retrying={data.isFetching} />
      ) : x ? (
        <>
          <dl className="ui-site-facts">
            <div>
              <dt>Time to buy</dt>
              <dd>
                <span className="ui-site-fact-value">{hours === null ? "–" : hours < 1 ? `${Math.max(1, Math.round(hours * 60))}m` : hours < 48 ? `${Math.round(hours)}h` : `${Math.round(hours / 24)} days`}</span>
                <span className="ui-site-fact-note">median, from the first visit</span>
              </dd>
            </div>
            <div>
              <dt>Visits before buying</dt>
              <dd>
                <span className="ui-site-fact-value">{x.medianVisits === null ? "–" : String(Math.round(x.medianVisits * 10) / 10)}</span>
                <span className="ui-site-fact-note">median, incl. the one that bought</span>
              </dd>
            </div>
            <div>
              <dt>Bought on the first visit</dt>
              <dd>
                <span className="ui-site-fact-value">{percent(x.firstVisitShare)}</span>
                <span className="ui-site-fact-note">of {num(x.customers)} new {x.customers === 1 ? "customer" : "customers"}</span>
              </dd>
            </div>
          </dl>
          <div className="ui-site-two">
            <div className="ui-table-scroll">
              <table className="ui-table is-dense is-stack">
                <caption className="ui-site-caption">First found by, and credited to</caption>
                <thead>
                  <tr>
                    <th scope="col">Found by</th>
                    <th scope="col">Credited to</th>
                    <th scope="col" className="is-num">Customers</th>
                    <th scope="col" className="is-num">Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {pairs.shown.map((p) => (
                    <tr key={`${p.found}|${p.credited}`}>
                      <td>{valueLabel("source", p.found)}</td>
                      <td className={cn(p.found === p.credited && "ui-site-quiet")} data-label="Credited to">{p.found === p.credited ? "Same" : valueLabel("source", p.credited)}</td>
                      <td className="is-num" data-label="Customers">{num(p.customers)}</td>
                      <td className="is-num" data-lead="">{pairMoney(p.revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {pairs.more}
            </div>
            <div className="ui-table-scroll">
              <table className="ui-table is-dense">
                <caption className="ui-site-caption">Landing pages before buying</caption>
                <thead>
                  <tr>
                    <th scope="col">Page</th>
                    <th scope="col" className="is-num">Customers</th>
                  </tr>
                </thead>
                <tbody>
                  {pages.shown.map((p) => (
                    <tr key={p.path}>
                      <td className="ui-site-path-cell"><span className="ui-site-trunc" title={p.path}>{p.path}</span></td>
                      <td className="is-num is-2">{num(p.customers)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {pages.more}
            </div>
          </div>
          <CookielessNote site={site} />
        </>
      ) : null}
    </Section>
  );
}

function CookielessNote({ site }: { site: SiteDTO }) {
  if (site.idMode !== "cookieless") return null;
  return <p className="ui-site-note">This site is cookieless, so a visitor can only be followed within one day. For journeys over several days, change Visitor identification in Settings.</p>;
}

export function CustomerValue({ d }: { d: Dash }) {
  const site = d.o!.site;
  const data = useQuery({ queryKey: keys.siteData(d.id, "customer-value", d.query), queryFn: () => call(api.sites[":id"]["customer-value"].$get({ param: { id: d.id }, query: d.query })) });
  const x = data.data;
  const rows = useMore(x?.rows ?? []);
  if (x && !x.customers) return null;
  const life = moneyColumn((x?.rows ?? []).map((r) => r.lifetimeRevenue), site.currency);
  const each = moneyColumn((x?.rows ?? []).map((r) => r.avgValue), site.currency);
  return (
    <Section
      title="Customer value by first source"
      sub="Customers whose first payment is in this period, with everything they’ve paid since (less refunds), by where their first visit came from."
      foldOnPhone={x ? `${num(x.customers)} ${x.customers === 1 ? "customer" : "customers"}, ${moneyShort(x.lifetimeRevenue, site.currency)} paid since.` : "Lifetime value by first source."}
    >
      {data.isPending ? (
        <RowsSkeleton rows={4} />
      ) : data.isError ? (
        <ErrorState compact what="This report" error={data.error} onRetry={() => void data.refetch()} retrying={data.isFetching} />
      ) : x ? (
        <div className="ui-table-scroll">
          <table className="ui-table is-dense is-stack">
            <thead>
              <tr>
                <th scope="col">First source</th>
                <th scope="col" className="is-num">Customers</th>
                <th scope="col" className="is-num">Lifetime revenue</th>
                <th scope="col" className="is-num">Per customer</th>
                <th scope="col" className="is-num" title="Customers who paid more than once">Paid again</th>
              </tr>
            </thead>
            <tbody>
              {rows.shown.map((r) => (
                <tr key={`${r.channel}|${r.source}`}>
                  <td>
                    {r.source ? valueLabel("source", r.source) : "Not matched to a visit"}
                    {r.channel ? <span className="ui-table-sub">{r.channel}</span> : null}
                  </td>
                  <td className="is-num" data-label="Customers">{num(r.customers)}</td>
                  <td className="is-num" data-lead="">{life(r.lifetimeRevenue)}</td>
                  <td className="is-num" data-label="Per customer">{each(r.avgValue)}</td>
                  <td className="is-num" data-label="Paid again">{percent(r.repeatShare)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.more}
        </div>
      ) : null}
    </Section>
  );
}

// ---- Payments ----

const CONFIDENCE_TONE: Record<string, BadgeTone> = { high: "good", medium: "neutral", low: "warn" };

/** Why a payment wasn't matched, in words: stored codes ("no_reference") never reach the page. */
const REASONS: Record<string, string> = {
  no_reference: "No checkout reference",
  no_email: "No email to match on",
  unknown_reference: "Unknown visit reference",
  ambiguous: "Several visits could match",
};
export function reasonText(reason: string | null): string {
  if (!reason) return "Not matched";
  if (!/^[a-z0-9]+(_[a-z0-9]+)+$/.test(reason)) return reason;
  const words = reason.replaceAll("_", " ");
  return REASONS[reason] ?? words[0]!.toUpperCase() + words.slice(1);
}

function CsvButton({ href }: { href: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={Download}
      loading={busy}
      title="Every payment of the period as CSV"
      onClick={() => {
        setBusy(true);
        downloadFile(href)
          .catch((e: unknown) => toast.error(errorText(e) ?? "The download failed."))
          .finally(() => setBusy(false));
      }}
    >
      CSV
    </Button>
  );
}

const PAYMENTS_PREVIEW = 5;

export function Payments({ d }: { d: Dash }) {
  const qc = useQueryClient();
  const site = d.o!.site;
  const [status, setStatus] = useState<"all" | "matched" | "unmatched">("all");
  const [visitor, setVisitor] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [size, setSize] = useState<PageSize>(() => savedPageSize("payments"));
  /** The newest few inline; the full table and its pager only when asked for (as BreakdownList's "Show all N"). */
  const [all, setAll] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const filterKey = JSON.stringify([d.query, status, q, size]);
  useEffect(() => setPage(1), [filterKey]);
  const base = { ...viewQuery(d.view), status, ...(q ? { q } : {}) };
  const query = { ...base, limit: String(size), offset: String((page - 1) * size) };
  const data = useQuery({
    queryKey: keys.siteData(d.id, "payments", query),
    queryFn: () => call(api.sites[":id"].payments.$get({ param: { id: d.id }, query })),
    placeholderData: (prev) => prev,
  });
  const rematch = useMutation({
    mutationFn: () => call(api.sites[":id"].rematch.$post({ param: { id: d.id } })),
    onSuccess: (r) => {
      toast.success(r.matched ? `Matched ${r.matched} of ${r.tried} payments` : `None of ${r.tried} payments could be matched yet`);
      void qc.invalidateQueries({ queryKey: keys.site(d.id) });
    },
    onError: (e) => toast.error(errorText(e) ?? "Matching failed"),
  });
  const list = data.data?.payments ?? [];
  const total = data.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / size));
  const collapsed = !all && total > PAYMENTS_PREVIEW;
  const rows = collapsed ? list.slice(0, PAYMENTS_PREVIEW) : list;
  return (
    <Section
      title="Payments"
      sub="Each payment, the visit it was matched to, and the visit the attribution model credits. Open a credited visit to see the buyer’s journey."
      aside={
        <>
          {d.manage ? <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => rematch.mutate()} loading={rematch.isPending}>Match again</Button> : null}
          <CsvButton href={`/_admin/api/sites/${d.id}/payments.csv?${new URLSearchParams(base).toString()}`} />
        </>
      }
    >
      <div className="ui-site-filterbar">
        <Segmented
          label="Payments shown"
          size="sm"
          value={status}
          onChange={setStatus}
          options={[
            { value: "all", label: "All" },
            { value: "matched", label: "Matched" },
            { value: "unmatched", label: "Not matched", short: "Unmatched" },
          ]}
        />
        <div className="ui-site-search">
          <Search aria-hidden />
          <Input label="Search payments" hideLabel type="search" name="q" placeholder="Email, customer or payment id…" value={search} onChange={(e) => setSearch(e.target.value)} autoComplete="off" spellCheck={false} />
        </div>
        {data.data ? (
          <p className="ui-site-count" aria-live="polite">
            {num(total)} {total === 1 ? "payment" : "payments"}
            {q ? " found" : ""}, net {moneyShort(data.data.net, site.currency, false)}
          </p>
        ) : null}
      </div>
      {data.isPending ? (
        <RowsSkeleton rows={5} />
      ) : data.isError && !data.data ? (
        <ErrorState compact what="Payments" error={data.error} onRetry={() => void data.refetch()} retrying={data.isFetching} />
      ) : !list.length ? (
        <div className="ui-state is-compact">
          <p className="ui-state-title">{q ? "No payment matches that search." : "No payments in this period."}</p>
          <p className="ui-state-body">{q ? "Try part of the email or the provider’s payment id." : "Connect a payment provider in the site’s settings."}</p>
        </div>
      ) : (
        <div className={cn("ui-site-payments", data.isPlaceholderData && "is-stale")} aria-busy={data.isPlaceholderData || undefined}>
          <div className="ui-table-scroll">
            <table className="ui-table is-stack">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col" className="is-num">Amount</th>
                  <th scope="col">Customer</th>
                  <th scope="col">Credited to</th>
                  <th scope="col">Matched by</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <PaymentRow key={p.id} p={p} site={site} onVisitor={setVisitor} fmt={moneyColumn([], p.currency)} />
                ))}
              </tbody>
            </table>
          </div>
          {collapsed ? (
            <button type="button" className="ui-more" onClick={() => setAll(true)}>
              Show all {num(total)} payments
            </button>
          ) : all ? (
            <Pager
              page={page}
              pages={pages}
              size={size}
              total={total}
              onPage={setPage}
              onSize={(s) => {
                setSize(s);
                savePageSize("payments", s);
              }}
            />
          ) : null}
        </div>
      )}
      <VisitorDialog d={d} visitorId={visitor} onClose={() => setVisitor(null)} />
    </Section>
  );
}

function PaymentRow({ p, site, onVisitor, fmt }: { p: SitePaymentDTO; site: SiteDTO; onVisitor: (id: string) => void; fmt: (v: number) => string }) {
  const c = p.credited;
  const kind = p.kind === "charge" ? (p.billing === "sub_renewal" ? "Renewal" : p.billing === "sub_new" ? "New subscription" : "One-time") : p.kind === "refund" ? "Refund" : p.kind === "dispute" ? "Dispute" : "Dispute won";
  const creditedName = c ? (c.link ? `Short link ${c.link}` : c.source || c.channel) : null;
  return (
    <tr>
      <td className="ui-site-nowrap">
        {whenFull(p.occurredAt)}
        <span className="ui-table-sub">
          {p.provider} · {kind}
          {p.testMode ? " · test" : ""}
        </span>
      </td>
      <td className={cn("is-num", p.amountMinor < 0 && "ui-site-neg")} data-lead="">
        {fmt(p.amountMinor)}
        {p.currency !== site.currency && p.amountSiteMinor !== null ? <span className="ui-table-sub">{moneyShort(p.amountSiteMinor, site.currency, false)}</span> : null}
        {p.amountSiteMinor === null ? <span className="ui-table-sub ui-site-warn">Rate pending</span> : null}
      </td>
      <td className="ui-site-cust">
        <span className="ui-site-trunc" title={p.email ?? p.customerId ?? undefined}>{p.email ?? p.customerId ?? "–"}</span>
      </td>
      <td className="ui-site-credit" data-label={c ? "Credited to" : undefined}>
        {c ? (
          p.visitorId ? (
            <button type="button" className="ui-site-journey" onClick={() => onVisitor(p.visitorId!)} title="Show the buyer’s journey">
              <span className="ui-site-trunc">{creditedName}</span>
              <span className="ui-table-sub">{[c.channel, c.campaign, c.entry, c.country && countryName(c.country)].filter(Boolean).join(" · ")}</span>
            </button>
          ) : (
            <>
              <span className="ui-site-trunc">{creditedName}</span>
              <span className="ui-table-sub">{[c.channel, c.campaign, c.entry].filter(Boolean).join(" · ")}</span>
            </>
          )
        ) : (
          <span className="ui-site-quiet">–</span>
        )}
      </td>
      <td>
        {p.matchedBy ? (
          <span title={confidenceMeaning(p.confidence)}>
            <Badge tone={CONFIDENCE_TONE[p.confidence ?? "low"] ?? "neutral"}>
              {matchLabel(p.matchedBy)}, {p.confidence ?? "low"}
            </Badge>
          </span>
        ) : p.kind === "charge" ? (
          <span className="ui-site-warn ui-site-small" title={p.unmatchedReason ?? undefined}>{reasonText(p.unmatchedReason)}</span>
        ) : (
          <span className="ui-site-quiet ui-site-small">Follows its charge</span>
        )}
      </td>
    </tr>
  );
}

function VisitorDialog({ d, visitorId, onClose }: { d: Dash; visitorId: string | null; onClose: () => void }) {
  const site = d.o!.site;
  const profile = useQuery({
    queryKey: keys.siteData(d.id, "visitor", { visitorId }),
    queryFn: () => call(api.sites[":id"].visitors[":visitor"].$get({ param: { id: d.id, visitor: visitorId! } })),
    enabled: Boolean(visitorId),
  });
  const v = profile.data;
  const events = v
    ? [...v.payments.map((p) => ({ t: p.occurredAt, kind: "payment" as const, p })), ...v.sessions.map((s) => ({ t: s.startedAt, kind: "visit" as const, s }))].sort((a, b) => b.t - a.t)
    : [];
  return (
    <Dialog open={Boolean(visitorId)} onOpenChange={(o) => !o && onClose()} title={v?.email ?? v?.name ?? "Buyer’s journey"} description="Every visit and payment of this visitor, newest first." size="lg">
      {profile.isError ? (
        <ErrorState compact what="This journey" error={profile.error} onRetry={() => void profile.refetch()} />
      ) : !v ? (
        <RowsSkeleton rows={4} />
      ) : (
        <ol className="ui-site-journeylist">
          {events.map((e) =>
            e.kind === "payment" ? (
              <li key={`p${e.p.id}`} className="is-payment">
                <span className="ui-site-j-what">
                  <strong>{moneyShort(e.p.amountMinor, e.p.currency, false)}</strong> paid via {e.p.provider}
                </span>
                <span className="ui-site-j-when">{whenFull(e.t)}</span>
              </li>
            ) : (
              <li key={`s${e.s.id}`}>
                <span className="ui-site-j-what">
                  <strong>{e.s.link ? `Short link ${e.s.link}` : e.s.source || "Direct"}</strong>
                  <span className="ui-site-quiet"> · {e.s.channel}{e.s.campaign ? ` · ${e.s.campaign}` : ""}</span>
                </span>
                <span className="ui-site-j-when">{whenFull(e.t)}</span>
                <span className="ui-site-j-detail">
                  {e.s.entry}
                  {e.s.exit !== e.s.entry ? ` → ${e.s.exit}` : ""} · {num(e.s.pageviews)} {e.s.pageviews === 1 ? "page" : "pages"} · {duration(e.s.engagedSec)} · {e.s.city || countryName(e.s.country)} · {e.s.device}, {e.s.browser}
                </span>
              </li>
            ),
          )}
        </ol>
      )}
      <p className="ui-site-note">Visits of {site.idMode === "cookieless" ? "cookieless sites can only be linked within one day" : "this visitor on this browser"}.</p>
    </Dialog>
  );
}
