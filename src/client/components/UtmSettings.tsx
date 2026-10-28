import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bookmark, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { UtmPresetDTO } from "../../shared/types";
import { MAX_PRESETS, PRESET_NAME_MAX } from "../../shared/utm";
import { api, call, keys } from "../api";
import { num } from "../lib/format";
import { SETTINGS_HELP } from "../lib/help";
import { TemplateChips } from "./LinkUtm";
import { UtmBuilder } from "./UtmBuilder";
import { Button, Card, CardHeader, Dialog, Empty, Field, Input } from "./ui";

/** One-click starting points when there are no presets yet. */
const SUGGESTED = [
  { name: "LinkedIn", template: "utm_source=linkedin&utm_medium=social&utm_campaign={slug}" },
  { name: "Newsletter", template: "utm_source=newsletter&utm_medium=email&utm_campaign={slug}" },
  { name: "QR print", template: "utm_source=print&utm_medium=qr&utm_campaign={slug}" },
  { name: "A/B test", template: "utm_source={source}&utm_medium=shortlink&utm_campaign={slug}&utm_content={variant}" },
];

const EXAMPLE_TARGET = "https://example.com/guide";

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
    <Dialog open onOpenChange={(o) => !o && onClose()} title={editing ? `Edit “${preset.name}”` : "New UTM preset"} description="Apply it to any link in one click. Links get a copy, so editing a preset later doesn't change them." wide>
      <div className="space-y-4">
        <Field label="Name" htmlFor="preset-name">
          <Input id="preset-name" value={name} maxLength={PRESET_NAME_MAX} placeholder="e.g. LinkedIn organic" onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
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
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={!name.trim() || Boolean(problem) || !template} loading={save.isPending}>
            {editing ? "Save preset" : "Add preset"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function Suggestions({ items, onAdd, busy }: { items: typeof SUGGESTED; onAdd: (p: (typeof SUGGESTED)[number]) => void; busy: boolean }) {
  return (
    <>
      {items.map((p) => (
        <button key={p.name} type="button" title={p.template} onClick={() => onAdd(p)} disabled={busy} className="rounded-full border border-line bg-surface px-2.5 py-1 text-xs font-medium text-fg hover:border-accent/50 hover:text-accent disabled:opacity-60">
          + {p.name}
        </button>
      ))}
    </>
  );
}

/** Settings → UTM: the default template and the saved presets. */
export function UtmSettings({ defaultUtm, onSaveDefault, saving }: { defaultUtm: string; onSaveDefault: (t: string) => void; saving: boolean }) {
  const qc = useQueryClient();
  const presets = useQuery({ queryKey: keys.utmPresets, queryFn: () => call(api["utm-presets"].$get()) });
  const [draft, setDraft] = useState(defaultUtm);
  const [problem, setProblem] = useState<string | null>(null);
  const [editing, setEditing] = useState<UtmPresetDTO | "new" | null>(null);
  const [deleting, setDeleting] = useState<UtmPresetDTO | null>(null);
  const list = presets.data?.presets ?? [];
  const suggestions = SUGGESTED.filter((sg) => !list.some((p) => p.name.toLowerCase() === sg.name.toLowerCase()));

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
    <Card id="utm" className="scroll-mt-6 lg:col-span-2">
      <CardHeader title="UTM parameters" description="Tags added to the destination when someone clicks, so analytics tools know where visits come from." info={SETTINGS_HELP.defaultUtm} />
      <div className="grid gap-6 px-4 pb-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-fg">Default template</h3>
            <p className="mt-0.5 text-xs text-muted">For links with UTM on and no template of their own. Saving republishes those links.</p>
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
          <div className="flex justify-end gap-2">
            {draft !== defaultUtm ? (
              <Button variant="ghost" onClick={() => setDraft(defaultUtm)}>
                Undo changes
              </Button>
            ) : null}
            <Button onClick={() => onSaveDefault(draft)} disabled={draft === defaultUtm || Boolean(problem)} loading={saving}>
              Save default
            </Button>
          </div>
        </div>

        <div className="space-y-3 lg:border-l lg:border-line lg:pl-6">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-fg">Presets</h3>
              <p className="mt-0.5 text-xs text-muted">Apply to a link in one click from its UTM settings.</p>
            </div>
            <Button size="sm" variant="outline" onClick={() => setEditing("new")} disabled={list.length >= MAX_PRESETS}>
              <Plus /> New
            </Button>
          </div>
          {presets.isPending ? null : list.length === 0 ? (
            <div className="rounded-md border border-dashed border-line">
              <Empty icon={<Bookmark />} title="No presets yet">
                <p>Start with a common one:</p>
                <div className="mt-3 flex flex-wrap justify-center gap-1.5">
                  <Suggestions items={suggestions} onAdd={(p) => add.mutate(p)} busy={add.isPending} />
                </div>
              </Empty>
            </div>
          ) : (
            <ul className="divide-y divide-line rounded-md border border-line">
              {list.map((p) => (
                <li key={p.id} className="flex items-start gap-2 px-3 py-2.5">
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="text-sm font-medium text-fg">
                      {p.name}
                      {p.links ? <span className="ml-2 text-xs font-normal text-muted">{num(p.links)} {p.links === 1 ? "link" : "links"}</span> : null}
                    </p>
                    <TemplateChips template={p.template} />
                  </div>
                  <Button variant="ghost" size="icon-sm" aria-label={`Edit ${p.name}`} onClick={() => setEditing(p)}>
                    <Pencil />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label={`Delete ${p.name}`} onClick={() => setDeleting(p)}>
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {list.length && suggestions.length && list.length < MAX_PRESETS ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted">Suggestions:</span>
              <Suggestions items={suggestions} onAdd={(p) => add.mutate(p)} busy={add.isPending} />
            </div>
          ) : null}
        </div>
      </div>
      {editing ? <PresetDialog key={editing === "new" ? "new" : editing.id} preset={editing} onClose={() => setEditing(null)} /> : null}
      <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)} title={`Delete “${deleting?.name ?? ""}”?`} description={deleting?.links ? `${num(deleting.links)} ${deleting.links === 1 ? "link uses" : "links use"} a copy of it and keep their parameters.` : "No link uses it right now."}>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setDeleting(null)}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => deleting && remove.mutate(deleting)} loading={remove.isPending}>
            Delete preset
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}
