// Visitor pages for protected and limited links, in the not-found page's style.

import { NOT_FOUND_IMAGE_PATH, renderPageCard } from "../shared/not-found";
import { PAGE_HEADERS, publicNotFoundPage } from "./not-found";

const address = (domain: string, slug: string) => `${domain}/${slug.length > 80 ? `${slug.slice(0, 80)}…` : slug}`;

export async function passwordPage(env: Env, domain: string, slug: string, opts: { error: string | null; status: number; retryAfter?: number }): Promise<Response> {
  const style = await publicNotFoundPage(env);
  const html = renderPageCard(style, { domain, imageSrc: null }, {
    title: "Password required",
    code: "🔒",
    heading: "This link is protected",
    address: null,
    message: "Enter the password you were given to continue.",
    button: null,
    form: { error: opts.error },
    note: address(domain, slug),
  });
  return new Response(html, {
    status: opts.status,
    headers: {
      ...PAGE_HEADERS,
      // The form posts back to this page.
      "Content-Security-Policy": PAGE_HEADERS["Content-Security-Policy"].replace("form-action 'none'", "form-action 'self'"),
      ...(opts.retryAfter ? { "Retry-After": String(opts.retryAfter) } : {}),
    },
  });
}

/**
 * After a correct password: sets the access cookie and moves on to the short
 * link with a meta refresh. Not a 303: browsers hold every redirect after a
 * form post to the page's form-action, which (rightly) doesn't allow the
 * destination's site.
 */
export async function unlockedPage(env: Env, domain: string, slug: string, path: string, cookie: string): Promise<Response> {
  const style = await publicNotFoundPage(env);
  const html = renderPageCard(style, { domain, imageSrc: null }, {
    title: "Unlocked",
    code: "🔓",
    heading: "Unlocked",
    address: null,
    message: "Taking you there now.",
    button: { label: "Continue", href: path },
    refresh: { seconds: 0, url: path },
    note: address(domain, slug),
  });
  return new Response(html, { status: 200, headers: { ...PAGE_HEADERS, "Cache-Control": "no-store", "Set-Cookie": cookie } });
}

export async function limitPage(env: Env, domain: string, slug: string): Promise<Response> {
  const style = await publicNotFoundPage(env);
  const html = renderPageCard(style, { domain, imageSrc: style.image ? `${NOT_FOUND_IMAGE_PATH}?v=${style.image.v}` : null }, {
    title: "Link limit reached",
    code: "410",
    heading: "This link has reached its limit",
    address: address(domain, slug),
    message: "It could only be opened a set number of times, and they've all been used.",
    button: style.buttonLabel ? { label: style.buttonLabel, href: style.buttonUrl || env.FALLBACK_URL } : null,
  });
  return new Response(html, { status: 410, headers: PAGE_HEADERS });
}

/** When the click counter can't be reached: the limit is kept, so nobody gets in uncounted. */
export async function unavailablePage(env: Env, domain: string, slug: string): Promise<Response> {
  const style = await publicNotFoundPage(env);
  const html = renderPageCard(style, { domain, imageSrc: null }, {
    title: "Try again",
    code: "503",
    heading: "This link is busy",
    address: null,
    message: "It couldn't be opened just now. Please try again in a moment.",
    button: null,
    note: address(domain, slug),
  });
  return new Response(html, { status: 503, headers: { ...PAGE_HEADERS, "Retry-After": "5" } });
}
