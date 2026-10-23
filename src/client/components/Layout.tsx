import { ArrowUpRight, BarChart3, ChartNoAxesCombined, ChevronRight, Cloud, Globe2, Link2, LogOut, Plus, Search, Settings, Unlink, Upload } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router";
import { APP_NAME, AUTHOR_NAME, AUTHOR_URL, REPO_URL } from "../../shared/brand";
import type { Permission } from "../../shared/permissions";
import { linkPath, useDomains } from "../lib/links";
import { useCan, useMe } from "../lib/me";
import { cn } from "../lib/utils";
import { LinkForm } from "./LinkForm";
import { SystemStatusBanner } from "./SystemStatus";
import { Button } from "./ui";

interface NavItem {
  to: string;
  label: string;
  icon: typeof Link2;
  end: boolean;
  also?: string;
  /** Shown only to people with this permission. */
  need?: Permission;
  /** Starts the second group in the sidebar. */
  group?: 2;
}

const NAV: NavItem[] = [
  { to: "/", label: "Overview", icon: ChartNoAxesCombined, end: true, need: "stats.view" },
  { to: "/stats", label: "Full statistics", icon: BarChart3, end: false, need: "stats.view" },
  { to: "/links", label: "All links", icon: Link2, end: false },
  // Destinations (/health) and missed visits (/misses) are its two tabs.
  { to: "/health", label: "Link health", icon: Unlink, end: false, also: "/misses", need: "health.manage", group: 2 },
  { to: "/import", label: "Import links", icon: Upload, end: false, need: "links.create", group: 2 },
  { to: "/settings", label: "Settings", icon: Settings, end: false, group: 2 },
];

/** A nav entry is current on its own path and, for Link health, on its other tab. */
function isCurrent(n: NavItem, pathname: string): boolean {
  if (n.end) return pathname === n.to;
  return pathname.startsWith(n.to) || (n.also !== undefined && pathname.startsWith(n.also));
}

const ROLE_LABEL = { admin: "Admin", manager: "Manager", user: "User" } as const;

/** "Anna Novak" → "AN", "anna@example.com" → "AN". */
function initials(name: string, email: string): string {
  const words = (name.trim() || email.split("@")[0]!.replace(/[._-]+/g, " ")).split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? words[0]?.[1] ?? "")).toUpperCase() || "?";
}

function Brand() {
  return <Link to="/" className="flex items-center gap-2.5 text-xl font-semibold tracking-[-0.04em] text-fg">
    <span className="flex size-9 items-center justify-center rounded-xl bg-accent text-white shadow-sm"><Link2 className="size-5 -rotate-45" strokeWidth={2.5} /></span>
    <span>Short<span className="text-accent">hop</span></span>
  </Link>;
}

export function Layout() {
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { domains, primary, demo } = useDomains();
  const me = useMe().data;
  const can = useCan();
  const nav = NAV.filter((n) => !n.need || can(n.need));
  const firstOfGroup2 = nav.find((n) => n.group === 2);
  // Without Access everyone signed in is the owner, with no email to show.
  const passwordOnly = me?.authMode === "password";
  const current = NAV.find((n) => isCurrent(n, pathname));
  const creates = can("links.create");
  const manage = can("settings.manage");

  useEffect(() => {
    document.title = `${current?.label ?? "Workspace"} · ${APP_NAME}`;
    window.scrollTo(0, 0);
  }, [pathname, current?.label]);

  function findLink(e: FormEvent) {
    e.preventDefault();
    navigate(`/links${search.trim() ? `?q=${encodeURIComponent(search.trim())}` : ""}`);
    setSearch("");
  }

  return <div className="min-h-screen">
    <a href="#main-content" className="fixed top-3 left-3 z-50 -translate-y-24 rounded-xl bg-accent px-4 py-3 text-sm text-white focus:translate-y-0">Skip to content</a>
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col overflow-y-auto border-r border-line bg-surface px-4 py-7 md:flex">
      <div className="px-3"><Brand /></div>
      {(() => {
        const inner = <><span className="flex size-8 items-center justify-center rounded-lg border border-line bg-white"><Globe2 className="size-4 text-muted" /></span>
          <div className="min-w-0"><p className="text-sm font-semibold">Personal workspace{demo ? <span className="ml-1.5 rounded bg-accent-soft px-1.5 py-0.5 align-middle text-[10px] font-semibold text-accent">Demo data</span> : null}</p><p className="mt-0.5 truncate text-[11px] text-muted">{primary || "No domain yet"}{domains.length > 1 ? ` + ${domains.length - 1} more` : ""}</p></div></>;
        const box = "mt-8 flex items-center gap-3 rounded-xl border border-line bg-bg px-3 py-3";
        return manage ? <Link to="/settings#domains" className={cn(box, "hover:border-accent/40")} title="Short domains">{inner}</Link> : <div className={box}>{inner}</div>;
      })()}
      {creates ? <Button className="mt-5 w-full shrink-0" onClick={() => setCreating(true)}><Plus /> Create link</Button> : null}
      <p className="mt-8 mb-3 px-3 text-[10px] font-semibold tracking-[0.16em] text-subtle">WORKSPACE</p>
      <nav className="flex flex-col gap-1" aria-label="Main">
        {nav.map((n) => { const { to, label, icon: Icon } = n; return <Link key={to} to={to} aria-current={isCurrent(n, pathname) ? "page" : undefined}
          className={cn("flex items-center gap-3 rounded-xl px-3 py-3 text-[13px] font-medium transition-colors", n === firstOfGroup2 && "mt-5", isCurrent(n, pathname) ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-2 hover:text-fg")}>
          <Icon className="size-[18px]" strokeWidth={1.8} />{label}
        </Link>; })}
      </nav>
      <div className="mt-auto pt-8">
        <div className="rounded-xl border border-line bg-bg p-4">
          <Cloud className="mb-2 size-5 text-accent" />
          <p className="text-xs font-semibold">Small links. Big possibilities.</p>
          <p className="mt-1.5 text-xs leading-relaxed text-muted">Your links, analytics, and audience. In one place.</p>
          {manage ? <Link to="/settings#cloudflare" className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-accent">Cloudflare features <ArrowUpRight className="size-3" /></Link> : null}
        </div>
        <div className="mt-5 flex items-center gap-2.5 border-t border-line px-2 pt-5">
          <Link to="/settings#account" className="flex min-w-0 items-center gap-2.5" title="Your account">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent">{me ? (passwordOnly ? "AD" : initials(me.name, me.email)) : ""}</span>
            <div className="min-w-0"><p className="truncate text-xs font-semibold">{me ? (passwordOnly ? "Admin" : me.name || me.email) : " "}</p><p className="mt-0.5 truncate text-[11px] text-muted">{me ? (passwordOnly ? "Password login" : me.owner ? "Owner" : ROLE_LABEL[me.role]) : " "}</p></div>
          </Link>
          <form method="post" action="/_admin/logout" className="ml-auto">
            <button type="submit" className="flex size-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg" aria-label="Log out" title="Log out">
              <LogOut className="size-4" />
            </button>
          </form>
        </div>
      </div>
    </aside>

    <div className="md:ml-60">
      <header className="flex min-h-[76px] items-center justify-between gap-4 border-b border-line bg-surface px-4 sm:px-8 lg:px-10">
        <div className="md:hidden"><Brand /></div>
        <div className="hidden items-center gap-2 text-xs text-muted md:flex"><span>Workspace</span><ChevronRight className="size-3 text-subtle" /><span className="font-medium text-fg">{current?.label ?? "Workspace"}</span>{pathname.startsWith("/links/") && <><ChevronRight className="size-3" /><span>Link details</span></>}</div>
        <form onSubmit={findLink} role="search" className="relative hidden w-64 sm:block">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" />
          <input aria-label="Find a link" placeholder="Find a link…" value={search} onChange={(e) => setSearch(e.target.value)} className="h-9 w-full rounded-lg border border-line bg-bg pr-3 pl-9 text-xs placeholder:text-subtle" />
        </form>
        {creates ? <Button size="icon" className="sm:hidden" onClick={() => setCreating(true)} aria-label="Create link"><Plus /></Button> : null}
      </header>
      <main id="main-content" tabIndex={-1} className="px-4 pt-7 pb-24 outline-none sm:px-8 md:pb-12 lg:px-10 lg:pt-9">
        <div key={pathname} className="page-enter mx-auto max-w-[1320px]"><SystemStatusBanner /><Outlet /></div>
        <footer className="mx-auto mt-8 flex max-w-[1320px] flex-wrap items-center justify-between gap-2 border-t border-line pt-5 text-[11px] text-muted"><span>Made for meaningful connections.</span><span><a href={REPO_URL} target="_blank" rel="noopener noreferrer" className="font-medium text-accent hover:underline">{APP_NAME}</a> by <a href={AUTHOR_URL} target="_blank" rel="noopener noreferrer" className="font-medium text-accent hover:underline">{AUTHOR_NAME}</a> · MIT</span><span>Analytics in UTC · No tracking cookies</span></footer>
      </main>
    </div>
    <nav className="mobile-nav fixed inset-x-0 bottom-0 z-30 grid border-t border-line bg-surface/95 backdrop-blur md:hidden" style={{ gridTemplateColumns: `repeat(${nav.length}, minmax(0, 1fr))` }} aria-label="Main">
      {nav.map((n) => { const { to, label, icon: Icon } = n; return <Link key={to} to={to} aria-current={isCurrent(n, pathname) ? "page" : undefined} className={cn("flex min-h-16 flex-col items-center justify-center gap-1 text-[10px] font-medium", isCurrent(n, pathname) ? "text-accent" : "text-muted")}><Icon className="size-5" />{label}</Link>; })}
    </nav>
    {creates ? <LinkForm open={creating} onOpenChange={setCreating} onSaved={(l) => navigate(linkPath(l))} /> : null}
  </div>;
}
