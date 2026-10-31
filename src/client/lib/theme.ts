// The admin theme: automatic (follows the system), light or dark. Kept in this
// browser, like the accent. public/_admin/assets/theme-1.js applies it before
// the first paint; this module changes it afterwards.

import { useSyncExternalStore } from "react";

export type Theme = "auto" | "light" | "dark";
const KEY = "theme";
const EVENT = "sh-theme";

export function savedTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "auto";
  } catch {
    return "auto";
  }
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

export function saveTheme(theme: Theme): void {
  applyTheme(theme);
  try {
    if (theme === "auto") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // Private mode: it still applies until the page is reloaded.
  }
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** The chosen theme, updated when it changes (here or in another tab). */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, savedTheme, () => "auto");
}
