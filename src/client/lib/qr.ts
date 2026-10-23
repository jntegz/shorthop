// QR rendering in the browser: SVG from the code's module matrix with the
// chosen design, PNG from that SVG, a decode test, print sheets and ZIPs.

import { strToU8, zipSync } from "fflate";
import jsQR from "jsqr";
import QRCode from "qrcode";
import { escapeHtml } from "../../shared/html";
import { PREVIEW_IMAGE_PATH } from "../../shared/preview";
import type { QrStyle } from "../../shared/qr";

const FONT = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/** What a short link's QR code encodes: ?s=qr attributes scans to print in the stats. */
export function qrText(shortUrl: string): string {
  return `${shortUrl}?s=qr`;
}

const logoCache = new Map<string, Promise<string>>();

/** An uploaded logo as a data URL: an SVG used as an image can't load other files. */
export function logoDataUrl(key: string): Promise<string> {
  let p = logoCache.get(key);
  if (!p) {
    p = fetch(`${PREVIEW_IMAGE_PATH}${key}`, { credentials: "same-origin" })
      .then((r) => {
        if (!r.ok) throw new Error("The logo couldn't be loaded.");
        return r.blob();
      })
      .then(
        (blob) =>
          new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(new Error("The logo couldn't be read."));
            reader.readAsDataURL(blob);
          }),
      );
    p.catch(() => logoCache.delete(key));
    logoCache.set(key, p);
  }
  return p;
}

function eye(x: number, y: number, shape: QrStyle["eyes"]): string {
  if (shape === "circle") {
    const cx = x + 3.5;
    const cy = y + 3.5;
    return `<path fill-rule="evenodd" d="M${cx - 3.5} ${cy}a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0 -7 0ZM${cx - 2.5} ${cy}a2.5 2.5 0 1 1 5 0a2.5 2.5 0 1 1 -5 0Z"/><circle cx="${cx}" cy="${cy}" r="1.5"/>`;
  }
  const r = shape === "rounded" ? [2, 1.3, 0.9] : [0, 0, 0];
  const rr = (x0: number, y0: number, w: number, rad: number) =>
    rad
      ? `M${x0 + rad} ${y0}h${w - 2 * rad}a${rad} ${rad} 0 0 1 ${rad} ${rad}v${w - 2 * rad}a${rad} ${rad} 0 0 1 -${rad} ${rad}h-${w - 2 * rad}a${rad} ${rad} 0 0 1 -${rad} -${rad}v-${w - 2 * rad}a${rad} ${rad} 0 0 1 ${rad} -${rad}Z`
      : `M${x0} ${y0}h${w}v${w}h-${w}Z`;
  return `<path fill-rule="evenodd" d="${rr(x, y, 7, r[0]!)}${rr(x + 1, y + 1, 5, r[1]!)}"/><path d="${rr(x + 2, y + 2, 3, r[2]!)}"/>`;
}

/** Top-left corners of the 5×5 alignment patterns (ISO/IEC 18004 positions, as the qrcode library places them). */
function alignmentCorners(version: number, n: number): [number, number][] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = n === 145 ? 26 : Math.ceil((n - 13) / (2 * count - 2)) * 2;
  const pos = [n - 7];
  for (let i = 1; i < count - 1; i++) pos.unshift(pos[0]! - step);
  pos.unshift(6);
  const out: [number, number][] = [];
  for (const r of pos) {
    for (const c of pos) {
      // Not where a finder pattern already is.
      if ((r === 6 && c === 6) || (r === 6 && c === n - 7) || (r === n - 7 && c === 6)) continue;
      out.push([r - 2, c - 2]);
    }
  }
  return out;
}

/** An alignment pattern (a 5×5 ring and centre), in the corners' shape so it stays recognisable. */
function alignment(x: number, y: number, shape: QrStyle["eyes"]): string {
  if (shape === "circle") {
    const cx = x + 2.5;
    const cy = y + 2.5;
    return `<path fill-rule="evenodd" d="M${cx - 2.5} ${cy}a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0ZM${cx - 1.5} ${cy}a1.5 1.5 0 1 1 3 0a1.5 1.5 0 1 1 -3 0Z"/><circle cx="${cx}" cy="${cy}" r="0.6"/>`;
  }
  const outer = shape === "rounded" ? 1.4 : 0;
  const inner = shape === "rounded" ? 0.8 : 0;
  const rr = (x0: number, y0: number, w: number, rad: number) =>
    rad
      ? `M${x0 + rad} ${y0}h${w - 2 * rad}a${rad} ${rad} 0 0 1 ${rad} ${rad}v${w - 2 * rad}a${rad} ${rad} 0 0 1 -${rad} ${rad}h-${w - 2 * rad}a${rad} ${rad} 0 0 1 -${rad} -${rad}v-${w - 2 * rad}a${rad} ${rad} 0 0 1 ${rad} -${rad}Z`
      : `M${x0} ${y0}h${w}v${w}h-${w}Z`;
  return `<path fill-rule="evenodd" d="${rr(x, y, 5, outer)}${rr(x + 1, y + 1, 3, inner)}"/><path d="M${x + 2} ${y + 2}h1v1h-1Z"/>`;
}

export interface RenderedQr {
  svg: string;
  /** Aspect: height / width (frames add a caption band). */
  ratio: number;
}

/** The design as a standalone SVG. `logo` is the logo's data URL when the design has one. */
export function renderQrSvg(text: string, style: QrStyle, logo: string | null = null): RenderedQr {
  const qr = QRCode.create(text, { errorCorrectionLevel: style.logo ? "H" : style.level });
  const n = qr.modules.size;
  const m = style.margin;
  const total = n + 2 * m;
  const hasCaption = style.frame !== "none" && style.caption.trim() !== "";
  const band = hasCaption ? Math.max(4, total * 0.16) : style.frame === "box" ? 1.2 : 0;
  const pad = style.frame === "box" ? 1.2 : 0;
  const W = total + 2 * pad;
  const H = total + 2 * pad + band;
  const ox = pad + m;
  const oy = pad + m;

  // Modules hidden behind the logo are left out, so nothing pokes through.
  const logoSize = style.logo && logo ? style.logo.size * n : 0;
  const lx = (n - logoSize) / 2;
  const clear = (r: number, c: number) => logoSize > 0 && c + 1 > lx - 0.5 && c < lx + logoSize + 0.5 && r + 1 > lx - 0.5 && r < lx + logoSize + 0.5;
  const inEye = (r: number, c: number) => (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);
  // Dotted and rounded modules draw alignment patterns whole: as loose dots, scanners can't find them.
  const aligns = style.modules === "square" ? [] : alignmentCorners(qr.version, n).filter(([r, c]) => !clear(r + 2, c + 2));
  const inAlign = (r: number, c: number) => aligns.some(([ar, ac]) => r >= ar && r < ar + 5 && c >= ac && c < ac + 5);

  const shapes: string[] = [];
  if (style.modules === "square") {
    // Horizontal runs keep the file small.
    for (let r = 0; r < n; r++) {
      let c = 0;
      while (c < n) {
        if (qr.modules.get(r, c) && !inEye(r, c) && !clear(r, c)) {
          const start = c;
          while (c < n && qr.modules.get(r, c) && !inEye(r, c) && !clear(r, c)) c++;
          shapes.push(`M${ox + start} ${oy + r}h${c - start}v1h-${c - start}Z`);
        } else c++;
      }
    }
  } else {
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (!qr.modules.get(r, c) || inEye(r, c) || clear(r, c) || inAlign(r, c)) continue;
        const x = ox + c;
        const y = oy + r;
        shapes.push(style.modules === "dots" ? `M${x + 0.05} ${y + 0.5}a0.45 0.45 0 1 0 0.9 0a0.45 0.45 0 1 0 -0.9 0Z` : `M${x + 0.35} ${y}h0.3a0.35 0.35 0 0 1 0.35 0.35v0.3a0.35 0.35 0 0 1 -0.35 0.35h-0.3a0.35 0.35 0 0 1 -0.35 -0.35v-0.3a0.35 0.35 0 0 1 0.35 -0.35Z`);
      }
    }
  }

  const parts: string[] = [];
  const bg = style.transparent ? "none" : style.bg;
  if (style.frame === "box") {
    parts.push(`<defs><clipPath id="f"><rect width="${W}" height="${H}" rx="1.6"/></clipPath></defs>`);
    parts.push(`<rect x="0.3" y="0.3" width="${W - 0.6}" height="${H - 0.6}" rx="1.4" fill="${bg}" stroke="${style.fg}" stroke-width="0.6"/>`);
    if (hasCaption) parts.push(`<rect x="0" y="${total + 2 * pad - 0.3}" width="${W}" height="${band + 0.3}" fill="${style.fg}" clip-path="url(#f)"/>`);
  } else if (!style.transparent) {
    parts.push(`<rect width="${W}" height="${H}" fill="${bg}"/>`);
  }
  parts.push(`<g fill="${style.fg}"${style.modules === "square" ? ' shape-rendering="crispEdges"' : ""}><path d="${shapes.join("")}"/></g>`);
  parts.push(`<g fill="${style.fg}">${eye(ox, oy, style.eyes)}${eye(ox + n - 7, oy, style.eyes)}${eye(ox, oy + n - 7, style.eyes)}${aligns.map(([r, c]) => alignment(ox + c, oy + r, style.eyes)).join("")}</g>`);
  if (logoSize > 0 && logo) {
    const p = 0.6;
    parts.push(`<rect x="${ox + lx - p}" y="${oy + lx - p}" width="${logoSize + 2 * p}" height="${logoSize + 2 * p}" rx="1" fill="${style.transparent ? "#ffffff" : style.bg}"/>`);
    parts.push(`<image href="${escapeHtml(logo)}" x="${ox + lx}" y="${oy + lx}" width="${logoSize}" height="${logoSize}" preserveAspectRatio="xMidYMid meet"/>`);
  }
  if (hasCaption) {
    const y = style.frame === "box" ? total + 2 * pad + band / 2 - 0.3 : total + band * 0.45;
    const fill = style.frame === "box" ? (style.transparent ? "#ffffff" : style.bg) : style.fg;
    const size = Math.min(band * 0.5, (W * 0.9) / Math.max(1, style.caption.length * 0.55));
    parts.push(`<text x="${W / 2}" y="${y}" font-family="${FONT}" font-size="${size.toFixed(2)}" font-weight="600" fill="${fill}" text-anchor="middle" dominant-baseline="central">${escapeHtml(style.caption.trim())}</text>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${Math.round(W * 10)}" height="${Math.round(H * 10)}">${parts.join("")}</svg>`;
  return { svg, ratio: H / W };
}

/** Draws the SVG at `width` pixels. `matte` fills transparent areas first (for decoding). */
export async function svgToCanvas(r: RenderedQr, width: number, matte?: string): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(new Blob([r.svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = Math.round(width * r.ratio);
    const ctx = canvas.getContext("2d")!;
    if (matte) {
      ctx.fillStyle = matte;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function svgToPng(r: RenderedQr, width: number): Promise<Blob> {
  const canvas = await svgToCanvas(r, width);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't create the PNG"))), "image/png"));
}

/** Decodes the rendered code like a phone would, at a modest resolution. */
export async function verifyQr(r: RenderedQr, expected: string): Promise<{ ok: boolean; read: string | null }> {
  const canvas = await svgToCanvas(r, 600, "#ffffff");
  const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
  const result = jsQR(data.data, data.width, data.height, { inversionAttempts: "attemptBoth" });
  return { ok: result?.data === expected, read: result?.data ?? null };
}

export interface PrintOptions {
  /** Width of each code on paper, in millimetres. */
  sizeMm: number;
  /** One code centred on the page, or as many as fit (to cut out). */
  layout: "single" | "fill";
  /** The short link under each code, for people who can't scan. */
  showUrl: boolean;
}

/**
 * Opens a print view (save it as PDF from the print dialog). Must be called
 * from a click, or browsers block the window.
 */
export function openPrintSheet(r: RenderedQr, label: string, opts: PrintOptions): boolean {
  const w = window.open("", "_blank");
  if (!w) return false;
  const cellH = opts.sizeMm * r.ratio + (opts.showUrl ? 7 : 0);
  // A4 portrait, 12 mm margins: 186 × 273 mm of printable area, 6 mm gaps.
  const cols = opts.layout === "fill" ? Math.max(1, Math.floor((186 + 6) / (opts.sizeMm + 6))) : 1;
  const rows = opts.layout === "fill" ? Math.max(1, Math.floor((273 + 6) / (cellH + 6))) : 1;
  const cell = `<figure><div class="code">${r.svg.replace(/ width="\d+" height="\d+"/, "")}</div>${opts.showUrl ? `<figcaption>${escapeHtml(label)}</figcaption>` : ""}</figure>`;
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>QR code · ${escapeHtml(label)}</title>
<style>
@page { size: A4; margin: 12mm; }
* { box-sizing: border-box; }
body { margin: 0; font-family: ${FONT}; color: #222; }
main { display: grid; grid-template-columns: repeat(${cols}, ${opts.sizeMm}mm); gap: 6mm; justify-content: center; ${opts.layout === "single" ? "min-height: 260mm; align-content: center;" : ""} }
figure { margin: 0; width: ${opts.sizeMm}mm; break-inside: avoid; }
.code svg { display: block; width: 100%; height: auto; }
figcaption { margin-top: 2mm; font-size: 3mm; text-align: center; word-break: break-all; }
.hint { font-size: 12px; color: #666; text-align: center; margin: 0 0 8mm; }
@media print { .hint { display: none; } }
</style></head><body>
<p class="hint">Print, or choose “Save as PDF” as the printer. Print at 100% scale so the codes keep their size.</p>
<main>${Array.from({ length: cols * rows }, () => cell).join("")}</main>
</body></html>`);
  w.document.close();
  w.addEventListener("load", () => w.print(), { once: true });
  setTimeout(() => w.print(), 500);
  return true;
}

export interface ZipItem {
  file: string;
  render: () => Promise<RenderedQr>;
  row: string[];
}

/** Builds a ZIP of codes plus a CSV that maps each file to its link. */
export async function zipQrCodes(items: ZipItem[], format: "svg" | "png", px: number, onProgress: (done: number) => void): Promise<Blob> {
  const files: Record<string, Uint8Array> = {};
  const csvRows = [["file", "short_url", "encoded_url", "destination", "title"]];
  let done = 0;
  for (const item of items) {
    const r = await item.render();
    const name = `${item.file}.${format}`;
    files[name] = format === "svg" ? strToU8(r.svg) : new Uint8Array(await (await svgToPng(r, px)).arrayBuffer());
    csvRows.push([name, ...item.row]);
    onProgress(++done);
  }
  // Cells starting like a formula are defused for spreadsheets, then quoted as needed.
  const cell = (v: string) => {
    const safe = /^[=+\-@]/.test(v) ? `'${v}` : v;
    return /[",\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
  };
  const csv = csvRows.map((r) => r.map(cell).join(",")).join("\n");
  files["qr-codes.csv"] = strToU8(`${csv}\n`);
  const zip = zipSync(files, { level: 6 });
  return new Blob([zip as BlobPart], { type: "application/zip" });
}
