// Overlays: Dialog, Sheet and Menu, thin wrappers around Radix. They portal
// into <body>, so their tokens come from <html data-ui="app"> (set in
// _admin/index.html), not from a wrapper element. Focus is trapped and returned by Radix;
// Escape closes; the close button is always labelled.

import { X } from "lucide-react";
import { Dialog as RDialog, DropdownMenu as RMenu } from "radix-ui";
import { useEffect, type ComponentType, type ReactNode } from "react";
import { cn } from "../../lib/utils";
import { IconButton } from "./button";

interface OverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Buttons, right-aligned; the primary one last. */
  footer?: ReactNode;
  className?: string;
}

/**
 * Where focus lands when a dialog opens: the first field of the body, else the
 * first footer button (Cancel, by the "primary last" rule), never the ✕.
 * A confirm dialog therefore opens on Cancel, a form on its first input.
 */
/**
 * For components/ui.tsx dialogs opened from these pages (LinkForm's Edit),
 * which let Radix focus the ✕ on open: once the dialog has taken focus, move
 * it to the first text field, so it opens where you type, without a ring on
 * Close.
 */
export function useFocusFirstField(open: boolean) {
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    let tries = 0;
    const run = () => {
      const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]');
      const dlg = dialogs[dialogs.length - 1];
      if (dlg && dlg.contains(document.activeElement)) {
        const active = document.activeElement as HTMLElement | null;
        // Only replace the default (the ✕ or the panel); never steal a field the user is in.
        if (active && (active === dlg || active.getAttribute("aria-label") === "Close")) {
          dlg.querySelector<HTMLElement>('input:is([type="url"], [type="text"], :not([type])):not(:disabled), textarea:not(:disabled)')?.focus({ preventScroll: true });
        }
        return;
      }
      if (++tries < 30) raf = requestAnimationFrame(run);
    };
    raf = requestAnimationFrame(run);
    return () => cancelAnimationFrame(raf);
  }, [open]);
}

function focusFirst(e: Event) {
  const root = e.currentTarget as HTMLElement;
  const target =
    root.querySelector<HTMLElement>(":is(.ui-dialog-body, .ui-sheet-body) :is(input, select, textarea):not(:disabled, [type=hidden])") ??
    root.querySelector<HTMLElement>(".ui-dialog-foot :is(button, a[href]):not(:disabled)");
  if (!target) return;
  e.preventDefault();
  target.focus();
}

/** A centred dialog for a short task that needs protected focus (confirm, a small form). */
export function Dialog({ open, onOpenChange, title, description, children, footer, className, size = "md" }: OverlayProps & { size?: "sm" | "md" | "lg" }) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="ui-scrim" />
        <RDialog.Content className={cn("ui-dialog", className)} data-size={size} onOpenAutoFocus={focusFirst} {...(description ? {} : { "aria-describedby": undefined })}>
          <header className="ui-dialog-head">
            <div>
              <RDialog.Title className="ui-dialog-title">{title}</RDialog.Title>
              {description ? <RDialog.Description className="ui-dialog-desc">{description}</RDialog.Description> : null}
            </div>
            <RDialog.Close asChild>
              <IconButton label="Close" icon={X} size="sm" />
            </RDialog.Close>
          </header>
          {children ? <div className="ui-dialog-body">{children}</div> : null}
          {footer ? <footer className="ui-dialog-foot">{footer}</footer> : null}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

/**
 * A sheet: from the bottom on phones (the "More" menu), from the right on
 * wider screens (side = "auto"), or always from the bottom (side = "bottom").
 */
export function Sheet({ open, onOpenChange, title, description, children, footer, className, side = "auto", hideTitle }: OverlayProps & { side?: "auto" | "bottom" | "right"; hideTitle?: boolean }) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="ui-scrim" />
        <RDialog.Content className={cn("ui-sheet", className)} data-side={side} aria-describedby={undefined}>
          <span className="ui-sheet-grip" aria-hidden />
          <header className={cn("ui-dialog-head", hideTitle && "is-bare")}>
            <div>
              <RDialog.Title className={cn("ui-dialog-title", hideTitle && "ui-sr")}>{title}</RDialog.Title>
              {description ? <RDialog.Description className="ui-dialog-desc">{description}</RDialog.Description> : null}
            </div>
            <RDialog.Close asChild>
              <IconButton label="Close" icon={X} size="sm" />
            </RDialog.Close>
          </header>
          {children ? <div className="ui-sheet-body">{children}</div> : null}
          {footer ? <footer className="ui-dialog-foot">{footer}</footer> : null}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

type Icon = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

export interface MenuItem {
  label: string;
  icon?: Icon;
  onSelect: () => void;
  /** A destructive action: red, and last in the menu. */
  danger?: boolean;
  disabled?: boolean;
  /** Shortcut hint, e.g. "E". */
  kbd?: string;
}

/** An action menu (Radix DropdownMenu): arrow keys, type-ahead, Escape. */
export function Menu({ trigger, items, label, align = "end", open, onOpenChange }: { trigger: ReactNode; items: (MenuItem | "separator")[]; label?: string; align?: "start" | "end"; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  return (
    <RMenu.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <RMenu.Trigger asChild>{trigger}</RMenu.Trigger>
      <RMenu.Portal>
        <RMenu.Content className="ui-menu" align={align} sideOffset={6} collisionPadding={8} aria-label={label}>
          {items.map((it, i) =>
            it === "separator" ? (
              <RMenu.Separator key={`s${i}`} className="ui-menu-sep" />
            ) : (
              <RMenu.Item key={it.label} className="ui-menu-item" data-danger={it.danger ? "" : undefined} disabled={it.disabled} onSelect={it.onSelect}>
                {it.icon ? <it.icon aria-hidden /> : null}
                <span>{it.label}</span>
                {it.kbd ? <kbd className="ui-menu-kbd" aria-hidden>{it.kbd}</kbd> : null}
              </RMenu.Item>
            ),
          )}
        </RMenu.Content>
      </RMenu.Portal>
    </RMenu.Root>
  );
}
