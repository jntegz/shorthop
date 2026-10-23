import { ChevronDown, Link2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { validateSlug } from "../../shared/slug";
import { normalizeTarget, validateUtmTemplate } from "../../shared/target";
import type { LinkDTO } from "../../shared/types";
import { api, call, keys, linkFromError } from "../api";
import { fromLocalInput, toLocalInput } from "../lib/format";
import { LINK_HELP } from "../lib/help";
import { linkKey, linkState, useDomains, useLinkLabel } from "../lib/links";
import { copy } from "../lib/utils";
import { Button, Dialog, Field, Input, Select, Switch, Textarea } from "./ui";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit this link; omit to create a new one. */
  link?: LinkDTO;
  /** Prefill the slug when creating (e.g. from the misses report). */
  initialSlug?: string;
  /** Prefill the domain when creating; defaults to the primary domain. */
  initialDomain?: string;
  onSaved?: (link: LinkDTO) => void;
}

interface FormState {
  /** Empty means the primary domain. */
  domain: string;
  target: string;
  slug: string;
  title: string;
  tags: string;
  notes: string;
  expires: string;
  active: boolean;
  utm: boolean;
  utmTemplate: string;
  passQuery: boolean;
  broken: boolean;
  /** "domain/slug" of the replacement, or "" for none. */
  replacement: string;
}

function initial(link?: LinkDTO, slug = "", domain = ""): FormState {
  return {
    domain: link?.domain ?? domain,
    target: link?.target ?? "",
    slug: link?.slug ?? slug,
    title: link?.title ?? "",
    tags: link?.tags.join(", ") ?? "",
    notes: link?.notes ?? "",
    expires: toLocalInput(link?.expiresAt ?? null),
    active: link?.active ?? true,
    utm: link?.utm ?? false,
    utmTemplate: link?.utmTemplate ?? "",
    passQuery: link?.passQuery ?? false,
    broken: link?.broken ?? false,
    replacement: link?.replacement ? linkKey(link.replacement.domain, link.replacement.slug) : "",
  };
}

export function LinkForm({ open, onOpenChange, link, initialSlug, initialDomain, onSaved }: Props) {
  const qc = useQueryClient();
  const editing = Boolean(link);
  const { domains, primary, multiple } = useDomains();
  const label = useLinkLabel();
  const [f, setF] = useState<FormState>(() => initial(link, initialSlug, initialDomain));
  const [touched, setTouched] = useState(false);
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => {
    if (open) {
      setF(initial(link, initialSlug, initialDomain));
      setTouched(false);
      setAdvanced(Boolean(link));
    }
  }, [open, link, initialSlug, initialDomain]);

  const domain = f.domain || primary;

  // Replacement choices: links that work right now (plus the current choice, so it stays visible).
  const candidates = useQuery({
    queryKey: keys.links({ picker: true }),
    queryFn: () => call(api.links.$get({ query: { sort: "slug", period: "7d" } })),
    enabled: open && editing && f.broken,
  });
  const replacementOptions = (candidates.data?.links ?? []).filter(
    (l) => !(link && l.domain === link.domain && l.slug === link.slug) && (linkState(l) === "active" || linkKey(l.domain, l.slug) === f.replacement),
  );

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));

  const targetCheck = f.target ? normalizeTarget(f.target, { allowHttp: link?.source === "import", selfHosts: domains }) : null;
  const errors = {
    target: !f.target ? "Enter the destination URL." : targetCheck && !targetCheck.ok ? targetCheck.error : null,
    slug: !editing && f.slug ? validateSlug(f.slug, "native") : null,
    utmTemplate: f.utm && f.utmTemplate ? validateUtmTemplate(f.utmTemplate) : null,
  };
  const valid = !errors.target && !errors.slug && !errors.utmTemplate;

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        target: f.target.trim(),
        title: f.title.trim() || null,
        tags: f.tags,
        notes: f.notes,
        expiresAt: fromLocalInput(f.expires),
        active: f.active,
        utm: f.utm,
        utmTemplate: f.utm && f.utmTemplate.trim() ? f.utmTemplate.trim() : null,
        passQuery: f.passQuery,
      };
      if (link) {
        const cut = f.replacement.indexOf("/");
        const replacement = f.broken && cut > 0 ? { domain: f.replacement.slice(0, cut), slug: f.replacement.slice(cut + 1) } : null;
        const json = { ...body, broken: f.broken, replacement };
        return (await call(api.links[":domain"][":slug"].$patch({ param: { domain: link.domain, slug: link.slug }, json }))).link;
      }
      return (await call(api.links.$post({ json: { ...body, domain: domain || undefined, slug: f.slug.trim() || undefined } }))).link;
    },
    onSuccess: (saved) => {
      void qc.invalidateQueries({ queryKey: keys.allLinks });
      qc.setQueryData(keys.link(saved.domain, saved.slug), { link: saved });
      toast.success(editing ? "Link updated" : "Link created", {
        description: "Live worldwide within about a minute.",
        action: editing ? undefined : { label: "Copy", onClick: () => void copy(saved.shortUrl) },
      });
      onSaved?.(saved);
      onOpenChange(false);
    },
    onError: (err) => {
      const saved = linkFromError(err);
      if (saved) {
        void qc.invalidateQueries({ queryKey: keys.allLinks });
        toast.warning("Saved, but not published yet", { description: "Run “Republish all links” in Settings." });
        onSaved?.(saved);
        onOpenChange(false);
        return;
      }
      toast.error(err instanceof Error ? err.message : "Couldn't save the link");
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (errors.utmTemplate) setAdvanced(true);
    if (valid && !save.isPending) save.mutate();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={link ? `Edit ${label(link)}` : "Create a new link"}
      description={editing ? "Update your destination and link preferences." : "A shorter link. A lasting connection."}
      wide
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Destination URL" htmlFor="target" hint="Where should this link take people?" info={LINK_HELP.target} error={touched || f.target ? errors.target : null}>
          <Input
            id="target"
            type="url"
            aria-required="true"
            aria-invalid={Boolean((touched || f.target) && errors.target)}
            inputMode="url"
            autoFocus={!editing}
            placeholder="https://example.com/…"
            value={f.target}
            onChange={(e) => set("target", e.target.value)}
          />
        </Field>

        {!editing ? (
          <Field
            label="Domain"
            htmlFor="domain"
            info={LINK_HELP.domain}
            hint={
              multiple ? (
                "Each domain has its own short links."
              ) : (
                <>
                  Your only short domain so far.{" "}
                  <Link to="/settings#domains" className="font-medium text-accent hover:underline" onClick={() => onOpenChange(false)}>
                    Add another domain
                  </Link>
                </>
              )
            }
          >
            <Select id="domain" value={domain} onChange={(e) => set("domain", e.target.value)} disabled={!multiple}>
              {(domains.length ? domains : [domain || "sh.example"]).map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        {!editing ? (
          <Field label="Custom slug (your own link ending)" htmlFor="slug" hint={`Optional. Type your own word or phrase to go after ${domain || "sh.example"}/, e.g. webinar-2026. Leave blank for a random one.`} error={errors.slug} info={LINK_HELP.slug}>
            <div className="flex items-center overflow-hidden rounded-lg border border-line bg-bg focus-within:ring-2 focus-within:ring-accent/25"><span className="flex shrink-0 items-center gap-2 pl-3 text-sm text-muted"><Link2 className="size-4" />{domain || "sh.example"}/</span><Input id="slug" className="border-0 bg-transparent shadow-none focus:ring-0" placeholder="type-your-own-slug" value={f.slug} onChange={(e) => set("slug", e.target.value)} autoComplete="off" aria-invalid={Boolean(errors.slug)} /></div>
          </Field>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Title" htmlFor="title" hint="Only shown here in the admin" info={LINK_HELP.title}>
            <Input id="title" value={f.title} onChange={(e) => set("title", e.target.value)} />
          </Field>
          <Field label="Tags" htmlFor="tags" hint="Comma-separated" info={LINK_HELP.tags}>
            <Input id="tags" placeholder="linkedin, ebook" value={f.tags} onChange={(e) => set("tags", e.target.value)} />
          </Field>
        </div>

        <details open={advanced} onToggle={(e) => setAdvanced(e.currentTarget.open)} className="group rounded-xl border border-line bg-bg">
          <summary className="flex list-none items-center justify-between px-4 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">Link settings <span className="ml-auto mr-3 text-xs font-normal text-muted">Tracking, expiry & notes</span><ChevronDown className="size-4 transition-transform group-open:rotate-180" /></summary>
          <div className="space-y-4 border-t border-line p-4">
        <Field label="Notes" htmlFor="notes" info={LINK_HELP.notes}>
          <Textarea id="notes" rows={2} value={f.notes} onChange={(e) => set("notes", e.target.value)} />
        </Field>

        <Field label="Expires" htmlFor="expires" hint="After this moment the link shows the “not found” page. Leave empty to keep it forever." info={LINK_HELP.expires}>
          <div className="flex gap-2">
            <Input id="expires" type="datetime-local" value={f.expires} onChange={(e) => set("expires", e.target.value)} />
            {f.expires ? (
              <Button type="button" variant="outline" onClick={() => set("expires", "")}>
                Clear
              </Button>
            ) : null}
          </div>
        </Field>

        <div className="space-y-4 rounded-lg border border-line p-4">
          <Switch id="active" checked={f.active} onCheckedChange={(v) => set("active", v)} label="Active" description="Disabled links show the “not found” page." info={LINK_HELP.active} />
          {editing ? (
            <Switch
              id="broken"
              checked={f.broken}
              onCheckedChange={(v) => set("broken", v)}
              label="Link no longer working"
              description="Visitors see a notice instead of the destination, pointing them to a replacement link if you choose one."
              info={LINK_HELP.broken}
            />
          ) : null}
          {editing && f.broken ? (
            <Field
              label="Replacement link"
              htmlFor="replacement"
              hint={
                <>
                  Without one, visitors are sent to the site set in{" "}
                  <Link to="/settings#dead-link" className="font-medium text-accent hover:underline" onClick={() => onOpenChange(false)}>
                    Settings
                  </Link>{" "}
                  after a few seconds.
                </>
              }
              info={LINK_HELP.replacement}
            >
              <Select id="replacement" value={f.replacement} onChange={(e) => set("replacement", e.target.value)} disabled={candidates.isPending}>
                <option value="">{candidates.isPending ? "Loading links…" : "None: redirect to the site in Settings"}</option>
                {f.replacement && !replacementOptions.some((l) => linkKey(l.domain, l.slug) === f.replacement) && !candidates.isPending ? (
                  <option value={f.replacement}>{f.replacement} (deleted)</option>
                ) : null}
                {replacementOptions.map((l) => {
                  const key = linkKey(l.domain, l.slug);
                  const state = linkState(l);
                  return (
                    <option key={key} value={key}>
                      {label(l)}
                      {l.title ? ` · ${l.title}` : ""}
                      {state === "active" ? "" : ` (${state === "broken" ? "not working" : state})`}
                    </option>
                  );
                })}
              </Select>
            </Field>
          ) : null}
          <Switch
            id="utm"
            checked={f.utm}
            onCheckedChange={(v) => set("utm", v)}
            label="Add UTM parameters"
            description="Appends the UTM template on redirect. Existing UTM values in the target are kept."
            info={LINK_HELP.utm}
          />
          {f.utm ? (
            <Field label="Custom UTM template" htmlFor="utmTemplate" hint="Leave empty to use the default from Settings. Placeholders: {slug}, {source}, {domain}." error={errors.utmTemplate} info={LINK_HELP.utmTemplate}>
              <Input
                id="utmTemplate"
                className="font-mono text-xs"
                placeholder="utm_source={domain}&utm_campaign={slug}"
                value={f.utmTemplate}
                onChange={(e) => set("utmTemplate", e.target.value)}
              />
            </Field>
          ) : null}
          <Switch
            id="passQuery"
            checked={f.passQuery}
            onCheckedChange={(v) => set("passQuery", v)}
            label="Pass query parameters through"
            description="Forwards extra ?params from the short link (except s and q=1) to the destination."
            info={LINK_HELP.passQuery}
          />
        </div>

          </div>
        </details>
        <div className="flex items-center justify-end gap-2 border-t border-line pt-4">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" loading={save.isPending} disabled={touched && !valid}>
            {editing ? "Save changes" : "Create link"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
