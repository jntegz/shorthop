import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ImagePlus, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  DEFAULT_NOT_FOUND,
  HEX_COLOR_RE,
  NOT_FOUND_IMAGE_MAX_BYTES,
  NOT_FOUND_IMAGE_TYPES,
  NOT_FOUND_PREVIEW_PATH,
  renderNotFound,
  type NotFoundPage,
} from "../../shared/not-found";
import { notFoundSchema } from "../../shared/schemas";
import { api, call } from "../api";
import { Button, Card, CardHeader, Field, Input, Notice, Spinner, Textarea } from "./ui";

type Draft = Omit<NotFoundPage, "image">;
const COLORS = [
  ["background", "Page background"],
  ["card", "Card"],
  ["text", "Text"],
  ["accent", "Accent and button"],
] as const;
const QUERY_KEY = ["settings", "not-found"] as const;

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

/** Settings → Not-found page: text, colors and an image, with a live preview. */
export function NotFoundEditor({ domain }: { domain: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: QUERY_KEY, queryFn: () => call(api.settings["not-found"].$get()) });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
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
  const onSaved = (part: Partial<NotFoundPage>) => qc.setQueryData(QUERY_KEY, (old: typeof q.data) => (old ? { ...old, page: { ...old.page, ...part } } : old));

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
            { ...DEFAULT_NOT_FOUND, ...draft, ...Object.fromEntries(COLORS.map(([k]) => [k, HEX_COLOR_RE.test(draft[k]) ? draft[k] : DEFAULT_NOT_FOUND[k]])), image: null },
            { domain, address: `${domain}/example`, fallbackUrl: q.data.fallbackUrl, imageSrc },
          )
        : "",
    [draft, q.data, domain, imageSrc],
  );

  if (q.isError) return <Notice tone="danger">{q.error.message}</Notice>;
  if (q.isPending || !draft) {
    return (
      <Card className="lg:col-span-2">
        <CardHeader title="Not-found page" />
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      </Card>
    );
  }
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const dirty = JSON.stringify(draft) !== JSON.stringify(strip(saved!));
  const badColor = COLORS.find(([k]) => !HEX_COLOR_RE.test(draft[k]));
  const badUrl = !notFoundSchema.shape.buttonUrl.safeParse(draft.buttonUrl).success;

  return (
    <Card className="lg:col-span-2" id="not-found">
      <CardHeader
        title="Not-found page"
        description="What visitors see when a link doesn't exist, is disabled or has expired. One page for every short domain."
      />
      <div className="grid gap-6 px-4 pb-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <Field label="Heading" htmlFor="nf-heading" error={draft.heading.trim() ? null : "Add a heading"}>
            <Input id="nf-heading" maxLength={120} value={draft.heading} onChange={(e) => set("heading", e.target.value)} />
          </Field>
          <Field label="Message" htmlFor="nf-message" hint="Plain text; line breaks are kept.">
            <Textarea id="nf-message" rows={3} maxLength={600} value={draft.message} onChange={(e) => set("message", e.target.value)} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Button text" htmlFor="nf-label" hint="Leave empty to hide the button.">
              <Input id="nf-label" maxLength={60} value={draft.buttonLabel} onChange={(e) => set("buttonLabel", e.target.value)} />
            </Field>
            <Field label="Button link" htmlFor="nf-url" hint={`Empty uses ${q.data.fallbackUrl}`} error={badUrl ? "Use a full https:// address" : null}>
              <Input id="nf-url" type="url" placeholder={q.data.fallbackUrl} value={draft.buttonUrl} onChange={(e) => set("buttonUrl", e.target.value.trim())} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-4">
            {COLORS.map(([k, label]) => (
              <Field key={k} label={label} htmlFor={`nf-${k}`} error={HEX_COLOR_RE.test(draft[k]) ? null : "Use #rrggbb"}>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    aria-label={`${label} picker`}
                    value={HEX_COLOR_RE.test(draft[k]) ? draft[k] : DEFAULT_NOT_FOUND[k]}
                    onChange={(e) => set(k, e.target.value)}
                    className="h-9 w-11 shrink-0 cursor-pointer rounded-lg border border-line bg-bg p-1"
                  />
                  <Input id={`nf-${k}`} className="font-mono text-xs" maxLength={7} value={draft[k]} onChange={(e) => set(k, e.target.value.trim())} />
                </div>
              </Field>
            ))}
          </div>
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-fg">Image</p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={file}
                type="file"
                accept={NOT_FOUND_IMAGE_TYPES.join(",")}
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  if (f.size > NOT_FOUND_IMAGE_MAX_BYTES) return void toast.error("The image must be 512 KB or smaller");
                  upload.mutate(f);
                }}
              />
              <Button variant="outline" size="sm" onClick={() => file.current?.click()} loading={upload.isPending}>
                <ImagePlus /> {saved?.image ? "Replace image" : "Upload image"}
              </Button>
              {saved?.image ? (
                <Button variant="ghost" size="sm" onClick={() => removeImage.mutate()} loading={removeImage.isPending}>
                  <Trash2 /> Remove
                </Button>
              ) : null}
            </div>
            <p className="text-xs text-muted">PNG, JPEG, GIF or WebP, up to 512 KB. Shown above the heading instead of the large “404”. Saved right away.</p>
          </div>
          <div className="flex flex-wrap justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => setDraft({ ...strip(DEFAULT_NOT_FOUND) })}>
              <RotateCcw /> Restore defaults
            </Button>
            <Button variant="outline" onClick={() => setDraft(strip(saved!))} disabled={!dirty}>
              Discard
            </Button>
            <Button onClick={() => save.mutate(draft)} disabled={!dirty || Boolean(badColor) || badUrl || !draft.heading.trim()} loading={save.isPending}>
              Save
            </Button>
          </div>
        </div>
        <div className="min-w-0">
          <div className="mb-2 flex items-center justify-between text-xs text-muted">
            <span>Preview</span>
            <a href={`https://${domain}${NOT_FOUND_PREVIEW_PATH}`} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
              Open the live page
            </a>
          </div>
          <iframe title="Not-found page preview" sandbox="" srcDoc={html} className="h-[520px] w-full rounded-md border border-line bg-white" />
        </div>
      </div>
    </Card>
  );
}
