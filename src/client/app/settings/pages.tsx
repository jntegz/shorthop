// Settings → Links → the pages visitors see instead of a destination: the
// not-found page (text, colours, image) and the "link no longer working"
// page (both variants, where to send visitors and how soon), each with a live
// sandboxed preview.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, ImagePlus, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { DEAD_LINK_MAX_DELAY, DEAD_LINK_MIN_DELAY, DEFAULT_DEAD_LINK, normalizeDeadLink, renderDeadLink, type DeadLinkPage } from "../../../shared/dead-link";
import {
  DEFAULT_NOT_FOUND,
  HEX_COLOR_RE,
  normalizeNotFound,
  NOT_FOUND_IMAGE_MAX_BYTES,
  NOT_FOUND_IMAGE_TYPES,
  NOT_FOUND_PREVIEW_PATH,
  PAGE_COLOR_KEYS,
  renderNotFound,
  type NotFoundPage,
} from "../../../shared/not-found";
import { deadLinkSchema, notFoundSchema } from "../../../shared/schemas";
import { api, call } from "../../api";
import { Button, ErrorState, Input, Segmented, Switch, Textarea } from "../ui";
import { SectionSkeleton, SettingsSection } from "./common";
import { LinkPicker } from "./LinkPicker";

// ---------------- Not-found page ----------------

type Draft = Omit<NotFoundPage, "image">;
const COLORS = [
  ["background", "Page background"],
  ["card", "Card"],
  ["text", "Text"],
  ["accent", "Accent and button"],
] as const;
const DARK_COLORS = [
  ["darkBackground", "Page background"],
  ["darkCard", "Card"],
  ["darkText", "Text"],
  ["darkAccent", "Accent and button"],
] as const;
const NOT_FOUND_KEY = ["settings", "not-found"] as const;
const DEAD_LINK_KEY = ["settings", "dead-link"] as const;

function strip({ image: _, ...rest }: NotFoundPage): Draft {
  return rest;
}

function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** The preview frame: sandboxed (no scripts, no navigation), the page rendered as it will be served. */
function Preview({ title, html }: { title: string; html: string }) {
  return <iframe title={title} sandbox="" srcDoc={html} className="settings-frame" />;
}

type ColorKey = (typeof COLORS)[number][0] | (typeof DARK_COLORS)[number][0];

function ColorFields({ colors, draft, set, group }: { colors: typeof COLORS | typeof DARK_COLORS; draft: Draft; set: (k: ColorKey, v: string) => void; group: string }) {
  return (
    <fieldset className="settings-colors">
      <legend className="ui-sr">{group}</legend>
      {colors.map(([k, label]) => {
        const ok = HEX_COLOR_RE.test(draft[k]);
        return (
          <div key={k} className="ui-field" data-invalid={ok ? undefined : ""}>
            <label htmlFor={`nf-${k}`} className="ui-field-label">
              {label}
            </label>
            <div className="settings-color">
              <input type="color" aria-label={`${label} picker`} value={ok ? draft[k] : DEFAULT_NOT_FOUND[k]} onChange={(e) => set(k, e.target.value)} className="settings-swatch" />
              <input
                id={`nf-${k}`}
                className="ui-input settings-hex"
                maxLength={7}
                spellCheck={false}
                autoComplete="off"
                value={draft[k]}
                aria-invalid={ok ? undefined : true}
                aria-describedby={ok ? undefined : `nf-${k}-error`}
                onChange={(e) => set(k, e.target.value.trim())}
              />
            </div>
            {ok ? null : (
              <p id={`nf-${k}-error`} className="ui-field-error">
                Use #rrggbb
              </p>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}

/** Settings → Not-found page: text, colours and an image, with a live preview. */
export function NotFoundSection({ domain }: { domain: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: NOT_FOUND_KEY, queryFn: () => call(api.settings["not-found"].$get()) });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [scheme, setScheme] = useState<"light" | "dark">("light");
  const file = useRef<HTMLInputElement>(null);
  const saved = q.data?.page;

  useEffect(() => {
    if (saved && draft === null) setDraft(strip(saved));
  }, [saved, draft]);

  // The preview iframe is sandboxed, so the image goes in as a data: URL.
  useEffect(() => {
    let live = true;
    if (!saved?.image) return setImageSrc(null);
    api.settings["not-found"].image
      .$get()
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => (b ? readDataUrl(b) : null))
      .then((src) => live && setImageSrc(src))
      .catch(() => live && setImageSrc(null));
    return () => {
      live = false;
    };
  }, [saved?.image?.v]);

  /** Merges a saved part (settings or image) into the cached page. */
  const onSaved = (part: Partial<NotFoundPage>) => qc.setQueryData(NOT_FOUND_KEY, (old: typeof q.data) => (old ? { ...old, page: { ...old.page, ...part } } : old));

  const save = useMutation({
    mutationFn: (d: Draft) => call(api.settings["not-found"].$put({ json: d })),
    onSuccess: ({ settings }) => {
      onSaved(settings);
      setDraft(settings);
      toast.success("Not-found page saved", { description: "Visitors see it within about a minute." });
    },
    onError: (e) => toast.error(e.message),
  });

  const upload = useMutation({
    mutationFn: (f: File) => call(api.settings["not-found"].image.$put({ form: { file: f } })),
    onSuccess: ({ image }) => {
      onSaved({ image });
      toast.success("Image uploaded");
    },
    onError: (e) => toast.error(e.message),
  });

  const removeImage = useMutation({
    mutationFn: () => call(api.settings["not-found"].image.$delete()),
    onSuccess: () => {
      onSaved({ image: null });
      toast.success("Image removed");
    },
    onError: (e) => toast.error(e.message),
  });

  const html = useMemo(
    () =>
      draft && q.data
        ? renderNotFound(
            { ...DEFAULT_NOT_FOUND, ...draft, ...Object.fromEntries(PAGE_COLOR_KEYS.map((k) => [k, HEX_COLOR_RE.test(draft[k]) ? draft[k] : DEFAULT_NOT_FOUND[k]])), image: null },
            { domain, address: `${domain}/example`, fallbackUrl: q.data.fallbackUrl, imageSrc, scheme },
          )
        : "",
    [draft, q.data, domain, imageSrc, scheme],
  );

  const title = "Not-found page";
  if (q.isError && !q.data)
    return (
      <SettingsSection id="not-found" title={title}>
        <ErrorState what="The not-found page" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      </SettingsSection>
    );
  if (q.isPending || !draft || !saved) return <SectionSkeleton id="not-found" title={title} lines={6} tall />;

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const dirty = JSON.stringify(draft) !== JSON.stringify(strip(saved));
  const badColor = PAGE_COLOR_KEYS.find((k) => !HEX_COLOR_RE.test(draft[k]));
  const badUrl = !notFoundSchema.shape.buttonUrl.safeParse(draft.buttonUrl).success;

  return (
    <SettingsSection id="not-found" title={title} sub="What visitors see when a link doesn't exist, is disabled or has expired. One page for every short domain.">
      <div className="settings-split settings-split-preview">
        <div className="settings-stack">
          <Input id="nf-heading" label="Heading" maxLength={120} value={draft.heading} onChange={(e) => set("heading", e.target.value)} error={draft.heading.trim() ? null : "Add a heading"} />
          <Textarea id="nf-message" label="Message" hint="Plain text; line breaks are kept." rows={3} maxLength={600} value={draft.message} onChange={(e) => set("message", e.target.value)} />
          <div className="settings-grid-2">
            <Input id="nf-label" label="Button text" hint="Leave empty to hide the button." maxLength={60} value={draft.buttonLabel} onChange={(e) => set("buttonLabel", e.target.value)} />
            <Input
              id="nf-url"
              label="Button link"
              type="url"
              hint={`Empty uses ${q.data.fallbackUrl}`}
              error={badUrl ? "Use a full https:// address" : null}
              placeholder={q.data.fallbackUrl}
              value={draft.buttonUrl}
              onChange={(e) => set("buttonUrl", e.target.value.trim())}
            />
          </div>
          <div>
            <h3 className="settings-h4">Colours</h3>
            <ColorFields colors={COLORS} draft={draft} set={set} group="Colours" />
          </div>
          <div className="settings-group">
            <Switch
              id="nf-dark"
              label="Dark version"
              description="For visitors whose device is set to dark mode. Also used by the “no longer working” and password pages."
              checked={draft.dark}
              onCheckedChange={(v) => {
                set("dark", v);
                if (v) setScheme("dark");
              }}
            />
            {draft.dark ? <ColorFields colors={DARK_COLORS} draft={draft} set={set} group="Dark version colours" /> : <p className="settings-note">Everyone sees the colours above.</p>}
          </div>
          <div className="settings-group">
            <h3 className="settings-h4">Image</h3>
            <div className="settings-actions">
              <input
                ref={file}
                type="file"
                accept={NOT_FOUND_IMAGE_TYPES.join(",")}
                hidden
                aria-label="Image file"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  if (f.size > NOT_FOUND_IMAGE_MAX_BYTES) return void toast.error("The image must be 512 KB or smaller");
                  upload.mutate(f);
                }}
              />
              <Button size="sm" icon={ImagePlus} onClick={() => file.current?.click()} loading={upload.isPending}>
                {saved.image ? "Replace image" : "Upload image"}
              </Button>
              {saved.image ? (
                <Button variant="ghost" size="sm" icon={Trash2} onClick={() => removeImage.mutate()} loading={removeImage.isPending}>
                  Remove
                </Button>
              ) : null}
            </div>
            <p className="settings-note">PNG, JPEG, GIF or WebP, up to 512 KB. Shown above the heading instead of the large “404”. Saved right away.</p>
          </div>
          <div className="settings-form-actions">
            <Button variant="ghost" icon={RotateCcw} onClick={() => setDraft({ ...strip(DEFAULT_NOT_FOUND) })}>
              Restore defaults
            </Button>
            <Button onClick={() => setDraft(strip(saved))} disabled={!dirty}>
              Discard
            </Button>
            <Button variant={dirty ? "primary" : "secondary"} onClick={() => save.mutate(draft)} disabled={!dirty || Boolean(badColor) || badUrl || !draft.heading.trim()} loading={save.isPending}>
              Save
            </Button>
          </div>
        </div>
        <div className="settings-preview">
          <div className="settings-preview-bar">
            <Segmented<"light" | "dark">
              label="Preview"
              size="sm"
              value={draft.dark ? scheme : "light"}
              onChange={setScheme}
              options={[{ value: "light", label: "Light" }, ...(draft.dark ? [{ value: "dark" as const, label: "Dark" }] : [])]}
            />
            <a className="ui-panel-link settings-ext" href={`https://${domain}${NOT_FOUND_PREVIEW_PATH}`} target="_blank" rel="noopener noreferrer">
              Open the live page
              <ArrowUpRight aria-hidden />
              <span className="ui-sr"> (opens in a new tab)</span>
            </a>
          </div>
          <Preview title="Not-found page preview" html={html} />
        </div>
      </div>
    </SettingsSection>
  );
}

// ---------------- Link no longer working ----------------

type Variant = "replaced" | "gone";

/** Settings → "Link no longer working" page: the wording of both variants, where to send visitors, and how soon. */
export function DeadLinkSection({ domain }: { domain: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: DEAD_LINK_KEY, queryFn: () => call(api.settings["dead-link"].$get()) });
  // Shared with the not-found page: the colours come from there.
  const style = useQuery({ queryKey: NOT_FOUND_KEY, queryFn: () => call(api.settings["not-found"].$get()) });
  const [draft, setDraft] = useState<DeadLinkPage | null>(null);
  const [variant, setVariant] = useState<Variant>("replaced");
  const [scheme, setScheme] = useState<"light" | "dark">("light");
  // Which of your links the "with replacement" preview points to ("domain/slug", "" for a placeholder).
  const [sample, setSample] = useState("");
  const saved = q.data?.page;

  useEffect(() => {
    if (saved && draft === null) setDraft(saved);
  }, [saved, draft]);

  const save = useMutation({
    mutationFn: (d: DeadLinkPage) => call(api.settings["dead-link"].$put({ json: d })),
    onSuccess: ({ page }) => {
      qc.setQueryData(DEAD_LINK_KEY, (old: typeof q.data) => (old ? { ...old, page } : old));
      setDraft(page);
      toast.success("“Link no longer working” page saved", { description: "Visitors see it within about a minute." });
    },
    onError: (e) => toast.error(e.message),
  });

  // Same rule as the Worker's deadLinkRedirectUrl, from the not-found settings as they're saved.
  const defaultRedirect = style.data ? style.data.page.buttonUrl || style.data.fallbackUrl : (q.data?.defaultRedirectUrl ?? "");
  const html = useMemo(() => {
    if (!draft || !style.data) return "";
    const page = normalizeDeadLink(draft);
    return renderDeadLink(
      page,
      { ...normalizeNotFound(style.data.page), image: null },
      { domain, address: `${domain}/old-link`, imageSrc: null, scheme },
      variant === "replaced" ? { kind: "replaced", href: "#", label: sample || `${domain}/new-link` } : { kind: "gone", redirectUrl: page.redirectUrl || defaultRedirect },
    )
      // The preview never navigates away on its own.
      .replace(/<meta http-equiv="refresh"[^>]*>\n?/, "");
  }, [draft, style.data, domain, variant, defaultRedirect, sample, scheme]);

  const title = "“Link no longer working” page";
  if (q.isError && !q.data)
    return (
      <SettingsSection id="dead-link" title={title}>
        <ErrorState what="The “link no longer working” page" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      </SettingsSection>
    );
  if (q.isPending || !draft || !saved) return <SectionSkeleton id="dead-link" title={title} lines={6} tall />;

  const set = <K extends keyof DeadLinkPage>(k: K, v: DeadLinkPage[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const check = deadLinkSchema.safeParse(draft);
  const badUrl = !deadLinkSchema.shape.redirectUrl.safeParse(draft.redirectUrl).success;
  const badDelay = !deadLinkSchema.shape.delaySeconds.safeParse(draft.delaySeconds).success;

  const groupHead = (v: Variant, heading: string, body: string) => (
    <div className="settings-subhead">
      <div>
        <h3 className="settings-h3">{heading}</h3>
        <p className="settings-note">{body}</p>
      </div>
      {variant === v ? (
        <span className="settings-aside-note">In the preview</span>
      ) : (
        <button type="button" className="ui-panel-link" onClick={() => setVariant(v)}>
          Preview this
        </button>
      )}
    </div>
  );

  return (
    <SettingsSection id="dead-link" title={title} sub="What visitors see for a link you've marked as no longer working (in the link's settings). Uses the colours of the not-found page.">
      <div className="settings-split settings-split-preview">
        <div className="settings-stack">
          <div className="settings-variant" data-active={variant === "replaced" || undefined} onFocus={() => setVariant("replaced")} onClick={() => setVariant("replaced")}>
            {groupHead("replaced", "With a replacement link", "Shown when the link has a replacement. You pick the replacement for each link in its settings (Edit → Replacement link), not here.")}
            <Input id="dl-r-heading" label="Heading" maxLength={120} value={draft.replacedHeading} onChange={(e) => set("replacedHeading", e.target.value)} error={draft.replacedHeading.trim() ? null : "Add a heading"} />
            <Textarea id="dl-r-message" label="Message" hint="Shown above the button to the replacement link." rows={3} maxLength={600} value={draft.replacedMessage} onChange={(e) => set("replacedMessage", e.target.value)} />
            <Input id="dl-r-button" label="Button text" maxLength={60} value={draft.replacedButton} onChange={(e) => set("replacedButton", e.target.value)} error={draft.replacedButton.trim() ? null : "Add a button label"} />
            <LinkPicker
              id="dl-sample"
              label="Preview with"
              hint="Only changes the preview, so you can see the page with one of your links."
              value={sample}
              onChange={(k) => setSample(k)}
              emptyLabel={`Example: ${domain}/new-link`}
            />
          </div>

          <div className="settings-variant" data-active={variant === "gone" || undefined} onFocus={() => setVariant("gone")} onClick={() => setVariant("gone")}>
            {groupHead("gone", "Without a replacement", "Shown when the link has no replacement, or the replacement no longer works. Visitors are sent on automatically.")}
            <Input id="dl-g-heading" label="Heading" maxLength={120} value={draft.goneHeading} onChange={(e) => set("goneHeading", e.target.value)} error={draft.goneHeading.trim() ? null : "Add a heading"} />
            <Textarea id="dl-g-message" label="Message" hint="{seconds} becomes the delay below." rows={3} maxLength={600} value={draft.goneMessage} onChange={(e) => set("goneMessage", e.target.value)} />
            <div className="settings-grid-2">
              <Input id="dl-g-button" label="Button text" hint="Leave empty to hide the button." maxLength={60} value={draft.goneButton} onChange={(e) => set("goneButton", e.target.value)} />
              <Input
                id="dl-delay"
                label="Redirect after (seconds)"
                type="number"
                inputMode="numeric"
                min={DEAD_LINK_MIN_DELAY}
                max={DEAD_LINK_MAX_DELAY}
                error={badDelay ? `Between ${DEAD_LINK_MIN_DELAY} and ${DEAD_LINK_MAX_DELAY} seconds` : null}
                value={Number.isFinite(draft.delaySeconds) ? draft.delaySeconds : ""}
                onChange={(e) => set("delaySeconds", e.target.valueAsNumber)}
              />
            </div>
            <Input
              id="dl-url"
              label="Redirect to"
              type="url"
              hint={`Empty uses the not-found page's button link: ${defaultRedirect}`}
              error={badUrl ? "Use a full https:// address" : null}
              placeholder={defaultRedirect}
              value={draft.redirectUrl}
              onChange={(e) => set("redirectUrl", e.target.value.trim())}
            />
          </div>

          <div className="settings-form-actions">
            <Button variant="ghost" icon={RotateCcw} onClick={() => setDraft({ ...DEFAULT_DEAD_LINK })}>
              Restore defaults
            </Button>
            <Button onClick={() => setDraft(saved)} disabled={!dirty}>
              Discard
            </Button>
            <Button variant={dirty ? "primary" : "secondary"} onClick={() => check.success && save.mutate(check.data)} disabled={!dirty || !check.success} loading={save.isPending}>
              Save
            </Button>
          </div>
        </div>
        <div className="settings-preview">
          <div className="settings-preview-bar">
            <Segmented<Variant>
              value={variant}
              onChange={setVariant}
              label="Preview variant"
              size="sm"
              options={[
                { value: "replaced", label: "With replacement" },
                { value: "gone", label: "No replacement" },
              ]}
            />
            {style.data?.page.dark ? (
              <Segmented<"light" | "dark">
                label="Preview colours"
                size="sm"
                value={scheme}
                onChange={setScheme}
                options={[
                  { value: "light", label: "Light" },
                  { value: "dark", label: "Dark" },
                ]}
              />
            ) : null}
          </div>
          <p className="settings-note">Preview (doesn't change any link)</p>
          {style.isError && !style.data ? (
            <ErrorState compact what="The preview" error={style.error} onRetry={() => void style.refetch()} retrying={style.isFetching} />
          ) : (
            <Preview title="“Link no longer working” page preview" html={html} />
          )}
        </div>
      </div>
    </SettingsSection>
  );
}
