// /kit: every component of the admin in every state, for review. States that
// need a pointer or focus (hover, focus, active) are shown with data-demo,
// which the CSS treats like the real state. Switch the theme at the top to
// see light and dark.

import { ArrowUpRight, Copy, Download, Pencil, Plus, QrCode, Search, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { saveTheme, useTheme, type Theme } from "../../lib/theme";
import type { Period } from "../../../shared/types";
import type { SortDir } from "../../lib/table";
import { ApiError } from "../../api";
import { LinkForm } from "../../components/LinkForm";
import { breakdownItems, Delta, PeriodBar, PeriodControl, ribbonParts, SourceRibbon, sourceParts, TabbedPanel, withSwatches } from "../parts";
import { HeatLegend, heatScale } from "../sites/insights";
import { Badge, BreakdownList, Button, Checkbox, Columns, Dialog, Empty, ErrorState, IconButton, Input, Menu, Notice, Pager, Section, Segmented, Select, Sheet, Skeleton, SkeletonText, SortTH, Stat, StatStrip, StatStripSkeleton, Switch, Table, Tabs, TD, TextButton, TH, TR, type BreakdownItem, type StatItem } from "../ui";

function KitSection({ id, title, note, children }: { id: string; title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="ui-kit-section" aria-labelledby={`kit-${id}`}>
      <header className="ui-kit-section-head">
        <h2 id={`kit-${id}`} className="ui-h2">{title}</h2>
        {note ? <p className="ui-kit-note">{note}</p> : null}
      </header>
      {children}
    </section>
  );
}

/** One labelled cell of the state grid. */
function Cell({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? "ui-kit-cell is-wide" : "ui-kit-cell"}>
      <div className="ui-kit-cell-body">{children}</div>
      <p className="ui-kit-cell-label">{label}</p>
    </div>
  );
}

const SWATCHES: { name: string; role: string; text?: boolean }[] = [
  { name: "canvas", role: "page" },
  { name: "side", role: "sidebar" },
  { name: "panel", role: "overlays, inputs" },
  { name: "sunken", role: "controls, skeletons" },
  { name: "line", role: "rules" },
  { name: "line-strong", role: "table heads, edges" },
  { name: "line-control", role: "input edges ≥ 3:1" },
  { name: "ink", role: "text", text: true },
  { name: "ink-2", role: "secondary text", text: true },
  { name: "ink-3", role: "tertiary ≥ 4.5:1", text: true },
  { name: "accent", role: "line, KPI rule ≥ 3:1" },
  { name: "accent-fill", role: "primary fill" },
  { name: "accent-ink", role: "accent text", text: true },
  { name: "accent-wash", role: "selected, notice" },
  { name: "bar", role: "breakdown bar" },
  { name: "good", role: "up, active", text: true },
  { name: "warn", role: "attention", text: true },
  { name: "bad", role: "down, danger", text: true },
];

const TYPE: { token: string; size: string; face: string; sample: string; cls: string }[] = [
  { token: "kpi", size: "46 / 34 px", face: "Hanken 560", sample: "12,480", cls: "ui-kit-t-kpi" },
  { token: "xl", size: "28 px", face: "Hanken 680", sample: "Analytics", cls: "ui-kit-t-xl" },
  { token: "lg", size: "17 px", face: "Hanken 680", sample: "Where human clicks came from", cls: "ui-kit-t-lg" },
  { token: "md", size: "15 px", face: "Hanken 680", sample: "Human clicks, by day", cls: "ui-kit-t-md" },
  { token: "base", size: "14 px", face: "Hanken 420", sample: "Share a link, or look at a longer period.", cls: "ui-kit-t-base" },
  { token: "sm", size: "13 px", face: "Hanken 560", sample: "Previous period · 30 days", cls: "ui-kit-t-sm" },
  { token: "xs", size: "12 px", face: "Hanken 560", sample: "CLICKS 1 2 3 4 5 6 7 8 9 0", cls: "ui-kit-t-xs" },
];

const ROWS: BreakdownItem[] = [
  { key: "li", label: "LinkedIn", value: 1840, to: "/kit" },
  { key: "nl", label: "Newsletter", value: 1210, to: "/kit" },
  { key: "direct", label: "Direct", value: 602, to: "/kit" },
  { key: "x", label: "X (Twitter)", value: 233, to: "/kit" },
  { key: "bot", label: "Bots and previews", value: 88, quiet: true },
];

const LINKS = [
  { slug: "/guide", target: "example.com/guide", clicks: 1840, revenue: "$1,033", status: "good" as const, state: "Active" },
  { slug: "/talk-slides", target: "speakerdeck.com/example/talk", clicks: 612, revenue: "$49", status: "good" as const, state: "Active" },
  { slug: "/old-webinar", target: "zoom.us/rec/share/…", clicks: 41, revenue: "–", status: "warn" as const, state: "Expires soon" },
  { slug: "/broken-pdf", target: "drive.google.com/file/d/…", clicks: 7, revenue: "–", status: "danger" as const, state: "Down" },
];

const RIBBON = [
  { value: "linkedin", clicks: 420 },
  { value: "newsletter", clicks: 260 },
  { value: "", clicks: 180 },
  { value: "x", clicks: 90 },
  { value: "youtube", clicks: 60 },
  { value: "talk", clicks: 30 },
  { value: "mastodon", clicks: 12 },
].map((r) => ({ ...r, bots: 0 }));
const RIBBON_PARTS = sourceParts(RIBBON);
const RIBBON_ROWS = withSwatches(breakdownItems(RIBBON, "source"), ribbonParts(RIBBON_PARTS).swatch);

/** A week of hourly visits for the heatmap sample: quiet nights, a weekday lunch bump, Sunday evenings. */
const HEAT: number[][] = Array.from({ length: 7 }, (_, d) =>
  Array.from({ length: 24 }, (_, h) => {
    const night = h < 7 ? 0.1 : 1;
    const lunch = h >= 11 && h <= 13 && d < 5 ? 1.8 : 1;
    const evening = h >= 17 && h <= 22 ? (d === 6 ? 3.2 : 1.6) : 1;
    return Math.round(((h * 7 + d * 13) % 5) * night * lunch * evening + (night === 1 ? 2 : 0));
  }),
);
const HEAT_MAX = Math.max(...HEAT.flat());
const HEAT_SCALE = heatScale(HEAT.flat());
const HEAT_TOP = new Set(
  HEAT.flatMap((row, d) => row.map((v, h) => ({ v, k: `${d}-${h}` })))
    .sort((a, b) => b.v - a.v)
    .slice(0, 3)
    .map((x) => x.k),
);

const STRIP: StatItem[] = [
  { id: "clicks", label: "Human clicks", value: "4,160", delta: <Delta current={4160} previous={3520} />, note: "92% of all hits" },
  { id: "uniques", label: "Unique visitors", value: "2,904", delta: <Delta current={2904} previous={3010} />, note: "Counted once a day" },
  { id: "revenue", label: "Revenue", value: <span className="ui-kpi-na">No website yet</span>, note: "Add a website to see sales", disabled: true },
  { id: "bots", label: "Bots and previews", value: "356", delta: <Delta current={356} previous={300} good={false} />, note: "Not counted as clicks", quiet: true },
];

function ThemePicker() {
  const theme = useTheme();
  return <Segmented<Theme> label="Theme" value={theme} onChange={saveTheme} options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }, { value: "auto", label: "Automatic" }]} />;
}

export function Kit() {
  const [period, setPeriod] = useState("30d");
  const [tab, setTab] = useState("sources");
  const [checks, setChecks] = useState({ a: true, b: false });
  const [sw, setSw] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(["/talk-slides"]));
  const [dialog, setDialog] = useState(false);
  const [form, setForm] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [kitPeriod, setKitPeriod] = useState<Period>({ range: "30d" });
  const [dir, setDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(1);
  const [kpi, setKpi] = useState("clicks");
  const allSelected = selected.size === LINKS.length;
  const sorted = [...LINKS].sort((a, b) => (dir === "asc" ? a.clicks - b.clicks : b.clicks - a.clicks));

  const toggle = (slug: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(slug)) n.delete(slug);
      else n.add(slug);
      return n;
    });

  return (
    <div className="ui-page ui-kit">
      <header className="ui-head">
        <div className="ui-head-main">
          <h1 className="ui-h1">Component sheet</h1>
          <p className="ui-head-sub">Almanac, the admin's design system. Every component, every state. Spec: docs/DESIGN.md.</p>
        </div>
        <div className="ui-head-tools">
          <ThemePicker />
        </div>
      </header>

      <KitSection id="colour" title="Colour" note="Accent tokens derive from your accent (Settings → Appearance); lightness is clamped so text on them stays readable.">
        <ul className="ui-kit-swatches">
          {SWATCHES.map((s) => (
            <li key={s.name}>
              <span className="ui-kit-swatch" style={{ background: `var(--ui-${s.name})` }} aria-hidden>
                {s.text ? <span style={{ color: "var(--ui-canvas)" }}>Aa</span> : null}
              </span>
              <span className="ui-kit-swatch-name">--ui-{s.name}</span>
              <span className="ui-kit-swatch-role">{s.role}</span>
            </li>
          ))}
        </ul>
        <div className="ui-kit-pairs">
          <span className="ui-kit-pair" style={{ background: "var(--ui-accent-fill)", color: "var(--ui-on-accent)" }}>on-accent on accent-fill</span>
          <span className="ui-kit-pair" style={{ background: "var(--ui-danger-fill)", color: "var(--ui-on-danger)" }}>on-danger on danger-fill</span>
          <span className="ui-kit-pair" style={{ background: "var(--ui-accent-wash)", color: "var(--ui-accent-ink)" }}>accent-ink on accent-wash</span>
          <span className="ui-kit-pair" style={{ background: "var(--ui-canvas)", color: "var(--ui-ink-3)", boxShadow: "inset 0 0 0 1px var(--ui-line)" }}>ink-3 on canvas</span>
        </div>
      </KitSection>

      <KitSection id="type" title="Type" note="Hanken Grotesk for everything: headings and numbers by weight and size. Figures are tabular wherever they line up.">
        <table className="ui-kit-type">
          <tbody>
            {TYPE.map((t) => (
              <tr key={t.token}>
                <th scope="row">{t.token}</th>
                <td className="ui-kit-type-meta">{t.size}<br />{t.face}</td>
                <td className={t.cls}>{t.sample}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </KitSection>

      <KitSection id="buttons" title="Buttons" note="One shape, a pill. Primary once per view. 36 px (sm 30, lg 44); every size is 44 px on phones.">
        {(["primary", "secondary", "ghost", "danger"] as const).map((v) => (
          <div key={v} className="ui-kit-grid">
            <Cell label={`${v}`}><Button variant={v} icon={v === "danger" ? Trash2 : v === "primary" ? Plus : undefined}>{v === "primary" ? "Create link" : v === "danger" ? "Delete" : v === "ghost" ? "Export CSV" : "Edit"}</Button></Cell>
            <Cell label="hover"><Button variant={v} data-demo="hover">Hover</Button></Cell>
            <Cell label="focus-visible"><Button variant={v} data-demo="focus">Focus</Button></Cell>
            <Cell label="active"><Button variant={v} data-demo="active">Pressed</Button></Cell>
            <Cell label="disabled"><Button variant={v} disabled>Disabled</Button></Cell>
            <Cell label="loading"><Button variant={v} loading>Saving…</Button></Cell>
          </div>
        ))}
        <div className="ui-kit-grid">
          <Cell label="sm / md / lg"><span className="ui-kit-row"><Button size="sm">Small</Button><Button>Medium</Button><Button size="lg">Large</Button></span></Cell>
          <Cell label="with shortcut"><Button variant="primary" icon={Plus} kbd="C">Create link</Button></Cell>
          <Cell label="link as button (asChild)"><Button asChild><a href="#kit-buttons">Open the guide</a></Button></Cell>
          <Cell label="text button"><span>Couldn’t load. <TextButton>Try again</TextButton></span></Cell>
        </div>
        <div className="ui-kit-grid">
          <Cell label="icon: ghost"><IconButton label="Copy link" icon={Copy} /></Cell>
          <Cell label="icon: hover"><IconButton label="QR code" icon={QrCode} data-demo="hover" /></Cell>
          <Cell label="icon: focus"><IconButton label="Edit" icon={Pencil} data-demo="focus" /></Cell>
          <Cell label="icon: secondary"><IconButton label="Download" icon={Download} variant="secondary" /></Cell>
          <Cell label="icon: primary"><IconButton label="Create link" icon={Plus} variant="primary" /></Cell>
          <Cell label="icon: disabled"><IconButton label="Delete" icon={Trash2} disabled /></Cell>
          <Cell label="icon: loading"><IconButton label="Refreshing" icon={Search} variant="secondary" loading /></Cell>
        </div>
      </KitSection>

      <KitSection id="fields" title="Fields" note="Every input has a visible label. 16 px text on phones (no iOS zoom). Focus ring on any focus, so you see where typing lands.">
        <div className="ui-kit-grid is-fields">
          <Cell label="default"><Input label="Short link" placeholder="guide" /></Cell>
          <Cell label="hover"><Input label="Short link" placeholder="guide" data-demo="hover" /></Cell>
          <Cell label="focus"><Input label="Short link" defaultValue="guide" data-demo="focus" /></Cell>
          <Cell label="with hint"><Input label="Destination" defaultValue="https://example.com/guide" hint="Visitors land here." /></Cell>
          <Cell label="error"><Input label="Short link" defaultValue="guide" error="/guide is taken. Try /guide-2." /></Cell>
          <Cell label="disabled"><Input label="Domain" defaultValue="sh.example" disabled /></Cell>
          <Cell label="select"><Select label="Domain" options={[{ value: "a", label: "sh.example" }, { value: "b", label: "alt.example" }]} /></Cell>
          <Cell label="select: focus"><Select label="Status" data-demo="focus" options={[{ value: "all", label: "All links" }]} /></Cell>
          <Cell label="select: disabled"><Select label="Status" disabled options={[{ value: "all", label: "All links" }]} /></Cell>
          <Cell label="hidden label (filter)"><Input label="Find a link" hideLabel placeholder="Find a link…" type="search" /></Cell>
        </div>
      </KitSection>

      <KitSection id="toggles" title="Checkbox and switch" note="Radix primitives. The label is part of the target; rows are 44 px on phones. A switch applies at once, a checkbox waits for Save.">
        <div className="ui-kit-grid">
          <Cell label="unchecked"><Checkbox label="Track clicks" checked={checks.b} onCheckedChange={(v) => setChecks((c) => ({ ...c, b: v }))} /></Cell>
          <Cell label="checked"><Checkbox label="Track clicks" checked={checks.a} onCheckedChange={(v) => setChecks((c) => ({ ...c, a: v }))} /></Cell>
          <Cell label="indeterminate"><Checkbox label="Select all" checked="indeterminate" /></Cell>
          <Cell label="hover"><Checkbox label="Hover" checked={false} data-demo="hover" /></Cell>
          <Cell label="focus"><Checkbox label="Focus" checked data-demo="focus" /></Cell>
          <Cell label="disabled"><Checkbox label="Disabled" checked disabled /></Cell>
          <Cell label="with description" wide><Checkbox label="Check the destination every day" description="Emails you when it stops loading." checked={false} /></Cell>
        </div>
        <div className="ui-kit-grid">
          <Cell label="on"><Switch label="Live data" checked={sw} onCheckedChange={setSw} /></Cell>
          <Cell label="off"><Switch label="Live data" checked={false} /></Cell>
          <Cell label="hover"><Switch label="Hover" checked={false} data-demo="hover" /></Cell>
          <Cell label="focus"><Switch label="Focus" checked data-demo="focus" /></Cell>
          <Cell label="disabled"><Switch label="Disabled" checked disabled /></Cell>
        </div>
      </KitSection>

      <KitSection id="segmented" title="Segmented control" note="A radio group: Tab enters on the chosen option, arrows move and choose. Phones show the short labels.">
        <div className="ui-kit-grid">
          <Cell label="period (live)" wide>
            <Segmented label="Period" value={period} onChange={setPeriod} options={[{ value: "today", label: "Today", short: "Today" }, { value: "7d", label: "7 days", short: "7d" }, { value: "30d", label: "30 days", short: "30d" }, { value: "90d", label: "90 days", short: "90d" }, { value: "365d", label: "12 months", short: "12m" }, { value: "all", label: "All time", short: "All" }]} />
          </Cell>
          <Cell label="period with Custom… (PeriodControl custom, live)" wide>
            <PeriodControl value={kitPeriod} onChange={setKitPeriod} custom />
          </Cell>
          <Cell label="hover on “Week”"><Segmented label="Group by" value="day" onChange={() => {}} demo={{ index: 1, state: "hover" }} options={[{ value: "day", label: "Day" }, { value: "week", label: "Week" }]} /></Cell>
          <Cell label="focus"><Segmented label="Group by" value="day" onChange={() => {}} demo={{ index: 0, state: "focus" }} options={[{ value: "day", label: "Day" }, { value: "week", label: "Week" }]} /></Cell>
          <Cell label="disabled option, sm"><Segmented label="Chart" size="sm" value="line" onChange={() => {}} options={[{ value: "line", label: "Line" }, { value: "bars", label: "Bars" }, { value: "map", label: "Map", disabled: true }]} /></Cell>
        </div>
      </KitSection>

      <KitSection id="tabs" title="Tabs" note="Underline tabs (Radix): arrows, Home and End. The rule grows in when a tab is chosen. More tabs than room: the row scrolls with snap and the cut edge fades, so hidden tabs stay discoverable.">
        <div className="ui-kit-grid">
          <Cell label="live, with counts and an aside" wide>
            <Tabs label="Sources" value={tab} onValueChange={setTab} items={[{ value: "sources", label: "Sources", count: 12 }, { value: "referrers", label: "Referrers", count: 48 }, { value: "utm", label: "Campaigns" }, { value: "x", label: "Disabled", disabled: true }]} aside={<a className="ui-panel-link" href="#kit-tabs">All sources</a>}>
              {(v) => <p className="ui-kit-panel-text">Panel for “{v}”.</p>}
            </Tabs>
          </Cell>
          <Cell label="overflow: edge fade" wide>
            <div className="ui-kit-tabs-narrow">
              <Tabs label="Channels" value="channel" onValueChange={() => {}} items={[{ value: "channel", label: "Channels" }, { value: "source", label: "Sources" }, { value: "referrer", label: "Referrers" }, { value: "campaign", label: "Campaigns" }, { value: "medium", label: "Medium" }, { value: "term", label: "Keyword" }]}>
                {() => null}
              </Tabs>
            </div>
          </Cell>
          <Cell label="hover and focus" wide>
            <Tabs label="Places" value="countries" onValueChange={() => {}} items={[{ value: "countries", label: "Countries" }, { value: "regions", label: "Regions", demo: "hover" }, { value: "cities", label: "Cities", demo: "focus" }]}>
              {() => null}
            </Tabs>
          </Cell>
        </div>
      </KitSection>

      <KitSection id="table" title="Table" note="Header, rows, numeric cells right-aligned and tabular: the row’s lead value 680 ink, a secondary number (is-2) 560 ink-2, as here Revenue next to Clicks. Rows: ↑/↓ or j/k move, Enter opens, Space ticks the row’s box (out of the Tab order). Row 1 shows focus, row 2 selected, row 3 hover. Clicks is a sortable head (SortTH); the Pager sits under paged tables.">
        <Table label="Links" rowNav>
          <thead>
            <tr>
              <TH className="is-check"><Checkbox label="Select all links" checked={allSelected ? true : selected.size ? "indeterminate" : false} onCheckedChange={(v) => setSelected(v ? new Set(LINKS.map((l) => l.slug)) : new Set())} hideLabel /></TH>
              <TH>Link</TH>
              <TH>Status</TH>
              <TH numeric>Revenue</TH>
              <SortTH label="Clicks" numeric active dir={dir} onSort={() => setDir((d) => (d === "asc" ? "desc" : "asc"))} />
            </tr>
          </thead>
          <tbody>
            {sorted.map((l, i) => (
              <TR key={l.slug} focusable first={i === 0} selected={selected.has(l.slug)} data-demo={i === 0 ? "focus" : i === 2 ? "hover" : undefined}>
                <TD className="is-check">
                  <Checkbox label={`Select ${l.slug}`} checked={selected.has(l.slug)} onCheckedChange={() => toggle(l.slug)} hideLabel tabIndex={-1} data-row-select="" />
                </TD>
                <TD>
                  <a href="#kit-table" data-row-link>{l.slug}</a>
                  <span className="ui-table-sub">{l.target}</span>
                </TD>
                <TD>{l.status === "good" ? null : <Badge tone={l.status}>{l.state}</Badge>}</TD>
                <TD numeric className="is-2">{l.revenue}</TD>
                <TD numeric>{l.clicks.toLocaleString("en-US")}</TD>
              </TR>
            ))}
          </tbody>
        </Table>
        <Pager page={page} pages={3} size={25} total={68} onPage={setPage} onSize={() => setPage(1)} />
      </KitSection>

      <KitSection id="header" title="Page header and period bar" note="One pattern on every page: the h1 and one identity line left, page actions right (never wrapping under the title on wide screens). Analytics pages add the PeriodBar under a 1 px rule: the period, then the range it covers, in the one date format (“Oct 2 – Oct 31”), time zone last. The bar is a size container: under 600 px of width the period takes its short labels (“7d”, “Custom”) and the full width, so it never runs past the page.">
        <div className="ui-kit-headdemo">
          <header className="ui-head">
            <div className="ui-head-main">
              <p className="ui-h1" role="presentation">Analytics</p>
              <p className="ui-head-sub">example.com +1</p>
            </div>
            <div className="ui-head-tools">
              <Button variant="ghost" icon={Download}>Export CSV</Button>
            </div>
          </header>
          <PeriodBar value={kitPeriod} onChange={setKitPeriod}>
            <span>Oct 2 – Oct 31, Europe/Paris.</span>
          </PeriodBar>
        </div>
      </KitSection>

      <KitSection id="ribbon" title="Source ribbon" note="The signature, and the header of its section: right under the title, above the tabs. The list below is its legend: each source row carries its segment’s swatch, so names and numbers are said once. 28 px, 2 px gaps, the share printed in segments ≥ 10 % (≥ 18 % on phones). A single-hue ordinal ramp, validated: adjacent steps ≥ 0.06 OKLCH L apart, the faintest ≥ 2:1 on the light canvas; in dark mode the steps run from a light tint down to the accent. Screen readers get the parts as a list. Home and link page: human clicks by source; website dashboard: visitors by channel.">
        <div className="ui-kit-narrow">
          <TabbedPanel
            title="Sources"
            tabs={[{ id: "source", label: "Sources" }, { id: "referrer", label: "Referrers" }]}
            lead={<SourceRibbon items={RIBBON_PARTS} label="Where human clicks came from, by source" />}
            render={(t) => (t === "source" ? <BreakdownList items={RIBBON_ROWS} limit={6} /> : <p className="ui-kit-panel-text">Referrers have no swatches: the ribbon is by source.</p>)}
          />
        </div>
      </KitSection>

      <KitSection id="breakdown" title="Breakdown list" note="A 6 px bar on a full-width track under each row, as long as the row’s share of the total. The bar is ink mixed 48 % into the canvas: 3.6:1 (light) and 3.7:1 (dark), so it reads as a mark in both themes; the track is the line colour. The accent only on the row you point at or focus. Share and value right-aligned. Bots sit last, quieter (30 %, 2.1:1).">
        <div className="ui-kit-grid is-two">
          <Cell label="default, row 2 hover, bots quiet" wide>
            <BreakdownList items={ROWS} demo={{ index: 1, state: "hover" }} />
          </Cell>
          <Cell label="focus" wide>
            <BreakdownList items={ROWS.slice(0, 3)} demo={{ index: 2, state: "focus" }} />
          </Cell>
          <Cell label="loading" wide>
            <SkeletonText lines={4} />
          </Cell>
          <Cell label="empty" wide>
            <BreakdownList items={[]} emptyText="No link got a click in this period." />
          </Cell>
        </div>
      </KitSection>

      <KitSection id="columns" title="Two columns (Columns)" note="Breakdown lists in two open columns at ≥ 1024 px. Columns splits the sections so the two columns end as evenly as possible (source order kept within each), so a short list never leaves a half-empty row; once you interact, nothing jumps to the other column. One column, in source order, below 1024 px.">
        <Columns>
          <section className="ui-panel"><header className="ui-panel-head"><h3 className="ui-h2">Sources</h3></header><BreakdownList items={ROWS.slice(0, 3)} /></section>
          <section className="ui-panel"><header className="ui-panel-head"><h3 className="ui-h2">Revenue by website</h3></header><BreakdownList items={ROWS.slice(0, 1)} /></section>
          <section className="ui-panel"><header className="ui-panel-head"><h3 className="ui-h2">Locations</h3></header><BreakdownList items={ROWS} /></section>
          <section className="ui-panel"><header className="ui-panel-head"><h3 className="ui-h2">Devices</h3></header><BreakdownList items={ROWS.slice(0, 3)} /></section>
        </Columns>
      </KitSection>

      <KitSection id="stat" title="KPI stat" note="Tabular numerals over a 1 px rule. As tabs they switch the chart: the selected one carries a 3 px accent indicator, hover a line-strong one.">
        <div className="ui-kit-stats">
          <Stat label="Human clicks" value="4,160" delta={<Delta current={4160} previous={3520} />} note="92% of all hits" data-demo="selected" />
          <Stat label="Unique visitors" value="2,904" delta={<Delta current={2904} previous={3010} />} note="Counted once a day" role="tab" aria-selected={false} data-demo="hover" />
          <Stat label="Revenue" value={<span className="ui-kpi-na">No website yet</span>} note={<a href="#kit-stat">Add a website to see sales</a>} disabled />
          <Stat label="Bots and previews" value="356" delta={<Delta current={356} previous={300} good={false} />} note="Not counted as clicks" quiet />
          <Stat label={<Skeleton className="ui-skel-text" style={{ width: 84 }} />} value={<Skeleton className="ui-skel-num" />} note={<Skeleton className="ui-skel-text" style={{ width: 110 }} />} />
        </div>
        <p className="ui-kit-legend">selected · hover · disabled · quiet · loading</p>
        <div className="ui-kit-strip">
          <StatStrip items={STRIP} value={kpi} onChange={setKpi} />
          <p className="ui-kit-legend">StatStrip, live: ←/→ (skips Revenue, not available), Home/End, Enter/Space</p>
          <StatStripSkeleton count={4} aria-hidden />
          <p className="ui-kit-legend">StatStripSkeleton</p>
        </div>
      </KitSection>

      <KitSection id="section" title="Section" note="Page structure without cards: a 1 px top rule, a title, an optional line under it, tools on the right. With foldOnPhone (a one-line summary), a rarely used section starts closed under 768 px: the title becomes a 44 px disclosure button. Website dashboard: How customers bought, Customer value, Peak hours.">
        <Section title="Latest hits" sub="The last 7 days, newest first." aside={<a className="ui-panel-link" href="#kit-section">Filter and see more</a>}>
          <p className="ui-kit-panel-text">Section content.</p>
        </Section>
      </KitSection>

      <KitSection id="links" title="Text links" note="One style for every text action and section link: accent ink, a 40 % underline that strengthens on hover. TextButton, “All links”, “Show all N”, “Show table”, “Edit settings”. ↗ only on links that leave the admin.">
        <div className="ui-kit-grid">
          <Cell label="TextButton"><TextButton>Show rules</TextButton></Cell>
          <Cell label="hover"><TextButton data-demo="hover">Edit settings</TextButton></Cell>
          <Cell label="section link"><a className="ui-panel-link" href="#kit-links">All links</a></Cell>
          <Cell label="leaving the admin"><a className="ui-panel-link" href="#kit-links">Cloudflare docs <ArrowUpRight aria-hidden className="ui-kit-inline-icon" /></a></Cell>
          <Cell label="show all"><button type="button" className="ui-more">Show all 9</button></Cell>
        </div>
      </KitSection>

      <KitSection id="heat" title="Peak hours heatmap" note="Five discrete steps of ink mixed into the canvas (12 / 30 / 48 / 68 / 90 %), by rank among the cells with any value: the quietest 40 % stay near the canvas, and only the busiest 10 % reach ink, so the weekly pattern reads whatever the spread. Equal values share a step. Validated (dataviz, --ordinal) on both canvases: monotone lightness, adjacent steps ≥ 0.06 L, steps 2–5 ≥ 2.1:1; step 1 is the near-zero end. The three busiest slots are the accent. A legend with the smallest and the busiest value. Phones: 3-hour blocks with their own scale.">
        <div className="ui-site-heat-scroll">
          <table className="ui-site-heat" aria-label="Peak hours sample">
            <thead>
              <tr>
                <td />
                {Array.from({ length: 24 }, (_, h) => (
                  <th key={h} scope="col">{h % 3 === 0 ? h : <span className="ui-sr">{h}</span>}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {HEAT.map((row, d) => (
                <tr key={d}>
                  <th scope="row">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][d]}</th>
                  {row.map((v, h) => (
                    <td key={h} data-l={HEAT_SCALE.level(v)} className={HEAT_TOP.has(`${d}-${h}`) ? "is-top" : undefined}>
                      <span className="ui-sr">{v}</span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <HeatLegend min={Math.min(...HEAT.flat().filter((v) => v > 0))} max={HEAT_MAX} bounds={HEAT_SCALE.bounds} fmt={String} unit="visits an hour" />
      </KitSection>

      <KitSection id="badge" title="Badge" note="Only when the state is news: Disabled, Expired, Down, Paused, people online. A link or site that simply works gets no badge (no “Active”). Four tones, each with a dot so colour isn’t the only signal.">
        <div className="ui-kit-row">
          <Badge tone="good">3 online now</Badge>
          <Badge tone="warn">Expires in 2 days</Badge>
          <Badge tone="danger">Down</Badge>
          <Badge tone="neutral">Paused</Badge>
        </div>
      </KitSection>

      <KitSection id="states" title="Loading, empty, error" note="Skeletons in the shape of the content, never a lone spinner. Errors name what failed and offer a retry.">
        <div className="ui-kit-grid is-two">
          <Cell label="skeleton" wide>
            <div className="ui-kit-skel">
              <Skeleton className="ui-skel-text" style={{ width: 120 }} />
              <Skeleton className="ui-skel-num" />
              <Skeleton className="ui-skel-chart" style={{ height: 80 }} />
            </div>
          </Cell>
          <Cell label="empty" wide>
            <Empty compact title="No links yet." action={<Button variant="primary" size="sm" icon={Plus}>Create link</Button>}>
              Short links you create show up here with their clicks.
            </Empty>
          </Cell>
          <Cell label="error with retry" wide>
            <ErrorState compact what="Your link statistics" error={new Error("D1_ERROR: too many requests")} onRetry={() => { setBusy(true); setTimeout(() => setBusy(false), 1200); }} retrying={busy} />
          </Cell>
          <Cell label="error, offline" wide>
            <ErrorState compact what="Latest hits" error={new TypeError("Failed to fetch")} onRetry={() => {}} />
          </Cell>
          <Cell label="error, server fault: plain words, raw answer under Details" wide>
            <ErrorState compact what="Your links" error={new ApiError("Internal error", 500)} onRetry={() => {}} />
          </Cell>
        </div>
      </KitSection>

      <KitSection id="notice" title="Notice" note="One tinted band in the flow. Danger is for what is broken now, not for configuration.">
        <div className="ui-kit-stack">
          <Notice title="Live data isn’t connected." action={<Button size="sm">Connect</Button>}>Totals come from saved days; today’s clicks appear tomorrow.</Notice>
          <Notice tone="good" title="Imported 48 links." />
          <Notice tone="warn" title="2 destinations are being rechecked.">They failed once in the last hour.</Notice>
          <Notice tone="danger" title="/broken-pdf is down." action={<Button size="sm" variant="secondary">Open Link health</Button>}>Visitors see an error page since 09:14 UTC.</Notice>
        </div>
      </KitSection>

      <KitSection id="overlays" title="Dialog, sheet, menu, toast" note="Radix, portalled into <body>; the tokens sit on <html data-ui>. Focus is trapped and returned. Static previews below, live ones on the buttons.">
        <div className="ui-kit-row">
          <Button onClick={() => setDialog(true)}>Open dialog</Button>
          <Button onClick={() => setSheet(true)}>Open sheet</Button>
          <Button onClick={() => setForm(true)}>Open the link form (components/LinkForm)</Button>
          <Menu
            label="Link actions"
            trigger={<Button>Open menu</Button>}
            items={[
              { label: "Edit", icon: Pencil, onSelect: () => {}, kbd: "E" },
              { label: "Copy link", icon: Copy, onSelect: () => toast.success("Copied", { description: "sh.example/guide" }) },
              { label: "QR code", icon: QrCode, onSelect: () => {} },
              "separator",
              { label: "Delete", icon: Trash2, onSelect: () => {}, danger: true },
            ]}
          />
          <Button onClick={() => toast.success("Link saved", { description: "sh.example/guide" })}>Toast: success</Button>
          <Button onClick={() => toast.error("Couldn’t save", { description: "The slug is taken." })}>Toast: error</Button>
        </div>
        <div className="ui-kit-static">
          <div className="ui-dialog" data-size="sm" role="presentation">
            <header className="ui-dialog-head">
              <div>
                <p className="ui-dialog-title">Delete /old-webinar?</p>
                <p className="ui-dialog-desc">Visitors get “link not found”. You can restore it for 30 days.</p>
              </div>
            </header>
            <footer className="ui-dialog-foot">
              <Button>Cancel</Button>
              <Button variant="danger">Delete</Button>
            </footer>
          </div>
          <div className="ui-menu" role="presentation">
            <div className="ui-menu-item"><Pencil aria-hidden /><span>Edit</span><kbd className="ui-menu-kbd">E</kbd></div>
            <div className="ui-menu-item" data-highlighted=""><Copy aria-hidden /><span>Copy link</span></div>
            <div className="ui-menu-item" data-disabled=""><QrCode aria-hidden /><span>QR code</span></div>
            <div className="ui-menu-sep" />
            <div className="ui-menu-item" data-danger=""><Trash2 aria-hidden /><span>Delete</span></div>
          </div>
        </div>
        <Dialog
          open={dialog}
          onOpenChange={setDialog}
          title="Delete /old-webinar?"
          description="Visitors get “link not found”. You can restore it for 30 days."
          size="sm"
          footer={
            <>
              <Button onClick={() => setDialog(false)}>Cancel</Button>
              <Button variant="danger" onClick={() => setDialog(false)}>Delete</Button>
            </>
          }
        />
        <LinkForm open={form} onOpenChange={setForm} />
        <Sheet open={sheet} onOpenChange={setSheet} title="Filters" description="Applied as you change them." footer={<Button variant="primary" onClick={() => setSheet(false)}>Done</Button>}>
          <div className="ui-kit-stack">
            <Select label="Status" options={[{ value: "all", label: "All links" }, { value: "active", label: "Active" }]} />
            <Input label="Tag" placeholder="talks" />
            <Switch label="Only links with revenue" checked={false} />
          </div>
        </Sheet>
      </KitSection>
    </div>
  );
}
