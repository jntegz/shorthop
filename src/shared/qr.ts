// QR code designs: what's stored per link (and as the default for new codes),
// and the checks that keep a design scannable. Rendering is in the admin.

export const QR_MODULE_SHAPES = ["square", "rounded", "dots"] as const;
export const QR_EYE_SHAPES = ["square", "rounded", "circle"] as const;
export const QR_FRAMES = ["none", "caption", "box"] as const;
export const QR_LEVELS = ["L", "M", "Q", "H"] as const;

export interface QrStyle {
  /** Dark modules, as #rrggbb. */
  fg: string;
  /** Background, as #rrggbb (ignored when transparent). */
  bg: string;
  transparent: boolean;
  /** Error correction: how much of the code can be covered or damaged. */
  level: (typeof QR_LEVELS)[number];
  modules: (typeof QR_MODULE_SHAPES)[number];
  eyes: (typeof QR_EYE_SHAPES)[number];
  /** Quiet zone around the code, in modules. Scanners need about 4. */
  margin: number;
  /** An uploaded image (a preview-image key) in the middle, `size` as a share of the code's width. */
  logo: { key: string; size: number } | null;
  frame: (typeof QR_FRAMES)[number];
  caption: string;
}

export const DEFAULT_QR_STYLE: QrStyle = {
  fg: "#000000",
  bg: "#ffffff",
  transparent: false,
  level: "M",
  modules: "square",
  eyes: "square",
  margin: 4,
  logo: null,
  frame: "none",
  caption: "Scan me",
};

export const QR_LOGO_MIN = 0.12;
export const QR_LOGO_MAX = 0.28;
export const QR_CAPTION_MAX = 40;
export const QR_MARGIN_MIN = 1;
export const QR_MARGIN_MAX = 8;
/** Below this many modules of quiet zone, some scanners struggle. */
export const QR_MARGIN_SAFE = 3;

const HEX_RE = /^#[0-9a-f]{6}$/i;
const KEY_RE = /^[a-z0-9]{20}\.(png|jpg|gif|webp)$/;

/** Validates a stored or submitted design; returns it cleaned, or a reason. */
export function validateQrStyle(input: unknown): { ok: true; style: QrStyle } | { ok: false; error: string } {
  const s = input as Partial<QrStyle> | null;
  if (!s || typeof s !== "object") return { ok: false, error: "Missing design." };
  // Strings and numbers only: coercing a JSON object like {"toString":1} would throw.
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  if (!HEX_RE.test(text(s.fg)) || !HEX_RE.test(text(s.bg))) return { ok: false, error: "Colours must look like #1a2b3c." };
  if (!(QR_LEVELS as readonly string[]).includes(text(s.level))) return { ok: false, error: "Unknown error-correction level." };
  if (!(QR_MODULE_SHAPES as readonly string[]).includes(text(s.modules))) return { ok: false, error: "Unknown module shape." };
  if (!(QR_EYE_SHAPES as readonly string[]).includes(text(s.eyes))) return { ok: false, error: "Unknown corner shape." };
  if (!(QR_FRAMES as readonly string[]).includes(text(s.frame))) return { ok: false, error: "Unknown frame." };
  const margin = typeof s.margin === "number" || typeof s.margin === "string" ? Number(s.margin) : NaN;
  if (!Number.isInteger(margin) || margin < QR_MARGIN_MIN || margin > QR_MARGIN_MAX) return { ok: false, error: `The quiet zone must be ${QR_MARGIN_MIN}–${QR_MARGIN_MAX} modules.` };
  let logo: QrStyle["logo"] = null;
  if (s.logo) {
    if (typeof s.logo !== "object" || !KEY_RE.test(text(s.logo.key)) || typeof s.logo.size !== "number" || !(s.logo.size >= QR_LOGO_MIN && s.logo.size <= QR_LOGO_MAX)) {
      return { ok: false, error: "Upload the logo again." };
    }
    logo = { key: s.logo.key, size: Math.round(s.logo.size * 100) / 100 };
  }
  const caption = text(s.caption).trim().slice(0, QR_CAPTION_MAX);
  return {
    ok: true,
    style: {
      fg: s.fg!.toLowerCase(),
      bg: s.bg!.toLowerCase(),
      transparent: Boolean(s.transparent),
      level: logo ? "H" : s.level!,
      modules: s.modules!,
      eyes: s.eyes!,
      margin,
      logo,
      frame: s.frame!,
      caption,
    },
  };
}

export function parseQrStyle(json: string | null | undefined): QrStyle | null {
  if (!json) return null;
  try {
    const r = validateQrStyle(JSON.parse(json));
    return r.ok ? r.style : null;
  } catch {
    return null;
  }
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG contrast ratio, 1–21. */
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x! + 0.05) / (y! + 0.05);
}

export interface QrWarning {
  level: "error" | "warn";
  message: string;
}

/**
 * Design problems a scan test can miss: phone cameras need strong contrast,
 * dark-on-light codes, and a quiet zone. A transparent code is judged on
 * white, where it is usually printed.
 */
export function qrWarnings(s: QrStyle): QrWarning[] {
  const out: QrWarning[] = [];
  const bg = s.transparent ? "#ffffff" : s.bg;
  const ratio = contrastRatio(s.fg, bg);
  if (ratio < 3) out.push({ level: "error", message: `Contrast is ${ratio.toFixed(1)}:1. Many phones won't read it: aim for at least 4:1.` });
  else if (ratio < 4) out.push({ level: "warn", message: `Contrast is ${ratio.toFixed(1)}:1. Darken the code or lighten the background for reliable scans.` });
  if (luminance(s.fg) > luminance(bg)) out.push({ level: "warn", message: "Light code on a dark background: some phone cameras can't read inverted codes." });
  if (s.margin < QR_MARGIN_SAFE) out.push({ level: "warn", message: "A narrow quiet zone can stop scans when the code is printed next to other content." });
  if (s.transparent) out.push({ level: "warn", message: "Transparent: put it on a light, plain background." });
  return out;
}
