// Countries for smart-routing rules, named by the browser (no data to ship).

import { UNKNOWN_COUNTRY } from "../../shared/routing";
import { countryName, flag } from "./format";

/** Two-letter region codes that aren't countries Cloudflare reports. */
const NOT_COUNTRIES = new Set(["EU", "EZ", "UN", "QO", "XA", "XB", "ZZ", "AA", "XX", "T1"]);

export interface CountryOption {
  code: string;
  name: string;
  flag: string;
}

let cached: CountryOption[] | null = null;

/** Every country the browser can name, A–Z, then "Unknown location". */
export function countryOptions(): CountryOption[] {
  if (cached) return cached;
  const list: CountryOption[] = [];
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
  } catch {
    names = null;
  }
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      if (NOT_COUNTRIES.has(code)) continue;
      const name = names?.of(code);
      if (name && name !== code) list.push({ code, name, flag: flag(code) });
    }
  }
  list.sort((x, y) => x.name.localeCompare(y.name));
  list.push({ code: UNKNOWN_COUNTRY, name: "Unknown location", flag: "🌐" });
  cached = list;
  return list;
}

/** A country code's display name, including the unknown pseudo-country. */
export function routeCountryName(code: string): string {
  return code === UNKNOWN_COUNTRY ? "Unknown location" : countryName(code);
}
