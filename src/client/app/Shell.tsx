// The admin's shell: sidebar (brand, workspace, Create link, the nav in two
// groups, footer links, account row; on phones a bottom tab bar and a More
// sheet), the command bar (⌘K or /) and the c shortcut. Styles: shell.css,
// loaded with every other admin stylesheet by main.tsx.

import { Activity, BarChart3, ChevronRight, ChevronsUpDown, Ellipsis, Globe, LayoutList, Link2, LogOut, Moon, Plus, Search, Settings, Sun, Unlink, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router";
import { APP_NAME, AUTHOR_NAME, AUTHOR_URL, REPO_URL } from "../../shared/brand";
import type { Permission } from "../../shared/permissions";
import { LinkForm } from "../components/LinkForm";
import { useSystemHealth } from "./hits/SystemStatus";
import { linkPath, useDomains } from "../lib/links";
import { useCan, useMe } from "../lib/me";
import { saveTheme, useTheme } from "../lib/theme";
import { CommandBar } from "./CommandBar";
import { Button, IconButton, Menu, Sheet, type MenuItem } from "./ui";

export interface NavItem {
  to: string;
  label: string;
  icon: typeof Link2;
  end: boolean;
  /** Another path where this entry is current too (Link health: /misses; Settings: /api-docs). */
  also?: string;
  need?: Permission;
  /** Starts the second group. */
  group?: 2;
  /** On phones: one of the bottom tabs, with this shorter label. */
  tab?: string;
}

/** The sidebar, in two groups. */
export const NAV: NavItem[] = [
  { to: "/", label: "Analytics", icon: BarChart3, end: true, need: "stats.view", tab: "Analytics" },
  { to: "/links", label: "All links", icon: Link2, end: false, tab: "Links" },
  { to: "/links?status=bio", label: "Bio pages", icon: LayoutList, end: false },
  { to: "/sites", label: "Websites", icon: Globe, end: false, need: "stats.view", tab: "Websites" },
  { to: "/hits", label: "Recent hits", icon: Activity, end: false, need: "stats.view" },
  { to: "/health", label: "Link health", icon: Unlink, end: false, also: "/misses", need: "health.manage", group: 2 },
  { to: "/import", label: "Import links", icon: Upload, end: false, need: "links.create", group: 2 },
  { to: "/settings", label: "Settings", icon: Settings, end: false, also: "/api-docs", group: 2 },
];

const BIO_VIEW = /[?&]status=bio(&|$)/;

/** Own path, Bio pages by its query, Link health also on /misses, Settings also on /api-docs. */
export function isCurrent(n: NavItem, pathname: string, search = ""): boolean {
  const [path, query] = n.to.split("?");
  if (n.end) return pathname === path;
  if (query) return pathname === path && BIO_VIEW.test(search);
  if (pathname === "/links" && BIO_VIEW.test(search)) return false;
  return pathname.startsWith(path!) || (n.also !== undefined && pathname.startsWith(n.also));
}

const ROLE_LABEL = { admin: "Admin", manager: "Manager", user: "User" } as const;

/** "Anna Novak" → "AN", "anna@example.com" → "AN". */
function initials(name: string, email: string): string {
  const words = (name.trim() || email.split("@")[0]!.replace(/[._-]+/g, " ")).split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? words[0]?.[1] ?? "")).toUpperCase() || "?";
}

/** Two dots and the arc between them: a short hop. */
export function HopMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path d="M5 17.5C6.5 8.5 17.5 8.5 19 17.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeDasharray="0.1 4.2" />
      <circle cx="5" cy="17.5" r="2.6" fill="currentColor" />
      <circle cx="19" cy="17.5" r="2.6" fill="currentColor" />
    </svg>
  );
}

/** Whether the admin is dark right now: chosen, or following the system. */
function useIsDark(): boolean {
  const theme = useTheme();
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return theme === "dark" || (theme === "auto" && systemDark);
}

/** Light or dark in one click (Settings → Appearance also offers Automatic). */
function ThemeToggle() {
  const dark = useIsDark();
  return <IconButton label={dark ? "Switch to light mode" : "Switch to dark mode"} icon={dark ? Sun : Moon} onClick={() => saveTheme(dark ? "light" : "dark")} />;
}

function isTyping(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

/** Checks whose failure means short links or the admin itself are broken right now. */
const BROKEN_NOW = new Set(["kv", "d1"]);

/**
 * System status, quietly: one line with a dot when a check needs attention,
 * nothing when all is well. The dot is warn for a setup still to finish (email,
 * Analytics Engine, a rollup); red only when redirects or the database fail.
 */
function StatusLine({ onNavigate }: { onNavigate?: () => void }) {
  const { data } = useSystemHealth();
  if (!data || data.status === "ok") return null;
  // Checks off by choice (an advisory) stay in System status, not here.
  const problems = data.checks.filter((c) => c.status !== "ok" && !c.advisory);
  if (!problems.length) return null;
  const broken = problems.some((c) => c.status === "error" && BROKEN_NOW.has(c.id));
  const text = problems.length === 1 ? `${problems[0]!.label} needs a look` : `${problems.length} system checks to review`;
  return (
    <Link to="/#status" className="ui-status" data-tone={broken ? "error" : "warn"} onClick={onNavigate} title={problems.map((c) => c.label).join(", ")}>
      <span className="ui-status-dot" aria-hidden />
      <span className="ui-status-text">{text}</span>
    </Link>
  );
}

function Brand() {
  return (
    <Link to="/" className="ui-brand" aria-label={`${APP_NAME}, analytics`}>
      <HopMark className="ui-brand-mark" />
      <span>{APP_NAME}</span>
    </Link>
  );
}

function FootLinks({ apiUse, manage, onNavigate }: { apiUse: boolean; manage: boolean; onNavigate?: () => void }) {
  return (
    <>
      {apiUse ? (
        <Link to="/settings#mcp" className="ui-foot-link" onClick={onNavigate}>
          AI assistants (MCP)
        </Link>
      ) : null}
      {manage ? (
        <Link to="/settings#cloudflare" className="ui-foot-link" onClick={onNavigate}>
          Cloudflare features
        </Link>
      ) : null}
      <p className="ui-foot-credit">
        <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
          {APP_NAME}
        </a>{" "}
        by{" "}
        <a href={AUTHOR_URL} target="_blank" rel="noopener noreferrer">
          {AUTHOR_NAME}
        </a>{" "}
        · MIT
      </p>
    </>
  );
}

function AccountLink({ me, onNavigate }: { me: ReturnType<typeof useMe>["data"]; onNavigate?: () => void }) {
  // Without Access everyone signed in is the owner, with no email to show.
  const passwordOnly = me?.authMode === "password";
  return (
    <Link to="/settings#account" className="ui-account-link" title="Your account" onClick={onNavigate}>
      <span className="ui-avatar" aria-hidden>{me ? (passwordOnly ? "AD" : initials(me.name, me.email)) : ""}</span>
      <span className="ui-account-text">
        <span className="ui-account-name">{me ? (passwordOnly ? "Admin" : me.name || me.email) : " "}</span>
        <span className="ui-account-role">{me ? (passwordOnly ? "Password login" : me.owner ? "Owner" : ROLE_LABEL[me.role]) : " "}</span>
      </span>
    </Link>
  );
}

function NavEntry({ n, current, className }: { n: NavItem; current: boolean; className?: string }) {
  return (
    <Link to={n.to} aria-current={current ? "page" : undefined} className={className}>
      <n.icon aria-hidden />
      <span className="ui-nav-label">{n.label}</span>
    </Link>
  );
}

/**
 * The workspace box. One domain: its name (a link to Settings → Short domains
 * for people who manage settings). Several: the primary domain and how many
 * there are, opening a list where each domain jumps to its links.
 */
function Workspace({ domains, primary, manage, demo }: { domains: string[]; primary: string; manage: boolean; demo: boolean }) {
  const navigate = useNavigate();
  const main = primary || domains[0] || "No domain yet";
  const name = (
    <span className="ui-workspace-name">
      Personal workspace{demo ? <span className="ui-workspace-demo">Demo data</span> : null}
    </span>
  );
  if (domains.length < 2) {
    const inner = (
      <>
        {name}
        <span className="ui-workspace-domain">{main}</span>
      </>
    );
    return manage ? (
      <Link to="/settings#domains" className="ui-workspace" title="Short domains">{inner}</Link>
    ) : (
      <div className="ui-workspace">{inner}</div>
    );
  }
  const ordered = [main, ...domains.filter((d) => d !== main)];
  const items: (MenuItem | "separator")[] = ordered.map((d) => ({
    label: d === main ? `${d} (primary)` : d,
    icon: Globe,
    onSelect: () => navigate(`/links?domain=${encodeURIComponent(d)}`),
  }));
  if (manage) items.push("separator", { label: "Manage short domains", icon: Settings, onSelect: () => navigate("/settings#domains") });
  return (
    <Menu
      label="Short domains"
      align="start"
      items={items}
      trigger={
        <button type="button" className="ui-workspace is-menu" aria-label={`Personal workspace: ${domains.length} short domains. Show them`}>
          <span className="ui-workspace-text">
            {name}
            <span className="ui-workspace-domain">
              {main} <span className="ui-workspace-count">+{domains.length - 1}</span>
            </span>
          </span>
          <ChevronsUpDown aria-hidden className="ui-workspace-chevron" />
        </button>
      }
    />
  );
}

export function Shell() {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const can = useCan();
  const me = useMe().data;
  const { domains, primary, demo } = useDomains();
  const [creating, setCreating] = useState(false);
  const [command, setCommand] = useState(false);
  const [more, setMore] = useState(false);
  const nav = NAV.filter((n) => !n.need || can(n.need));
  const firstOfGroup2 = nav.find((n) => n.group === 2);
  const current = NAV.find((n) => isCurrent(n, pathname, search));
  const creates = can("links.create");
  const manage = can("settings.manage");
  const apiUse = can("api.use");

  const title = pathname === "/kit" ? "Component sheet" : (current?.label ?? "Workspace");
  useEffect(() => {
    document.title = `${title} · ${APP_NAME}`;
  }, [title]);
  useEffect(() => {
    window.scrollTo(0, 0);
    setMore(false);
  }, [pathname]);

  // ⌘K or / opens the command bar; c creates a link.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommand((v) => !v);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || document.querySelector("[role=dialog]")) return;
      if (e.key === "/") {
        e.preventDefault();
        setCommand(true);
      } else if (e.key === "c" && creates) {
        e.preventDefault();
        setCreating(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [creates]);


  const tabs = nav.filter((n) => n.tab);
  const rest = nav.filter((n) => !n.tab);
  const inMore = rest.some((n) => isCurrent(n, pathname, search));
  const closeMore = () => setMore(false);

  return (
    <div className="ui-app">
      <a href="#ui-main" className="ui-skip">Skip to content</a>
      <aside className="ui-side" aria-label="Sidebar">
        <Brand />
        <button type="button" className="ui-search" onClick={() => setCommand(true)} aria-keyshortcuts="Meta+K /" title="Search links, or jump to a page">
          <Search aria-hidden />
          <span>Search…</span>
          <kbd aria-hidden>⌘K</kbd>
        </button>
        <Workspace domains={domains} primary={primary} manage={manage} demo={demo} />
        {creates ? (
          <Button variant="primary" icon={Plus} kbd="C" className="ui-side-create" onClick={() => setCreating(true)} aria-keyshortcuts="c">
            Create link
          </Button>
        ) : null}
        <nav aria-label="Main" className="ui-nav">
          {nav.map((n) => (
            <NavEntry key={n.to} n={n} current={isCurrent(n, pathname, search)} className={n === firstOfGroup2 ? "ui-nav-item is-group" : "ui-nav-item"} />
          ))}
        </nav>
        <div className="ui-side-foot">
          <StatusLine />
          <FootLinks apiUse={apiUse} manage={manage} />
          <div className="ui-account">
            <AccountLink me={me} />
            <ThemeToggle />
            <form method="post" action="/_admin/logout">
              <IconButton type="submit" label="Log out" icon={LogOut} />
            </form>
          </div>
        </div>
      </aside>

      <header className="ui-mobile-head">
        <Brand />
        <div className="ui-mobile-actions">
          <IconButton label="Search or jump to" icon={Search} size="lg" onClick={() => setCommand(true)} />
          {creates ? <IconButton label="Create link" icon={Plus} variant="primary" size="lg" onClick={() => setCreating(true)} /> : null}
        </div>
      </header>

      <main id="ui-main" className="ui-main" tabIndex={-1}>
        <Outlet />
      </main>

      <nav aria-label="Main, phone" className="ui-tabbar" style={{ "--n": tabs.length + (rest.length ? 1 : 0) } as React.CSSProperties}>
        {tabs.map((n) => {
          const active = isCurrent(n, pathname, search);
          return (
            <Link key={n.to} to={n.to} aria-current={active ? "page" : undefined} className="ui-tabbar-item">
              <n.icon aria-hidden />
              <span>{n.tab}</span>
            </Link>
          );
        })}
        {rest.length ? (
          <button type="button" className={inMore || more ? "ui-tabbar-item is-current" : "ui-tabbar-item"} onClick={() => setMore(true)} aria-haspopup="dialog" aria-expanded={more}>
            <Ellipsis aria-hidden />
            <span>More</span>
          </button>
        ) : null}
      </nav>

      <Sheet open={more} onOpenChange={setMore} title="More" side="bottom">
        <ul className="ui-more-list">
          {rest.map((n) => {
            const active = isCurrent(n, pathname, search);
            return (
              <li key={n.to}>
                <Link to={n.to} onClick={closeMore} aria-current={active ? "page" : undefined} className="ui-more-item">
                  <n.icon aria-hidden />
                  <span className="ui-nav-label">{n.label}</span>
                  <ChevronRight className="ui-more-chevron" aria-hidden />
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="ui-more-account">
          <AccountLink me={me} onNavigate={closeMore} />
          <ThemeToggle />
          <form method="post" action="/_admin/logout">
            <Button type="submit" size="sm" icon={LogOut}>Log out</Button>
          </form>
        </div>
        <StatusLine onNavigate={closeMore} />
        <div className="ui-more-links">
          <FootLinks apiUse={apiUse} manage={manage} onNavigate={closeMore} />
        </div>
      </Sheet>

      <CommandBar open={command} onOpenChange={setCommand} onCreate={creates ? () => setCreating(true) : undefined} />
      {creates ? <LinkForm open={creating} onOpenChange={setCreating} onSaved={(l) => navigate(linkPath(l))} /> : null}
    </div>
  );
}
