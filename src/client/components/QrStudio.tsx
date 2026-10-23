import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Download, ImagePlus, Loader2, Printer, RotateCcw, ScanLine, Trash2, XCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { PREVIEW_IMAGE_TYPES } from "../../shared/preview";
import {
  DEFAULT_QR_STYLE,
  QR_CAPTION_MAX,
  QR_LOGO_MAX,
  QR_LOGO_MIN,
  QR_MARGIN_MAX,
  QR_MARGIN_MIN,
  qrWarnings,
  type QrStyle,
} from "../../shared/qr";
import { api, call, keys, uploadPreviewImage } from "../api";
import { useCan } from "../lib/me";
import { logoDataUrl, openPrintSheet, qrText, renderQrSvg, svgToPng, verifyQr, type PrintOptions, type RenderedQr } from "../lib/qr";
import { cn, download } from "../lib/utils";
import { Button, Dialog, Input, Segmented, Select, Switch } from "./ui";

const SWATCHES: { fg: string; bg: string; name: string }[] = [
  { fg: "#000000", bg: "#ffffff", name: "Classic" },
  { fg: "#4c3fa0", bg: "#ffffff", name: "Shorthop purple" },
  { fg: "#0b3954", bg: "#ffffff", name: "Navy" },
  { fg: "#1f5132", bg: "#f4f9f4", name: "Forest" },
  { fg: "#7a1f2b", bg: "#fff7f2", name: "Wine" },
];
const PNG_SIZES = [512, 1024, 2048, 4096] as const;
const LEVELS: { value: QrStyle["level"]; label: string }[] = [
  { value: "L", label: "Low (7%)" },
  { value: "M", label: "Medium (15%), recommended" },
  { value: "Q", label: "Quartile (25%)" },
  { value: "H", label: "High (30%), for logos" },
];

function ColorField({ id, label, value, onChange, disabled }: { id: string; label: string; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <div className={cn("space-y-1", disabled && "opacity-50")}>
      <label htmlFor={id} className="text-xs font-medium text-fg">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input type="color" aria-label={`${label} picker`} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className="size-9 shrink-0 cursor-pointer rounded-lg border border-line bg-surface p-0.5" />
        <Input
          id={id}
          className="h-9 font-mono text-xs uppercase"
          value={text}
          disabled={disabled}
          maxLength={7}
          onChange={(e) => {
            setText(e.target.value);
            if (/^#[0-9a-f]{6}$/i.test(e.target.value)) onChange(e.target.value.toLowerCase());
          }}
          onBlur={() => setText(value)}
        />
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 border-t border-line pt-4 first:border-0 first:pt-0">
      <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">{title}</h3>
      {children}
    </section>
  );
}

type Scan = { state: "checking" } | { state: "ok" } | { state: "fail"; read: string | null } | { state: "error"; message: string };

/**
 * The QR studio for one short link: design, a live scan test, downloads,
 * a print sheet, and saving the design to the link or as the default.
 */
export function QrStudio({
  open,
  onOpenChange,
  link,
  label,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  link: { domain: string; slug: string; shortUrl: string; qr: QrStyle | null };
  label: string;
}) {
  const qc = useQueryClient();
  const can = useCan();
  const defaults = useQuery({ queryKey: keys.qrDefault, queryFn: () => call(api.qr.default.$get()), enabled: open });
  const saved = link.qr ?? defaults.data?.style ?? null;
  const [style, setStyle] = useState<QrStyle>(link.qr ?? DEFAULT_QR_STYLE);
  const [ready, setReady] = useState(Boolean(link.qr));
  const [logo, setLogo] = useState<string | null>(null);
  const [rendered, setRendered] = useState<RenderedQr | null>(null);
  const [scan, setScan] = useState<Scan>({ state: "checking" });
  const [pngSize, setPngSize] = useState<(typeof PNG_SIZES)[number]>(2048);
  const [print, setPrint] = useState<PrintOptions>({ sizeMm: 40, layout: "single", showUrl: true });
  const fileInput = useRef<HTMLInputElement>(null);
  const text = qrText(link.shortUrl);
  const fileName = `qr-${label.replace(/^\//, "").replace(/[^A-Za-z0-9._~-]+/g, "-")}`;

  // Start from the link's design, or the default once it has loaded.
  useEffect(() => {
    if (!open) return;
    if (link.qr) {
      setStyle(link.qr);
      setReady(true);
    } else if (defaults.data) {
      setStyle(defaults.data.style);
      setReady(true);
    }
  }, [open, link.qr, defaults.data]);

  useEffect(() => {
    let live = true;
    if (!style.logo) {
      setLogo(null);
      return;
    }
    logoDataUrl(style.logo.key)
      .then((d) => live && setLogo(d))
      .catch((e: Error) => live && toast.error(e.message));
    return () => {
      live = false;
    };
  }, [style.logo]);

  // Render, then decode it like a phone would (debounced while sliders move).
  useEffect(() => {
    if (!open || !ready || (style.logo && !logo)) return;
    let live = true;
    let r: RenderedQr;
    try {
      r = renderQrSvg(text, style, logo);
    } catch (e) {
      setScan({ state: "error", message: e instanceof Error ? e.message : "Couldn't draw the code" });
      return;
    }
    setRendered(r);
    setScan({ state: "checking" });
    const t = setTimeout(() => {
      verifyQr(r, text)
        .then((v) => live && setScan(v.ok ? { state: "ok" } : { state: "fail", read: v.read }))
        .catch(() => live && setScan({ state: "error", message: "The scan test couldn't run in this browser." }));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [open, ready, style, logo, text]);

  const set = <K extends keyof QrStyle>(k: K, v: QrStyle[K]) => setStyle((s) => ({ ...s, [k]: v }));
  const warnings = useMemo(() => qrWarnings(style), [style]);
  const dirty = saved !== null && JSON.stringify(saved) !== JSON.stringify({ ...style, level: style.logo ? "H" : style.level });
  const blocked = scan.state === "fail" || warnings.some((w) => w.level === "error");

  const upload = useMutation({
    mutationFn: (file: File) => {
      if (!(PREVIEW_IMAGE_TYPES as readonly string[]).includes(file.type)) throw new Error("Use a PNG, JPEG, GIF or WebP image.");
      return uploadPreviewImage(file);
    },
    onSuccess: (img) => setStyle((s) => ({ ...s, logo: { key: img.key, size: s.logo?.size ?? 0.22 }, level: "H" })),
    onError: (e) => toast.error(e.message),
  });
  const saveLink = useMutation({
    mutationFn: () => call(api.links[":domain"][":slug"].$patch({ param: { domain: link.domain, slug: link.slug }, json: { qr: { ...style } } })),
    onSuccess: (data) => {
      qc.setQueryData(keys.link(link.domain, link.slug), data);
      void qc.invalidateQueries({ queryKey: keys.allLinks });
      toast.success("Design saved to this link", { description: "Download it again any time and get exactly the same code." });
    },
    onError: (e) => toast.error(e.message),
  });
  const saveDefault = useMutation({
    mutationFn: () => call(api.qr.default.$put({ json: { style: { ...style } } })),
    onSuccess: (r) => {
      qc.setQueryData(keys.qrDefault, r);
      toast.success("Default design saved", { description: "Links without their own design use it, including bulk downloads." });
    },
    onError: (e) => toast.error(e.message),
  });

  const downloadSvg = () => rendered && download(`${fileName}.svg`, rendered.svg, "image/svg+xml");
  const downloadPng = async () => {
    if (!rendered) return;
    try {
      download(`${fileName}-${pngSize}.png`, await svgToPng(rendered, pngSize));
    } catch {
      toast.error("Couldn't create the PNG");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={`QR code for ${label}`} description="Scans are counted as source “QR code” in the stats. The destination can change any time without reprinting." wide="xl">
      <div className="grid gap-6 md:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
        {/* Preview and checks */}
        <div className="space-y-3 md:sticky md:top-0 md:self-start">
          <div
            className={cn("flex aspect-square items-center justify-center overflow-hidden rounded-xl border border-line p-3", style.transparent ? "bg-[length:16px_16px] bg-[linear-gradient(45deg,#eee_25%,transparent_25%,transparent_75%,#eee_75%),linear-gradient(45deg,#eee_25%,#fff_25%,#fff_75%,#eee_75%)] bg-[position:0_0,8px_8px]" : "bg-surface-2")}
          >
            {rendered ? (
              <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(rendered.svg)}`} alt={`QR code for ${text}`} className="max-h-full max-w-full" />
            ) : (
              <Loader2 className="size-6 animate-spin text-accent" />
            )}
          </div>
          <div
            className={cn(
              "flex items-start gap-2 rounded-lg px-3 py-2 text-xs",
              scan.state === "ok" ? "bg-good-soft text-good" : scan.state === "checking" ? "bg-surface-2 text-muted" : "bg-danger-soft text-danger",
            )}
            role="status"
          >
            {scan.state === "ok" ? <CheckCircle2 className="mt-px size-4 shrink-0" /> : scan.state === "checking" ? <ScanLine className="mt-px size-4 shrink-0" /> : <XCircle className="mt-px size-4 shrink-0" />}
            <span>
              {scan.state === "ok"
                ? "Scans correctly in a test decode."
                : scan.state === "checking"
                  ? "Testing the scan…"
                  : scan.state === "fail"
                    ? scan.read
                      ? "It reads, but not as this link. Simplify the design."
                      : "It doesn't scan. Use more contrast, a smaller logo or a wider quiet zone."
                    : scan.message}
            </span>
          </div>
          {warnings.map((w) => (
            <p key={w.message} className={cn("flex items-start gap-1.5 text-xs", w.level === "error" ? "text-danger" : "text-warn")}>
              <AlertTriangle className="mt-px size-3.5 shrink-0" /> {w.message}
            </p>
          ))}
          <p className="font-mono text-[11px] break-all text-muted">{text}</p>
          <p className="text-[11px] leading-relaxed text-subtle">Test it with a phone before printing a large run, at the size you'll print.</p>
        </div>

        {/* Controls */}
        <div className="space-y-4">
          <Section title="Colours">
            <div className="flex flex-wrap gap-1.5">
              {SWATCHES.map((sw) => (
                <button
                  key={sw.name}
                  type="button"
                  title={sw.name}
                  aria-label={`${sw.name} colours`}
                  aria-pressed={style.fg === sw.fg && style.bg === sw.bg}
                  onClick={() => setStyle((s) => ({ ...s, fg: sw.fg, bg: sw.bg }))}
                  className={cn("flex size-8 items-center justify-center rounded-lg border-2", style.fg === sw.fg && style.bg === sw.bg ? "border-accent" : "border-line")}
                  style={{ background: sw.bg }}
                >
                  <span className="size-4 rounded" style={{ background: sw.fg }} />
                </button>
              ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <ColorField id="qr-fg" label="Code" value={style.fg} onChange={(v) => set("fg", v)} />
              <ColorField id="qr-bg" label="Background" value={style.bg} onChange={(v) => set("bg", v)} disabled={style.transparent} />
            </div>
            <Switch id="qr-transparent" label="Transparent background" description="For placing the code on your own artwork. Keep that artwork light and plain." checked={style.transparent} onCheckedChange={(v) => set("transparent", v)} />
          </Section>

          <Section title="Shape">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <span className="w-16 text-xs text-muted">Pattern</span>
              <Segmented label="Module shape" value={style.modules} onChange={(v) => set("modules", v)} options={[{ value: "square", label: "Square" }, { value: "rounded", label: "Rounded" }, { value: "dots", label: "Dots" }]} />
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <span className="w-16 text-xs text-muted">Corners</span>
              <Segmented label="Corner shape" value={style.eyes} onChange={(v) => set("eyes", v)} options={[{ value: "square", label: "Square" }, { value: "rounded", label: "Rounded" }, { value: "circle", label: "Circle" }]} />
            </div>
          </Section>

          <Section title="Logo">
            {style.logo ? (
              <div className="flex flex-wrap items-center gap-3">
                {logo ? <img src={logo} alt="" className="size-12 rounded-lg border border-line bg-white object-contain p-1" /> : <Loader2 className="size-5 animate-spin text-accent" />}
                <div className="min-w-40 flex-1 space-y-1">
                  <label htmlFor="qr-logo-size" className="flex justify-between text-xs">
                    <span className="font-medium text-fg">Size</span>
                    <span className="text-muted tabular">{Math.round(style.logo.size * 100)}% of the width</span>
                  </label>
                  <input
                    id="qr-logo-size"
                    type="range"
                    min={QR_LOGO_MIN}
                    max={QR_LOGO_MAX}
                    step={0.01}
                    value={style.logo.size}
                    onChange={(e) => setStyle((s) => (s.logo ? { ...s, logo: { ...s.logo, size: Number(e.target.value) } } : s))}
                    className="w-full accent-[var(--accent)]"
                  />
                </div>
                <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove logo" onClick={() => set("logo", null)}>
                  <Trash2 />
                </Button>
              </div>
            ) : can("links.create") || can("links.edit") ? (
              <Button type="button" variant="outline" size="sm" onClick={() => fileInput.current?.click()} loading={upload.isPending}>
                {upload.isPending ? null : <ImagePlus />} Add a logo
              </Button>
            ) : null}
            <p className="text-xs text-muted">A square image with a plain background works best. A logo switches error correction to High so the code still reads.</p>
            <input
              ref={fileInput}
              type="file"
              accept={PREVIEW_IMAGE_TYPES.join(",")}
              className="sr-only"
              tabIndex={-1}
              aria-hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) upload.mutate(f);
                e.target.value = "";
              }}
            />
          </Section>

          <Section title="Frame">
            <Segmented label="Frame" value={style.frame} onChange={(v) => set("frame", v)} options={[{ value: "none", label: "None" }, { value: "caption", label: "Caption" }, { value: "box", label: "Box" }]} />
            {style.frame !== "none" ? (
              <Input aria-label="Caption" maxLength={QR_CAPTION_MAX} value={style.caption} placeholder="Scan me" onChange={(e) => set("caption", e.target.value)} />
            ) : null}
          </Section>

          <Section title="Reliability">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label htmlFor="qr-level" className="text-xs font-medium text-fg" title="How much of the code can be covered or damaged and still read. Higher levels make denser codes.">
                  Error correction
                </label>
                <Select id="qr-level" className="h-9 text-xs" value={style.logo ? "H" : style.level} disabled={Boolean(style.logo)} onChange={(e) => set("level", e.target.value as QrStyle["level"])}>
                  {LEVELS.map((l) => (
                    <option key={l.value} value={l.value}>
                      {l.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1">
                <label htmlFor="qr-margin" className="flex justify-between text-xs">
                  <span className="font-medium text-fg">Quiet zone</span>
                  <span className="text-muted tabular">{style.margin} modules</span>
                </label>
                <input id="qr-margin" type="range" min={QR_MARGIN_MIN} max={QR_MARGIN_MAX} step={1} value={style.margin} onChange={(e) => set("margin", Number(e.target.value))} className="mt-2 w-full accent-[var(--accent)]" />
              </div>
            </div>
          </Section>

          <Section title="Download and print">
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" onClick={downloadSvg} disabled={!rendered}>
                <Download /> SVG
              </Button>
              <div className="flex">
                <Button type="button" variant="outline" className="rounded-r-none" onClick={() => void downloadPng()} disabled={!rendered}>
                  <Download /> PNG
                </Button>
                <Select aria-label="PNG width" className="h-10 w-auto rounded-l-none border-l-0 text-xs" value={pngSize} onChange={(e) => setPngSize(Number(e.target.value) as (typeof PNG_SIZES)[number])}>
                  {PNG_SIZES.map((n) => (
                    <option key={n} value={n}>
                      {n} px
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select aria-label="Printed size" className="h-9 w-auto text-xs" value={print.sizeMm} onChange={(e) => setPrint((p) => ({ ...p, sizeMm: Number(e.target.value) }))}>
                {[20, 30, 40, 50, 80, 120].map((mm) => (
                  <option key={mm} value={mm}>
                    {mm / 10} cm wide{mm === 20 ? " (smallest)" : ""}
                  </option>
                ))}
              </Select>
              <Select aria-label="Print layout" className="h-9 w-auto text-xs" value={print.layout} onChange={(e) => setPrint((p) => ({ ...p, layout: e.target.value as PrintOptions["layout"] }))}>
                <option value="single">One per page</option>
                <option value="fill">Fill the page</option>
              </Select>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!rendered}
                onClick={() => rendered && !openPrintSheet(rendered, link.shortUrl.replace(/^https?:\/\//, ""), print) && toast.error("Allow pop-ups to open the print sheet.")}
              >
                <Printer /> Print sheet
              </Button>
            </div>
            <label className="flex items-center gap-2 text-xs text-muted">
              <input type="checkbox" checked={print.showUrl} onChange={(e) => setPrint((p) => ({ ...p, showUrl: e.target.checked }))} className="accent-[var(--accent)]" />
              Print the short link under each code
            </label>
            {blocked ? <p className="text-xs text-danger">Fix the problems on the left before printing: this code may not scan.</p> : null}
          </Section>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setStyle(defaults.data?.style ?? DEFAULT_QR_STYLE)}
          disabled={!defaults.data}
          title="Back to the default design"
        >
          <RotateCcw /> Default design
        </Button>
        <div className="flex flex-wrap gap-2">
          {can("settings.manage") ? (
            <Button type="button" variant="outline" onClick={() => saveDefault.mutate()} loading={saveDefault.isPending} disabled={!ready}>
              Use as default
            </Button>
          ) : null}
          {can("links.edit") ? (
            <Button type="button" onClick={() => saveLink.mutate()} loading={saveLink.isPending} disabled={!ready || (!dirty && Boolean(link.qr))}>
              {link.qr && !dirty ? "Design saved" : "Save to this link"}
            </Button>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}
