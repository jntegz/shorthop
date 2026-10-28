import { useQuery } from "@tanstack/react-query";
import type { LinkDTO } from "../../shared/types";
import { api, call, keys } from "../api";
import { linkKey, linkState, useLinkLabel } from "../lib/links";
import { Select } from "./ui";

/** A choice of your links that work right now (the same list as the link form's replacement picker); "" for none. */
export function LinkPicker({
  id,
  value,
  onChange,
  exclude = [],
}: {
  id: string;
  value: string;
  onChange: (key: string, link: LinkDTO | null) => void;
  /** Links not to offer, as linkKeys. */
  exclude?: string[];
}) {
  const label = useLinkLabel();
  const candidates = useQuery({
    queryKey: keys.links({ picker: true }),
    queryFn: () =>
      call(api.links.$get({ query: { sort: "slug", period: "7d" } })),
  });
  const options = (candidates.data?.links ?? []).filter(
    (l) =>
      linkState(l) === "active" && !exclude.includes(linkKey(l.domain, l.slug)),
  );
  return (
    <Select
      id={id}
      value={value}
      disabled={candidates.isPending}
      onChange={(e) =>
        onChange(
          e.target.value,
          options.find((l) => linkKey(l.domain, l.slug) === e.target.value) ??
            null,
        )
      }
    >
      <option value="">
        {candidates.isPending ? "Loading links…" : "Choose a link"}
      </option>
      {options.map((l) => {
        const key = linkKey(l.domain, l.slug);
        return (
          <option key={key} value={key}>
            {label(l)}
            {l.title ? ` · ${l.title}` : ""}
          </option>
        );
      })}
    </Select>
  );
}
