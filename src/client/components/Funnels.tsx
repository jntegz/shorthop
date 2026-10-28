import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Filter, Plus, Trash2, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { FUNNEL_WINDOWS, type FunnelStep, type SiteDTO } from "../../shared/sites";
import { api, ApiError, call, keys } from "../api";
import { num } from "../lib/format";
import { useCan } from "../lib/me";
import { duration, money, percent, viewQuery, type SiteView } from "../lib/sites";
import { Button, Card, CardHeader, Dialog, Empty, Field, Input, Select, Spinner } from "./ui";

const WINDOW_LABELS: Record<number, string> = { 1: "1 hour", 24: "1 day", 72: "3 days", 168: "7 days", 720: "30 days" };

/** Saved funnels of a site: pick one to see how far visitors get, in order. */
export function FunnelsCard({ site, view, revenue }: { site: SiteDTO; view: SiteView; revenue: boolean }) {
  const can = useCan();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const list = useQuery({ queryKey: keys.siteData(site.id, "funnels", {}), queryFn: () => call(api.sites[":id"].funnels.$get({ param: { id: site.id } })) });
  const funnels = list.data?.funnels ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (!funnels.some((f) => f.id === selected)) setSelected(funnels[0]?.id ?? null);
  }, [funnels, selected]);
  const query = viewQuery(view);
  const report = useQuery({
    queryKey: keys.siteData(site.id, "funnel-report", { selected, ...query }),
    queryFn: () => call(api.sites[":id"].funnels[":funnel"].report.$get({ param: { id: site.id, funnel: selected! }, query })),
    enabled: Boolean(selected),
  });
  const remove = useMutation({
    mutationFn: (funnel: string) => call(api.sites[":id"].funnels[":funnel"].$delete({ param: { id: site.id, funnel } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.siteData(site.id, "funnels", {}) }),
  });
  const r = report.data;
  const first = r?.steps[0]?.visitors ?? 0;

  return (
    <Card>
      <CardHeader
        title={<span className="inline-flex items-center gap-2"><Filter className="size-4 text-accent" /> Funnels</span>}
        description="How many visitors reach each step, in order, within the funnel's time window. From Analytics Engine, so the last 90 days at most."
        action={
          <div className="flex flex-wrap items-center gap-2">
            {funnels.length ? (
              <Select aria-label="Funnel" value={selected ?? ""} onChange={(e) => setSelected(e.target.value)} className="h-9 w-48">
                {funnels.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </Select>
            ) : null}
            {can("sites.manage") && selected ? (
              <Button size="icon-sm" variant="ghost" aria-label="Delete funnel" onClick={() => confirm("Delete this funnel?") && remove.mutate(selected)}><Trash2 /></Button>
            ) : null}
            {can("sites.manage") ? <Button size="sm" variant="outline" onClick={() => setCreating(true)}><Plus /> New funnel</Button> : null}
          </div>
        }
      />
      {list.isPending ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : !funnels.length ? (
        <Empty title="No funnels yet">For example: landing page → /pricing → goal "signup". Revenue shows how many who finished went on to pay.</Empty>
      ) : report.isPending ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : report.isError ? (
        <p className="px-4 pb-4 text-sm text-danger">{report.error.message}</p>
      ) : r && !r.available ? (
        <Empty title="Needs Analytics Engine">Set CF_ANALYTICS_TOKEN to read page and goal events.</Empty>
      ) : r ? (
        <div className="space-y-2 px-4 pb-4">
          {r.steps.map((s, i) => {
            const prev = i ? r.steps[i - 1]!.visitors : s.visitors;
            return (
              <div key={i} className="relative overflow-hidden rounded-md border border-line px-4 py-3">
                <div className="absolute inset-y-0 left-0 bg-series-1 opacity-10" style={{ width: `${first ? (s.visitors / first) * 100 : 0}%` }} aria-hidden />
                <div className="relative flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                  <span className="flex size-6 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate font-medium">{s.step.type === "goal" ? `Goal: ${s.step.value}` : s.step.value}</span>
                  <span className="tabular font-semibold">{num(s.visitors)}</span>
                  <span className="tabular w-16 text-right text-xs text-muted">{first ? percent(s.visitors / first) : "–"}</span>
                  {i ? (
                    <span className="w-40 text-right text-xs text-muted">
                      {prev ? `${percent(1 - s.visitors / prev)} dropped` : ""}
                      {s.medianSecFromPrevious !== null ? ` · ${duration(s.medianSecFromPrevious)}` : ""}
                    </span>
                  ) : (
                    <span className="w-40" />
                  )}
                </div>
              </div>
            );
          })}
          {revenue ? (
            <p className="pt-1 text-sm text-muted">
              {num(r.paid.visitors)} of {num(r.steps[r.steps.length - 1]?.visitors ?? 0)} who finished paid afterwards
              {r.paid.revenue ? `, ${money(r.paid.revenue, site.currency)} in total` : ""}.
            </p>
          ) : null}
          {r.truncated ? <p className="text-xs text-warn">Analytics Engine returned its row limit; choose a shorter period for exact counts.</p> : null}
        </div>
      ) : null}
      {can("sites.manage") ? <NewFunnel site={site} open={creating} onOpenChange={setCreating} onCreated={setSelected} /> : null}
    </Card>
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
  const setStep = (i: number, s: Partial<FunnelStep>) => setSteps((list) => list.map((x, j) => (j === i ? { ...x, ...s } : x)));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New funnel" description="Pages take a path, with * for one segment and ** for anything (/blog/**). Goals take the goal's name." wide>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="fn-name"><Input id="fn-name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Signup" /></Field>
          <Field label="Steps must happen within" htmlFor="fn-window">
            <Select id="fn-window" value={windowHours} onChange={(e) => setWindowHours(Number(e.target.value))}>
              {FUNNEL_WINDOWS.map((h) => <option key={h} value={h}>{WINDOW_LABELS[h]}</option>)}
            </Select>
          </Field>
        </div>
        <ol className="space-y-2">
          {steps.map((s, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="w-5 text-right text-xs text-muted">{i + 1}.</span>
              <Select aria-label={`Step ${i + 1} type`} value={s.type} onChange={(e) => setStep(i, { type: e.target.value as FunnelStep["type"] })} className="w-28">
                <option value="page">Page</option>
                <option value="goal">Goal</option>
              </Select>
              <Input aria-label={`Step ${i + 1}`} value={s.value} onChange={(e) => setStep(i, { value: e.target.value })} placeholder={s.type === "page" ? "/pricing" : "signup"} />
              <Button type="button" size="icon-sm" variant="ghost" aria-label="Remove step" disabled={steps.length <= 2} onClick={() => setSteps((l) => l.filter((_, j) => j !== i))}><X /></Button>
            </li>
          ))}
        </ol>
        {steps.length < 10 ? <Button type="button" size="sm" variant="outline" onClick={() => setSteps((l) => [...l, { type: "goal", value: "" }])}><Plus /> Add step</Button> : null}
        {create.error instanceof ApiError ? <p className="text-sm text-danger">{create.error.message}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" loading={create.isPending}>Save funnel</Button>
        </div>
      </form>
    </Dialog>
  );
}
