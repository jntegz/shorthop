// The page visitors see for a link marked "no longer working". With a usable
// replacement it points to that link; without one it sends the visitor on to
// a site after a few seconds. The owner edits the wording in Settings; the
// colors and image are the not-found page's.

import { renderPageCard, type NotFoundPage } from "./not-found";

export interface DeadLinkPage {
  /** With a replacement link. */
  replacedHeading: string;
  replacedMessage: string;
  replacedButton: string;
  /** Without one (none chosen, or it was removed, disabled, expired or is itself not working). */
  goneHeading: string;
  goneMessage: string;
  goneButton: string;
  /** Where visitors are sent without a replacement; empty means the not-found page's button link. */
  redirectUrl: string;
  delaySeconds: number;
}

export const DEAD_LINK_MIN_DELAY = 3;
export const DEAD_LINK_MAX_DELAY = 60;

export const DEFAULT_DEAD_LINK: DeadLinkPage = {
  replacedHeading: "This link no longer works",
  replacedMessage: "The page this link pointed to doesn't exist anymore or stopped working. Here's the next best thing:",
  replacedButton: "Take me there",
  goneHeading: "This link no longer works",
  goneMessage: "The page this link pointed to doesn't exist anymore or stopped working. You'll be redirected in {seconds} seconds.",
  goneButton: "Go now",
  redirectUrl: "",
  delaySeconds: 7,
};

/** Keeps a stored or draft page safe to render: missing or bad values fall back to the defaults. */
export function normalizeDeadLink(p: Partial<DeadLinkPage> | null | undefined): DeadLinkPage {
  const v = { ...DEFAULT_DEAD_LINK, ...p };
  const delay = Math.round(Number(v.delaySeconds));
  return {
    replacedHeading: String(v.replacedHeading || DEFAULT_DEAD_LINK.replacedHeading),
    replacedMessage: String(v.replacedMessage ?? ""),
    replacedButton: String(v.replacedButton || DEFAULT_DEAD_LINK.replacedButton),
    goneHeading: String(v.goneHeading || DEFAULT_DEAD_LINK.goneHeading),
    goneMessage: String(v.goneMessage ?? ""),
    goneButton: String(v.goneButton ?? ""),
    redirectUrl: /^https?:\/\//i.test(String(v.redirectUrl)) ? String(v.redirectUrl) : "",
    delaySeconds: Number.isFinite(delay) ? Math.min(DEAD_LINK_MAX_DELAY, Math.max(DEAD_LINK_MIN_DELAY, delay)) : DEFAULT_DEAD_LINK.delaySeconds,
  };
}

/** Where the "no replacement" variant sends visitors. */
export function deadLinkRedirectUrl(p: DeadLinkPage, notFound: NotFoundPage, fallbackUrl: string): string {
  return p.redirectUrl || notFound.buttonUrl || fallbackUrl;
}

export type DeadLinkVariant =
  | { kind: "replaced"; href: string; label: string }
  | { kind: "gone"; redirectUrl: string };

/**
 * The full HTML document. `style` is the not-found page (colors and image);
 * `address` is the link the visitor opened ("go.example.com/old").
 */
export function renderDeadLink(
  p: DeadLinkPage,
  style: NotFoundPage,
  opts: { domain: string; address: string; imageSrc: string | null },
  variant: DeadLinkVariant,
): string {
  const seconds = (s: string) => s.replaceAll("{seconds}", String(p.delaySeconds));
  if (variant.kind === "replaced") {
    return renderPageCard(style, opts, {
      title: "Link no longer works",
      code: "410",
      heading: p.replacedHeading,
      address: opts.address,
      message: seconds(p.replacedMessage),
      button: { label: p.replacedButton, href: variant.href },
      note: variant.label,
    });
  }
  return renderPageCard(style, opts, {
    title: "Link no longer works",
    code: "410",
    heading: p.goneHeading,
    address: opts.address,
    message: seconds(p.goneMessage),
    button: p.goneButton ? { label: p.goneButton, href: variant.redirectUrl } : null,
    refresh: { seconds: p.delaySeconds, url: variant.redirectUrl },
  });
}
