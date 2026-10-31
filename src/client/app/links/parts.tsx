// Pieces of the links list: one link row and the skeleton rows. The sortable
// head, the pager and the tick box are ui/ components (SortTH, Pager, Checkbox).

import { BarChart3, Copy, Ellipsis, ExternalLink, Gauge, LayoutList, Lock, Power, QrCode, Split } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { IMPORT_SOURCE_LABEL, type LinkListItem } from "../../../shared/types";
import { problemText } from "../../../shared/link-check";
import { describeRouting } from "../../../shared/routing";
import { fullNum, hostOf, num } from "../../lib/format";
import { linkKey, linkPath, linkState, useLinkLabel } from "../../lib/links";
import { Badge, Checkbox, IconButton, Menu, Skeleton, TD, TR, type MenuItem } from "../ui";
import { bioButtonCount } from "../../../shared/bio";

// ---- Status: only what means something ----

/** Whether a row has a status worth a badge (StatusBadges renders something). */
export function hasStatus(l: LinkListItem): boolean {
  const s = linkState(l);
  return l.unsafe === "flagged" || s === "expired" || s === "disabled" || s === "broken" || Boolean(l.check && (l.check.state === "down" || l.check.state === "warning")) || Boolean(l.shares);
}

/** Badges for a row: nothing for a plain working link. */
export function StatusBadges({ l }: { l: LinkListItem }) {
  const label = useLinkLabel();
  const s = linkState(l);
  const out: ReactNode[] = [];
  if (l.unsafe === "flagged") out.push(<span key="u" title="Cloudflare's security service lists the destination as malware or phishing: visitors see a warning first"><Badge tone="danger">Unsafe?</Badge></span>);
  if (s === "expired") out.push(<Badge key="s" tone="warn">Expired</Badge>);
  else if (s === "disabled") {
    const where = l.offRedirect === "home" ? "Visitors go to the main site" : l.offRedirect ? `Visitors go to ${label(l.offRedirect)}` : "Visitors see the “not found” page";
    out.push(<span key="s" title={`Turned off. ${where}. Automatic checks are paused.`}><Badge>Disabled{l.offRedirect ? " · redirects" : ""}</Badge></span>);
  } else if (s === "broken") {
    out.push(
      l.replacement ? (
        <span key="s" title={`Visitors are pointed to ${label(l.replacement)}`}><Badge>Replaced</Badge></span>
      ) : (
        <span key="s" title="Visitors see a short notice, then go to the site set in Settings"><Badge>Retired</Badge></span>
      ),
    );
  } else if (l.check && (l.check.state === "down" || l.check.state === "warning")) {
    out.push(
      <Link key="c" to={`/health?state=${l.check.state}`} className="links-badge-link" tabIndex={-1} title={`${problemText(l.check.problem, l.check.httpStatus)}. Opens Link health.`}>
        <Badge tone={l.check.state === "down" ? "danger" : "warn"}>{l.check.state === "down" ? "Destination down" : "Destination issue"}</Badge>
      </Link>,
    );
  }
  if (l.shares) out.push(<span key="sh" title={`${l.shares} shared statistics ${l.shares === 1 ? "page" : "pages"} working now`}><Badge>Shared{l.shares > 1 ? ` · ${l.shares}` : ""}</Badge></span>);
  if (!out.length) return null;
  return <span className="links-status">{out}</span>;
}

// ---- Destination: host first, the rest quieter ----

export function Destination({ url }: { url: string }) {
  const host = hostOf(url);
  const at = url.indexOf(host);
  const rest = at >= 0 ? url.slice(at + host.length) : url;
  return (
    <span className="links-dest" title={url} translate="no">
      <span className="links-host">{host}</span>
      {rest && rest !== "/" ? rest : null}
    </span>
  );
}

// ---- One row ----

export interface RowProps {
  l: LinkListItem;
  first: boolean;
  bios: boolean;
  canSelect: boolean;
  checked: boolean;
  onCheck: (on: boolean) => void;
  seesClicks: boolean;
  /** The chosen period's clicks column is drawn (not when the whole list has none in it). */
  showPeriod: boolean;
  /** The Status column is drawn (only when some row has a status). */
  statusCol: boolean;
  periodLabel: string;
  canEdit: boolean;
  toggling: boolean;
  onCopy: () => void;
  onQr: () => void;
  onToggle: () => void;
  onTag: (tag: string) => void;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
}

const INTERACTIVE = "a, button, input, select, label, [role=checkbox], [role=menuitem]";

export function LinkRow({ l, first, bios, canSelect, checked, onCheck, seesClicks, showPeriod, statusCol, periodLabel, canEdit, toggling, onCopy, onQr, onToggle, onTag, menuOpen, onMenuOpenChange }: RowProps) {
  const label = useLinkLabel();
  const navigate = useNavigate();
  const name = label(l);
  const to = linkPath(l);
  // The whole row opens the link; controls inside it keep their own click.
  const onClick = (e: MouseEvent<HTMLTableRowElement>) => {
    if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
    if (window.getSelection()?.toString()) return;
    if (e.metaKey || e.ctrlKey) window.open(`/_admin${to}`, "_blank", "noopener");
    else navigate(to);
  };
  const items: (MenuItem | "separator")[] = [
    { label: "Copy short link", icon: Copy, onSelect: onCopy },
    { label: "QR code", icon: QrCode, onSelect: onQr },
    { label: "Open destination", icon: ExternalLink, onSelect: () => window.open(l.target, "_blank", "noopener,noreferrer") },
    ...(seesClicks ? [{ label: "Statistics", icon: BarChart3, onSelect: () => navigate(`${to}#stats`) }] : []),
    ...(canEdit ? ["separator" as const, { label: l.active ? "Disable" : "Enable", icon: Power, disabled: toggling, onSelect: onToggle }] : []),
  ];
  const shownTags = l.tags.slice(0, 2);
  const moreTags = l.tags.slice(2);
  return (
    <TR focusable first={first} selected={canSelect ? checked : undefined} onClick={onClick} data-key={linkKey(l.domain, l.slug)}>
      {canSelect ? (
        <TD className="links-c-check">
          {/* Out of the Tab order: the row is the keyboard stop (Space or x ticks it, via [data-row-select]). */}
          <Checkbox label={`Select ${name}`} hideLabel checked={checked} onCheckedChange={onCheck} tabIndex={-1} data-row-select="" />
        </TD>
      ) : null}
      <TD className="links-c-link">
        <span className="links-line">
          <Link to={to} className="links-slug" translate="no" data-row-link title={name.length > 28 ? name : undefined} tabIndex={-1}>
            {name}
          </Link>
          {l.source === "import" ? <span className="links-mark-text" title={l.importFrom && l.importFrom !== "csv" ? `Imported from ${IMPORT_SOURCE_LABEL[l.importFrom]}` : undefined}>Imported</span> : null}
          {l.protected ? <span className="links-mark" title="Password protected"><Lock aria-hidden /><span className="ui-sr">Password protected</span></span> : null}
          {l.maxClicks ? <span className="links-mark" title={`Opens at most ${l.maxClicks.toLocaleString("en")} times`}><Gauge aria-hidden /><span className="ui-sr">Visit limit</span></span> : null}
          {l.routing ? <span className="links-mark" title={`Smart routing: ${describeRouting(l.routing)}`}><Split aria-hidden /><span className="ui-sr">Smart routing</span></span> : null}
          {l.bio && !bios ? <span className="links-mark" title={`A link-in-bio page with ${bioButtonCount(l.bio)} ${bioButtonCount(l.bio) === 1 ? "button" : "buttons"}`}><LayoutList aria-hidden /><span className="ui-sr">Bio page</span></span> : null}
          <span className="links-status-inline"><StatusBadges l={l} /></span>
        </span>
        {l.title ? <span className="links-sub links-sub-title" title={l.title}>{l.title}</span> : null}
        <span className="links-sub links-sub-dest"><Destination url={l.target} /></span>
      </TD>
      <TD className="links-c-dest"><Destination url={l.target} /></TD>
      <TD className="links-c-tags">
        {l.tags.length ? (
          <span className="links-tags">
            {shownTags.map((t) => (
              <button key={t} type="button" className="links-tag" tabIndex={-1} onClick={() => onTag(t)} title={`Show only links tagged “${t}”`}>
                {t}
              </button>
            ))}
            {moreTags.length ? <span className="links-tag-more" title={moreTags.join(", ")}>+{moreTags.length}<span className="ui-sr"> more: {moreTags.join(", ")}</span></span> : null}
          </span>
        ) : null}
      </TD>
      {statusCol ? <TD className="links-c-status"><StatusBadges l={l} /></TD> : null}
      {seesClicks && showPeriod ? (
        <TD numeric className={l.clicksPeriod ? "links-c-num links-c-period links-num" : "links-c-num links-c-period links-num is-zero"} title={`${fullNum(l.clicksPeriod)} clicks in the ${periodLabel.toLowerCase()}`}>
          {num(l.clicksPeriod)}
        </TD>
      ) : null}
      {seesClicks ? (
        <TD numeric className={`${showPeriod ? "links-c-num links-c-total links-num is-2" : "links-c-num links-num"}${l.clicksTotal ? "" : " is-zero"}`} title={`${fullNum(l.clicksTotal)} clicks in total`}>
          {num(l.clicksTotal)}
        </TD>
      ) : null}
      <TD className="links-c-menu">
        <Menu
          label={`Actions for ${name}`}
          items={items}
          open={menuOpen}
          onOpenChange={onMenuOpenChange}
          trigger={<IconButton label={`Actions for ${name}`} icon={Ellipsis} size="sm" className="links-row-menu" tabIndex={-1} aria-keyshortcuts="." />}
        />
      </TD>
    </TR>
  );
}

/** The table's shape while the first page loads. */
export function SkeletonRows({ rows, canSelect, seesClicks, showPeriod, statusCol }: { rows: number; canSelect: boolean; seesClicks: boolean; showPeriod: boolean; statusCol: boolean }) {
  const widths = [62, 44, 78, 52, 70, 38, 58, 48, 66, 40];
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <tr key={i} className="links-skel-row" aria-hidden>
          {canSelect ? <td className="links-c-check"><Skeleton className="links-skel-box" /></td> : null}
          <td className="links-c-link"><Skeleton className="ui-skel-text" style={{ width: `${widths[i % widths.length]}%` }} /></td>
          <td className="links-c-dest"><Skeleton className="ui-skel-text" style={{ width: `${widths[(i + 3) % widths.length]}%` }} /></td>
          <td className="links-c-tags">{i % 3 === 0 ? <Skeleton className="ui-skel-text" style={{ width: 56 }} /> : null}</td>
          {statusCol ? <td className="links-c-status" /> : null}
          {seesClicks && showPeriod ? <td className="links-c-num links-c-period"><Skeleton className="ui-skel-text links-skel-num" /></td> : null}
          {seesClicks ? <td className={showPeriod ? "links-c-num links-c-total" : "links-c-num"}><Skeleton className="ui-skel-text links-skel-num" /></td> : null}
          <td className="links-c-menu" />
        </tr>
      ))}
    </>
  );
}
