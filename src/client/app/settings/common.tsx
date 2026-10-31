// Small pieces shared by the settings tabs (General, Links, Statistics & email).
// Look: settings.css (settings- prefix).

import { Copy } from "lucide-react";
import type { ReactNode } from "react";
import { day } from "../../lib/format";
import type { Help } from "../../lib/help";
import { copy } from "../../lib/utils";
import { IconButton, Section, Skeleton, SkeletonText } from "../ui";
import { HelpTip } from "./parts";

/**
 * A settings section: the ui Section, with its longer explanation
 * (SETTINGS_HELP) behind the (i) in its tools, the same click/tap popover the
 * API and Access tabs use (parts.tsx HelpTip), so it works on touch.
 */
export function SettingsSection({ id, title, sub, aside, help, className, children }: { id: string; title: ReactNode; sub?: ReactNode; aside?: ReactNode; help?: Help; className?: string; children: ReactNode }) {
  const tools =
    aside || help ? (
      <>
        {aside}
        {help ? <HelpTip help={help} /> : null}
      </>
    ) : undefined;
  return (
    <Section id={id} title={title} sub={sub} aside={tools} className={className ? `settings-section ${className}` : "settings-section"}>
      {children}
    </Section>
  );
}

/** Inline code: a command, a file name, a variable. */
export function Code({ children }: { children: ReactNode }) {
  return <code className="settings-code">{children}</code>;
}

/** A command or config snippet with a copy button. */
export function Snippet({ text }: { text: string }) {
  return (
    <div className="settings-snippet">
      <pre>{text}</pre>
      <IconButton label="Copy" icon={Copy} size="sm" className="settings-snippet-copy" onClick={() => void copy(text)} />
    </div>
  );
}

/** The loading shape of a section whose own data hasn't arrived (the id is there, so #anchors still land). */
export function SectionSkeleton({ id, title, lines = 4, tall }: { id: string; title: ReactNode; lines?: number; tall?: boolean }) {
  return (
    <Section id={id} title={title} className="settings-section">
      <div aria-busy className="settings-skel">
        <SkeletonText lines={lines} />
        {tall ? <Skeleton className="settings-skel-block" /> : null}
      </div>
    </Section>
  );
}

/** "Oct 14 – Oct 20", or one day. */
export function span(from: string, to: string): string {
  return from === to ? day(from) : `${day(from)} – ${day(to)}`;
}
