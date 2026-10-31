// Search or jump: pages, actions and links in one keyboard-first list.
// Link search reuses the Links page query with its defaults.

import { useQuery } from "@tanstack/react-query";
import { Activity, BarChart3, CornerDownLeft, Globe2, LayoutList, Link2, Plus, Settings, SunMoon, Unlink, Upload } from "lucide-react";
import { Dialog as D } from "radix-ui";
import { useDeferredValue, useEffect, useMemo, useState, type ComponentType } from "react";
import { useNavigate } from "react-router";
import { api, call, keys } from "../api";
import { hostOf } from "../lib/format";
import { linkPath, useLinkLabel } from "../lib/links";
import { useCan } from "../lib/me";
import { saveTheme, savedTheme } from "../lib/theme";
import { cn } from "../lib/utils";

interface Item {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  run: () => void;
}

export function CommandBar({ open, onOpenChange, onCreate }: { open: boolean; onOpenChange: (open: boolean) => void; onCreate?: () => void }) {
  const navigate = useNavigate();
  const label = useLinkLabel();
  const can = useCan();
  const [text, setText] = useState("");
  const q = useDeferredValue(text.trim());
  const [active, setActive] = useState(0);
  const query = { q: q || undefined, tag: undefined, domain: undefined, status: "all" as const, period: "7d" as const };
  const links = useQuery({ queryKey: keys.links(query), queryFn: () => call(api.links.$get({ query })), enabled: open && q.length > 0, placeholderData: (prev) => prev });

  useEffect(() => {
    if (open) {
      setText("");
      setActive(0);
    }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const go = (to: string) => () => {
      onOpenChange(false);
      navigate(to);
    };
    const base: Item[] = [
      ...(can("stats.view") ? [{ id: "p-analytics", group: "Go to", label: "Analytics", icon: BarChart3, run: go("/") }] : []),
      { id: "p-links", group: "Go to", label: "All links", icon: Link2, run: go("/links") },
      { id: "p-bio", group: "Go to", label: "Bio pages", icon: LayoutList, run: go("/links?status=bio") },
      ...(can("stats.view") ? [{ id: "p-sites", group: "Go to", label: "Websites", icon: Globe2, run: go("/sites") }] : []),
      ...(can("stats.view") ? [{ id: "p-hits", group: "Go to", label: "Recent hits", icon: Activity, run: go("/hits") }] : []),
      ...(can("health.manage") ? [{ id: "p-health", group: "Go to", label: "Link health", icon: Unlink, run: go("/health") }] : []),
      ...(can("links.create") ? [{ id: "p-import", group: "Go to", label: "Import links", icon: Upload, run: go("/import") }] : []),
      { id: "p-settings", group: "Go to", label: "Settings", icon: Settings, run: go("/settings") },
      ...(onCreate ? [{ id: "a-create", group: "Actions", label: "Create link", hint: "C", icon: Plus, run: () => { onOpenChange(false); onCreate(); } }] : []),
      { id: "a-theme", group: "Actions", label: "Switch theme", icon: SunMoon, run: () => saveTheme(savedTheme() === "dark" ? "light" : savedTheme() === "light" ? "auto" : "dark") },
    ];
    const needle = q.toLowerCase();
    const filtered = needle ? base.filter((i) => i.label.toLowerCase().includes(needle)) : base;
    const found: Item[] = q && links.data
      ? links.data.links.slice(0, 8).map((l) => ({
          id: `l-${l.domain}/${l.slug}`,
          group: "Links",
          label: label(l),
          hint: l.title || hostOf(l.target),
          icon: Link2,
          run: go(linkPath(l)),
        }))
      : [];
    return [...found, ...filtered];
  }, [q, links.data, label, navigate, onCreate, onOpenChange, can]);

  useEffect(() => setActive(0), [q]);
  const current = Math.min(active, Math.max(0, items.length - 1));

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((current + 1) % Math.max(1, items.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((current - 1 + items.length) % Math.max(1, items.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      items[current]?.run();
    }
  };

  let lastGroup = "";
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="ui-overlay" />
        <D.Content className="ui-command" aria-describedby={undefined}>
          <D.Title className="ui-sr">Search or jump to</D.Title>
          <div className="ui-command-input">
            <input
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKey}
              placeholder="Search links, pages and actions"
              aria-label="Search links, pages and actions"
              role="combobox"
              aria-expanded
              aria-controls="ui-command-list"
              aria-activedescendant={items[current] ? `ui-cmd-${items[current]!.id}` : undefined}
            />
            {links.isFetching ? <span className="ui-command-busy">Searching…</span> : null}
          </div>
          <ul id="ui-command-list" role="listbox" className="ui-command-list" aria-label="Results">
            {items.map((item, i) => {
              const head = item.group !== lastGroup ? item.group : null;
              lastGroup = item.group;
              return (
                <li key={item.id} role="presentation">
                  {head ? <div className="ui-command-group" role="presentation">{head}</div> : null}
                  <div
                    id={`ui-cmd-${item.id}`}
                    role="option"
                    aria-selected={i === current}
                    className={cn("ui-command-item", i === current && "is-active")}
                    onMouseMove={() => setActive(i)}
                    onClick={() => item.run()}
                  >
                    <item.icon aria-hidden />
                    <span className="ui-command-label">{item.label}</span>
                    {item.hint ? <span className="ui-command-hint">{item.hint}</span> : null}
                    {i === current ? <CornerDownLeft className="ui-command-enter" aria-hidden /> : null}
                  </div>
                </li>
              );
            })}
            {!items.length ? <li className="ui-command-empty">{links.isFetching ? "Searching…" : `Nothing matches “${q}”.`}</li> : null}
          </ul>
          <div className="ui-command-foot">
            <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
            <span><kbd>↵</kbd> open</span>
            <span><kbd>esc</kbd> close</span>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
