import { Activity, ArrowUpRight, BarChart3, ChartNoAxesCombined, ChevronRight, Ellipsis, Globe, Link2, LogOut, Plus, Search, Settings, Unlink, Upload, X } from "lucide-react";
import { Dialog as D } from "radix-ui";
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
  /** On phones: one of the tabs in the bottom bar (the rest are under More), with a shorter label. */
  tab?: string;
}

const NAV: NavItem[] = [
  { to: "/", label: "Overview", icon: ChartNoAxesCombined, end: true, need: "stats.view", tab: "Overview" },
  { to: "/stats", label: "Full statistics", icon: BarChart3, end: false, need: "stats.view", tab: "Stats" },
  { to: "/links", label: "All links", icon: Link2, end: false, tab: "Links" },
  { to: "/hits", label: "Recent hits", icon: Activity, end: false, need: "stats.view" },
  { to: "/sites", label: "Websites", icon: Globe, end: false, need: "stats.view", tab: "Websites" },
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
    <span className="flex size-9 items-center justify-center rounded-md bg-accent text-white"><Link2 className="size-5 -rotate-45" strokeWidth={2.5} /></span>
    <span>Short<span className="text-accent">hop</span></span>
  </Link>;
}

export function Layout() {
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const [more, setMore] = useState(false);
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
    setMore(false);
  }, [pathname, current?.label]);

  function findLink(e: FormEvent) {
    e.preventDefault();
    navigate(`/links${search.trim() ? `?q=${encodeURIComponent(search.trim())}` : ""}`);
    setSearch("");
  }

  return <div className="min-h-screen">
    <a href="#main-content" className="fixed top-3 left-3 z-50 -translate-y-24 rounded-md bg-accent px-4 py-3 text-sm text-white focus:translate-y-0">Skip to content</a>
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col overflow-y-auto border-r border-line bg-surface px-4 py-7 md:flex">
      <div className="px-3"><Brand /></div>
      {(() => {
        const inner = <><div className="min-w-0"><p className="text-sm font-semibold">Personal workspace{demo ? <span className="ml-1.5 rounded bg-accent-soft px-1.5 py-0.5 align-middle text-[10px] font-semibold text-accent">Demo data</span> : null}</p><p className="mt-0.5 truncate text-xs text-muted">{primary || "No domain yet"}{domains.length > 1 ? ` + ${domains.length - 1} more` : ""}</p></div></>;
        const box = "mt-8 flex items-center gap-3 rounded-md border border-line bg-bg px-3 py-3";
        return manage ? <Link to="/settings#domains" className={cn(box, "hover:border-accent/40")} title="Short domains">{inner}</Link> : <div className={box}>{inner}</div>;
      })()}
      {creates ? <Button className="mt-5 w-full shrink-0" onClick={() => setCreating(true)}><Plus /> Create link</Button> : null}
      <nav className="mt-8 flex flex-col gap-1" aria-label="Main">
        {nav.map((n) => { const { to, label, icon: Icon } = n; return <Link key={to} to={to} aria-current={isCurrent(n, pathname) ? "page" : undefined}
          className={cn("flex items-center gap-3 rounded-md px-2.5 py-2 text-sm font-medium transition-colors", n === firstOfGroup2 && "mt-5", isCurrent(n, pathname) ? "bg-surface-2 font-semibold text-fg" : "text-muted hover:bg-surface-2 hover:text-fg")}>
          <Icon className={cn("size-[18px]", isCurrent(n, pathname) && "text-accent")} strokeWidth={1.8} />{label}
        </Link>; })}
      </nav>
      <div className="mt-auto pt-8">
        {manage ? <Link to="/settings#cloudflare" className="inline-flex items-center gap-1 px-2 text-xs text-muted hover:text-fg">Cloudflare features <ArrowUpRight className="size-3" /></Link> : null}
        <div className="mt-5 flex items-center gap-2.5 border-t border-line px-2 pt-5">
          <Link to="/settings#account" className="flex min-w-0 items-center gap-2.5" title="Your account">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">{me ? (passwordOnly ? "AD" : initials(me.name, me.email)) : ""}</span>
            <div className="min-w-0"><p className="truncate text-xs font-semibold">{me ? (passwordOnly ? "Admin" : me.name || me.email) : " "}</p><p className="mt-0.5 truncate text-xs text-muted">{me ? (passwordOnly ? "Password login" : me.owner ? "Owner" : ROLE_LABEL[me.role]) : " "}</p></div>
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
      <header className="flex h-14 items-center justify-between gap-4 border-b border-line bg-surface px-4 sm:px-8 lg:px-10">
        <div className="md:hidden"><Brand /></div>
        <div className="hidden items-center gap-2 text-xs text-muted md:flex">{pathname.startsWith("/links/") && <><Link to="/links" className="hover:text-fg">Links</Link><ChevronRight className="size-3 text-subtle" /><span className="font-medium text-fg">Link details</span></>}</div>
        <form onSubmit={findLink} role="search" className="relative hidden w-64 sm:block">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" />
          <input aria-label="Find a link" placeholder="Find a link…" value={search} onChange={(e) => setSearch(e.target.value)} className="h-9 w-full rounded-lg border border-line bg-bg pr-3 pl-9 text-xs placeholder:text-subtle" />
        </form>
        {creates ? <Button size="icon" className="sm:hidden" onClick={() => setCreating(true)} aria-label="Create link"><Plus /></Button> : null}
      </header>
      <main id="main-content" tabIndex={-1} className="px-4 pt-7 pb-24 outline-none sm:px-8 md:pb-12 lg:px-10 lg:pt-9">
        <div key={pathname} className="mx-auto max-w-[1320px]"><SystemStatusBanner /><Outlet /></div>
        <footer className="mx-auto mt-8 flex max-w-[1320px] flex-wrap items-center justify-between gap-2 border-t border-line pt-5 text-xs text-muted"><span>Made for meaningful connections.</span><span><a href={REPO_URL} target="_blank" rel="noopener noreferrer" className="font-medium text-accent hover:underline">{APP_NAME}</a> by <a href={AUTHOR_URL} target="_blank" rel="noopener noreferrer" className="font-medium text-accent hover:underline">{AUTHOR_NAME}</a> · MIT</span><span>Analytics in UTC · No tracking cookies</span></footer>
      </main>
    </div>
    <MobileNav nav={nav} pathname={pathname} more={more} onMore={setMore} me={me} manage={manage} />
    {creates ? <LinkForm open={creating} onOpenChange={setCreating} onSaved={(l) => navigate(linkPath(l))} /> : null}
  </div>;
}

/**
 * Phones: four tabs and More, a sheet with every other page, the account and
 * log out. Each tab keeps a tall target and a one-line label.
 */
function MobileNav({
  nav,
  pathname,
  more,
  onMore,
  me,
  manage,
}: {
  nav: NavItem[];
  pathname: string;
  more: boolean;
  onMore: (open: boolean) => void;
  me: ReturnType<typeof useMe>["data"];
  manage: boolean;
}) {
  const tabs = nav.filter((n) => n.tab);
  const rest = nav.filter((n) => !n.tab);
  const inMore = rest.some((n) => isCurrent(n, pathname));
  const tabClass = (active: boolean) =>
    cn("flex min-h-16 min-w-0 flex-col items-center justify-center gap-1 px-1 text-[11px] font-medium transition-colors", active ? "text-accent" : "text-muted active:text-fg");
  return (
    <>
      <nav
        className="mobile-nav fixed inset-x-0 bottom-0 z-30 grid border-t border-line bg-surface/95 backdrop-blur md:hidden"
        style={{ gridTemplateColumns: `repeat(${tabs.length + (rest.length ? 1 : 0)}, minmax(0, 1fr))` }}
        aria-label="Main"
      >
        {tabs.map((n) => {
          const active = isCurrent(n, pathname);
          const Icon = n.icon;
          return (
            <Link key={n.to} to={n.to} aria-current={active ? "page" : undefined} className={tabClass(active)}>
              <Icon className="size-5" strokeWidth={active ? 2.2 : 1.8} aria-hidden />
              <span className="max-w-full truncate">{n.tab}</span>
            </Link>
          );
        })}
        {rest.length ? (
          <button type="button" onClick={() => onMore(true)} aria-haspopup="dialog" aria-expanded={more} className={tabClass(inMore || more)}>
            <Ellipsis className="size-5" strokeWidth={inMore ? 2.2 : 1.8} aria-hidden />
            <span>More</span>
          </button>
        ) : null}
      </nav>
      <D.Root open={more} onOpenChange={onMore}>
        <D.Portal>
          <D.Overlay className="fixed inset-0 z-40 bg-black/40 md:hidden" />
          <D.Content
            className="mobile-nav fixed inset-x-0 bottom-0 z-50 max-h-[85vh] overflow-y-auto rounded-t-2xl border-t border-line bg-surface px-4 pt-3 shadow-2xl focus:outline-none md:hidden"
            aria-describedby={undefined}
          >
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-line" aria-hidden />
            <div className="mb-2 flex items-center justify-between">
              <D.Title className="text-base font-semibold text-fg">More</D.Title>
              <D.Close asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Close">
                  <X />
                </Button>
              </D.Close>
            </div>
            <ul className="space-y-1">
              {rest.map((n) => {
                const active = isCurrent(n, pathname);
                const Icon = n.icon;
                return (
                  <li key={n.to}>
                    <Link
                      to={n.to}
                      onClick={() => onMore(false)}
                      aria-current={active ? "page" : undefined}
                      className={cn("flex min-h-12 items-center gap-3 rounded-lg px-3 text-sm font-medium text-fg", active ? "bg-surface-2" : "active:bg-surface-2")}
                    >
                      <Icon className={cn("size-5", active ? "text-accent" : "text-muted")} strokeWidth={1.8} aria-hidden />
                      {n.label}
                      <ChevronRight className="ml-auto size-4 text-subtle" aria-hidden />
                    </Link>
                  </li>
                );
              })}
            </ul>
            <div className="mt-3 flex items-center gap-3 border-t border-line px-3 py-4">
              <Link to="/settings#account" onClick={() => onMore(false)} className="flex min-w-0 flex-1 items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">{me ? initials(me.name, me.email) : ""}</span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-fg">{me ? me.name || me.email : ""}</span>
                  <span className="block truncate text-xs text-muted">{me ? (me.owner ? "Owner" : ROLE_LABEL[me.role]) : ""}</span>
                </span>
              </Link>
              <form method="post" action="/_admin/logout">
                <Button type="submit" variant="outline" size="sm">
                  <LogOut /> Log out
                </Button>
              </form>
            </div>
            {manage ? (
              <Link to="/settings#cloudflare" onClick={() => onMore(false)} className="mb-4 inline-flex items-center gap-1 px-3 text-xs text-muted">
                Cloudflare features <ArrowUpRight className="size-3" aria-hidden />
              </Link>
            ) : null}
          </D.Content>
        </D.Portal>
      </D.Root>
    </>
  );
}
