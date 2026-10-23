import { useEffect, useState } from "react";
import { utcDate } from "../../shared/dates";
import type { Period, Range } from "../../shared/types";
import { useMe } from "../lib/me";
import { Button, Dialog, Field, Input, Segmented } from "./ui";

const QUICK = ["today", "7d", "30d", "90d"] as const;
type Quick = (typeof QUICK)[number];
const QUICK_LABELS: Record<Quick, string> = { today: "Today", "7d": "7 days", "30d": "30 days", "90d": "90 days" };
const LONGER: { range: Range; label: string }[] = [
  { range: "180d", label: "6 months" },
  { range: "270d", label: "9 months" },
  { range: "365d", label: "12 months" },
  { range: "all", label: "All time" },
];

const withYear = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
/** "2026-10-01" → "1 Oct 2026". */
const day = (iso: string) => withYear.format(new Date(`${iso}T00:00:00Z`));

/** The API's period query: only the fields that are set. */
export function periodQuery(p: Period): { range: Range; from?: string; to?: string } {
  return p.range === "custom" && p.from && p.to ? { range: "custom", from: p.from, to: p.to } : { range: p.range };
}

/** "range=custom&from=…&to=…", for download links. */
export function periodParams(p: Period): string {
  return new URLSearchParams(periodQuery(p)).toString();
}

/** A short name for a period that isn't one of the quick picks. */
function longerLabel(p: Period): string | null {
  if (p.range === "custom" && p.from && p.to) return p.from === p.to ? day(p.from) : `${day(p.from)} – ${day(p.to)}`;
  return LONGER.find((l) => l.range === p.range)?.label ?? null;
}

/** Today · 7 days · 30 days · 90 days · Custom: longer ranges and any from–to dates (UTC). */
export function PeriodPicker({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  const [open, setOpen] = useState(false);
  const today = utcDate();
  const since = useMe().data?.workspace.statsSince ?? undefined;
  const [from, setFrom] = useState(value.from ?? "");
  const [to, setTo] = useState(value.to ?? today);

  useEffect(() => {
    if (!open) return;
    setFrom(value.from ?? since ?? "");
    setTo(value.to ?? today);
  }, [open, value.from, value.to, since, today]);

  const quick = (QUICK as readonly string[]).includes(value.range) ? (value.range as Quick) : "custom";
  const options = [
    ...QUICK.map((q) => ({ value: q as Quick | "custom", label: QUICK_LABELS[q] })),
    { value: "custom" as const, label: quick === "custom" ? (longerLabel(value) ?? "Custom") : "Custom…" },
  ];
  const error = !from || !to ? "Choose both dates." : from > to ? "The start date must be on or before the end date." : to > today ? "The end date can't be in the future." : null;
  const pick = (p: Period) => {
    onChange(p);
    setOpen(false);
  };

  return (
    <>
      <Segmented label="Date range" value={quick} onChange={(v) => (v === "custom" ? setOpen(true) : onChange({ range: v }))} options={options} />
      <Dialog open={open} onOpenChange={setOpen} title="Choose a period" description="Pick a longer range, or any dates you like. Days are in UTC.">
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {LONGER.map((l) => (
              <Button key={l.range} variant={value.range === l.range ? "primary" : "outline"} onClick={() => pick({ range: l.range })}>
                {l.label}
              </Button>
            ))}
          </div>
          <div className="space-y-4 rounded-xl border border-line p-4">
            <p className="text-sm font-medium text-fg">Custom dates</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="From" htmlFor="period-from" hint={since ? `Your stats start ${day(since)}.` : undefined}>
                <Input id="period-from" type="date" min={since} max={to || today} value={from} onChange={(e) => setFrom(e.target.value)} />
              </Field>
              <Field label="To" htmlFor="period-to">
                <Input id="period-to" type="date" min={from || since} max={today} value={to} onChange={(e) => setTo(e.target.value)} />
              </Field>
            </div>
            {error && (from || to) ? <p className="text-xs text-danger">{error}</p> : null}
            <div className="flex justify-end">
              <Button onClick={() => pick({ range: "custom", from, to })} disabled={Boolean(error)}>
                Show these dates
              </Button>
            </div>
          </div>
        </div>
      </Dialog>
    </>
  );
}
