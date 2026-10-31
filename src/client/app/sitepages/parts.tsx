// Pieces shared by the website guide, website settings, the Add website dialog
// and the API reference: code blocks with a copy button, inline code, a
// read-only field to copy, a searchable picker for long lists (time zones,
// currencies), the page header with its way back, and loading shapes.
// Look: sitepages.css (prefix sitepage-).

import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Check, ChevronDown, Copy } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link, useLocation, useParams } from "react-router";
import { api, call, keys } from "../../api";
import { cn, copy } from "../../lib/utils";
import { IconButton, Skeleton, SkeletonText } from "../ui";
import { sitePath } from "../../lib/sites";

// ---- Code ----

/** A block of code to copy: monospace on the sunken tint, scrolls sideways, a copy button in its corner. */
export function Code({ children, label }: { children: string; label: string }) {
  return (
    <div className="sitepage-code">
      {/* Focusable so a keyboard can scroll a long line. */}
      <pre tabIndex={0} aria-label={label}>
        <code>{children}</code>
      </pre>
      <IconButton className="sitepage-code-copy" label={`Copy ${label}`} icon={Copy} size="sm" onClick={() => void copy(children, "Copied")} />
    </div>
  );
}

/** Code inside a sentence. */
export function C({ children }: { children: ReactNode }) {
  return <code className="sitepage-c">{children}</code>;
}

/** A read-only value to copy (a webhook address): selects itself on focus, with a copy button beside it. */
export function CopyField({ id, value, label, hideLabel = true }: { id: string; value: string; label: string; hideLabel?: boolean }) {
  return (
    <div className="sitepage-copyfield">
      <label htmlFor={id} className={hideLabel ? "ui-sr" : "ui-field-label"}>{label}</label>
      <div className="sitepage-copyfield-row">
        <input id={id} className="ui-input sitepage-mono" readOnly value={value} onFocus={(e) => e.currentTarget.select()} />
        <IconButton variant="secondary" label={`Copy ${label}`} icon={Copy} onClick={() => void copy(value, `${label} copied`)} />
      </div>
    </div>
  );
}

// ---- Picker for long lists ----

export interface PickOption {
  value: string;
  label: string;
  /** Text after the label, e.g. the currency's name. */
  detail?: string;
  /** A short note at the end, e.g. "no daily rate". */
  note?: string;
}

const optionText = (o: PickOption) => (o.detail && o.detail !== o.label ? `${o.label} · ${o.detail}` : o.label);

/**
 * A text field that filters a long list as you type (ARIA combobox with a
 * listbox): arrows move, Enter picks, Escape puts the saved value back, Tab
 * or leaving the field keeps an exact match (or the only one left). The list
 * opens in the page flow, under the field, so it's never clipped by a dialog
 * and scrolls with it. The phone keyboard stays a plain text keyboard.
 */
export function ComboField({
  id,
  label,
  hint,
  value,
  onChange,
  options,
  placeholder = "Type to search…",
  disabled,
  className,
}: {
  id?: string;
  label: string;
  hint?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  options: PickOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  const auto = useId();
  const base = id ?? auto;
  const listId = `${base}-list`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const selected = options.find((o) => o.value === value);
  const q = (query ?? "").trim().toLowerCase();
  const shown = useMemo(
    () => (q ? options.filter((o) => `${o.value} ${o.label} ${o.detail ?? ""}`.toLowerCase().replaceAll("_", " ").includes(q.replaceAll("_", " "))) : options),
    [q, options],
  );

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  // Escape closes the list, not the dialog around it: the dialog listens on the
  // document (capture), so catch the key earlier, on the window.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || document.activeElement !== inputRef.current) return;
      e.stopPropagation();
      e.preventDefault();
      setOpen(false);
      setQuery(null);
      // Back to the saved value, selected, so typing starts over.
      requestAnimationFrame(() => inputRef.current?.select());
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  const show = () => {
    setActive(Math.max(0, query === null ? options.findIndex((o) => o.value === value) : 0));
    setOpen(true);
  };
  const pick = (o: PickOption) => {
    onChange(o.value);
    setQuery(null);
    setOpen(false);
  };
  /** Leaving the field: keep an exact match or the only one left, otherwise the saved value. */
  const settle = () => {
    if (query !== null && q) {
      const exact = options.find((o) => o.value.toLowerCase() === q || o.label.toLowerCase() === q || optionText(o).toLowerCase() === q);
      const only = shown.length === 1 ? shown[0] : undefined;
      const hit = exact ?? only;
      if (hit && hit.value !== value) onChange(hit.value);
    }
    setQuery(null);
    setOpen(false);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return show();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => Math.min(shown.length - 1, Math.max(0, a + step)));
    } else if (e.key === "PageDown" || e.key === "PageUp") {
      if (!open) return;
      e.preventDefault();
      setActive((a) => Math.min(shown.length - 1, Math.max(0, a + (e.key === "PageDown" ? 8 : -8))));
    } else if (e.key === "Enter") {
      if (open && shown[active]) {
        e.preventDefault();
        pick(shown[active]);
      }
    } else if (e.key === "Tab") {
      if (open && query !== null && q && shown[active]) pick(shown[active]);
    }
  };

  const hintId = hint ? `${base}-hint` : undefined;
  return (
    <div className={cn("ui-field sitepage-combo", className)}>
      <label htmlFor={base} className="ui-field-label">{label}</label>
      <span className="ui-select sitepage-combo-box">
        <input
          ref={inputRef}
          id={base}
          className="ui-input"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open && shown[active] ? `${base}-o${active}` : undefined}
          aria-describedby={hintId}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          disabled={disabled}
          placeholder={placeholder}
          value={query ?? (selected ? optionText(selected) : value)}
          onFocus={(e) => e.currentTarget.select()}
          onClick={() => (open ? undefined : show())}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onBlur={settle}
          onKeyDown={onKeyDown}
        />
        <ChevronDown aria-hidden />
      </span>
      {open ? (
        <ul ref={listRef} id={listId} role="listbox" aria-label={label} className="sitepage-combo-list">
          {shown.length ? (
            shown.map((o, i) => (
              <li
                key={o.value}
                id={`${base}-o${i}`}
                role="option"
                aria-selected={o.value === value}
                data-index={i}
                data-active={i === active ? "" : undefined}
                className="sitepage-combo-opt"
                // Keep focus in the field, so blur doesn't settle before the pick.
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => setActive(i)}
                onClick={() => pick(o)}
              >
                <span className="sitepage-combo-label" translate="no">{o.label}</span>
                {o.detail && o.detail !== o.label ? <span className="sitepage-combo-detail">{o.detail}</span> : null}
                {o.note ? <span className="sitepage-combo-note">{o.note}</span> : null}
                {o.value === value ? <Check className="sitepage-combo-check" aria-hidden /> : null}
              </li>
            ))
          ) : (
            <li className="sitepage-combo-none" role="presentation">Nothing matches “{query}”.</li>
          )}
        </ul>
      ) : null}
      {hint ? <p id={hintId} className="ui-field-hint">{hint}</p> : null}
    </div>
  );
}

/** IANA time zones as picker options; underscores read as spaces. */
export function zoneOptions(zones: string[]): PickOption[] {
  return zones.map((z) => ({ value: z, label: z.replaceAll("_", " ") }));
}

// ---- Page ----

/** The site these pages are about (the same key and request as the dashboard). */
export function useSitePage() {
  const { id = "" } = useParams();
  const site = useQuery({ queryKey: keys.site(id), queryFn: () => call(api.sites[":id"].$get({ param: { id } })) });
  return { id, site };
}

/** Client-side navigation doesn't jump to #goals by itself; do it once the sections exist. */
export function useHashScroll(ready: boolean) {
  const { hash } = useLocation();
  useEffect(() => {
    if (ready && hash) document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView();
  }, [ready, hash]);
}

/** "← Site name", back to the website's dashboard. */
export function BackToSite({ id, name }: { id: string; name: string | undefined }) {
  return (
    <Link to={sitePath(id)} className="sitepage-back">
      <ArrowLeft aria-hidden />
      {name ?? <Skeleton className="ui-skel-text" style={{ width: 120 }} />}
    </Link>
  );
}

/** The header: way back, title, one line under it, actions on the right. */
export function PageHead({ id, name, title, sub, tools }: { id: string; name: string | undefined; title: string; sub: ReactNode; tools?: ReactNode }) {
  return (
    <>
      <BackToSite id={id} name={name} />
      <header className="ui-head">
        <div className="ui-head-main">
          <h1 className="ui-h1">{title}</h1>
          <p className="ui-head-sub">{sub}</p>
        </div>
        {tools ? <div className="ui-head-tools">{tools}</div> : null}
      </header>
    </>
  );
}

/** The shape of a page of sections while it loads. */
export function SectionsSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div aria-busy aria-label="Loading">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="ui-section">
          <Skeleton className="ui-skel-text" style={{ width: 180, height: 18, marginBottom: 12 }} />
          <SkeletonText lines={3} />
          <Skeleton className="sitepage-skel-code" />
        </div>
      ))}
    </div>
  );
}

/** A 404 for a site that was deleted, or a mistyped address. */
export function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "status" in error && (error as { status: number }).status === 404);
}
