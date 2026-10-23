import { AlertTriangle, CheckCircle2, Clock, ShieldQuestion, XCircle, type LucideIcon } from "lucide-react";
import { STATE_LABEL, type CheckState } from "../../shared/link-check";
import { Badge } from "./ui";

type Tone = "good" | "warn" | "danger" | "neutral";

export const CHECK_STYLE: Record<CheckState, { tone: Tone; icon: LucideIcon; text: string; soft: string }> = {
  down: { tone: "danger", icon: XCircle, text: "text-danger", soft: "bg-danger-soft" },
  warning: { tone: "warn", icon: AlertTriangle, text: "text-warn", soft: "bg-warn-soft" },
  ok: { tone: "good", icon: CheckCircle2, text: "text-good", soft: "bg-good-soft" },
  blocked: { tone: "neutral", icon: ShieldQuestion, text: "text-muted", soft: "bg-surface-2" },
  unchecked: { tone: "neutral", icon: Clock, text: "text-muted", soft: "bg-surface-2" },
};

/** Worst first: the order problems are listed in. */
export const STATE_ORDER: readonly CheckState[] = ["down", "warning", "unchecked", "blocked", "ok"];

/** A destination check's state. `label` overrides the default wording. */
export function CheckBadge({ state, label }: { state: CheckState; label?: string }) {
  const { tone, icon: Icon } = CHECK_STYLE[state];
  return (
    <Badge tone={tone}>
      <Icon className="size-3" aria-hidden />
      {label ?? STATE_LABEL[state]}
    </Badge>
  );
}
