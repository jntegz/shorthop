import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, ArrowUpRight, DownloadCloud, ImagePlus, Link2, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { toast } from "sonner";
import {
  PREVIEW_DESCRIPTION_MAX,
  PREVIEW_DESCRIPTION_SHOWN,
  PREVIEW_IMAGE_IDEAL,
  PREVIEW_IMAGE_MAX_BYTES,
  PREVIEW_IMAGE_MIN,
  PREVIEW_IMAGE_PATH,
  PREVIEW_IMAGE_TYPES,
  PREVIEW_TITLE_MAX,
  PREVIEW_TITLE_SHOWN,
  type LinkPreview,
  type PreviewProblem,
} from "../../shared/preview";
import { api, call, uploadPreviewImage } from "../api";
import { cn } from "../lib/utils";
import { Button, Input, Segmented, Textarea } from "./ui";

type Platform = "linkedin" | "x" | "slack";

function imageSrc(p: LinkPreview): string | null {
  if (!p.image) return null;
  return p.image.kind === "upload" ? `${PREVIEW_IMAGE_PATH}${p.image.key}` : p.image.url;
}

/** The image's real size: from the upload, or measured in the browser for a URL. */
function useImageSize(p: LinkPreview): { width: number; height: number } | null | "loading" | "error" {
  const src = imageSrc(p);
  const known = p.image?.kind === "upload" && p.image.width && p.image.height ? { width: p.image.width, height: p.image.height } : null;
  const [measured, setMeasured] = useState<{ src: string; size: { width: number; height: number } | "error" } | null>(null);
  useEffect(() => {
    if (!src || known) return;
    const img = new Image();
    img.onload = () => setMeasured({ src, size: { width: img.naturalWidth, height: img.naturalHeight } });
    img.onerror = () => setMeasured({ src, size: "error" });
    img.src = src;
  }, [src, known]);
  if (!src) return null;
  if (known) return known;
  return measured?.src === src ? measured.size : "loading";
}

function Counter({ value, shown, max }: { value: number; shown: number; max: number }) {
  return (
    <span className={cn("text-xs tabular", value > max ? "text-danger" : value > shown ? "text-warn" : "text-subtle")} aria-live="polite">
      {value}/{shown}
      {value > shown && value <= max ? " · may be cut off" : ""}
    </span>
  );
}

/** Shortens text to fit `max`, at a word boundary, with an ellipsis. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:·|–—-]+$/, "")}…`;
}

function Cut({ text, max }: { text: string; max: number }) {
  return <>{text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text}</>;
}

/** Close-to-life mockups of how the link unfurls on each platform. */
function PreviewCard({ platform, p, domain }: { platform: Platform; p: LinkPreview; domain: string }) {
  const src = imageSrc(p);
  const title = p.title || "Your title";
  if (platform === "linkedin") {
    return (
      <div className="overflow-hidden rounded-lg border border-[#e0dfdc] bg-white text-[#191919] shadow-sm">
        {src ? <img src={src} alt="" className="aspect-[1.91] w-full bg-surface-2 object-cover" /> : null}
        <div className="bg-[#eef3f8] px-3 py-2.5">
          <p className="line-clamp-2 text-sm leading-snug font-semibold">{title}</p>
          <p className="mt-1 text-xs text-[#666]">{domain}</p>
        </div>
      </div>
    );
  }
  if (platform === "x") {
    return (
      <div>
        <div className="relative overflow-hidden rounded-2xl border border-[#cfd9de] bg-surface-2">
          {src ? <img src={src} alt="" className="aspect-[1.91] w-full object-cover" /> : <div className="aspect-[1.91] w-full" />}
          <span className="absolute bottom-2 left-2 rounded bg-black/70 px-1.5 py-0.5 text-[13px] text-white">
            <Cut text={title} max={70} />
          </span>
        </div>
        <p className="mt-1 text-[13px] text-[#536471]">From {domain}</p>
      </div>
    );
  }
  return (
    <div className="flex gap-3 rounded bg-white py-0.5 text-[15px] text-[#1d1c1d]">
      <span className="w-1 shrink-0 rounded bg-[#dddddd]" aria-hidden />
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-bold">{domain}</p>
        <p className="font-bold text-[#1264a3]">{title}</p>
        {p.description ? (
          <p className="text-sm leading-snug">
            <Cut text={p.description} max={PREVIEW_DESCRIPTION_SHOWN} />
          </p>
        ) : null}
        {src ? <img src={src} alt="" className="mt-1 max-h-48 max-w-full rounded-lg" /> : null}
      </div>
    </div>
  );
}

function ImageField({ value, onChange, problem }: { value: LinkPreview; onChange: (image: LinkPreview["image"]) => void; problem?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<"upload" | "url">(value.image?.kind === "url" ? "url" : "upload");
  const [dragging, setDragging] = useState(false);
  const size = useImageSize(value);
  const src = imageSrc(value);
  const upload = useMutation({
    mutationFn: (file: File) => {
      if (!(PREVIEW_IMAGE_TYPES as readonly string[]).includes(file.type)) throw new Error("Use a PNG, JPEG, GIF or WebP image.");
      if (file.size > PREVIEW_IMAGE_MAX_BYTES) throw new Error("The image must be 5 MB or smaller.");
      return uploadPreviewImage(file);
    },
    onSuccess: (image) => onChange(image),
    onError: (e) => toast.error(e.message),
  });
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) upload.mutate(file);
  };

  const warnings: string[] = [];
  if (size && typeof size === "object") {
    if (size.width < PREVIEW_IMAGE_MIN.width || size.height < PREVIEW_IMAGE_MIN.height) warnings.push(`At ${size.width}×${size.height} px it's too small for most platforms, which need at least ${PREVIEW_IMAGE_MIN.width}×${PREVIEW_IMAGE_MIN.height}.`);
    else if (size.width < PREVIEW_IMAGE_IDEAL.width) warnings.push(`${size.width}×${size.height} px works, but ${PREVIEW_IMAGE_IDEAL.width}×${PREVIEW_IMAGE_IDEAL.height} looks sharp everywhere.`);
    const ratio = size.width / size.height;
    if (ratio < 1.6 || ratio > 2.2) warnings.push("Wide cards are about 1.91:1, so the top and bottom (or sides) will be cropped.");
  } else if (size === "error") warnings.push("This image doesn't load. Check the address.");

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-fg">Image</span>
        <Segmented
          label="Image source"
          value={mode}
          onChange={setMode}
          options={[
            { value: "upload", label: "Upload" },
            { value: "url", label: "Image address" },
          ]}
        />
      </div>
      {src ? (
        <div className="relative overflow-hidden rounded-md border border-line bg-surface-2">
          <img src={src} alt="Preview image" className="aspect-[1.91] w-full object-cover" />
          <div className="absolute top-2 right-2 flex gap-1">
            {mode === "upload" ? (
              <Button type="button" size="sm" variant="outline" className="h-8 bg-surface/90 backdrop-blur" onClick={() => input.current?.click()} loading={upload.isPending}>
                Replace
              </Button>
            ) : null}
            <Button type="button" size="icon-sm" variant="outline" className="size-8 bg-surface/90 backdrop-blur" aria-label="Remove image" onClick={() => onChange(null)}>
              <Trash2 />
            </Button>
          </div>
          {size && typeof size === "object" ? (
            <span className="absolute bottom-2 left-2 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white tabular">
              {size.width}×{size.height}
            </span>
          ) : null}
        </div>
      ) : mode === "upload" ? (
        <button
          type="button"
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={drop}
          className={cn(
            "flex aspect-[1.91] w-full flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed text-center transition-colors",
            dragging ? "border-accent bg-accent-soft" : "border-line bg-surface hover:border-accent/50",
          )}
        >
          {upload.isPending ? <Loader2 className="size-6 animate-spin text-accent" /> : <ImagePlus className="size-6 text-accent" />}
          <span className="text-sm font-medium text-fg">{upload.isPending ? "Uploading…" : "Drop an image or choose a file"}</span>
          <span className="text-xs text-muted">
            PNG, JPEG, GIF or WebP up to 5 MB · {PREVIEW_IMAGE_IDEAL.width}×{PREVIEW_IMAGE_IDEAL.height} is ideal
          </span>
        </button>
      ) : null}
      {mode === "url" ? (
        <Input
          type="url"
          inputMode="url"
          aria-label="Image address"
          placeholder="https://example.com/cover.png"
          value={value.image?.kind === "url" ? value.image.url : ""}
          onChange={(e) => onChange(e.target.value.trim() ? { kind: "url", url: e.target.value.trim() } : null)}
        />
      ) : null}
      <input
        ref={input}
        type="file"
        accept={PREVIEW_IMAGE_TYPES.join(",")}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) upload.mutate(file);
          e.target.value = "";
        }}
      />
      {problem ? (
        <p role="alert" className="text-xs text-danger">
          {problem}
        </p>
      ) : null}
      {warnings.map((w) => (
        <p key={w} className="flex items-start gap-1.5 text-xs text-warn">
          <AlertTriangle className="mt-px size-3.5 shrink-0" /> {w}
        </p>
      ))}
    </div>
  );
}

/**
 * Link form → Social preview: what LinkedIn, Slack, X, iMessage and other
 * link previews show for this short link. Off: they show the destination's own.
 */
export function PreviewEditor({
  value,
  onChange,
  destination,
  domain,
  problems,
}: {
  value: LinkPreview | null;
  onChange: (p: LinkPreview | null) => void;
  /** The validated destination URL, to start from its own preview; null while invalid. */
  destination: string | null;
  domain: string;
  problems: PreviewProblem[];
}) {
  const [platform, setPlatform] = useState<Platform>("linkedin");
  const load = useMutation({
    mutationFn: (url: string) => call(api.previews.fetch.$post({ json: { url } })),
    onSuccess: (r) => {
      onChange({
        title: clip(r.title, PREVIEW_TITLE_MAX),
        description: clip(r.description, PREVIEW_DESCRIPTION_MAX),
        image: r.image ? { kind: "url", url: r.image } : (value?.image ?? null),
      });
      toast.success("Loaded the destination's preview", { description: r.title ? "Edit anything you'd like to change." : "It has no title; add one." });
    },
    onError: (e) => toast.error(e.message),
  });
  const problem = (field: PreviewProblem["field"]) => problems.find((p) => p.field === field)?.message;

  if (!value) {
    return (
      <div className="space-y-3">
        <p className="text-xs leading-relaxed text-muted">
          Without a custom preview, LinkedIn, Slack, X and messaging apps show the destination's own title and image. Set your own to control exactly what people see before they click.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" disabled={!destination} loading={load.isPending} onClick={() => destination && load.mutate(destination)} title={destination ? undefined : "Enter the destination URL first"}>
            {load.isPending ? null : <DownloadCloud />} Start from the destination's preview
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange({ title: "", description: "", image: null })}>
            Start blank
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
      <div className="space-y-4">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="preview-title" className="text-sm font-medium text-fg">
              Title
            </label>
            <Counter value={value.title.length} shown={PREVIEW_TITLE_SHOWN} max={PREVIEW_TITLE_MAX} />
          </div>
          <Input id="preview-title" value={value.title} maxLength={PREVIEW_TITLE_MAX + 20} aria-invalid={Boolean(problem("title"))} onChange={(e) => onChange({ ...value, title: e.target.value })} placeholder="What people see in bold" />
          {problem("title") ? (
            <p role="alert" className="text-xs text-danger">
              {problem("title")}
            </p>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="preview-description" className="text-sm font-medium text-fg">
              Description <span className="font-normal text-muted">· optional</span>
            </label>
            <Counter value={value.description.length} shown={PREVIEW_DESCRIPTION_SHOWN} max={PREVIEW_DESCRIPTION_MAX} />
          </div>
          <Textarea id="preview-description" rows={3} value={value.description} maxLength={PREVIEW_DESCRIPTION_MAX + 50} onChange={(e) => onChange({ ...value, description: e.target.value })} placeholder="A sentence or two. Slack and messaging apps show it; LinkedIn doesn't." />
          {problem("description") ? (
            <p role="alert" className="text-xs text-danger">
              {problem("description")}
            </p>
          ) : null}
        </div>
        <ImageField value={value} onChange={(image) => onChange({ ...value, image })} problem={problem("image")} />
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <Button type="button" variant="ghost" size="sm" disabled={!destination} loading={load.isPending} onClick={() => destination && load.mutate(destination)}>
            {load.isPending ? null : <RefreshCw />} Reload from destination
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>
            Remove custom preview
          </Button>
        </div>
      </div>

      <div className="space-y-3">
        <Segmented
          label="Preview on"
          value={platform}
          onChange={setPlatform}
          options={[
            { value: "linkedin", label: "LinkedIn" },
            { value: "x", label: "X" },
            { value: "slack", label: "Slack" },
          ]}
        />
        <div className="rounded-md border border-line bg-white p-3" aria-label={`How the link looks on ${platform}`}>
          <PreviewCard platform={platform} p={value} domain={domain} />
        </div>
        <div className="space-y-1.5 text-xs leading-relaxed text-muted">
          <p>
            <Link2 className="mr-1 inline size-3" />
            People who click still go straight to the destination.
          </p>
          <p>Platforms keep a copy of a preview for days. To refresh one after a change, ask them to fetch it again:</p>
          <p className="flex flex-wrap gap-x-3 gap-y-1">
            <a className="inline-flex items-center gap-0.5 font-medium text-accent hover:underline" href="https://www.linkedin.com/post-inspector/" target="_blank" rel="noreferrer noopener">
              LinkedIn Post Inspector <ArrowUpRight className="size-3" />
            </a>
            <a className="inline-flex items-center gap-0.5 font-medium text-accent hover:underline" href="https://developers.facebook.com/tools/debug/" target="_blank" rel="noreferrer noopener">
              Facebook Sharing Debugger <ArrowUpRight className="size-3" />
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
