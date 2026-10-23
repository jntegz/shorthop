// Small shadcn-style primitives on Radix, styled with the semantic tokens.

import { cva, type VariantProps } from "class-variance-authority";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Info, Loader2, X } from "lucide-react";
import { Dialog as D, Popover as P, Switch as S } from "radix-ui";
import {
  createContext,
  useContext,
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import type { Help } from "../lib/help";
import { PAGE_SIZES, parsePageSize, type PageSize, type SortDir } from "../lib/table";
import { cn } from "../lib/utils";

const button = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "border border-accent bg-accent text-accent-fg shadow-sm hover:brightness-110 active:translate-y-px",
        secondary: "bg-surface-2 text-fg hover:bg-line",
        outline: "border border-line bg-surface text-fg hover:bg-surface-2",
        ghost: "text-muted hover:bg-surface-2 hover:text-fg",
        danger: "bg-danger text-white hover:opacity-90",
      },
      size: {
        sm: "h-9 px-3",
        md: "h-10 px-4",
        icon: "size-10",
        "icon-sm": "size-9",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof button> {
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, loading, children, disabled, ...props },
  ref,
) {
  return (
    <button ref={ref} className={cn(button({ variant, size }), className)} disabled={disabled || loading} {...props}>
      {loading ? <Loader2 className="animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
});

export function buttonClass(opts: VariantProps<typeof button> & { className?: string }): string {
  return cn(button({ variant: opts.variant, size: opts.size }), opts.className);
}

const FieldContext = createContext<{ describedBy?: string; invalid?: boolean }>({});

const field =
  "w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg placeholder:text-subtle focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 disabled:opacity-60";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  const context = useContext(FieldContext);
  return <input ref={ref} aria-describedby={context.describedBy} aria-invalid={context.invalid || undefined} className={cn(field, "h-10", className)} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...props },
  ref,
) {
  const context = useContext(FieldContext);
  return <textarea ref={ref} aria-describedby={context.describedBy} aria-invalid={context.invalid || undefined} className={cn(field, "min-h-20 py-2", className)} {...props} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...props },
  ref,
) {
  const context = useContext(FieldContext);
  return (
    <select aria-describedby={context.describedBy} aria-invalid={context.invalid || undefined} ref={ref} className={cn(field, "h-10 cursor-pointer pr-8", className)} {...props}>
      {children}
    </select>
  );
});

/** An (i) button that opens a short explanation. Click, tap or keyboard; Esc closes it. */
export function InfoTip({ help, className }: { help: Help; className?: string }) {
  return (
    <P.Root>
      <P.Trigger asChild>
        <button
          type="button"
          aria-label={`About ${help.title}`}
          className={cn(
            "inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent transition-colors hover:bg-accent hover:text-accent-fg data-[state=open]:bg-accent data-[state=open]:text-accent-fg",
            className,
          )}
        >
          <Info className="size-3.5" strokeWidth={2.25} aria-hidden />
        </button>
      </P.Trigger>
      <P.Portal>
        {/* Above the Dialog (z-50) and portalled so its scroll area can't clip it. */}
        <P.Content
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          aria-label={help.title}
          className="z-[60] max-w-[min(20rem,calc(100vw-2rem))] rounded-xl border border-line bg-surface p-3 text-xs leading-relaxed text-fg shadow-xl focus:outline-none"
        >
          <p className="mb-1 font-semibold">{help.title}</p>
          <p className="text-muted">{help.body}</p>
          {help.example ? <p className="mt-2 rounded-md bg-surface-2 px-2 py-1 font-mono text-[11px] break-words text-fg">{help.example}</p> : null}
          <P.Arrow className="fill-surface" width={12} height={6} />
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}

function Label({ className, ...props }: HTMLAttributes<HTMLLabelElement> & { htmlFor?: string }) {
  return <label className={cn("text-sm font-medium text-fg", className)} {...props} />;
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  info,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: ReactNode;
  error?: string | null;
  info?: Help;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1">
        <Label htmlFor={htmlFor}>{label}</Label>
        {info ? <InfoTip help={info} /> : null}
      </div>
      <FieldContext.Provider value={{ describedBy: error || hint ? `${htmlFor}-description` : undefined, invalid: Boolean(error) }}>{children}</FieldContext.Provider>
      {error ? (
        <p id={`${htmlFor}-description`} className="text-xs text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={`${htmlFor}-description`} className="text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export function Switch({
  checked,
  onCheckedChange,
  id,
  label,
  description,
  info,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  id: string;
  label: string;
  description?: string;
  info?: Help;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-0.5">
        <div className="flex items-center gap-1">
          <label htmlFor={id} className="text-sm font-medium text-fg">
            {label}
          </label>
          {info ? <InfoTip help={info} /> : null}
        </div>
        {description ? <p className="text-xs text-muted">{description}</p> : null}
      </div>
      <S.Root
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        className="relative mt-0.5 inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full bg-line transition-colors data-[state=checked]:bg-accent"
      >
        <S.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-4.5" />
      </S.Root>
    </div>
  );
}

const badge = cva("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", {
  variants: {
    tone: {
      neutral: "bg-surface-2 text-muted",
      good: "bg-good-soft text-good",
      warn: "bg-warn-soft text-warn",
      danger: "bg-danger-soft text-danger",
      accent: "bg-accent-soft text-accent",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export function Badge({ tone, className, ...props }: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badge>) {
  return <span className={cn(badge({ tone }), className)} {...props} />;
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("card min-w-0 rounded-2xl border border-line bg-surface", className)} {...props} />;
}

export function CardHeader({
  title,
  description,
  action,
  info,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  info?: Help;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-x-3 gap-y-2 px-5 pt-5 pb-4", className)}>
      <div className="min-w-0">
        <div className="flex items-center gap-1">
          <h2 className="text-[15px] font-semibold tracking-tight text-fg">{title}</h2>
          {info ? <InfoTip help={info} /> : null}
        </div>
        {description ? <p className="mt-1 text-xs leading-relaxed text-muted">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-[#222438]/30 backdrop-blur-sm" />
        <D.Content
          className={cn(
            "fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-line bg-surface p-6 shadow-2xl focus:outline-none",
            wide ? "max-w-2xl" : "max-w-lg",
          )}
        >
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <D.Title className="text-base font-semibold text-fg">{title}</D.Title>
              {description ? (
                <D.Description className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">{description}</D.Description>
              ) : (
                <D.Description className="sr-only">{title}</D.Description>
              )}
            </div>
            <D.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close">
                <X />
              </Button>
            </D.Close>
          </div>
          {children}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: readonly { value: T; label: string }[];
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex max-w-full rounded-xl border border-line bg-surface-2 p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          tabIndex={value === o.value ? 0 : -1}
          onKeyDown={(event) => {
            const index = options.findIndex((option) => option.value === o.value);
            let next = index;
            if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % options.length;
            else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + options.length) % options.length;
            else if (event.key === "Home") next = 0;
            else if (event.key === "End") next = options.length - 1;
            else return;
            event.preventDefault();
            onChange(options[next]!.value);
            event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
          }}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-lg px-2 py-2 text-[11px] whitespace-nowrap font-medium transition-colors sm:px-3 sm:text-xs",
            value === o.value ? "bg-surface text-accent shadow-sm" : "text-muted hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span role="status"><Loader2 className={cn("size-5 animate-spin text-accent", className)} aria-hidden /><span className="sr-only">Loading</span></span>;
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {icon ? <div className="mb-2 flex size-14 items-center justify-center rounded-2xl bg-accent-soft text-accent [&_svg]:size-6">{icon}</div> : null}
      <p className="text-sm font-medium text-fg">{title}</p>
      {children ? <div className="max-w-sm text-sm text-muted">{children}</div> : null}
    </div>
  );
}

export function Notice({ tone = "warn", children }: { tone?: "warn" | "accent" | "danger"; children: ReactNode }) {
  const tones = {
    warn: "border-warn/30 bg-warn-soft text-warn",
    accent: "border-accent/30 bg-accent-soft text-accent",
    danger: "border-danger/30 bg-danger-soft text-danger",
  };
  return <div role={tone === "danger" ? "alert" : "status"} className={cn("flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm leading-relaxed", tones[tone])}><Info className="mt-0.5 size-4 shrink-0" aria-hidden /><div>{children}</div></div>;
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-7 flex flex-wrap items-center justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[28px] font-semibold tracking-[-0.035em] text-fg sm:text-[32px]">{title}</h1>
        {description ? <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** A column header that sorts the table: click to sort by it, click again to flip the order. */
export function SortHeader({ label, active, dir, onSort, className }: { label: string; active: boolean; dir: SortDir; onSort: () => void; className?: string }) {
  const Icon = !active ? ArrowUpDown : dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th className={cn("px-4 py-2.5 font-medium", className)} aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        onClick={onSort}
        className={cn("inline-flex items-center gap-1 rounded hover:text-fg", active && "text-fg", className?.includes("text-right") && "flex-row-reverse")}
        title={`Sort by ${label.toLowerCase()}`}
      >
        {label}
        <Icon className={cn("size-3.5", !active && "opacity-40")} aria-hidden />
      </button>
    </th>
  );
}

/** "Showing 1–25 of 312", rows per page (25, 50, 100) and previous/next. */
export function Pagination({ page, pages, size, total, onPage, onSize }: { page: number; pages: number; size: PageSize; total: number; onPage: (page: number) => void; onSize: (size: PageSize) => void }) {
  if (total === 0) return null;
  const from = (page - 1) * size + 1;
  const to = Math.min(page * size, total);
  return (
    <nav className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-muted" aria-label="Pagination">
      <span className="tabular">Showing {from}–{to} of {total}</span>
      <div className="flex items-center gap-2">
        <label className="inline-flex items-center gap-2">
          Rows per page
          <Select className="h-9 w-auto text-xs" value={size} onChange={(e) => onSize(parsePageSize(e.target.value) ?? size)}>
            {PAGE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
        </label>
        <Button variant="outline" size="icon-sm" aria-label="Previous page" disabled={page <= 1} onClick={() => onPage(page - 1)}><ChevronLeft /></Button>
        <span className="tabular min-w-20 text-center">Page {page} of {pages}</span>
        <Button variant="outline" size="icon-sm" aria-label="Next page" disabled={page >= pages} onClick={() => onPage(page + 1)}><ChevronRight /></Button>
      </div>
    </nav>
  );
}
