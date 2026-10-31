// Hosted checkout pages a short link can point straight at, and how each
// carries a reference into the payment webhook. The same mapping as provider()
// and withRef() in src/tracker/tracker.js (keep the two in step): the tracker
// decorates checkout links on a tracked site; the redirect does it for a short
// link that goes to a checkout with no site in between.

import type { Provider } from "./sites";

export type CheckoutProvider = Extract<Provider, "stripe" | "lemonsqueezy" | "dodo" | "creem" | "gumroad">;

/** The checkout provider of a hosted checkout URL, or null. */
export function checkoutProvider(url: URL): CheckoutProvider | null {
  const h = url.hostname;
  if (h === "buy.stripe.com") return "stripe";
  if (/\.lemonsqueezy\.com$/.test(h) && /\/checkout\//.test(url.pathname)) return "lemonsqueezy";
  if (/(^|\.)checkout\.dodopayments\.com$/.test(h)) return "dodo";
  if (/(^|\.)creem\.io$/.test(h) && /^\/(test\/)?payment\//.test(url.pathname)) return "creem";
  if (/(^|\.)gumroad\.com$/.test(h) && /^\/l\//.test(url.pathname)) return "gumroad";
  return null;
}

/** The query parameter each provider returns in its webhook (read back by its adapter). */
const PARAM: Record<CheckoutProvider, string> = {
  stripe: "client_reference_id",
  lemonsqueezy: "checkout[custom][sh_ref]",
  dodo: "metadata_sh_ref",
  creem: "metadata[sh_ref]",
  gumroad: "sh_ref",
};

/**
 * The checkout URL with `ref` added for its provider. A reference the owner
 * already put in the URL wins: it's theirs. Stripe's client_reference_id
 * allows letters, digits, - and _ (up to 200), hence the sh_ prefix form.
 */
export function withCheckoutRef(href: string, ref: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  const p = checkoutProvider(url);
  if (!p) return href;
  const key = PARAM[p];
  if (url.searchParams.has(key)) return href;
  url.searchParams.set(key, p === "stripe" ? `sh_${ref}` : ref);
  return url.href;
}

/** Providers whose hosted checkout can't carry a reference in its URL: sales go through a tracked site. */
export const NO_URL_REFERENCE = ["paddle", "fastspring", "paypal"] as const satisfies readonly Provider[];
