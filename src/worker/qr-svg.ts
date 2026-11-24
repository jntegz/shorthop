// A QR code as inline SVG for the server-rendered sign-in pages (the two-factor
// setup). Only the encoder is imported: the package's Node entry would bring
// its PNG and file renderers along.

import { create } from "qrcode/lib/core/qrcode";
import { escapeHtml } from "../shared/html";

const QUIET = 4;

/** Dark modules on a white square, whatever the page theme, so every camera reads it. */
export function qrSvg(text: string, label: string): string {
  const { modules } = create(text, { errorCorrectionLevel: "M" });
  const n = modules.size;
  let d = "";
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (modules.data[y * n + x]) d += `M${x + QUIET} ${y + QUIET}h1v1h-1z`;
    }
  }
  const size = n + QUIET * 2;
  return `<svg class="qr" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="${escapeHtml(label)}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
