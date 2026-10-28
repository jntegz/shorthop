import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownRight, ArrowRight, ArrowUpRight, BookOpen, Check, CircleDashed, Globe, Pause, Plus, Settings2 } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import { change } from "../../shared/change";
import { PROVIDER_INFO, PROVIDERS, type SiteDTO, type SiteListItem } from "../../shared/sites";
import { api, ApiError, call, keys } from "../api";
import { Button, buttonClass, Card, Combobox, Dialog, Field, Input, Notice, PageHeader, Select, Spinner } from "../components/ui";
import { ago, num } from "../lib/format";
import { useCan } from "../lib/me";
import { browserTimeZone, currencyOptions, money, percent, timeZones } from "../lib/sites";
import { cn } from "../lib/utils";

/** The owner's own websites: traffic and the revenue it brings. */
export function Sites() {
  const can = useCan();
  const [adding, setAdding] = useState(false);
  const sites = useQuery({ queryKey: keys.sites, queryFn: () => call(api.sites.$get()), refetchInterval: 60_000 });
  const list = sites.data?.sites ?? [];

  return (
    <>
      <PageHeader
        title="Websites"
        description="Traffic and revenue of your own sites: which channels, campaigns and short links bring paying customers."
        actions={can("sites.manage") && list.length ? <Button onClick={() => setAdding(true)}><Plus /> Add website</Button> : null}
      />
      {sites.isPending ? (
        <div className="flex justify-center py-24"><Spinner /></div>
      ) : sites.isError ? (
        <Notice tone="danger">
          Your websites couldn’t load: {sites.error.message}{" "}
          <button className="ml-1 font-medium underline underline-offset-2" onClick={() => void sites.refetch()} disabled={sites.isFetching}>{sites.isFetching ? "Retrying…" : "Try again"}</button>
        </Notice>
      ) : !list.length ? (
        <FirstSite manage={can("sites.manage")} onAdd={() => setAdding(true)} />
      ) : (
        <div className="space-y-4">
          {[...list].sort(bySiteActivity).map((s) => (
            <SiteCard key={s.id} site={s} money={can("revenue.view")} manage={can("sites.manage")} />
          ))}
        </div>
      )}
      {can("sites.manage") ? <AddSite open={adding} onOpenChange={setAdding} /> : null}
    </>
  );
}

const dayFormat = new Intl.DateTimeFormat("en", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const dayLabel = (day: string) => dayFormat.format(new Date(`${day}T12:00:00Z`));

/** A change against the previous period, coloured by whether it's good news. */
function Delta({ current, previous, period }: { current: number; previous: number; period: string }) {
  const c = change(current, previous);
  if (!c) return null;
  const Icon = c.dir === "down" ? ArrowDownRight : ArrowUpRight;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-medium tabular",
        c.dir === "flat" ? "bg-surface-2 text-muted" : c.dir === "up" ? "bg-good-soft text-good" : "bg-danger-soft text-danger",
      )}
      title={`${c.title} ${period}`}
    >
      {c.dir === "flat" ? null : <Icon className="size-3" aria-hidden />}
      {c.text}
    </span>
  );
}

/** Is the site sending data, and how recently. */
function SiteStatus({ site }: { site: SiteListItem }) {
  if (!site.tracking) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted" title="Visits aren't recorded while tracking is paused">
        <Pause className="size-3.5" aria-hidden /> Tracking paused
      </span>
    );
  }
  if (site.online) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-good" title="Visitors in the last 5 minutes">
        <span className="relative flex size-2" aria-hidden>
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-good opacity-50 motion-reduce:animate-none" />
          <span className="relative inline-flex size-2 rounded-full bg-good" />
        </span>
        {num(site.online)} online now
      </span>
    );
  }
  if (site.lastSeenAt === null) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-warn">
        <CircleDashed className="size-3.5" aria-hidden /> Waiting for the first visit
      </span>
    );
  }
  const quiet = Date.now() / 1000 - site.lastSeenAt > 2 * 86400;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs", quiet ? "text-warn" : "text-muted")} title={quiet ? "Nothing for over two days: is the script still on the site?" : undefined}>
      <span className={cn("size-2 rounded-full", quiet ? "bg-warn" : "bg-subtle")} aria-hidden /> Last visit {ago(site.lastSeenAt)}
    </span>
  );
}

/** Two weeks of visits per day in the site's time zone; today is the last, lighter bar (still filling). */
function DailyVisits({ days }: { days: SiteListItem["visitsDaily"] }) {
  const max = Math.max(...days.map((d) => d.visits));
  const total = days.reduce((a, d) => a + d.visits, 0);
  return (
    <figure className="min-w-0">
      <figcaption className="flex items-baseline justify-between gap-2 text-xs text-muted">
        <span>Visits per day, 14 days</span>
        <span className="tabular">{max ? `peak ${num(max)}` : ""}</span>
      </figcaption>
      {total ? (
        <ol className="mt-2 flex h-16 items-end gap-[3px]" aria-label={`${num(total)} visits in 14 days`}>
          {days.map((d, i) => {
            const today = i === days.length - 1;
            return (
              <li
                key={d.day}
                className="group/bar relative flex h-full flex-1 items-end"
                title={`${dayLabel(d.day)}${today ? " (today, so far)" : ""}: ${num(d.visits)} ${d.visits === 1 ? "visit" : "visits"}`}
              >
                <span
                  className={cn("block w-full rounded-[3px] transition-colors", d.visits ? (today ? "bg-series-1/45" : "bg-series-1/80 group-hover/bar:bg-series-1") : "bg-line")}
                  style={{ height: d.visits ? `${Math.max(8, (d.visits / max) * 100)}%` : "2px" }}
                />
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="mt-2 flex h-16 items-center justify-center rounded-md border border-dashed border-line text-xs text-subtle">No visits in 14 days</div>
      )}
      <div className="tabular mt-1 flex justify-between text-[11px] text-subtle">
        <span>{dayLabel(days[0]!.day)}</span>
        <span>Today</span>
      </div>
    </figure>
  );
}

/** Busiest first; then sites still waiting for their first visit; paused ones last. */
function bySiteActivity(a: SiteListItem, b: SiteListItem): number {
  const rank = (s: SiteListItem) => (!s.tracking ? 2 : s.lastSeenAt === null ? 1 : 0);
  return rank(a) - rank(b) || b.visitors7d - a.visitors7d || a.name.localeCompare(b.name);
}

function SiteCard({ site: s, money: seesMoney, manage }: { site: SiteListItem; money: boolean; manage: boolean }) {
  const conversion = s.visitors30d ? s.customers30d / s.visitors30d : 0;
  const waiting = s.lastSeenAt === null && s.tracking;
  const sold = s.revenue30d !== 0 || s.revenuePrev30d !== 0 || s.customers30d > 0;
  return (
    <Card className="group/site overflow-hidden">
      {/* The name is the link; its ::after stretches over the panel so the whole area opens the dashboard. */}
      <div className="relative grid grid-cols-[minmax(0,1fr)] gap-x-8 gap-y-5 p-5 transition-colors has-[a:hover]:bg-surface-2/40 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-base font-semibold text-accent uppercase" aria-hidden>
            {(s.name || s.domains[0] || "?").trim().charAt(0)}
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold tracking-tight text-fg">
              <Link
                to={`/sites/${s.id}`}
                className="after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-accent"
              >
                {s.name}
              </Link>
            </h2>
            <p className="truncate text-xs text-muted" title={s.domains.join(", ")}>
              {s.domains[0]}
              {s.domains.length > 1 ? ` +${s.domains.length - 1}` : ""}
            </p>
            <div className="mt-2">
              <SiteStatus site={s} />
            </div>
          </div>
        </div>

        {waiting ? (
          <div className="relative z-10 flex flex-col items-start justify-center gap-3 rounded-lg border border-dashed border-line px-4 py-4 md:col-span-1 xl:col-span-2">
            <p className="max-w-[60ch] text-sm text-muted">
              No visits have arrived from <span className="font-medium text-fg">{s.domains[0]}</span> yet. Add the script to the site; visits show up here within seconds.
            </p>
            {manage ? (
              <Link to={`/sites/${s.id}/guide`} className={buttonClass({ variant: "outline", size: "sm" })}>
                <BookOpen /> Install guide
              </Link>
            ) : null}
          </div>
        ) : (
          <>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
          <div className="min-w-0">
            <dt className="text-xs text-muted">Visitors, 7 days</dt>
            <dd className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="tabular text-xl font-semibold tracking-tight text-fg">{num(s.visitors7d)}</span>
              <Delta current={s.visitors7d} previous={s.visitorsPrev7d} period="against the 7 days before" />
            </dd>
            <dd className="tabular mt-0.5 text-xs text-subtle">{num(s.visitors24h)} in 24 h</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted">Revenue, 30 days</dt>
            {seesMoney && !sold ? (
              <>
                <dd className="mt-1 text-xl font-semibold tracking-tight text-subtle">{money(0, s.currency, true)}</dd>
                <dd className="mt-0.5 text-xs text-subtle">No sales in 60 days</dd>
              </>
            ) : seesMoney ? (
              <>
                <dd className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="tabular text-xl font-semibold tracking-tight text-fg">{money(s.revenue30d, s.currency, true)}</span>
                  <Delta current={s.revenue30d} previous={s.revenuePrev30d} period="against the 30 days before" />
                </dd>
                <dd className="tabular mt-0.5 text-xs text-subtle">
                  {s.customers30d ? `${num(s.customers30d)} ${s.customers30d === 1 ? "customer" : "customers"} · ${percent(Math.min(1, conversion))} of visitors` : "No customers yet"}
                </dd>
              </>
            ) : (
              <dd className="mt-1 text-xl font-semibold text-subtle">
                <span aria-hidden>–</span>
                <span className="sr-only">Not shown: you can’t view revenue</span>
              </dd>
            )}
          </div>
          <div className="col-span-2 min-w-0 sm:col-span-1">
            <dt className="text-xs text-muted">Top source, 7 days</dt>
            {s.topSource ? (
              <>
                <dd className="mt-1 truncate text-sm font-medium text-fg" title={s.topSource.name}>{s.topSource.name}</dd>
                <dd className="mt-1.5 flex items-center gap-2">
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2" aria-hidden>
                    <span className="block h-full rounded-full bg-series-1/70" style={{ width: `${Math.round(s.topSource.share * 100)}%` }} />
                  </span>
                  <span className="tabular text-xs text-muted">{percent(s.topSource.share)} of visits</span>
                </dd>
              </>
            ) : (
              <dd className="mt-1 text-sm text-subtle">No visits yet</dd>
            )}
          </div>
        </dl>

        {/* Above the panel's link, so each day's tooltip shows. */}
        <div className="relative z-10 md:col-span-2 xl:col-span-1">
          <DailyVisits days={s.visitsDaily} />
        </div>
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-3 py-2">
        <Link to={`/sites/${s.id}`} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-accent hover:bg-accent-soft pointer-coarse:min-h-11 pointer-coarse:px-3">
          Open dashboard <ArrowRight className="size-3.5 transition-transform group-hover/site:translate-x-0.5 motion-reduce:transition-none" aria-hidden />
        </Link>
        <div className="flex items-center gap-1">
          {manage ? (
            <Link to={`/sites/${s.id}/settings`} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-fg pointer-coarse:min-h-11 pointer-coarse:px-3">
              <Settings2 className="size-3.5" aria-hidden /> Settings &amp; setup
            </Link>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

const SETUP: { title: string; body: ReactNode }[] = [
  { title: "Add your domain", body: "Subdomains count too, so example.com covers app.example.com." },
  {
    title: "Paste one script tag",
    body: <code className="mt-2 block rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-xs leading-relaxed break-all text-fg">{'<script defer src="…/_t/script.js" data-site="…">'}</code>,
  },
  {
    title: "Connect your payments",
    body: (
      <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Supported payment providers">
        {PROVIDERS.map((p) => <li key={p} className="rounded-full border border-line bg-surface px-2 py-0.5 text-xs text-muted">{PROVIDER_INFO[p].label}</li>)}
      </ul>
    ),
  },
];

/** First run: what a website is here, and the three steps that get it reporting. */
function FirstSite({ manage, onAdd }: { manage: boolean; onAdd: () => void }) {
  return (
    <Card className="grid overflow-hidden lg:grid-cols-2">
      <div className="flex flex-col items-start px-6 py-8 sm:px-8 sm:py-10">
        <div className="flex size-11 items-center justify-center rounded-lg bg-accent-soft text-accent [&_svg]:size-5"><Globe aria-hidden /></div>
        <h2 className="mt-5 text-xl font-semibold tracking-tight text-balance text-fg">See which links bring paying customers</h2>
        <p className="mt-2 max-w-[60ch] text-sm leading-relaxed text-muted">
          Add a site you own and it gets its own analytics: visitors, pages, channels and campaigns. Connect your payment provider and every sale is credited to the visit, channel and short link that brought it.
        </p>
        <ul className="mt-5 space-y-2 text-sm text-fg">
          {["Sets no cookies and counts single-page-app navigation", "Revenue in your currency, converted at the day's ECB rate", "Short links to the site are credited automatically"].map((t) => (
            <li key={t} className="flex items-start gap-2"><Check className="mt-0.5 size-4 shrink-0 text-good" aria-hidden />{t}</li>
          ))}
        </ul>
        {manage ? (
          <Button className="mt-7" onClick={onAdd}><Plus /> Add your first website</Button>
        ) : (
          <p className="mt-7 text-sm text-muted">No websites have been added yet. An owner or admin can add one.</p>
        )}
      </div>
      <div className="border-t border-line bg-surface-2 px-6 py-8 sm:px-8 sm:py-10 lg:border-t-0 lg:border-l">
        <h3 className="text-sm font-semibold text-fg">How it works</h3>
        <ol className="mt-5 space-y-6">
          {SETUP.map((step, i) => (
            <li key={step.title} className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3">
              <span className="tabular flex size-7 items-center justify-center rounded-full border border-line bg-surface text-xs font-semibold text-fg" aria-hidden>{i + 1}</span>
              <div className="min-w-0 pt-1">
                <p className="text-sm font-medium text-fg">{step.title}</p>
                {typeof step.body === "string" ? <p className="mt-1 text-sm leading-relaxed text-muted">{step.body}</p> : step.body}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </Card>
  );
}

function AddSite({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [timezone, setTimezone] = useState(browserTimeZone);
  const [currency, setCurrency] = useState("USD");
  const create = useMutation({
    mutationFn: () => call(api.sites.$post({ json: { name: name.trim() || domain.trim(), domains: [domain], timezone, currency } })),
    onSuccess: (site: SiteDTO) => {
      void qc.invalidateQueries({ queryKey: keys.sites });
      toast.success(`${site.name} added`, { description: "Next: install the script and connect your payments." });
      onOpenChange(false);
      navigate(`/sites/${site.id}/settings`);
    },
  });
  const error = !create.error ? null : create.error instanceof ApiError ? create.error.message : "Couldn’t reach the server. Check your connection and try again.";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Add a website" description="A site you own. Days are counted in its time zone and revenue is shown in its currency.">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Domain" htmlFor="site-domain" hint="Subdomains count too: example.com covers app.example.com.">
          <Input id="site-domain" required placeholder="example.com" value={domain} onChange={(e) => setDomain(e.target.value)} autoFocus />
        </Field>
        <Field label="Name" htmlFor="site-name">
          <Input id="site-name" placeholder={domain || "My product"} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Time zone" htmlFor="site-tz">
            <Select id="site-tz" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {timeZones().map((tz) => <option key={tz} value={tz}>{tz}</option>)}
            </Select>
          </Field>
          <Field label="Currency" htmlFor="site-currency" hint="Payments in other currencies are converted at the day's ECB rate.">
            <Combobox id="site-currency" value={currency} onChange={(v) => v && setCurrency(v)} options={currencyOptions()} placeholder="Type a code or name…" />
          </Field>
        </div>
        {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" loading={create.isPending}>Add website</Button>
        </div>
      </form>
    </Dialog>
  );
}
