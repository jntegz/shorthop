// Small pieces shared by Settings → "API, MCP & webhooks" and "Access &
// security" (integrations.tsx, access.tsx and their parts). Look:
// settings.css, the "settings-a-" block.

import { Copy, Info } from "lucide-react";
import { Popover } from "radix-ui";
import type { ReactNode } from "react";
import { toast } from "sonner";
import type { Help } from "../../lib/help";
import { cn, copy } from "../../lib/utils";
import { Button, errorText, Skeleton } from "../ui";

/** A failed mutation, in words a person can act on. */
export function toastError(e: unknown) {
  toast.error(errorText(e) ?? (e instanceof Error ? e.message : "That didn’t work. Try again."));
}

/** The (i) behind a section title: the longer explanation from lib/help.ts, in a popover. */
export function HelpTip({ help }: { help: Help }) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className="ui-button ui-icon-button settings-a-help" data-variant="ghost" data-size="sm" aria-label={`About ${help.title}`} title={`About ${help.title}`}>
          <Info aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="settings-a-pop" side="bottom" align="end" sideOffset={6} collisionPadding={12} aria-label={help.title}>
          <p className="settings-a-pop-title">{help.title}</p>
          <p className="settings-a-pop-body">{help.body}</p>
          {help.example ? <code className="settings-a-pop-example">{help.example}</code> : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Label / value rows under 1 px rules. */
export function Facts({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn("settings-a-facts", className)}>{children}</dl>;
}
export function Fact({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="settings-a-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** A secret or one-time link shown in a read-only field, with Copy. */
export function SecretField({ value, copied, label }: { value: string; copied: string; label: string }) {
  return (
    <div className="settings-a-secret" role="group" aria-label={label}>
      <code>{value}</code>
      <Button size="sm" icon={Copy} onClick={() => void copy(value, copied)}>
        Copy
      </Button>
    </div>
  );
}

/** A copy-ready command or config, with a title line and Copy. */
export function CodeBlock({ title, code, copied = "Copied", copyLabel = "Copy" }: { title: ReactNode; code: string; copied?: string; copyLabel?: string }) {
  return (
    <div className="settings-a-code">
      <div className="settings-a-code-head">
        <p>{title}</p>
        <Button size="sm" variant="ghost" icon={Copy} onClick={() => void copy(code, copied)}>
          {copyLabel}
        </Button>
      </div>
      <pre tabIndex={0}>{code}</pre>
    </div>
  );
}

/** A list's loading shape: rows of text lines. */
export function RowsLoading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="settings-a-loading" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="settings-a-loading-row">
          <Skeleton className="ui-skel-text" style={{ width: `${46 - i * 6}%` }} />
          <Skeleton className="ui-skel-text" style={{ width: `${68 - i * 8}%` }} />
        </div>
      ))}
    </div>
  );
}

/** An external link (Cloudflare dashboard), marked as leaving the admin. */
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="settings-a-link">
      {children}
      <span aria-hidden> ↗</span>
      <span className="ui-sr"> (opens in a new tab)</span>
    </a>
  );
}
