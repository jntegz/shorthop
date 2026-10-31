// A small "?" that opens an explanation (lib/help.ts texts), as a Radix
// popover: click or Enter opens it, Escape closes it and
// focus returns to the button.

import { CircleHelp } from "lucide-react";
import { Popover } from "radix-ui";
import type { Help } from "../../lib/help";

export function HelpTip({ help, label }: { help: Help; label?: string }) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className="hits-help-btn" aria-label={label ?? help.title} title={help.title}>
          <CircleHelp aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="hits-help" side="bottom" align="start" sideOffset={6} collisionPadding={12}>
          <p className="hits-help-title">{help.title}</p>
          <p className="hits-help-body">{help.body}</p>
          {help.example ? <pre className="hits-help-example">{help.example}</pre> : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
