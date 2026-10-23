import { Globe2, SearchX } from "lucide-react";
import { NavLink } from "react-router";
import { cn } from "../lib/utils";

const TABS = [
  { to: "/health", label: "Destinations", icon: Globe2, hint: "Do your links still lead somewhere?" },
  { to: "/misses", label: "Missed visits", icon: SearchX, hint: "Visits to links that don't exist" },
] as const;

/** The two halves of Link health: destinations that fail, and visits that miss. */
export function HealthTabs({ badge }: { badge?: { to: (typeof TABS)[number]["to"]; count: number } }) {
  return (
    <nav aria-label="Link health" className="mb-6 flex gap-1 overflow-x-auto border-b border-line">
      {TABS.map(({ to, label, icon: Icon, hint }) => (
        <NavLink
          key={to}
          to={to}
          title={hint}
          className={({ isActive }) =>
            cn(
              "-mb-px flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
              isActive ? "border-accent text-accent" : "border-transparent text-muted hover:text-fg",
            )
          }
        >
          <Icon className="size-4" aria-hidden />
          {label}
          {badge?.to === to && badge.count > 0 ? (
            <span className="rounded-full bg-danger px-1.5 py-px text-[10px] font-semibold text-white tabular" aria-label={`${badge.count} need attention`}>
              {badge.count}
            </span>
          ) : null}
        </NavLink>
      ))}
    </nav>
  );
}
