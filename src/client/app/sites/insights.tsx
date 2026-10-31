// Behaviour on the website dashboard: funnels, peak hours, reading, page
// speed and the latest visits.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { FUNNEL_WINDOWS, VITALS_THRESHOLDS, type FunnelStep, type PeakMetric, type SiteDTO } from "../../../shared/sites";
import { api, call, keys } from "../../api";
import { ago, countryName, num } from "../../lib/format";
import { duration, percent } from "../../lib/sites";
import { cn } from "../../lib/utils";
import { Button, Dialog, ErrorState, errorText, IconButton, Input, Section, Segmented, Select } from "../ui";
import { moneyShort, NeedsAE, RowsSkeleton, type Dash } from "./common";

// ---- Funnels ----

const WINDOW_LABELS: Record<number, string> = { 1: "1 hour", 24: "1 day", 72: "3 days", 168: "7 days", 720: "30 days" };

/**
 * Funnels. Without live data (`live` false) the reports can't run, so the
 * section is one line under its title, and its tools (pick, delete, New
 * funnel) stay exactly where they are: funnels can be set up before
 * Analytics Engine is connected.
 */
export function Funnels({ d, live = true }: { d: Dash; live?: boolean }) {
  const site = d.o!.site;
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const list = useQuery({ queryKey: keys.siteData(site.id, "funnels", {}), queryFn: () => call(api.sites[":id"].funnels.$get({ param: { id: site.id } })) });
  const funnels = list.data?.funnels ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (!funnels.some((f) => f.id === selected)) setSelected(funnels[0]?.id ?? null);
  }, [funnels, selected]);
  const report = useQuery({
    queryKey: keys.siteData(site.id, "funnel-report", { selected, ...d.query }),
    queryFn: () => call(api.sites[":id"].funnels[":funnel"].report.$get({ param: { id: site.id, funnel: selected! }, query: d.query })),
    enabled: Boolean(selected),
  });
  const remove = useMutation({
    mutationFn: (funnel: string) => call(api.sites[":id"].funnels[":funnel"].$delete({ param: { id: site.id, funnel } })),
    onSuccess: () => {
      setDeleting(false);
      toast.success("Funnel deleted");
      void qc.invalidateQueries({ queryKey: keys.siteData(site.id, "funnels", {}) });
    },
    onError: (e) => toast.error(errorText(e) ?? "Couldn’t delete the funnel"),
  });
  const r = report.data;
  const first = r?.steps[0]?.visitors ?? 0;
  const name = funnels.find((f) => f.id === selected)?.name ?? "";
  return (
    <Section
      title="Funnels"
      className={live ? undefined : "ui-site-funnels is-compact"}
      sub={
        live
          ? "How many visitors reach each step, in order, within the funnel’s time window (the last 90 days at most)."
          : list.isPending
            ? "Reports need live data from Cloudflare Analytics Engine."
            : `${funnels.length ? `${num(funnels.length)} saved ${funnels.length === 1 ? "funnel" : "funnels"}` : "No funnels yet"} · reports need live data from Cloudflare Analytics Engine.`
      }
      aside={
        <>
          {funnels.length > 1 ? (
            <Select label="Funnel" hideLabel className="ui-site-funnel-pick" value={selected ?? ""} onChange={(e) => setSelected(e.target.value)} options={funnels.map((f) => ({ value: f.id, label: f.name }))} />
          ) : null}
          {d.manage && selected ? <IconButton label={`Delete the funnel ${name}`} icon={Trash2} size="sm" onClick={() => setDeleting(true)} /> : null}
          {d.manage ? <Button size="sm" icon={Plus} onClick={() => setCreating(true)}>New funnel</Button> : null}
        </>
      }
    >
      {!live ? (
        list.isError ? <ErrorState compact what="Funnels" error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} /> : null
      ) : list.isPending ? (
        <RowsSkeleton rows={3} />
      ) : list.isError ? (
        <ErrorState compact what="Funnels" error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
      ) : !funnels.length ? (
        <div className="ui-state is-compact">
          <p className="ui-state-title">No funnels yet.</p>
          <p className="ui-state-body">For example: landing page → /pricing → goal “signup”. With revenue, it also shows how many who finished went on to pay.</p>
        </div>
      ) : report.isPending ? (
        <RowsSkeleton rows={3} />
      ) : report.isError ? (
        <ErrorState compact what={`The funnel “${name}”`} error={report.error} onRetry={() => void report.refetch()} retrying={report.isFetching} />
      ) : r && !r.available ? (
        <NeedsAE what="Funnels" />
      ) : r ? (
        <>
          {funnels.length === 1 ? <p className="ui-site-note"><strong>{name}</strong>, steps within {WINDOW_LABELS[r.funnel.windowHours] ?? `${r.funnel.windowHours} hours`}</p> : null}
          <ol className="ui-rows ui-site-funnel">
            {r.steps.map((s, i) => {
              const prev = i ? r.steps[i - 1]!.visitors : s.visitors;
              return (
                <li key={i} className="ui-row">
                  <div className="ui-row-inner">
                    <span className="ui-row-bar" style={{ "--w": `${first ? (s.visitors / first) * 100 : 0}%` } as React.CSSProperties} aria-hidden />
                    <span className="ui-row-label">
                      <span className="ui-site-step-n" aria-hidden>{i + 1}</span>
                      <span className="ui-row-name is-path" title={s.step.value}>{s.step.type === "goal" ? `Goal: ${s.step.value}` : s.step.value}</span>
                    </span>
                    <span className="ui-row-share">
                      {i ? (prev ? `−${percent(1 - s.visitors / prev)}` : "") : ""}
                      {i && s.medianSecFromPrevious !== null ? <span className="ui-site-quiet">, {duration(s.medianSecFromPrevious)}</span> : null}
                    </span>
                    <span className="ui-row-share">{first ? percent(s.visitors / first) : "–"}</span>
                    <span className="ui-row-value">{num(s.visitors)}<span className="ui-sr"> visitors</span></span>
                  </div>
                </li>
              );
            })}
          </ol>
          {d.revenue ? (
            <p className="ui-site-note">
              {num(r.paid.visitors)} of {num(r.steps[r.steps.length - 1]?.visitors ?? 0)} who finished paid afterwards
              {r.paid.revenue ? `, ${moneyShort(r.paid.revenue, site.currency, false)} in total` : ""}.
            </p>
          ) : null}
          {r.truncated ? <p className="ui-site-note ui-site-warn">Analytics Engine returned its row limit; choose a shorter period for exact counts.</p> : null}
        </>
      ) : null}
      <Dialog
        open={deleting}
        onOpenChange={setDeleting}
        size="sm"
        title={`Delete the funnel “${name}”?`}
        description="Its steps are removed. The visits and goals it counted stay in your statistics."
        footer={
          <>
            <Button onClick={() => setDeleting(false)}>Cancel</Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => selected && remove.mutate(selected)}>Delete funnel</Button>
          </>
        }
      />
      {d.manage ? <NewFunnel site={site} open={creating} onOpenChange={setCreating} onCreated={setSelected} /> : null}
    </Section>
  );
}

function NewFunnel({ site, open, onOpenChange, onCreated }: { site: SiteDTO; open: boolean; onOpenChange: (v: boolean) => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [windowHours, setWindowHours] = useState(24);
  const [steps, setSteps] = useState<FunnelStep[]>([
    { type: "page", value: "/" },
    { type: "page", value: "/pricing" },
  ]);
  const create = useMutation({
    mutationFn: () => call(api.sites[":id"].funnels.$post({ param: { id: site.id }, json: { name, steps, windowHours } })),
    onSuccess: (f) => {
      void qc.invalidateQueries({ queryKey: keys.siteData(site.id, "funnels", {}) });
      toast.success("Funnel saved");
      onCreated(f.id);
      onOpenChange(false);
    },
  });
  const setStep = (i: number, s: Partial<FunnelStep>) => setSteps((l) => l.map((x, j) => (j === i ? { ...x, ...s } : x)));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="New funnel"
      description="Pages take a path, with * for one segment and ** for anything (/blog/**). Goals take the goal’s name."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="ui-new-funnel" loading={create.isPending}>Save funnel</Button>
        </>
      }
    >
      <form id="ui-new-funnel" onSubmit={submit} className="ui-site-form">
        <div className="ui-site-form-row">
          <Input label="Name" name="name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Signup…" autoComplete="off" />
          <Select label="Steps must happen within" value={String(windowHours)} onChange={(e) => setWindowHours(Number(e.target.value))} options={FUNNEL_WINDOWS.map((h) => ({ value: String(h), label: WINDOW_LABELS[h] ?? `${h} hours` }))} />
        </div>
        <ol className="ui-site-steps">
          {steps.map((s, i) => (
            <li key={i}>
              <span className="ui-site-step-n" aria-hidden>{i + 1}</span>
              <Select label={`Step ${i + 1} type`} hideLabel value={s.type} onChange={(e) => setStep(i, { type: e.target.value as FunnelStep["type"] })} options={[{ value: "page", label: "Page" }, { value: "goal", label: "Goal" }]} />
              <Input label={`Step ${i + 1}`} hideLabel value={s.value} onChange={(e) => setStep(i, { value: e.target.value })} placeholder={s.type === "page" ? "/pricing" : "signup"} autoComplete="off" spellCheck={false} />
              <IconButton label={`Remove step ${i + 1}`} icon={X} size="sm" disabled={steps.length <= 2} onClick={() => setSteps((l) => l.filter((_, j) => j !== i))} />
            </li>
          ))}
        </ol>
        {steps.length < 10 ? <Button size="sm" variant="ghost" icon={Plus} onClick={() => setSteps((l) => [...l, { type: "goal", value: "" }])}>Add step</Button> : null}
        {create.isError ? <p role="alert" className="ui-field-error">{errorText(create.error)}</p> : null}
      </form>
    </Dialog>
  );
}

// ---- Peak hours ----

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;

/**
 * The heatmap's five steps, by rank among the cells that had any: the
 * quietest 40 % are step 1 (near the canvas), then 40–65 %, 65–80 %, 80–90 %,
 * and only the busiest 10 % reach ink (step 5). Equal values always share a
 * step. Returns the upper bound of steps 1–4 and the level of a value.
 */
export function heatScale(values: number[]): { bounds: number[]; level: (v: number) => number } {
  const xs = values.filter((v) => v > 0).sort((a, b) => a - b);
  const at = (q: number) => xs[Math.min(xs.length - 1, Math.max(0, Math.ceil(q * xs.length) - 1))] ?? 0;
  const bounds = [at(0.4), at(0.65), at(0.8), at(0.9)];
  return { bounds, level: (v) => (v <= 0 ? 0 : 1 + bounds.filter((b) => v > b).length) };
}

/** The scale under the heatmap: five steps from the smallest to the busiest cell, and the accent for the busiest slots named below. */
export function HeatLegend({ min, max, bounds, fmt, unit, className }: { min: number; max: number; bounds: number[]; fmt: (v: number) => string; unit: string; className?: string }) {
  const range = (l: number) => {
    const lo = l === 1 ? min : bounds[l - 2]!;
    const hi = l === 5 ? max : bounds[l - 1]!;
    return l === 1 ? `${fmt(lo)}–${fmt(hi)}` : `more than ${fmt(lo)}${l === 5 ? "" : `, up to ${fmt(hi)}`}`;
  };
  return (
    <div className={cn("ui-site-heat-legend", className)}>
      <span className="ui-site-heat-key">
        <span className="ui-site-heat-end">{fmt(min)}</span>
        <span className="ui-site-heat-steps" aria-hidden>
          {[1, 2, 3, 4, 5].map((l) => (
            <span key={l} data-l={l} title={range(l)} />
          ))}
        </span>
        <span className="ui-site-heat-end">{fmt(max)}</span>
        <span className="ui-site-heat-unit">{unit}</span>
      </span>
      <span className="ui-site-heat-key">
        <span className="ui-site-heat-top" aria-hidden />
        Busiest
      </span>
    </div>
  );
}

export function PeakHours({ d }: { d: Dash }) {
  const site = d.o!.site;
  const [metric, setMetric] = useState<PeakMetric>("visits");
  const query = { ...d.query, metric };
  const data = useQuery({ queryKey: keys.siteData(d.id, "peak-hours", query), queryFn: () => call(api.sites[":id"]["peak-hours"].$get({ param: { id: d.id }, query })) });
  const x = data.data;
  const fmt = (v: number) => (x?.metric === "revenue" ? moneyShort(v, site.currency) : num(v));
  const max = Math.max(0, ...(x?.cells.flat() ?? []));
  const min = Math.min(...(x?.cells.flat().filter((v) => v > 0) ?? []), max);
  const scale = heatScale(x?.cells.flat() ?? []);
  const unit = metric === "visits" ? "visits an hour" : metric === "sales" ? "sales an hour" : "an hour";
  return (
    <Section
      title="Peak hours"
      foldOnPhone={x?.top[0] ? `Busiest: ${DAYS[x.top[0].day]} ${hourLabel(x.top[0].hour)}.` : "When visits start, by weekday and hour."}
      sub={`When ${metric === "visits" ? "visits start" : "buyers pay"}, by weekday and hour (${site.timezone.replaceAll("_", " ")}).`}
      aside={d.revenue ? <Segmented<PeakMetric> label="Peak hours metric" size="sm" value={metric} onChange={setMetric} options={[{ value: "visits", label: "Visits" }, { value: "sales", label: "Sales" }, { value: "revenue", label: "Revenue" }]} /> : undefined}
    >
      {data.isPending ? (
        <RowsSkeleton rows={4} />
      ) : data.isError ? (
        <ErrorState compact what="Peak hours" error={data.error} onRetry={() => void data.refetch()} retrying={data.isFetching} />
      ) : !x || !x.total ? (
        <p className="ui-rows-empty">{metric === "visits" ? "No visits in this period." : "No sales in this period."}</p>
      ) : (
        <>
          <div className="ui-site-heat-scroll is-wide" tabIndex={0} role="region" aria-label="Peak hours grid, scrolls sideways">
            <table className="ui-site-heat" aria-label={`Peak hours: ${metric}`}>
              <thead>
                <tr>
                  <td />
                  {Array.from({ length: 24 }, (_, h) => (
                    <th key={h} scope="col">{h % 3 === 0 ? h : <span className="ui-sr">{h}</span>}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {x.cells.map((row, day) => (
                  <tr key={day}>
                    <th scope="row">{DAYS[day]}</th>
                    {row.map((v, hour) => {
                      const top = x.top.some((t) => t.day === day && t.hour === hour);
                      return (
                        <td key={hour} title={`${DAYS[day]} ${hourLabel(hour)}: ${fmt(v)}`} className={cn(top && "is-top")} data-l={scale.level(v)}>
                          <span className="ui-sr">{fmt(v)}</span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <HeatLegend min={min} max={max} bounds={scale.bounds} fmt={fmt} unit={unit} className="is-wide" />
          <HeatBuckets cells={x.cells} top={x.top} fmt={fmt} metric={metric} unit={unit.replace("an hour", "per 3 hours")} />
          <p className="ui-site-note">
            Busiest:{" "}
            {x.top.map((t, i) => (
              <span key={`${t.day}-${t.hour}`}>
                {i ? ", " : ""}
                <strong>{DAYS[t.day]} {hourLabel(t.hour)}</strong> ({fmt(t.value)})
              </span>
            ))}
            {metric === "visits" && x.top[0] ? `. Posting an hour or two before ${DAYS[x.top[0].day]} ${hourLabel(x.top[0].hour)} catches the rise.` : "."}
          </p>
        </>
      )}
    </Section>
  );
}

/**
 * The phone form of the heatmap: the same days, in 3-hour blocks (8 columns),
 * so the whole week fits 343 px without a sideways scroll. Shown instead of
 * the 24-hour grid under 768 px (sites.css).
 */
function HeatBuckets({ cells, top, fmt, metric, unit }: { cells: number[][]; top: { day: number; hour: number }[]; fmt: (v: number) => string; metric: PeakMetric; unit: string }) {
  const blocks = cells.map((row) => Array.from({ length: 8 }, (_, b) => row.slice(b * 3, b * 3 + 3).reduce((a, v) => a + v, 0)));
  const max = Math.max(0, ...blocks.flat());
  const min = Math.min(...blocks.flat().filter((v) => v > 0), max);
  const scale = heatScale(blocks.flat());
  const span = (b: number) => `${hourLabel(b * 3)}–${hourLabel((b * 3 + 3) % 24)}`;
  return (
    <div className="ui-site-heat-scroll is-narrow">
      <table className="ui-site-heat is-blocks" aria-label={`Peak hours: ${metric}, in 3-hour blocks`}>
        <thead>
          <tr>
            <td />
            {Array.from({ length: 8 }, (_, b) => (
              <th key={b} scope="col">
                {b % 2 === 0 ? b * 3 : <span className="ui-sr">{b * 3}</span>}
                <span className="ui-sr">:00 to {(b * 3 + 3) % 24}:00</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {blocks.map((row, day) => (
            <tr key={day}>
              <th scope="row">{DAYS[day]}</th>
              {row.map((v, b) => {
                const isTop = top.some((t) => t.day === day && Math.floor(t.hour / 3) === b);
                return (
                  <td key={b} title={`${DAYS[day]} ${span(b)}: ${fmt(v)}`} className={cn(isTop && "is-top")} data-l={scale.level(v)}>
                    <span className="ui-sr">{fmt(v)}</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <HeatLegend min={min} max={max} bounds={scale.bounds} fmt={fmt} unit={unit} />
    </div>
  );
}

// ---- Reading and page speed (Analytics Engine) ----

type Readers = "all" | "buyers" | "others";

export function Reading({ d }: { d: Dash }) {
  const [who, setWho] = useState<Readers>("all");
  const ae = d.o!.aeAvailable;
  const data = useQuery({ queryKey: keys.siteData(d.id, "engagement", d.query), queryFn: () => call(api.sites[":id"].engagement.$get({ param: { id: d.id }, query: d.query })), enabled: ae });
  const rows = data.data?.[who] ?? [];
  return (
    <Section
      title="Reading"
      sub="Time on each page while the tab was visible and the visitor active, and how far they scrolled."
      aside={d.revenue && ae ? <Segmented<Readers> label="Readers" size="sm" value={who} onChange={setWho} options={[{ value: "all", label: "Everyone" }, { value: "buyers", label: "Buyers" }, { value: "others", label: "Non-buyers", short: "Others" }]} /> : undefined}
    >
      {!ae || data.data?.available === false ? (
        <NeedsAE what="Reading times" error={data.data?.error} />
      ) : data.isPending ? (
        <RowsSkeleton rows={4} />
      ) : data.isError ? (
        <ErrorState compact what="Reading data" error={data.error} onRetry={() => void data.refetch()} retrying={data.isFetching} />
      ) : !rows.length ? (
        <p className="ui-rows-empty">No reading data in this period. It’s sent when a visitor leaves a page or switches tabs.</p>
      ) : (
        <div className="ui-table-scroll">
          <table className="ui-table is-dense">
            <thead>
              <tr>
                <th scope="col">Page</th>
                <th scope="col" className="is-num">Visits</th>
                <th scope="col" className="is-num" title="Half the visits read longer, half shorter">Median time</th>
                <th scope="col" className="is-num">Avg scroll</th>
                <th scope="col" className="is-num" title="Share of visits that scrolled at least 75% of the page">Read 75%+</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 25).map((r) => (
                <tr key={r.path}>
                  <td className="ui-site-path-cell"><span className="ui-site-trunc" title={r.path}>{r.path}</span></td>
                  <td className="is-num">{num(r.visits)}</td>
                  <td className="is-num is-2">{duration(r.medianSec)}</td>
                  <td className="is-num is-2">{r.avgScroll ? `${r.avgScroll}%` : "–"}</td>
                  <td className="is-num is-2">{r.avgScroll ? percent(r.deepShare) : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

type Vital = keyof typeof VITALS_THRESHOLDS;
const VITALS: { k: Vital; label: string }[] = [
  { k: "lcpMs", label: "Loading (LCP)" },
  { k: "inpMs", label: "Responsiveness (INP)" },
  { k: "cls", label: "Visual stability (CLS)" },
];
const RATING = { good: "Good", needs: "Needs work", poor: "Poor" } as const;
const rate = (k: Vital, v: number): keyof typeof RATING => (v <= VITALS_THRESHOLDS[k][0] ? "good" : v < VITALS_THRESHOLDS[k][1] ? "needs" : "poor");
const vitalText = (k: Vital, v: number | null) => (v === null ? "–" : k === "cls" ? v.toFixed(2) : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${num(v)} ms`);

function VitalValue({ k, v }: { k: Vital; v: number | null }) {
  if (v === null) return <span className="ui-site-quiet">–</span>;
  const r = rate(k, v);
  return (
    <span className="ui-site-vital" data-rating={r} title={RATING[r]}>
      <span className="ui-site-vital-dot" aria-hidden />
      {vitalText(k, v)}
      <span className="ui-sr">, {RATING[r]}</span>
    </span>
  );
}

export function PageSpeed({ d }: { d: Dash }) {
  const ae = d.o!.aeAvailable;
  const data = useQuery({ queryKey: keys.siteData(d.id, "page-speed", d.query), queryFn: () => call(api.sites[":id"]["page-speed"].$get({ param: { id: d.id }, query: d.query })), enabled: ae });
  const overall = data.data?.overall ?? null;
  const pages = data.data?.pages ?? [];
  return (
    <Section title="Page speed" sub="Core Web Vitals from real visits, at the 75th percentile: three in four loads were this fast or faster.">
      {!ae || data.data?.available === false ? (
        <NeedsAE what="Page speed numbers" error={data.data?.error} />
      ) : data.isPending ? (
        <RowsSkeleton rows={3} />
      ) : data.isError ? (
        <ErrorState compact what="Page speed" error={data.error} onRetry={() => void data.refetch()} retrying={data.isFetching} />
      ) : !overall ? (
        <p className="ui-rows-empty">No page speed data in this period. Browsers without the APIs (older Safari) don’t report it.</p>
      ) : (
        <>
          <dl className="ui-site-facts">
            {VITALS.map(({ k, label }) => (
              <div key={k}>
                <dt>{label}</dt>
                <dd>
                  <span className="ui-site-fact-value">{vitalText(k, overall[k])}</span>
                  <span className="ui-site-fact-note">{overall[k] === null ? "Not measured" : <VitalValue k={k} v={overall[k]} />}</span>
                </dd>
              </div>
            ))}
          </dl>
          <div className="ui-table-scroll">
            <table className="ui-table is-dense">
              <thead>
                <tr>
                  <th scope="col">Page</th>
                  <th scope="col" className="is-num">Loads</th>
                  <th scope="col" className="is-num">LCP</th>
                  <th scope="col" className="is-num">INP</th>
                  <th scope="col" className="is-num">CLS</th>
                </tr>
              </thead>
              <tbody>
                {pages.slice(0, 25).map((r) => (
                  <tr key={r.path}>
                    <td className="ui-site-path-cell"><span className="ui-site-trunc" title={r.path}>{r.path}</span></td>
                    <td className="is-num">{num(r.loads)}</td>
                    <td className="is-num"><VitalValue k="lcpMs" v={r.lcpMs} /></td>
                    <td className="is-num"><VitalValue k="inpMs" v={r.inpMs} /></td>
                    <td className="is-num"><VitalValue k="cls" v={r.cls} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Section>
  );
}

// ---- Latest visits ----

export function LatestVisits({ d }: { d: Dash }) {
  const live = useQuery({ queryKey: keys.siteData(d.id, "live", {}), queryFn: () => call(api.sites[":id"].live.$get({ param: { id: d.id } })), refetchInterval: 15_000 });
  const list = live.data?.sessions.slice(0, 12) ?? [];
  const [all, setAll] = useState(false);
  const shown = all ? list : list.slice(0, 5);
  return (
    <Section title="Latest visits" sub="The newest visits, refreshed every 15 seconds.">
      {live.isPending ? (
        <RowsSkeleton rows={5} />
      ) : live.isError && !live.data ? (
        <ErrorState compact what="Latest visits" error={live.error} onRetry={() => void live.refetch()} retrying={live.isFetching} />
      ) : !list.length ? (
        <p className="ui-rows-empty">No visits yet.</p>
      ) : (
        <div className="ui-table-scroll">
          <table className="ui-table is-dense is-stack ui-site-live">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">From</th>
                <th scope="col">Pages</th>
                <th scope="col">Where</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => (
                <tr key={s.id}>
                  <td className="ui-site-nowrap" data-lead="">{ago(s.lastSeenAt)}</td>
                  <td data-title="">
                    {s.link ? `Short link ${s.link}` : s.source || "Direct"}
                    <span className="ui-table-sub">{s.channel}</span>
                  </td>
                  <td className="ui-site-path-cell">
                    <span className="ui-site-trunc" title={`${s.entry}${s.exit !== s.entry ? ` → ${s.exit}` : ""}`}>
                      {s.entry}
                      {s.exit !== s.entry ? ` → ${s.exit}` : ""}
                    </span>
                    <span className="ui-table-sub">{num(s.pageviews)} {s.pageviews === 1 ? "page" : "pages"}</span>
                  </td>
                  <td>{[s.city, countryName(s.country)].filter(Boolean).join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.length > 5 ? (
            <button type="button" className="ui-more" onClick={() => setAll((v) => !v)} aria-expanded={all}>
              {all ? "Show fewer" : `Show all ${num(list.length)}`}
            </button>
          ) : null}
        </div>
      )}
    </Section>
  );
}
