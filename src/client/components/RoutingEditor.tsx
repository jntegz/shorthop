import { AlertTriangle, ArrowDown, ArrowUp, FlaskConical, Globe2, Plus, Smartphone, Split, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import {
  DEVICE_LABEL,
  describeConditions,
  matchingRule,
  MAX_RULES,
  MAX_VARIANTS,
  newRouteId,
  ROUTE_DEVICES,
  shadowedRules,
  UNKNOWN_COUNTRY,
  type RouteDevice,
  type RouteRule,
  type RouteVariant,
  type RoutingError,
} from "../../shared/routing";
import { countryOptions, routeCountryName } from "../lib/countries";
import { hostOf } from "../lib/format";
import { cn } from "../lib/utils";
import { Badge, Button, Combobox, Input, Select, Switch } from "./ui";

const LETTERS = "ABCDEFGHIJ";

/** Shares that add up to 100, as evenly as whole numbers allow. */
function evenWeights(n: number): number[] {
  const base = Math.floor(100 / n);
  return Array.from({ length: n }, (_, i) => base + (i < 100 - base * n ? 1 : 0));
}

const variant = (label: string, url = "", weight = 100): RouteVariant => ({ id: newRouteId(), label, url, weight });
const blankRule = (over: Partial<RouteRule> = {}): RouteRule => ({
  id: newRouteId(),
  name: "",
  enabled: true,
  devices: [],
  countries: [],
  countryMode: "in",
  variants: [variant("")],
  ...over,
});

/** Starting points for the common setups. */
const PRESETS: { id: string; icon: typeof Smartphone; title: string; detail: string; rules: () => RouteRule[] }[] = [
  {
    id: "apps",
    icon: Smartphone,
    title: "App stores",
    detail: "iPhone to the App Store, Android to Google Play",
    rules: () => [
      blankRule({ name: "App Store", devices: ["ios"], variants: [variant("", "https://apps.apple.com/app/")] }),
      blankRule({ name: "Google Play", devices: ["android"], variants: [variant("", "https://play.google.com/store/apps/details?id=")] }),
    ],
  },
  {
    id: "country",
    icon: Globe2,
    title: "By country",
    detail: "A local page for chosen countries",
    rules: () => [blankRule({ name: "Local page", countries: ["CZ", "SK"] })],
  },
  {
    id: "ab",
    icon: FlaskConical,
    title: "A/B test",
    detail: "Split everyone between two pages",
    rules: () => [blankRule({ name: "A/B test", variants: [variant("A", "", 50), variant("B", "", 50)] })],
  },
];

function DeviceChips({ value, onChange, id }: { value: RouteDevice[]; onChange: (v: RouteDevice[]) => void; id: string }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby={`${id}-devices`}>
      {ROUTE_DEVICES.map((d) => {
        const on = value.includes(d);
        return (
          <button
            key={d}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== d) : [...value, d])}
            className={cn(
              "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
              on ? "border-accent bg-accent-soft text-accent" : "border-line bg-surface text-muted hover:border-accent/40 hover:text-fg",
            )}
          >
            {DEVICE_LABEL[d]}
          </button>
        );
      })}
    </div>
  );
}

function CountryPicker({ rule, onChange, id }: { rule: RouteRule; onChange: (r: Partial<RouteRule>) => void; id: string }) {
  const options = useMemo(
    () => countryOptions().filter((c) => !rule.countries.includes(c.code)).map((c) => ({ value: c.code, label: `${c.flag} ${c.name}`, detail: c.code === UNKNOWN_COUNTRY ? "no location data" : c.code })),
    [rule.countries],
  );
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          className="h-9 w-auto text-xs"
          aria-label="Countries are"
          value={rule.countryMode}
          onChange={(e) => onChange({ countryMode: e.target.value as RouteRule["countryMode"] })}
          disabled={!rule.countries.length}
        >
          <option value="in">In</option>
          <option value="not_in">Outside</option>
        </Select>
        {rule.countries.length ? (
          rule.countries.map((c) => (
            <span key={c} className="inline-flex items-center gap-1 rounded-full bg-accent-soft py-1 pr-1 pl-2.5 text-xs font-medium text-accent">
              {routeCountryName(c)}
              <button type="button" className="rounded-full p-0.5 hover:bg-accent/10" aria-label={`Remove ${routeCountryName(c)}`} onClick={() => onChange({ countries: rule.countries.filter((x) => x !== c) })}>
                <X className="size-3" />
              </button>
            </span>
          ))
        ) : (
          <span className="text-xs text-muted">any country</span>
        )}
      </div>
      <Combobox id={`${id}-country`} value="" onChange={(code) => code && onChange({ countries: [...rule.countries, code] })} options={options} placeholder="Type a country…" noneLabel="Add a country…" />
    </div>
  );
}

function Destinations({ rule, onChange, id }: { rule: RouteRule; onChange: (r: Partial<RouteRule>) => void; id: string }) {
  const vs = rule.variants;
  const split = vs.length > 1;
  const total = vs.reduce((s, v) => s + (Number.isFinite(v.weight) ? v.weight : 0), 0);
  const setVariant = (i: number, patch: Partial<RouteVariant>) => onChange({ variants: vs.map((v, j) => (j === i ? { ...v, ...patch } : v)) });
  const addVariant = () => {
    const next = [...vs, variant(LETTERS[vs.length] ?? "", "")];
    const weights = evenWeights(next.length);
    onChange({ variants: next.map((v, i) => ({ ...v, label: v.label || (LETTERS[i] ?? ""), weight: weights[i]! })) });
  };
  const removeVariant = (i: number) => {
    const next = vs.filter((_, j) => j !== i);
    const weights = evenWeights(next.length);
    onChange({ variants: next.map((v, j) => ({ ...v, weight: next.length === 1 ? 100 : weights[j]! })) });
  };
  return (
    <div className="space-y-2">
      {vs.map((v, i) => (
        <div key={v.id} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
          {split ? (
            <Input className="h-9 w-full text-xs sm:w-24" aria-label={`Name of destination ${i + 1}`} placeholder="Name" maxLength={40} value={v.label} onChange={(e) => setVariant(i, { label: e.target.value })} />
          ) : null}
          <Input
            className="h-9 min-w-0 flex-1 font-mono text-xs"
            type="url"
            inputMode="url"
            aria-label={split ? `URL of ${v.label || `destination ${i + 1}`}` : "Destination URL"}
            placeholder="https://…"
            value={v.url}
            onChange={(e) => setVariant(i, { url: e.target.value })}
            id={i === 0 ? `${id}-url` : undefined}
          />
          {split ? (
            <>
              <div className="relative w-20 shrink-0">
                <Input
                  className="h-9 pr-6 text-right text-xs tabular"
                  type="number"
                  min={1}
                  max={99}
                  aria-label={`Share for ${v.label || `destination ${i + 1}`}, percent`}
                  value={Number.isFinite(v.weight) ? v.weight : ""}
                  onChange={(e) => setVariant(i, { weight: e.target.value === "" ? Number.NaN : Math.round(Number(e.target.value)) })}
                />
                <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-muted">%</span>
              </div>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${v.label || `destination ${i + 1}`}`} onClick={() => removeVariant(i)}>
                <X />
              </Button>
            </>
          ) : null}
        </div>
      ))}
      {split ? (
        <div className="space-y-1.5">
          <div className="flex h-2 overflow-hidden rounded-full bg-surface-2" aria-hidden>
            {vs.map((v, i) => (
              <span key={v.id} style={{ width: `${Math.max(0, Math.min(100, v.weight || 0))}%` }} className={cn("h-full", i % 2 ? "bg-series-2" : "bg-series-1", i > 0 && "border-l-2 border-surface")} />
            ))}
          </div>
          <p className={cn("flex items-center gap-1 text-xs", total === 100 ? "text-muted" : "text-warn")} aria-live="polite">
            {total === 100 ? "Shares add up to 100%." : <><AlertTriangle className="size-3" /> Shares add up to {total}%; they need to total 100%.</>}
            {total !== 100 || vs.some((v, i) => v.weight !== evenWeights(vs.length)[i]) ? (
              <button type="button" className="ml-1 font-medium text-accent hover:underline" onClick={() => onChange({ variants: vs.map((v, i) => ({ ...v, weight: evenWeights(vs.length)[i]! })) })}>
                Split evenly
              </button>
            ) : null}
          </p>
        </div>
      ) : null}
      {vs.length < MAX_VARIANTS ? (
        <button type="button" onClick={addVariant} className="inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:underline">
          <Split className="size-3.5" /> {split ? "Add another destination" : "Split traffic for an A/B test"}
        </button>
      ) : null}
    </div>
  );
}

function RuleCard({
  rule,
  index,
  count,
  errors,
  shadowed,
  onChange,
  onMove,
  onRemove,
}: {
  rule: RouteRule;
  index: number;
  count: number;
  errors: string[];
  shadowed: boolean;
  onChange: (r: Partial<RouteRule>) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const id = `rule-${rule.id}`;
  return (
    <li className={cn("rounded-xl border bg-surface", errors.length ? "border-danger/40" : "border-line", !rule.enabled && "opacity-70")}>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-accent-soft text-xs font-semibold text-accent tabular" aria-hidden>
          {index + 1}
        </span>
        <Input className="h-8 min-w-0 flex-1 border-transparent bg-transparent px-1.5 text-sm font-medium shadow-none hover:border-line focus:border-line" aria-label={`Rule ${index + 1} name`} placeholder={`Rule ${index + 1}`} maxLength={60} value={rule.name} onChange={(e) => onChange({ name: e.target.value })} />
        {!rule.enabled ? <Badge>Paused</Badge> : null}
        <div className="flex items-center">
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Move rule ${index + 1} up`} disabled={index === 0} onClick={() => onMove(-1)}>
            <ArrowUp />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Move rule ${index + 1} down`} disabled={index === count - 1} onClick={() => onMove(1)}>
            <ArrowDown />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Delete rule ${index + 1}`} onClick={onRemove}>
            <Trash2 />
          </Button>
        </div>
      </div>
      <div className="space-y-4 p-3 sm:p-4">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <p id={`${id}-devices`} className="text-xs font-medium text-fg">
              Device <span className="font-normal text-muted">{rule.devices.length ? "" : "· any"}</span>
            </p>
            <DeviceChips id={id} value={rule.devices} onChange={(devices) => onChange({ devices })} />
          </div>
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-fg">Country</p>
            <CountryPicker id={id} rule={rule} onChange={onChange} />
          </div>
        </div>
        <div className="space-y-1.5">
          <label htmlFor={`${id}-url`} className="text-xs font-medium text-fg">
            {rule.variants.length > 1 ? "Destinations, split by share" : "Send them to"}
          </label>
          <Destinations id={id} rule={rule} onChange={onChange} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
          <p className="text-xs text-muted">
            <span className="font-medium text-fg">{describeConditions(rule, routeCountryName)}</span>
            {" → "}
            {rule.variants.length > 1 ? rule.variants.map((v) => `${v.label || "?"} ${Number.isFinite(v.weight) ? v.weight : "?"}%`).join(" / ") : rule.variants[0]?.url ? hostOf(rule.variants[0].url) || rule.variants[0].url : "no destination yet"}
          </p>
          <Switch id={`${id}-enabled`} label="Active" checked={rule.enabled} onCheckedChange={(enabled) => onChange({ enabled })} />
        </div>
        {shadowed && !errors.length ? (
          <p className="flex items-start gap-1.5 text-xs text-warn">
            <AlertTriangle className="mt-px size-3.5 shrink-0" /> A rule above already catches everyone this rule would, so it never runs. Move it up or narrow the rule above.
          </p>
        ) : null}
        {errors.map((e) => (
          <p key={e} role="alert" className="flex items-start gap-1.5 text-xs text-danger">
            <AlertTriangle className="mt-px size-3.5 shrink-0" /> {e}
          </p>
        ))}
      </div>
    </li>
  );
}

/** Try a visitor against the rules, without sending anything or counting a click. */
function Simulator({ rules, fallback }: { rules: RouteRule[]; fallback: string }) {
  const [device, setDevice] = useState<RouteDevice>("ios");
  const [country, setCountry] = useState("CZ");
  const countries = useMemo(() => countryOptions(), []);
  const hit = matchingRule({ rules, changedAt: 0 }, { device, country });
  return (
    <div className="rounded-xl border border-dashed border-line bg-surface p-3 sm:p-4">
      <p className="text-xs font-medium text-fg">Try it</p>
      <p className="mt-0.5 text-xs text-muted">Pick a visitor to see where they'd go. Nothing is opened or counted.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Select className="h-9 w-auto text-xs" aria-label="Visitor's device" value={device} onChange={(e) => setDevice(e.target.value as RouteDevice)}>
          {ROUTE_DEVICES.map((d) => (
            <option key={d} value={d}>
              {DEVICE_LABEL[d]}
            </option>
          ))}
        </Select>
        <Select className="h-9 w-auto max-w-56 text-xs" aria-label="Visitor's country" value={country} onChange={(e) => setCountry(e.target.value)}>
          {countries.map((c) => (
            <option key={c.code} value={c.code}>
              {c.flag} {c.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="mt-3 rounded-lg bg-bg px-3 py-2.5 text-xs" aria-live="polite">
        {hit ? (
          <>
            <p className="font-medium text-fg">
              Rule {hit.index + 1}
              {hit.rule.name ? `: ${hit.rule.name}` : ""}
            </p>
            <ul className="mt-1 space-y-0.5 text-muted">
              {hit.rule.variants.map((v) => (
                <li key={v.id} className="truncate font-mono text-[11px]" title={v.url}>
                  {hit.rule.variants.length > 1 ? <span className="font-sans font-medium text-fg">{v.weight}% {v.label} · </span> : "→ "}
                  {v.url || "(no URL yet)"}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <p className="font-medium text-fg">No rule matches: the default destination</p>
            <p className="mt-1 truncate font-mono text-[11px] text-muted" title={fallback}>
              → {fallback || "(enter the destination URL above)"}
            </p>
          </>
        )}
      </div>
      <p className="mt-2 text-[11px] text-subtle">Bots and link previews always get the default destination, so previews stay stable and tests count people only.</p>
    </div>
  );
}

/**
 * Link form → Smart routing. Rules run top to bottom and the first match wins;
 * everyone else goes to the link's destination (the fallback).
 */
export function RoutingEditor({ rules, onChange, fallback, errors }: { rules: RouteRule[]; onChange: (rules: RouteRule[]) => void; fallback: string; errors: RoutingError[] }) {
  const shadowed = shadowedRules(rules);
  const setRule = (i: number, patch: Partial<RouteRule>) => onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const move = (i: number, dir: -1 | 1) => {
    const next = [...rules];
    const [r] = next.splice(i, 1);
    next.splice(i + dir, 0, r!);
    onChange(next);
  };
  const general = errors.filter((e) => e.rule < 0).map((e) => e.message);

  if (!rules.length) {
    return (
      <div className="space-y-3">
        <p className="text-xs text-muted">Start from a common setup, or a blank rule. You can change everything afterwards.</p>
        <div className="grid gap-2 sm:grid-cols-3">
          {PRESETS.map(({ id, icon: Icon, title, detail, rules: make }) => (
            <button key={id} type="button" onClick={() => onChange(make())} className="flex flex-col items-start gap-2 rounded-xl border border-line bg-surface p-3 text-left transition-colors hover:border-accent/50 hover:bg-accent-soft/40">
              <span className="flex size-8 items-center justify-center rounded-lg bg-accent-soft text-accent">
                <Icon className="size-4" />
              </span>
              <span className="text-sm font-medium text-fg">{title}</span>
              <span className="text-xs leading-snug text-muted">{detail}</span>
            </button>
          ))}
        </div>
        <button type="button" onClick={() => onChange([blankRule()])} className="inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:underline">
          <Plus className="size-3.5" /> Blank rule
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-muted">Rules are checked from the top; the first one that matches a visitor wins. Each visit is assigned on its own, without cookies, so someone opening the link twice can land on different sides of a split.</p>
      <ol className="space-y-3">
        {rules.map((r, i) => (
          <RuleCard
            key={r.id}
            rule={r}
            index={i}
            count={rules.length}
            errors={errors.filter((e) => e.rule === i).map((e) => e.message)}
            shadowed={shadowed.has(i)}
            onChange={(patch) => setRule(i, patch)}
            onMove={(dir) => move(i, dir)}
            onRemove={() => onChange(rules.filter((_, j) => j !== i))}
          />
        ))}
      </ol>
      {general.map((e) => (
        <p key={e} role="alert" className="text-xs text-danger">
          {e}
        </p>
      ))}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2.5 text-xs">
        <span className="font-medium text-fg">Everyone else</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted" title={fallback}>
          → {fallback || "the destination URL above"}
        </span>
      </div>
      {rules.length < MAX_RULES ? (
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...rules, blankRule()])}>
          <Plus /> Add rule
        </Button>
      ) : null}
      <Simulator rules={rules} fallback={fallback} />
    </div>
  );
}
