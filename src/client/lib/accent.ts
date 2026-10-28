// The admin's accent colour: each person picks their own, kept in this browser.

export const ACCENTS = [
  { id: "purple", label: "Purple", color: "#6554c0" },
  { id: "blue", label: "Blue", color: "#3b5bdb" },
  { id: "red", label: "Red", color: "#c92a2a" },
  { id: "green", label: "Green", color: "#2b8a3e" },
] as const;

export const DEFAULT_ACCENT = "#3b5bdb";
const KEY = "accent";
const isHex = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);

export function savedAccent(): string {
  try {
    const v = localStorage.getItem(KEY);
    return isHex(v) ? v : DEFAULT_ACCENT;
  } catch {
    return DEFAULT_ACCENT;
  }
}

/** Sets the accent and the tokens made from it (the soft background, the first chart series). */
export function applyAccent(color: string): void {
  const c = isHex(color) ? color : DEFAULT_ACCENT;
  const s = document.documentElement.style;
  s.setProperty("--accent", c);
  s.setProperty("--accent-soft", `color-mix(in srgb, ${c} 9%, white)`);
  s.setProperty("--series-1", `color-mix(in srgb, ${c} 85%, white)`);
}

export function saveAccent(color: string): void {
  applyAccent(color);
  try {
    localStorage.setItem(KEY, color);
  } catch {
    // Private mode: it still applies until the page is reloaded.
  }
}
