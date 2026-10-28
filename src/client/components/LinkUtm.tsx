import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bookmark, Check } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { parseTemplate, PRESET_NAME_MAX, UTM_FIELDS } from "../../shared/utm";
import { api, call, keys } from "../api";
import { useCan, useMe } from "../lib/me";
import { cn } from "../lib/utils";
import { UtmBuilder, UtmPreview } from "./UtmBuilder";
import { Button, Input, Segmented } from "./ui";

/** "source linkedin · medium social": a template at a glance. */
export function TemplateChips({ template }: { template: string }) {
  const parts = parseTemplate(template);
  const pairs = [...UTM_FIELDS.filter((f) => parts.fields[f.key]).map((f) => [f.label.toLowerCase(), parts.fields[f.key]] as const), ...parts.extra.map((e) => [e.key, e.value] as const)];
  return (
    <span className="flex flex-wrap gap-1">
      {pairs.map(([k, v]) => (
        <span key={k} className="rounded-md bg-surface-2 px-1.5 py-0.5 text-xs">
          <span className="text-muted">{k}</span> <span className="font-medium text-fg">{v}</span>
        </span>
      ))}
    </span>
  );
}

/**
 * Link form → UTM: the default template, or this link's own (built field by
 * field, or copied from a preset), with the final URL previewed.
 */
export function LinkUtm({
  custom,
  onCustom,
  template,
  onTemplate,
  target,
  slug,
  onClose,
}: {
  custom: boolean;
  onCustom: (custom: boolean) => void;
  template: string;
  onTemplate: (template: string, problem: string | null) => void;
  target: string;
  slug: string;
  /** Closes the form (before leaving for Settings). */
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const presets = useQuery({ queryKey: keys.utmPresets, queryFn: () => call(api["utm-presets"].$get()) });
  const [naming, setNaming] = useState<string | null>(null);
  const defaultTemplate = useMe().data?.workspace.defaultUtm ?? "";
  // Presets and the default are workspace settings.
  const manage = useCan()("settings.manage");
  const list = presets.data?.presets ?? [];
  const matching = list.find((p) => custom && p.template === template);

  const savePreset = useMutation({
    mutationFn: (name: string) => call(api["utm-presets"].$post({ json: { name, template } })),
    onSuccess: (r) => {
      qc.setQueryData(keys.utmPresets, r);
      toast.success(`Saved the preset “${naming}”`, { description: "Apply it to any link from here, or manage presets in Settings." });
      setNaming(null);
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="space-y-3 rounded-lg border border-line bg-surface p-3">
      <Segmented
        label="Which UTM parameters"
        value={custom ? "custom" : "default"}
        onChange={(v) => {
          if (v === "custom" && !template) onTemplate(defaultTemplate, null);
          onCustom(v === "custom");
        }}
        options={[
          { value: "default", label: "Default template" },
          { value: "custom", label: "Custom for this link" },
        ]}
      />
      {list.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted">Presets:</span>
          {list.map((p) => {
            const on = matching?.id === p.id;
            return (
              <button
                key={p.id}
                type="button"
                aria-pressed={on}
                title={p.template}
                onClick={() => {
                  onCustom(true);
                  onTemplate(p.template, null);
                }}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                  on ? "border-accent bg-accent-soft text-accent" : "border-line bg-surface text-muted hover:border-accent/40 hover:text-fg",
                )}
              >
                {on ? <Check className="size-3" /> : null}
                {p.name}
              </button>
            );
          })}
        </div>
      ) : null}

      {custom ? (
        <>
          <UtmBuilder id="link-utm" value={template} onChange={onTemplate} target={target} slug={slug} />
          {matching ? (
            <p className="text-xs text-muted">Uses a copy of “{matching.name}”: editing the preset later won't change this link.</p>
          ) : template && manage ? (
            naming === null ? (
              <button type="button" className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline" onClick={() => setNaming("")}>
                <Bookmark className="size-3.5" /> Save as a preset
              </button>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  className="h-9 w-56 text-sm"
                  aria-label="Preset name"
                  placeholder="e.g. LinkedIn organic"
                  maxLength={PRESET_NAME_MAX}
                  autoFocus
                  value={naming}
                  onChange={(e) => setNaming(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      if (naming.trim()) savePreset.mutate(naming.trim());
                    }
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      setNaming(null);
                    }
                  }}
                />
                <Button type="button" size="sm" onClick={() => savePreset.mutate(naming.trim())} disabled={!naming.trim()} loading={savePreset.isPending}>
                  Save preset
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setNaming(null)}>
                  Cancel
                </Button>
              </div>
            )
          ) : null}
        </>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span>Follows the default, including later changes to it:</span>
            {defaultTemplate ? <TemplateChips template={defaultTemplate} /> : null}
          </div>
          <UtmPreview target={target} template={defaultTemplate} slug={slug} />
          {manage ? (
            <Link to="/settings#utm" className="inline-block text-xs font-medium text-accent hover:underline" onClick={onClose}>
              Change the default or manage presets in Settings
            </Link>
          ) : null}
        </div>
      )}
    </div>
  );
}
