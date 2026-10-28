import { Braces, Copy, Plus, X } from "lucide-react";
import { useEffect, useRef, useState, type FocusEvent } from "react";
import { buildTemplate, parseTemplate, partsProblem, previewUtm, UTM_FIELDS, UTM_PLACEHOLDERS, type UtmKey, type UtmParts } from "../../shared/utm";
import { useDomains } from "../lib/links";
import { cn, copy } from "../lib/utils";
import { Button, Input } from "./ui";

/**
 * The final URL with the added parameters picked out. Parameters the
 * destination already has are noted: its own value wins.
 */
export function UtmPreview({ target, template, slug }: { target: string; template: string; slug: string }) {
  const { primary } = useDomains();
  if (!target || !template) return null;
  const { url, kept } = previewUtm(target, template, { slug: slug || "your-slug", source: "linkedin", domain: primary, variant: "A" });
  const cut = url.length > target.length && url.startsWith(target.split("#")[0]!) ? target.split("#")[0]!.length : -1;
  return (
    <div className="space-y-1.5 rounded-lg bg-bg px-3 py-2.5">
      <p className="text-xs font-medium text-muted">Where a visitor from LinkedIn lands</p>
      <p className="font-mono text-xs leading-relaxed break-all text-fg">
        {cut > 0 ? (
          <>
            <span className="text-muted">{url.slice(0, cut)}</span>
            <span className="rounded bg-accent-soft text-accent">{url.slice(cut).split("#")[0]}</span>
            {url.includes("#") ? <span className="text-muted">#{url.split("#").slice(1).join("#")}</span> : null}
          </>
        ) : (
          url
        )}
      </p>
      {kept.length ? (
        <p className="text-xs text-warn">
          The destination already sets {kept.join(", ")}, so its own {kept.length === 1 ? "value is" : "values are"} kept and this one is skipped.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Field-by-field UTM editing. Holds its own field state while typing (so
 * spaces and half-typed values aren't normalized away) and reports the
 * template with whether it can be saved.
 */
export function UtmBuilder({
  id,
  value,
  onChange,
  target,
  slug,
}: {
  id: string;
  value: string;
  onChange: (template: string, problem: string | null) => void;
  /** The destination, for the live preview. */
  target: string;
  slug: string;
}) {
  const [parts, setParts] = useState<UtmParts>(() => parseTemplate(value));
  const emitted = useRef(value);
  const focused = useRef<{ el: HTMLInputElement; apply: (v: string) => void } | null>(null);

  // A template set from outside (a preset, a reset) replaces the fields.
  useEffect(() => {
    if (value !== emitted.current) {
      setParts(parseTemplate(value));
      emitted.current = value;
    }
  }, [value]);

  const update = (next: UtmParts) => {
    setParts(next);
    const t = buildTemplate(next);
    emitted.current = t;
    onChange(t, partsProblem(next));
  };
  const setField = (key: UtmKey, v: string) => update({ ...parts, fields: { ...parts.fields, [key]: v } });
  const setExtra = (i: number, patch: Partial<UtmParts["extra"][number]>) => update({ ...parts, extra: parts.extra.map((e, j) => (j === i ? { ...e, ...patch } : e)) });

  /** Inserts a placeholder where the cursor was in the last field used. */
  const insert = (token: string) => {
    const f = focused.current;
    if (!f) return;
    const { el } = f;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    f.apply(el.value.slice(0, start) + token + el.value.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };
  const track = (apply: (v: string) => void) => ({
    onFocus: (e: FocusEvent<HTMLInputElement>) => {
      focused.current = { el: e.currentTarget, apply };
    },
  });

  const problem = partsProblem(parts);
  const template = buildTemplate(parts);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
        <Braces className="size-3.5" aria-hidden />
        <span>Insert into the field you're in:</span>
        {UTM_PLACEHOLDERS.map((p) => (
          <button
            key={p.token}
            type="button"
            title={p.description}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => insert(p.token)}
            className="rounded-md border border-line bg-surface px-1.5 py-0.5 font-mono text-xs text-accent hover:border-accent/50"
          >
            {p.token}
          </button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {UTM_FIELDS.map((f) => (
          <div key={f.key} className="space-y-1">
            <label htmlFor={`${id}-${f.key}`} className="flex items-baseline justify-between gap-2 text-xs">
              <span className="font-medium text-fg">{f.label}</span>
              <span className="font-mono text-xs text-subtle">{f.key}</span>
            </label>
            <Input
              id={`${id}-${f.key}`}
              className="h-9 text-sm"
              value={parts.fields[f.key]}
              placeholder={f.example ? `e.g. ${f.example}` : "optional"}
              onChange={(e) => setField(f.key, e.target.value)}
              {...track((v) => setField(f.key, v))}
            />
            <p className="text-xs text-muted">{f.hint}</p>
          </div>
        ))}
      </div>
      {parts.extra.length ? (
        <div className="space-y-2">
          <p className="text-xs font-medium text-fg">Other parameters</p>
          {parts.extra.map((e, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input className="h-9 w-36 font-mono text-xs" aria-label={`Parameter ${i + 1} name`} placeholder="name" value={e.key} onChange={(ev) => setExtra(i, { key: ev.target.value })} />
              <span className="text-muted">=</span>
              <Input
                className="h-9 min-w-0 flex-1 text-sm"
                aria-label={`Parameter ${i + 1} value`}
                placeholder="value"
                value={e.value}
                onChange={(ev) => setExtra(i, { value: ev.target.value })}
                {...track((v) => setExtra(i, { value: v }))}
              />
              <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove parameter ${e.key || i + 1}`} onClick={() => update({ ...parts, extra: parts.extra.filter((_, j) => j !== i) })}>
                <X />
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" onClick={() => update({ ...parts, extra: [...parts.extra, { key: "", value: "" }] })} className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
          <Plus className="size-3.5" /> Add another parameter
        </button>
        {template ? (
          <button type="button" onClick={() => void copy(template, "Template copied")} className={cn("inline-flex min-w-0 items-center gap-1 text-xs text-muted hover:text-fg")} title="Copy the template">
            <Copy className="size-3 shrink-0" />
            <span className="max-w-72 truncate font-mono">{template}</span>
          </button>
        ) : null}
      </div>
      {problem ? (
        <p role="alert" className="text-xs text-danger">
          {problem}
        </p>
      ) : null}
      <UtmPreview target={target} template={template} slug={slug} />
    </div>
  );
}
