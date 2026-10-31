// Buttons. One shape (a pill), four variants, three sizes.
// Look: ui.css (.ui-button). Every button gets hover, focus-visible, active,
// disabled and loading; at phone width every size is at least 44 px tall.

import { Slot } from "radix-ui";
import { forwardRef, type ButtonHTMLAttributes, type ComponentType, type ReactNode } from "react";
import { cn } from "../../lib/utils";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

type Icon = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Busy: the label stays, a small ring shows, the button can't be pressed again. */
  loading?: boolean;
  icon?: Icon;
  /** A keyboard shortcut shown at the end, e.g. "C". */
  kbd?: string;
  /** Render the child (a router Link or an <a>) with the button's look. */
  asChild?: boolean;
  /** Kit only: show a state without interacting ("hover" | "focus" | "active"). */
  "data-demo"?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading = false, icon: IconC, kbd, asChild, className, children, disabled, type, ...rest },
  ref,
) {
  const cls = cn("ui-button", className);
  if (asChild) {
    return (
      <Slot.Root ref={ref} className={cls} data-variant={variant} data-size={size} {...rest}>
        {children}
      </Slot.Root>
    );
  }
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cls}
      data-variant={variant}
      data-size={size}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="ui-button-ring" aria-hidden /> : IconC ? <IconC aria-hidden /> : null}
      {children}
      {kbd ? <kbd className="ui-button-kbd" aria-hidden>{kbd}</kbd> : null}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** Required: the accessible name, also shown as the tooltip. */
  label: string;
  icon: Icon;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  "data-demo"?: string;
}

/** A square button with only an icon. The label is its name and its title. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon: IconC, variant = "ghost", size = "md", loading, className, disabled, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cn("ui-button ui-icon-button", className)}
      data-variant={variant}
      data-size={size}
      aria-label={label}
      title={label}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="ui-button-ring" aria-hidden /> : <IconC aria-hidden />}
    </button>
  );
});

/** Text that acts: inline, underlined, accent ink. For actions inside a sentence. */
export function TextButton({ className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  return (
    <button type="button" className={cn("ui-text-button", className)} {...rest}>
      {children}
    </button>
  );
}
