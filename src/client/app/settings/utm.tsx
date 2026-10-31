// Settings → Links → UTM parameters: the default template (saving republishes
// the links that use it) and the saved presets.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Braces, Copy, Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type FocusEvent } from "react";
import { toast } from "sonner";
import type { UtmPresetDTO } from "../../../shared/types";
import { buildTemplate, MAX_PRESETS, parseTemplate, partsProblem, PRESET_NAME_MAX, previewUtm, UTM_FIELDS, UTM_PLACEHOLDERS, type UtmKey, type UtmParts } from "../../../shared/utm";
import { api, call, keys } from "../../api";
import { num } from "../../lib/format";
import { SETTINGS_HELP } from "../../lib/help";
import { copy } from "../../lib/utils";
import { Button, Dialog, Empty, ErrorState, IconButton, Input, SkeletonText, TextButton } from "../ui";
import { SettingsSection } from "./common";

/** One-click starting points when there are no presets yet. */
const SUGGESTED = [
  { name: "LinkedIn", template: "utm_source=linkedin&utm_medium=social&utm_campaign={slug}" },
  { name: "Newsletter", template: "utm_source=newsletter&utm_medium=email&utm_campaign={slug}" },
  { name: "QR print", template: "utm_source=print&utm_medium=qr&utm_campaign={slug}" },
  { name: "A/B test", template: "utm_source={source}&utm_medium=shortlink&utm_campaign={slug}&utm_content={variant}" },
];

const EXAMPLE_TARGET = "https://example.com/guide";

/** A template's parameters as small name/value chips. */
export function TemplateChips({ template }: { template: string }) {
  const parts = parseTemplate(template);
  const pairs = [...UTM_FIELDS.filter((f) => parts.fields[f.key]).map((f) => [f.label.toLowerCase(), parts.fields[f.key]] as const), ...parts.extra.map((e) => [e.key, e.value] as const)];
  return (
    <span className="settings-chips">
      {pairs.map(([k, v]) => (
        <span key={k} className="settings-chip">
          <span className="settings-chip-k">{k}</span> <span className="settings-chip-v">{v}</span>
        </span>
      ))}
    </span>
  );
}

/**
 * The final URL with the added parameters picked out. Parameters the
 * destination already has are noted: its own value wins.
 */
export function UtmPreview({ target, template, slug }: { target: string; template: string; slug: string }) {
  if (!target || !template) return null;
  const { url, kept } = previewUtm(target, template, { slug: slug || "your-slug", source: "linkedin", variant: "A" });
  const base = target.split("#")[0]!;
  const cut = url.length > target.length && url.startsWith(base) ? base.length : -1;
  return (
    <div className="settings-utm-preview">
      <p className="settings-utm-preview-label">Where a visitor from LinkedIn lands</p>
      <p className="settings-utm-url">
        {cut > 0 ? (
          <>
            <span className="settings-utm-url-base">{url.slice(0, cut)}</span>
            <mark>{url.slice(cut).split("#")[0]}</mark>
            {url.includes("#") ? <span className="settings-utm-url-base">#{url.split("#").slice(1).join("#")}</span> : null}
          </>
        ) : (
          url
        )}
      </p>
      {kept.length ? (
        <p className="settings-warn-text">
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
export function UtmBuilder({ id, value, onChange, target, slug }: { id: string; value: string; onChange: (template: string, problem: string | null) => void; target: string; slug: string }) {
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
    <div className="settings-utm">
      <div className="settings-tokens">
        <Braces aria-hidden />
        <span>Insert into the field you're in:</span>
        {UTM_PLACEHOLDERS.map((p) => (
          <button key={p.token} type="button" className="settings-token" title={p.description} aria-label={`Insert ${p.token}: ${p.description}`} onMouseDown={(e) => e.preventDefault()} onClick={() => insert(p.token)}>
            {p.token}
          </button>
        ))}
      </div>
      <div className="settings-grid-2">
        {UTM_FIELDS.map((f) => (
          <Input
            key={f.key}
            id={`${id}-${f.key}`}
            label={
              <span className="settings-utm-label">
                <span>{f.label}</span>
                <span className="settings-utm-key">{f.key}</span>
              </span>
            }
            hint={f.hint}
            value={parts.fields[f.key]}
            placeholder={f.example ? `e.g. ${f.example}` : "optional"}
            onChange={(e) => setField(f.key, e.target.value)}
            {...track((v) => setField(f.key, v))}
          />
        ))}
      </div>
      {parts.extra.length ? (
        <fieldset className="settings-extra">
          <legend className="ui-field-label">Other parameters</legend>
          {parts.extra.map((e, i) => (
            <div key={i} className="settings-extra-row">
              <Input className="settings-extra-key" hideLabel label={`Parameter ${i + 1} name`} placeholder="name" value={e.key} onChange={(ev) => setExtra(i, { key: ev.target.value })} />
              <span className="settings-extra-eq" aria-hidden>
                =
              </span>
              <Input
                className="settings-extra-value"
                hideLabel
                label={`Parameter ${i + 1} value`}
                placeholder="value"
                value={e.value}
                onChange={(ev) => setExtra(i, { value: ev.target.value })}
                {...track((v) => setExtra(i, { value: v }))}
              />
              <IconButton label={`Remove parameter ${e.key || i + 1}`} icon={X} size="sm" onClick={() => update({ ...parts, extra: parts.extra.filter((_, j) => j !== i) })} />
            </div>
          ))}
        </fieldset>
      ) : null}
      <div className="settings-utm-foot">
        <TextButton onClick={() => update({ ...parts, extra: [...parts.extra, { key: "", value: "" }] })}>Add another parameter</TextButton>
        {template ? (
          <button type="button" className="settings-copy-template" onClick={() => void copy(template, "Template copied")} title="Copy the template">
            <Copy aria-hidden />
            <span className="ui-sr">Copy the template: </span>
            <span className="settings-copy-template-text">{template}</span>
          </button>
        ) : null}
      </div>
      {problem ? (
        <p role="alert" className="ui-field-error">
          {problem}
        </p>
      ) : null}
      <UtmPreview target={target} template={template} slug={slug} />
    </div>
  );
}

function PresetDialog({ preset, onClose }: { preset: UtmPresetDTO | "new"; onClose: () => void }) {
  const qc = useQueryClient();
  const editing = preset !== "new";
  const [name, setName] = useState(editing ? preset.name : "");
  const [template, setTemplate] = useState(editing ? preset.template : "utm_source=&utm_medium=&utm_campaign={slug}");
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      editing
        ? call(api["utm-presets"][":id"].$put({ param: { id: String(preset.id) }, json: { name: name.trim(), template } }))
        : call(api["utm-presets"].$post({ json: { name: name.trim(), template } })),
    onSuccess: (r) => {
      qc.setQueryData(keys.utmPresets, r);
      toast.success(editing ? "Preset saved" : `Added the preset “${name.trim()}”`, editing && preset.links ? { description: `The ${num(preset.links)} links using a copy of it keep their own.` } : undefined);
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={editing ? `Edit “${preset.name}”` : "New UTM preset"}
      description="Apply it to any link in one click. Links get a copy, so editing a preset later doesn't change them."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => save.mutate()} disabled={!name.trim() || Boolean(problem) || !template} loading={save.isPending}>
            {editing ? "Save preset" : "Add preset"}
          </Button>
        </>
      }
    >
      <div className="settings-stack">
        <Input id="preset-name" label="Name" value={name} maxLength={PRESET_NAME_MAX} placeholder="e.g. LinkedIn organic" onChange={(e) => setName(e.target.value)} />
        <UtmBuilder
          id="preset"
          value={template}
          onChange={(t, p) => {
            setTemplate(t);
            setProblem(p);
          }}
          target={EXAMPLE_TARGET}
          slug="guide"
        />
      </div>
    </Dialog>
  );
}

function Suggestions({ items, onAdd, busy }: { items: typeof SUGGESTED; onAdd: (p: (typeof SUGGESTED)[number]) => void; busy: boolean }) {
  return (
    <>
      {items.map((p) => (
        <Button key={p.name} size="sm" icon={Plus} title={p.template} onClick={() => onAdd(p)} disabled={busy} aria-label={`Add the ${p.name} preset`}>
          {p.name}
        </Button>
      ))}
    </>
  );
}

/** Settings → UTM: the default template and the saved presets. */
export function UtmSection({ defaultUtm, onSaveDefault, saving }: { defaultUtm: string; onSaveDefault: (t: string) => void; saving: boolean }) {
  const qc = useQueryClient();
  const presets = useQuery({ queryKey: keys.utmPresets, queryFn: () => call(api["utm-presets"].$get()) });
  const [draft, setDraft] = useState(defaultUtm);
  const [problem, setProblem] = useState<string | null>(null);
  const [editing, setEditing] = useState<UtmPresetDTO | "new" | null>(null);
  const [deleting, setDeleting] = useState<UtmPresetDTO | null>(null);
  const list = presets.data?.presets ?? [];
  const suggestions = SUGGESTED.filter((sg) => !list.some((p) => p.name.toLowerCase() === sg.name.toLowerCase()));
  const dirty = draft !== defaultUtm;

  const add = useMutation({
    mutationFn: (p: { name: string; template: string }) => call(api["utm-presets"].$post({ json: p })),
    onSuccess: (r, p) => {
      qc.setQueryData(keys.utmPresets, r);
      toast.success(`Added the preset “${p.name}”`);
    },
    onError: (e) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (p: UtmPresetDTO) => call(api["utm-presets"][":id"].$delete({ param: { id: String(p.id) } })),
    onSuccess: (r, p) => {
      qc.setQueryData(keys.utmPresets, r);
      toast.success(`Deleted “${p.name}”`, p.links ? { description: "Links using a copy of it keep their parameters." } : undefined);
      setDeleting(null);
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <SettingsSection id="utm" title="UTM parameters" sub="Tags added to the destination when someone clicks, so analytics tools know where visits come from." help={SETTINGS_HELP.defaultUtm}>
      <div className="settings-split settings-split-utm">
        <div className="settings-stack">
          <div>
            <h3 className="settings-h3">Default template</h3>
            <p className="settings-note">For links with UTM on and no template of their own. Saving republishes those links.</p>
          </div>
          <UtmBuilder
            id="default-utm"
            value={draft}
            onChange={(t, p) => {
              setDraft(t);
              setProblem(p);
            }}
            target={EXAMPLE_TARGET}
            slug="guide"
          />
          <div className="settings-form-actions">
            {dirty ? (
              <Button variant="ghost" onClick={() => setDraft(defaultUtm)}>
                Undo changes
              </Button>
            ) : null}
            <Button variant={dirty ? "primary" : "secondary"} onClick={() => onSaveDefault(draft)} disabled={!dirty || Boolean(problem)} loading={saving}>
              Save default
            </Button>
          </div>
        </div>

        <div className="settings-stack settings-split-side">
          <div className="settings-subhead">
            <div>
              <h3 className="settings-h3">Presets</h3>
              <p className="settings-note">Apply to a link in one click from its UTM settings.</p>
            </div>
            <Button size="sm" icon={Plus} onClick={() => setEditing("new")} disabled={list.length >= MAX_PRESETS}>
              New preset
            </Button>
          </div>
          {presets.isPending ? (
            <SkeletonText lines={4} />
          ) : presets.isError && !presets.data ? (
            <ErrorState compact what="Presets" error={presets.error} onRetry={() => void presets.refetch()} retrying={presets.isFetching} />
          ) : list.length === 0 ? (
            <Empty compact title="No presets yet">
              <p>Start with a common one:</p>
              <div className="settings-actions settings-gap">
                <Suggestions items={suggestions} onAdd={(p) => add.mutate(p)} busy={add.isPending} />
              </div>
            </Empty>
          ) : (
            <ul className="settings-rows">
              {list.map((p) => (
                <li key={p.id} className="settings-row">
                  <div className="settings-row-main">
                    <p className="settings-row-title">
                      {p.name}
                      {p.links ? (
                        <span className="settings-row-meta">
                          {num(p.links)} {p.links === 1 ? "link" : "links"}
                        </span>
                      ) : null}
                    </p>
                    <TemplateChips template={p.template} />
                  </div>
                  <IconButton label={`Edit ${p.name}`} icon={Pencil} size="sm" onClick={() => setEditing(p)} />
                  <IconButton label={`Delete ${p.name}`} icon={Trash2} size="sm" onClick={() => setDeleting(p)} />
                </li>
              ))}
            </ul>
          )}
          {list.length && suggestions.length && list.length < MAX_PRESETS ? (
            <div className="settings-actions">
              <span className="settings-note">Suggestions:</span>
              <Suggestions items={suggestions} onAdd={(p) => add.mutate(p)} busy={add.isPending} />
            </div>
          ) : null}
        </div>
      </div>
      {editing ? <PresetDialog key={editing === "new" ? "new" : editing.id} preset={editing} onClose={() => setEditing(null)} /> : null}
      <Dialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        size="sm"
        title={`Delete “${deleting?.name ?? ""}”?`}
        description={deleting?.links ? `${num(deleting.links)} ${deleting.links === 1 ? "link uses" : "links use"} a copy of it and keep their parameters.` : "No link uses it right now."}
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => deleting && remove.mutate(deleting)} loading={remove.isPending}>
              Delete preset
            </Button>
          </>
        }
      />
    </SettingsSection>
  );
}
