import { linkKey, linkLabel } from "../../shared/domains";
import type { LinkDTO } from "../../shared/types";
import { useMe } from "./me";

export { linkKey };

/** Admin route of a link. */
export function linkPath(l: { domain: string; slug: string }): string {
  return `/links/${encodeURIComponent(l.domain)}/${encodeURIComponent(l.slug)}`;
}

/** The configured short domains, primary first. */
export function useDomains(): { domains: string[]; primary: string; multiple: boolean; demo: boolean } {
  const workspace = useMe().data?.workspace;
  const domains = workspace?.domains ?? [];
  return { domains, primary: workspace?.primaryDomain ?? domains[0] ?? "", multiple: domains.length > 1, demo: Boolean(workspace?.demo) };
}

/** Labels links as "/guide" on the primary domain and "alt.example/guide" elsewhere. */
export function useLinkLabel(): (l: { domain: string; slug: string }) => string {
  const { primary } = useDomains();
  return (l) => linkLabel(l.domain, l.slug, primary || l.domain);
}

/** What a visitor gets right now. */
export function linkState(l: Pick<LinkDTO, "active" | "expiresAt" | "broken">): "active" | "disabled" | "expired" | "broken" {
  if (!l.active) return "disabled";
  if (l.expiresAt !== null && l.expiresAt * 1000 <= Date.now()) return "expired";
  if (l.broken) return "broken";
  return "active";
}
