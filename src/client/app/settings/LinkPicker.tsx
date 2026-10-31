// A choice of your links that work right now (the same list and query as the
// link form's replacement picker, components/LinkPicker), as a labelled select.
// "" means none (or the example the caller names).

import { useQuery } from "@tanstack/react-query";
import type { LinkDTO } from "../../../shared/types";
import { api, call, keys } from "../../api";
import { linkKey, linkState, useLinkLabel } from "../../lib/links";
import { Select } from "../ui";

export function LinkPicker({
  id,
  label,
  hint,
  value,
  onChange,
  exclude = [],
  emptyLabel = "Choose a link",
  className,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (key: string, link: LinkDTO | null) => void;
  /** Links not to offer, as linkKeys. */
  exclude?: string[];
  /** The "" option, e.g. "Example: sh.example/new-link". */
  emptyLabel?: string;
  className?: string;
}) {
  const linkLabel = useLinkLabel();
  const candidates = useQuery({
    queryKey: keys.links({ picker: true }),
    queryFn: () => call(api.links.$get({ query: { sort: "slug", period: "7d" } })),
  });
  // The current choice stays listed even when it no longer works (disabled,
  // replaced, expired), so the picker doesn't look empty.
  const links = (candidates.data?.links ?? []).filter((l) => linkKey(l.domain, l.slug) === value || (linkState(l) === "active" && !exclude.includes(linkKey(l.domain, l.slug))));
  const first = candidates.isPending ? "Loading links…" : candidates.isError && !candidates.data ? `${emptyLabel} (your links couldn’t load)` : emptyLabel;
  return (
    <Select
      id={id}
      label={label}
      hint={hint}
      className={className}
      value={value}
      disabled={candidates.isPending}
      onChange={(e) => onChange(e.target.value, links.find((l) => linkKey(l.domain, l.slug) === e.target.value) ?? null)}
      options={[
        { value: "", label: first },
        ...links.map((l) => ({ value: linkKey(l.domain, l.slug), label: `${linkLabel(l)}${l.title ? ` · ${l.title}` : ""}` })),
      ]}
    />
  );
}
