// The link's history on the link page: components/LinkHistory (its query,
// restore and dialog), with one display fix.
// LinkHistory prints the QR code design and bio page fields as raw JSON, and
// a version saved before those fields existed as "undefined" ("undefined →
// {"fg":"#4c3fa0",…}"). This wrapper rewrites those two values into words
// after React renders them; it reads only text the component shows and
// changes nothing else. The real fix belongs in components/LinkHistory.tsx
// (Value): describe both fields there, and drop this wrapper.

import { useEffect, useRef } from "react";
import { bioButtonCount, parseBio } from "../../../shared/bio";
import { FIELD_LABEL } from "../../../shared/history";
import { parseQrStyle, type QrStyle } from "../../../shared/qr";
import type { LinkDTO } from "../../../shared/types";
import { LinkHistory } from "../../components/LinkHistory";

const SHAPE: Record<QrStyle["modules"], string> = { square: "Square", rounded: "Rounded", dots: "Dots" };
const EYES: Record<QrStyle["eyes"], string> = { square: "square corners", rounded: "rounded corners", circle: "round corners" };

/** "Dots, round corners, #4c3fa0 on white, logo, framed: “Scan for the guide”" */
export function qrText(json: string): string | null {
  const q = parseQrStyle(json);
  if (!q) return null;
  const bg = q.transparent ? "transparent" : q.bg.toLowerCase() === "#ffffff" ? "white" : q.bg;
  const fg = q.fg.toLowerCase() === "#000000" ? "black" : q.fg;
  const parts = [SHAPE[q.modules], EYES[q.eyes], `${fg} on ${bg}`];
  if (q.logo) parts.push("logo");
  if (q.frame !== "none") parts.push(`${q.frame === "box" ? "framed" : "caption"}: “${q.caption}”`);
  return parts.join(", ");
}

function bioText(json: string): string | null {
  const b = parseBio(json);
  if (!b) return null;
  const n = bioButtonCount(b);
  const socials = b.socials?.length ?? 0;
  return `A bio page with ${n} ${n === 1 ? "button" : "buttons"}${socials ? ` and ${socials} social ${socials === 1 ? "link" : "links"}` : ""}`;
}

const FIELDS: { label: string; none: string; text: (json: string) => string | null }[] = [
  { label: FIELD_LABEL.qr, none: "Default design", text: qrText },
  { label: FIELD_LABEL.bio, none: "Off", text: bioText },
];

/** Rewrites the value chips of the QR design and bio page rows inside `root`. */
function humanize(root: ParentNode) {
  for (const dt of root.querySelectorAll("dt")) {
    const field = FIELDS.find((f) => f.label === dt.textContent?.trim());
    const dd = dt.nextElementSibling;
    if (!field || !dd) continue;
    for (const chip of dd.querySelectorAll<HTMLElement>(":scope > span")) {
      const raw = chip.textContent?.trim() ?? "";
      const next = raw === "undefined" ? "Not recorded" : raw === "Empty" ? field.none : raw.startsWith("{") ? field.text(raw) : null;
      if (next === null || next === raw) continue;
      chip.textContent = next;
      chip.title = raw === "undefined" ? "This version was saved before this setting was recorded." : next;
    }
  }
}

export function LinkPageHistory({ link }: { link: LinkDTO }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // The list (in this wrapper) and the restore dialog (portalled into <body>).
    const run = () => {
      humanize(el);
      for (const d of document.querySelectorAll('[role="dialog"]')) humanize(d);
    };
    run();
    const mo = new MutationObserver(run);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, []);
  return (
    <div ref={ref} className="ui-section ui-ld-reused ui-ld-history">
      <LinkHistory link={link} />
    </div>
  );
}
