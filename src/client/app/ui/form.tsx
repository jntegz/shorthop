// Form controls. Every control has a visible label (or, for compact filters,
// an aria-label the caller must give); hints and errors are linked with
// aria-describedby. Native <input>/<select> keep the platform's keyboard and
// mobile pickers; Checkbox and Switch are Radix primitives.

import { CheckIcon, ChevronDown, MinusIcon } from "lucide-react";
import { Checkbox as RCheckbox, Switch as RSwitch } from "radix-ui";
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

interface FieldProps {
  label: ReactNode;
  /** Visually hidden label (the control still has a name). */
  hideLabel?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  "data-demo"?: string;
}

function useFieldIds(id?: string) {
  const auto = useId();
  const base = id ?? auto;
  return { id: base, hint: `${base}-hint`, error: `${base}-error` };
}

function FieldShell({ ids, label, hideLabel, hint, error, className, children }: FieldProps & { ids: ReturnType<typeof useFieldIds>; children: ReactNode }) {
  return (
    <div className={cn("ui-field", className)} data-invalid={error ? "" : undefined}>
      <label htmlFor={ids.id} className={cn("ui-field-label", hideLabel && "ui-sr")}>{label}</label>
      {children}
      {error ? <p id={ids.error} className="ui-field-error">{error}</p> : hint ? <p id={ids.hint} className="ui-field-hint">{hint}</p> : null}
    </div>
  );
}

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & FieldProps;

/** A labelled text input. 16 px text on phones so iOS doesn't zoom. */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ label, hideLabel, hint, error, className, id, "data-demo": demo, ...rest }, ref) {
  const ids = useFieldIds(id);
  return (
    <FieldShell ids={ids} label={label} hideLabel={hideLabel} hint={hint} error={error} className={className}>
      <input
        ref={ref}
        id={ids.id}
        className="ui-input"
        data-demo={demo}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? ids.error : hint ? ids.hint : undefined}
        {...rest}
      />
    </FieldShell>
  );
});

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & FieldProps & { options: { value: string; label: string }[] };

/** A labelled native select: the platform picker on phones, type-ahead on desktop. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ label, hideLabel, hint, error, className, id, options, "data-demo": demo, ...rest }, ref) {
  const ids = useFieldIds(id);
  return (
    <FieldShell ids={ids} label={label} hideLabel={hideLabel} hint={hint} error={error} className={className}>
      <span className="ui-select" data-demo={demo}>
        <select
          ref={ref}
          id={ids.id}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? ids.error : hint ? ids.hint : undefined}
          {...rest}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <ChevronDown aria-hidden />
      </span>
    </FieldShell>
  );
});

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & FieldProps;

/** A labelled multi-line input, in the same shell as Input. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ label, hideLabel, hint, error, className, id, "data-demo": demo, rows = 4, ...rest }, ref) {
  const ids = useFieldIds(id);
  return (
    <FieldShell ids={ids} label={label} hideLabel={hideLabel} hint={hint} error={error} className={className}>
      <textarea
        ref={ref}
        id={ids.id}
        rows={rows}
        className="ui-input ui-textarea"
        data-demo={demo}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? ids.error : hint ? ids.hint : undefined}
        {...rest}
      />
    </FieldShell>
  );
});

interface ToggleProps {
  label: ReactNode;
  /** Visually hidden label, e.g. a row checkbox in a table (it still has a name). */
  hideLabel?: boolean;
  description?: ReactNode;
  checked: boolean | "indeterminate";
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  id?: string;
  "data-demo"?: string;
  /** Passed to the box itself, e.g. tabIndex={-1} for a table row's tick box that the row selects. */
  tabIndex?: number;
  [data: `data-${string}`]: string | undefined;
}

/** A Radix checkbox with its label; the whole row is the target (44 px on phones). */
export function Checkbox({ label, hideLabel, description, checked, onCheckedChange, disabled, className, id, ...box }: ToggleProps) {
  const auto = useId();
  const cid = id ?? auto;
  return (
    <div className={cn("ui-toggle", className)} data-disabled={disabled ? "" : undefined}>
      <RCheckbox.Root
        id={cid}
        className="ui-checkbox"
        checked={checked}
        onCheckedChange={(v) => onCheckedChange?.(v === true)}
        disabled={disabled}
        aria-describedby={description ? `${cid}-d` : undefined}
        {...box}
      >
        <RCheckbox.Indicator className="ui-checkbox-mark">{checked === "indeterminate" ? <MinusIcon aria-hidden /> : <CheckIcon aria-hidden />}</RCheckbox.Indicator>
      </RCheckbox.Root>
      <span className={cn("ui-toggle-text", hideLabel && "ui-sr")}>
        <label htmlFor={cid} className="ui-toggle-label">{label}</label>
        {description ? <span id={`${cid}-d`} className="ui-toggle-desc">{description}</span> : null}
      </span>
    </div>
  );
}

/** A Radix switch: for a setting that takes effect at once (no Save button). */
export function Switch({ label, hideLabel, description, checked, onCheckedChange, disabled, className, id, ...box }: ToggleProps) {
  const auto = useId();
  const sid = id ?? auto;
  return (
    <div className={cn("ui-toggle", className)} data-disabled={disabled ? "" : undefined}>
      <RSwitch.Root
        id={sid}
        className="ui-switch"
        checked={checked === true}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-describedby={description ? `${sid}-d` : undefined}
        {...box}
      >
        <RSwitch.Thumb className="ui-switch-thumb" />
      </RSwitch.Root>
      <span className={cn("ui-toggle-text", hideLabel && "ui-sr")}>
        <label htmlFor={sid} className="ui-toggle-label">{label}</label>
        {description ? <span id={`${sid}-d`} className="ui-toggle-desc">{description}</span> : null}
      </span>
    </div>
  );
}
