# DESIGN: Shorthop admin, "Almanac"

The design system of the admin at `/_admin`: tokens, components and layout rules. The code is the source of truth: `src/client/app/tokens.css` (tokens), `ui.css` + `ui/*.tsx` (components), `shell.css` + `Shell.tsx` (navigation), `home.css` (page layout and the analytics home), `components.css` (the components in `src/client/components/`). `src/client/main.tsx` imports every stylesheet in one fixed order (fonts, tokens, components, ui, shell, home, then each page's), never with a lazy page, so which of two equal selectors wins doesn't depend on the route you enter by. Component sheet: `/_admin/kit` (every component in every state). If this file and the code disagree, the code is right; fix this file.

Mode: **Operate.** People read clicks, sources and money daily and create links fast. Precision and restraint over expression; the character lives in the numerals, the lichen-grey neutrals and the source ribbon.

---

## 1. Scope and tokens

- `data-ui="app"` sits on `<html>` in `_admin/index.html`, so the tokens apply from the first paint; every rule is scoped to `:root[data-ui="app"]`. It is on `<html>`, not a wrapper, because Radix portals (Dialog, Sheet, Menu, LinkForm, toasts) render into `<body>`.
- The components in `src/client/components/` use the Tailwind colours named in `index.css` (`--bg`, `--surface`, `--surface-2`, `--line`, `--fg`, `--muted`, `--subtle`, `--accent*`, `--danger*`, `--good*`, `--warn*`, `--series-*`, `--font-sans`). `tokens.css` points each one at a `--ui-*` token, so LinkForm, the QR studio, Share statistics, Disable/Enable, the tag manager and toasts match the rest.
- **`components.css` shapes those components from the outside** instead of rewriting them. Rules match whole Tailwind classes (`[class~="…"]`), so a markup change degrades to the plain Tailwind look. Inside their dialogs: panel surface, radius lg, pop shadow, a `--ui-t-lg` title; pill buttons (primary = accent fill, outline/secondary = the design's secondary, danger = danger fill with on-danger text); fields in the design's shell (`--ui-line-control`, accent halo on focus); Segmented becomes the ink-pill Segmented; device/country chips are sunken pills, the chosen one an ink pill; switches use the design's track. **No card-in-card:** collapsible groups (`details`), routing rules, the "Everyone else" row, the simulator and the "Link no longer working" group lose their box and sit under a 1 px `--ui-line` rule; the rule number is ink-3 text, not an accent tile. The link page's History (`components/LinkHistory`, styled in `link.css`) has no filled icon discs: a 1 px `--ui-line-strong` ring on the canvas with an ink-3 icon; before → after chips are neutral (the old value struck through in ink-3, the new value on `--ui-sunken` in ink), never red/green. The form's Cancel / Save row sticks to the bottom of the scrolling dialog. A select disabled because it has one choice (domain) reads ink-2, not faint.
- Theme: `lib/theme.ts` (`data-theme="light" | "dark"`, none = auto); `public/_admin/assets/theme-1.js` applies the saved theme and accent before the first paint. Tokens use `light-dark()`, driven by `color-scheme` (light / dark / system). Lightning CSS compiles `light-dark()` to its `--lightningcss-light/dark` fallback at build time.
- Accent: `--accent-base` from `lib/accent.ts` (each person picks one). Every accent colour derives from it (§2.2).

## 2. Colour

### 2.1 Neutrals (lichen grey: a faint green-grey)

| Token | Light | Dark | Role |
|---|---|---|---|
| `--ui-canvas` | `#f8f9f7` | `#0f1311` | page |
| `--ui-side` | `#f1f4f0` | `#0b0f0d` | sidebar (second neutral layer) |
| `--ui-panel` | `#ffffff` | `#161b18` | overlays, inputs, current nav item; never a card |
| `--ui-sunken` | `#eef1ed` | `#1b211d` | segmented track, kbd, skeleton base, neutral badge |
| `--ui-hover` | `#eef1ed` | `#1b211d` | hover rows and ghost buttons |
| `--ui-pressed` | `#e4e9e3` | `#232b26` | active (pressed) state, skeleton sheen |
| `--ui-line` | `#dfe4de` | `#27302a` | section rules, row rules |
| `--ui-line-strong` | `#c4ccc3` | `#38433b` | table-head rule, secondary button edge |
| `--ui-line-control` | `#828e85` | `#66736a` | edges that identify a control (input, checkbox, switch track): ≥ 3:1 (3.4 / 3.5) |
| `--ui-ink` | `#121a15` | `#e3eae5` | text (16.8 / 15.3:1) |
| `--ui-ink-2` | `#434e47` | `#a9b5ad` | secondary text (8.2 / 8.8:1) |
| `--ui-ink-3` | `#5a665e` | `#8b988f` | tertiary text; lowest allowed for text (5.7 / 6.2:1 on canvas, ≥ 5.4 on every surface) |
| `--ui-ghost`, `--ui-bots` | `#8a958d`, `#9aa59d` | `#6d7a71`, `#56625a` | decoration only (previous-period line, bots bar). Never text. |
| `--ui-overlay` | ink 32 % | black 60 % | scrim |

### 2.2 Accent, derived from `--accent-base`

| Token | Light | Dark | Use | Floor |
|---|---|---|---|---|
| `--ui-accent-fill` | mix 86 % with black | mix 55 % with white | primary button, checked checkbox/switch, ribbon segment 0 | text on it ≥ 4.5:1 |
| `--ui-on-accent` | `#ffffff` | `#0f1311` | text/icons on the fill | |
| `--ui-accent-ink` | mix 80 % with black | mix 55 % with white | accent text, links, focus ring | ≥ 4.5:1 on canvas, panel, wash |
| `--ui-accent` | base | mix 75 % with white | chart line, selected-KPI indicator, nav mark | ≥ 3:1 (graphics) |
| `--ui-accent-wash` | 10 % on canvas | 18 % on canvas | selected row, info notice, avatar | |
| `--ui-bar-data` | ink 48 % into canvas (`#7e837f`) | same mix (`#6b706d`) | breakdown bars at rest | **3.6:1 / 3.7:1** on canvas (a mark, not an underline) |
| `--ui-bar-quiet` | ink 30 % | same | bots and "everything else" rows | 2.1:1 |
| `--ui-bar-track` | `--ui-line` | same | the full-width track under every bar | 1.2 / 1.4:1 (visible, never read as a value) |
| `--ui-accent` | accent | same | a bar on hover or focus of a linked row, and on the active-filter row | ≥ 3:1 |
| `--ui-bar-rest` | ink 16 % on canvas | same | only the sparkline's unfinished day | decoration |
| `--ui-seg-0…4` | fill, then OKLCH L 0.525 / 0.632 / 0.70 / 0.765 (accent hue, chroma capped) | L 0.88 / 0.815 / 0.75 / 0.685 / 0.62 | ribbon segments | see "Ribbon ramp" below |
| `--ui-seg-rest` | `#dfe4de` | `#5b665e` | "Everything else" | |
| heatmap | `--ui-ink` mixed into `--ui-canvas` in five steps, 12 / 30 / 48 / 68 / 90 % (empty = sunken); the three busiest slots `--ui-accent` | same tokens (so the busiest step is the lightest) | peak hours | validated (below) |
| sparkline | `--ui-ghost` bars, today `--ui-bar-rest`; `--ui-accent` on the row you point at or move to | same | Websites picker | ≥ 3:1 as a graphic |

**Ribbon ramp.** A single-hue ordinal ramp, run through the dataviz validator (`--ordinal`) for the default blue: monotone lightness, every adjacent step ≥ 0.06 OKLCH L apart, the faintest step ≥ 2:1 on the light canvas (2.01) and ≥ 5:1 on the dark one (5.04). Dark mode steps from a light tint *down* toward the accent, never toward the canvas, so no segment sinks into `#0f1311`. Text inside segments: white on 0–1 in light (7.7 / 5.7:1), ink on 2–4 (≥ 4.98:1); dark ink on every dark step (≥ 5.0:1); "Everything else" keeps ink (13.8 / 4.9:1). Browsers without relative colour fall back to `color-mix` steps.

**Heatmap ramp.** Neutral, not accent: five discrete steps of ink mixed into the canvas (light `#d9dbd8 #abafab #7f8581 #525954 #252c27`, dark `#242826 #464b48 #6b716d #979d99 #cbd1cd`). Steps are by **rank** among the cells that had any value (`heatScale` in `sites/insights.tsx`): the quietest 40 % are step 1, then 25 / 15 / 10 %, and only the busiest 10 % reach ink, so the weekly pattern reads whatever the spread; equal values share a step. Validated with the dataviz validator (`--ordinal`) on both canvases: monotone lightness, every adjacent step ≥ 0.06 L apart, steps 2–5 clear 2:1 (2.10 light, 2.10 dark); step 1 is the sequential near-zero end and recedes on purpose (1.3:1), an empty cell is the sunken tint. The three busiest slots (named in the "Busiest:" note) are the accent. A legend under the grid shows the five steps between the smallest and the busiest value ("1 ▢▢▢▢▢ 20 visits an hour", each step's range in its title) and the accent "Busiest" key. Cells are 13 px tall with 2 px gaps, the grid at most 720 px wide; phones get 3-hour blocks with their own scale and legend ("per 3 hours").

**Dark mode flips the text on the accent.** White text on a lightened accent would be 3.8:1, so in dark mode the fill gets *lighter* and the text *dark* (`#0f1311`). Primary buttons, measured in the browser with the default blue `#3b5bdb`: **7.7:1 light, 8.0:1 dark.** Purple / red / green presets: 7.5–8.0 / 7.8–9.0.

**Safe degradation for any picked colour.** `lib/accent.ts` accepts any hex, so a user can pick yellow or navy. Under `@supports (color: oklch(from red l c h))` the fill and ink are clamped in OKLCH: at most L 0.50 in light, at least L 0.72 in dark; the accent line at most L 0.60 light, at least L 0.62 dark. The four presets are unaffected by the clamp. Worst case over 200,000 random colours (sRGB, clipped): white on fill ≥ 5.07:1 light, dark on fill ≥ 7.14:1 dark, accent ink on canvas ≥ 4.9:1. Measured in the browser: yellow `#f2c200` 5.95 / 14.3, cyan `#22d3ee` 5.51 / 13.7, navy `#0b1a5a` 17.6 / 7.5. Browsers without relative colour fall back to the unclamped mixes, which pass for the presets.

### 2.3 Status

| Token | Light | Dark | Wash (badge/notice bg) | Text on wash |
|---|---|---|---|---|
| `--ui-good` | `#187548` | `#5bc78f` | 9 % / 16 % on canvas | 4.8 / 7.1:1 |
| `--ui-warn` | `#845d16` | `#dfb15c` | 10 % / 16 % | 4.9 / 7.4:1 |
| `--ui-bad` | `#ad3535` | `#f07d7d` | 10 % / 16 % | 5.2 / 5.8:1 |
| `--ui-danger-fill` / `--ui-on-danger` | `#ad3535` / white | `#f07d7d` / `#0f1311` | danger button | 6.3 / 7.1:1 |

Rules: green and red mean "better/worse than before" or "working/broken now". A standing configuration state is warn, never red: the sidebar status dot is red only when link storage (KV) or the database (D1) fails, warn for anything still to set up. A paused site shows no deltas on visit metrics ("Tracking paused" as the note), never red ones. One accent stays meaningful: it marks the current metric, primary action, selection, focus and the row you point at; breakdown bars rest in ink (`--ui-bar-data`), sparklines in ghost, the heatmap is a neutral ramp (its three busiest slots excepted), rule numbers and History markers are ink-3. **Money is ink** (680, like any value): green only for positive deltas, red only for negative deltas and refunds.

### 2.4 Browser surfaces
`::selection` is accent 28 %; `caret-color` accent ink; `accent-color` accent fill; `scrollbar-color` line-strong on transparent; focus ring 2 px `--ui-focus` (= accent ink), offset 2 px.

## 3. Type

Self-hosted variable woff2 (OFL, `src/client/app/fonts/`, Latin and Latin Ext, 35 and 20 KB, emitted as files by the build and loaded with the admin's CSS; CSP `font-src 'self'`). One family, **Hanken Grotesk** (weight 100–900, declared as the family "Hanken UI" in `fonts.css`), for text, headings and numbers alike: they are set apart by size, weight and tabular figures. `--ui-font-display` and `--ui-font-num` point at `--ui-font-ui`, so headings or numbers can get their own face in one place.

| Token | Size | Weight | Use |
|---|---|---|---|
| `--ui-t-kpi` | 46 px (34 on phones) | 560, tracking −0.035 em, line-height 1.05 | KPI numerals: only the StatStrip. A quiet stat (bots) uses `--ui-t-xl`; secondary numbers (visit facts, path to money, subscriptions) use `--ui-t-lg` 680 |
| `--ui-t-xl` | 28 px | 680, −0.02 em | page title (h1) |
| `--ui-t-lg` | 17 px | 680 | section titles (h2), dialog titles, state titles |
| `--ui-t-md` | 15 px | 680 | chart title, compact state titles |
| `--ui-t-base` | 14 px | 420, line-height 1.55 | body, rows, menu items |
| `--ui-t-sm` | 13 px | 420–560 | labels, notes, tabs, buttons, deltas |
| `--ui-t-xs` | 12 px | 560 | axis ticks, column heads, kbd, badges |
| `--ui-t-input` | 14 px, 16 px on phones | 420 | inputs (no iOS focus zoom) |

Weights: `--ui-w-body` 420, `--ui-w-medium` 560, `--ui-w-strong` 680, `--ui-w-num` 560. Rules: every number that lines up is `tabular-nums lining-nums` and right-aligned; **one voice for row numbers** in tables and lists: the row's lead value 680 ink (`.ui-row-value`, `td.is-num`), a secondary number in the same row 560 ink-2 (`td.is-num.is-2`, a stacked table's `data-label` cell, the links list's Total next to the period); a share is 13 px ink-3; headings `text-wrap: balance`, prose `pretty`; measure ≤ 72ch for prose; no eyebrows/kickers above headings; sentence case.

## 4. Space, size, shape, depth

- **Spacing:** `--ui-s-1…7` = 4 / 8 / 12 / 20 / 28 / 40 / 64. Tight inside a group (4–12), generous between groups (28–64), more space above a heading than below.
- **Sizes:** row `--ui-row` 38; controls `--ui-control-sm` 30, `--ui-control` 36, `--ui-control-lg` 44; **every control is 44 px under 768 px** (`--ui-touch`, the sm/md tokens are re-pointed there). Sidebar `--ui-side-w` 248 (220 at 768–1023). Page max `--ui-page-max` 1180.
- **Radius:** `--ui-r-sm` 6 (bars, segments, menu items), `--ui-r-md` 10 (inputs, nav items, notices, menus), `--ui-r-lg` 14 (dialogs, sheets), `--ui-r-pill` 999 (buttons, segmented, search, badges). Buttons have one shape: the pill. Toolbar fields are pills too (the links search and its filter selects, the chart's bucket select); form fields are `--ui-r-md`.
- **Borders:** 1 px only. `--ui-line` between sections/rows, `--ui-line-strong` under table heads and around secondary buttons, `--ui-line-control` around inputs. Never a coloured side border on a card, row, notice or alert. State indicators (the Tabs underline, the selected KPI) are separate bars drawn on a 1 px rule, never a thick border on a rounded box.
- **Shadows:** `--ui-shadow-raise` `0 1px 2px` ink 6 % (light only; current nav item). `--ui-shadow-menu` ring + `0 12px 28px -10px` (menus, toasts). `--ui-shadow-pop` ring + `0 28px 56px -18px` (dialogs, sheets, command bar, chart readout). Nothing on page content.
- **Z-index:** sticky 10 (phone header) · side 20 · tabbar 30 · overlay/scrim 60 · modal 61 · menu 70 · skip link 90 (sonner keeps its own top layer).

## 5. Motion

| Token | Value | Use |
|---|---|---|
| `--ui-dur-press` | 120 ms | button press scale (0.97) |
| `--ui-dur-fast` | 140 ms | colour/background/border changes, switch thumb, exits |
| `--ui-dur` | 200 ms | dialog enter, tab underline, KPI indicator |
| `--ui-dur-slow` | 240 ms | sheet enter, breakdown bar widths, ribbon segments |
| `--ui-ease-out` | `cubic-bezier(0.23, 1, 0.32, 1)` | entering/exiting, press, underline |
| `--ui-ease-move` | `cubic-bezier(0.77, 0, 0.175, 1)` | on-screen morphs (bars and ribbon re-proportion when the period changes) |
| `--ui-ease-drawer` | `cubic-bezier(0.32, 0.72, 0, 1)` | sheets |

Rules: motion only explains a change (state, feedback, where something came from). Transform and opacity, plus `flex-grow`/`width` for data bars (the change *is* the data). Colour hovers use plain `ease` and move nothing, so they need no hover-capability gate. Dialog: fade + scale 0.97 from centre; sheet: slides from its edge (bottom on phones, right on wide screens); menu: scale 0.96 from `--radix-dropdown-menu-content-transform-origin`; exits mirror entrances, faster. **No animation on the command bar** (opened by keyboard many times a day) or on page loads. **Reduced motion:** `index.css` switches every animation and transition off globally; overlays then appear instantly.

## 6. Layout rules

- **Shell:** sidebar (248) + page. Page centred, max 1180, padding 40 / 40 / 64 (28 at tablet, 20 / 16 on phones).
- **No cards, no card-in-card.** Structure comes from space and 1 px rules. Sections are separated by a top rule and 28 px. The only boxed surfaces are controls (inputs, the workspace switcher), notices (a tinted band) and overlays.
- **Grid:** KPI strip = equal columns (`--n`, 4 at 1440, 2 under 1024). Breakdown lists = two open columns with a 64 px gutter at ≥ 1024 (`Columns`, §7); one column below (two lists at ~220 px each were unreadable at 768). **No half-empty rows:** `Columns` splits the sections between the two columns so they end as evenly as possible (each column keeps source order), measured once the content is there; after you interact nothing moves to the other column.
- **Breakdown lists:** name left; under the row a **6 px bar on a full-width track** (`--ui-bar-track`), the bar's width the row's **share of the list's total** (`barWidth`, one rule for every bar in the admin), so every list scans by shape before you read a number. The bar is `--ui-bar-data` (ink 48 %: 3.6:1 light, 3.7:1 dark), quiet rows `--ui-bar-quiet`, the accent on hover/focus of a linked row and on the active-filter row. A list with one row draws no bar (100 % of itself says nothing). Share (ink-3, 13 px) and value (680) right-aligned and tabular. Bots/"everything else" last and quieter. "Show all N" below, never pagination. Lists show 8 rows on the home, 6 on the link page and the website dashboard, **5 on phones** (website dashboard).
- **Text links (one style).** Every text action and section link is the TextButton look: accent ink, a 40 % underline that strengthens on hover (`.ui-text-button`, `.ui-link-btn`, `.ui-panel-link`, `.ui-more` share one rule): "All links", "Live map and filters ↗", "Filter and see more ↗", "Show all N", "Show table", "Edit settings", "Show rules". ↗ only on links that leave the admin.
- **State notices (one place).** A notice about the chosen period (no clicks, no visits, filters match nothing, paused tracking) sits **right after the PeriodBar, before the KPIs**, on every analytics page. The link's own state (turned off, marked broken, destination down) sits under the header, before the PeriodBar.
- **Empty periods show dashes.** In a period with no hits (no visits and no payments on a website), counts render "—" in the not-available style (`NoneValue` in `parts.tsx`, read as "None"), never a row of big zeros. Notes say "No hits in this period" ("No hits yet" only for All time), "No sales in this period", "No visits in this period"; never "0 customers from 0 payments".
- **Badges only for news.** A link that works gets no badge on its page (the list doesn't show one either): Disabled, Expired, Replaced, Retired do. A website that simply works shows its last visit as text.
- **Tab rows that don't fit** (phones, many tabs) scroll with snap, and the cut edge fades out (40 px mask, `data-fade` set by `Tabs`), so hidden tabs ("Medium", "Time zones") are discoverable.
- **Phones fold what's rarely used.** On the website dashboard under 768 px, How customers bought, Customer value and Peak hours start closed (`Section foldOnPhone`): the title is a 44 px disclosure button with a one-line summary ("15 new customers, median 43 days to buy."). Nothing is removed; tools and actions appear when opened, and Funnels (with New funnel) and Payments stay open.
- **Header (one pattern, every page).** Row 1: the title block (h1 `--ui-t-xl`, then one identity line `ui-head-sub`: workspace scope, the site's domains, the link's URLs) on the left; page actions on the right (Export CSV; Guide and Settings; Copy, Edit, ⋯; More; Add a website), top-aligned, never wrapping under the title on wide screens. Row 2 on the three analytics pages: the **PeriodBar** (`parts.tsx`), under a 1 px rule: the period control, then the range it covers ("Oct 2 – Oct 31, Europe/Paris.", freshness or the live-data note after it). On phones the actions become 44 px icon buttons beside the title (labelled ones always wrap under the title block on the website page, so the name gets the full width) and the period goes full width with the range under it. Titles wrap at spaces only (`overflow-wrap: break-word`, never `anywhere`): a slug breaks after `-` or `/` first, a single overlong word only when it can't fit a line. **The period never overflows:** the PeriodBar is a size container; under 600 px of width (tablets beside the sidebar, phones) the options take their short labels ("7d", "12m", "Custom") and share the full width; a long custom range scrolls inside the control's own track. "Custom…" reads "Custom" in short form, never a bare "…". A ghost action at the right edge lines its label up with the content edge (negative margin of its padding at ≥ 768 px).
- **Formats (one set).** Dates: the browser's locale through `Intl` (`day()` and the website chart's `bucketLabel` alike), "Oct 2"; a range "Oct 2 – Oct 31"; a single day "No clicks on Oct 31". Peak label: "Peak 897 on Oct 7" on every chart. Money: whole amounts drop ".00" in every cell ("$199", "$75.67"), right-aligned tabular; other currencies are named, never added. Stored codes never reach the page (`no_reference` → "No checkout reference").
- **Errors in words.** `errorText` maps a server fault or a generic message ("Internal error", 5xx) to a cause and a next step ("The server ran into a problem. It's usually brief: try again in a moment. If it keeps happening, look at System status in Settings."), 401/403/404/429 to their own lines, and keeps a specific server answer (a validation message). ErrorState adds Try again and a closed "Details" disclosure with "HTTP 500: Internal error".
- **Collapse what can't show anything (one scroll story).** A section that needs Cloudflare Analytics Engine and doesn't have it is not drawn; the website dashboard names them once in one live-data notice under the chart ("Pages, goals, funnels, reading and page speed need live data…" + Connect in Settings), and the Content panel keeps only its D1 tabs (landing, exit pages). Latest hits without live data is one quiet line, the same words on every page (`LiveDataLine` in `parts.tsx`). **Funnels without live data** stay as a section with one line ("1 saved funnel · reports need live data…") and keep all their tools (pick, delete, **New funnel**), so funnels can be set up before Analytics Engine is connected. **A column that carries nothing isn't drawn**, decided from the rows already loaded: Top links' Revenue column needs at least two rows with a value (one sale moves into its row's sub line, "$49 from 1 customer"); the links list's period column is dropped when the whole list has no clicks in it (the count line says ", none clicked in the last 7 days"; kept while it's the sort), and its Status column when no row has a status. **Not measured is not zero:** with no visits, Time per visit and Goal conversion show "No visits" in the not-available style; on a paused site with no visits, every visit KPI says "Not tracked". A panel with no rows in any tab is not drawn (Networks and bots); a tab with no rows is dropped. A home period with no hits shows the notice and the zero KPIs, not empty charts. Smart routing with no routed clicks is one line after the lists ("3 rules, 1 split · no routed clicks in this period." + Show rules); with routed clicks it leads, after the ribbon. Long tables show 5 rows + "Show all N" (payments, then their Pager; latest visits; customer value; how customers bought).
- **Website dashboard order:** KPIs → visit facts line → chart → live-data notice → path to money (compact) → lists (short links, where visitors came from headed by the channel ribbon, content, AI landing pages, location incl. networks, devices; goals with live data) → how customers bought → customer value → payments → funnels (live data) → peak hours → reading and page speed (live data) → latest visits. On phones the three rarely used sections fold (§6) and lists show 5 rows.
- **Revenue on the link page:** the KPI is the chosen period's; "Revenue by website" breaks that same number down; Settings says "Revenue, last 12 months" and says the KPI covers only the chosen period.
- **Column priority by breakpoint.** Decorative columns drop first (sparkline, top source, the status column, which moves under the name as a badge only when it's news), then secondary counts; **money and the main count never drop.** Websites picker: ≥ 1024 everything; < 1024 Website, Visitors, Revenue. Links: < 1360 Tags drop; < 1024 the destination moves under the slug and the Status column goes (its badge sits next to the slug, only for rows that have one), counts narrow to 76 px, so the slug keeps more than half the row; < 768 one clicks column. At every width the period's column isn't drawn when the whole list has no clicks in it (Total stands alone). **Websites list:** the list API counts traffic over 7 days and money over 30, so the columns are grouped by window, each named once in a group head: "Last 7 days" over Visitors (with its change), Visits per day (a 7-day sparkline) and Top source; "Last 30 days" over Revenue (with its change) and New customers ("18", "1.5% of visitors paid"). Under 1024 the group row goes, the heads read "Visitors, 7 days" and "Revenue, 30 days", and New customers drops (a secondary count; every cell stays value + change on two lines); on phones the windows are named in the page line. Tables that carry money or a journey per row (`.ui-table.is-stack`: payments, customer value, found-by/credited-to, latest visits) **stack under 768**: line 1 = the row's name + its main number (`data-lead`), line 2 = the other cells with their column name (`data-label`). The peak-hours heatmap becomes 7 days × 8 three-hour blocks under 768, with its own scale and legend. No table clips silently.
- **KPI strip:** under 1024 the strip is two columns and an odd count lets the first (leading) stat span both: 1 + 2 + 2, never an orphan cell. The website's secondary facts line wraps 2 + 2 under 1200 px, never 3 + 1.
- **Section rhythm:** header → PeriodBar → (period notice) → KPIs → chart → health line → two-column lists (Sources headed by the ribbon) → full-width latest hits.
- **Signature: the source ribbon, as the header of its section.** One 100 % bar, segments stepping from the accent fill to faint tints, 28 px tall with 2 px gaps, the share printed inside segments ≥ 10 % (≥ 18 % on phones). It sits right under the section title and above the tabs: Sources on the home and the link page (human clicks by source), "Where visitors came from" on the website dashboard (visitors by channel, from the Channels tab's own query). **No separate legend:** the list right under it is the legend, each row of that tab carrying its segment's swatch (rows folded into "Everything else" carry the rest swatch). Screen readers get the parts as a list inside the figure. "Where from" is said once.

## 7. Components (`src/client/app/ui/`, look in `ui.css`)

Every interactive component: default, hover, focus-visible, active, disabled, loading where it applies; 44 px targets on phones; visible labels; keyboard paths. `data-demo="hover|focus|active|selected"` forces a state for `/kit` only.

| Component | API | States and behaviour |
|---|---|---|
| **Button** | `variant` primary / secondary / ghost / danger, `size` sm / md / lg, `icon`, `kbd`, `loading`, `asChild` (Link/a) | hover: fill mixes 10 % toward its text colour (primary/danger), edge darkens (secondary), tint (ghost); focus ring; active: darker + scale 0.97 (120 ms); disabled 50 % + not-allowed; loading: ring replaces the icon, label stays, `aria-busy`, can't be pressed again. Primary once per view. |
| **IconButton** | `label` (required → `aria-label` + `title`), `icon`, variant, size | square, same states; ghost uses radius md. |
| **TextButton** | inline action in a sentence, or a section's aside action | accent ink, underline strengthens on hover. The same look for `.ui-panel-link` (section links), `.ui-link-btn` and `.ui-more` ("Show all N"). |
| **Input** | `label` (or `hideLabel` for compact filters), `hint`, `error` | edge `line-control`; hover darker; focus (any focus, so typing shows where it lands): accent edge + 3 px accent halo; error: red edge, message below (`aria-invalid`, `aria-describedby`); disabled sunken; 16 px text on phones. |
| **Select** | native `<select>`, same field shell | platform picker on phones, type-ahead; explicit bg/colour for Windows dark mode. |
| **Checkbox** | Radix; `label`, `description`, `hideLabel`, `checked` incl. `"indeterminate"`; `tabIndex` and `data-*` go to the box | label is part of the target; checked = accent fill + on-accent tick; 44 px row on phones. A table row's tick box: `hideLabel tabIndex={-1} data-row-select=""` (the row is the keyboard stop; Space/x tick it). |
| **Switch** | Radix; same props | for settings that apply at once; thumb slides 140 ms. |
| **Segmented** | `label`, `options` (`short` label for phones, `disabled`), `value`, `onChange`, size | ARIA radio group, roving tabindex, arrows move *and* choose; selected = ink pill with canvas text. Used for the period. |
| **Tabs** | Radix; `label`, `items` (`count`, `disabled`), `value`, `onValueChange`, render-prop panel, `aside` | underline style: ink 2 px rule grows from centre (200 ms); hover shows a line-strong rule; arrows/Home/End. A row wider than its column scrolls with snap and fades at the cut edge (`data-fade` start/end/both). |
| **Table** (`Table`, `TH`, `TD`, `TR`, `SortTH`, `Pager`) | `rowNav`, `TH/TD numeric`, `TR focusable/first/selected` | head 12 px over a strong rule; rows 42 px (34 dense, 44 phone); numeric cells right-aligned and tabular, lead 680 ink, `is-2` 560 ink-2 (§3); row hover tint; keyboard: ↑/↓ or j/k move (roving tabindex), Home/End, Enter opens `[data-row-link]`, Space toggles `[data-row-select]`; focused row shows the focus ring inside the row; selected row = accent wash, `aria-selected`. **SortTH** (`label`, `short` for phones, `active`, `dir`, `onSort`, `numeric`): the whole label is a button, `aria-sort` on the cell, arrow on the active column and on hover. **Pager** (`page`, `pages`, `size`, `total`, `onPage`, `onSize`): range left, rows per page (hidden label), previous/next icon buttons with "Page n of N"; used by the links list and the payments table. |
| **BreakdownList** | `items` (`label`, `sub`, `value`, `display`, `extra`, `to`, `quiet`, `swatch`), `limit`, `unit`, `total`, `showShare`, `emptyText` | §6; 6 px bar on a track, width = share of `total` (`barWidth`); one row draws no bar; `swatch` ("0"…"4", "rest") puts the ribbon segment's key before the name; rows with `to` are real links (hover underline + accent bar, focus ring + accent bar); "Show all N" toggles. The website dashboard's `PickRows` follows the same rules. |
| **Stat** (KPI) | `label`, `value`, `delta`, `note`, `quiet`, `disabled`; any div props | a 1 px `line` rule under the number; the indicator is a separate 3 px bar on that rule (no radius): line-strong on hover, accent when selected (colour, 200 ms). Not-available value 17 px ink-2. `quiet` (bots) is ink-2 at `--ui-t-xl`, on the same line height. |
| **StatStrip**, **StatStripSkeleton** | `items` (`StatItem`: `id`, `label`, `value`, `delta`, `note`, `quiet`, `disabled`), `value`, `onChange`, `label` | a row of Stats in equal columns (`--n`). With `onChange` it is a tab list that switches the chart: ←/→ move and choose (disabled ones skipped), Home/End, Enter/Space; one roving tab stop. Without it the numbers are plain (nothing to chart). Used by the home, the link page and the website dashboard. |
| **Columns** | `className`, children (sections) | `ui/layout.tsx`. Two open columns at ≥ 1024 (1 px grid rows, each child spans its measured height + 40 px, placed in the column `balance()` picks: the most even split, first section left, source order within a column; `grid-auto-flow: dense`). Re-measures on resize and content change; the split freezes after a pointer or key press inside. One column below 1024. Home, link page, website dashboard. |
| **Section** | `title`, `sub`, `aside`, `id`, `className`, `foldOnPhone` | a 1 px top rule, 28 px above the h2, an optional sub line (ink-2, ≤ 72ch), tools on the right; `scroll-margin-top` for `#anchors`. With `foldOnPhone` (a one-line summary) it starts closed under 768 px: the title is a disclosure button (`aria-expanded`, chevron), the summary replaces the sub line, tools and content show when open (content stays mounted). Link page and website dashboard sections. |
| **useNarrow** | hook | true under 768 px (`matchMedia`), for layout decisions CSS can't make (rows shown, folds). |
| **Badge** | `tone` good / warn / danger / neutral | wash background, tone text, dot (colour is never the only signal). Only when the state is news (Disabled, Expired, Down, Paused, "3 online now"); never "Active". |
| **Skeleton**, **SkeletonText** | sizes via class/style | the shape of the content, shimmer 1.4 s (off with reduced motion). No lone spinners. |
| **Empty** | `title`, body, one `action`, `compact` | says why and what next. |
| **ErrorState** | `what`, `error`, `onRetry`, `retrying`, `compact` | "{what} couldn’t load." + a cause and next step in plain words (`errorText`) + Try again (loading while retrying) + a closed "Details" disclosure with the raw status and message (`errorDetail`); `role="alert"`. |
| **Notice** | `tone` info / good / warn / danger, `title`, body, `action` | one tinted band with an icon; danger only for what is broken now. |
| **Dialog** | `open`, `onOpenChange`, `title`, `description`, `footer`, `size` sm/md/lg | Radix: focus trap and return, Escape, labelled close; footer right-aligned, primary last; bottom-anchored on phones. Opens on the body's first field, else the first footer button (Cancel), never on ✕. For a `components/ui.tsx` dialog, `useFocusFirstField(open)` moves focus from the ✕ to its first text field once it opens (LinkForm's Edit). |
| **Sheet** | same + `side` auto / bottom / right | right edge on wide screens, bottom with grip on phones; `overscroll-behavior: contain`. |
| **Menu** | `trigger`, `items` (`icon`, `kbd`, `danger`, `disabled`, `"separator"`), `label`, `align` | Radix DropdownMenu: arrows, type-ahead, Escape; danger items red, last. |
| **Toast** | sonner (mounted in `main.tsx`) | styled in `tokens.css`: panel surface, strong ring + menu shadow, tone colour on the title only. |

### 7.1 Shared analytics pieces (`src/client/app/parts.tsx`, look in `home.css`)

Used by the home, the link page and the website dashboard; page folders keep only what one page needs.

| Piece | API | Behaviour |
|---|---|---|
| **PeriodBar** | `value`, `onChange`, `custom`, children (the range) | the second header row of the analytics pages (§6 Header). `rangeLabel(from, to)` is the one range format. |
| **PeriodControl** | `value`, `onChange`, `custom` | the period as a Segmented (Today … All time). With `custom`, a last option "Custom…" opens a dialog with 6 / 9 months and any from–to dates (UTC, not before the stats start, not in the future); the chosen range then shows as that option's label. Without it, a range from the URL that isn't a quick one shows as one more chosen option. Link page: `custom`; home and website dashboard: without. |
| **TrendBlock** | `title`, `buckets` (null = loading shape), `weekly`, `metric`, `currency`, `canCompare`, `height` | "{title}, by day/week", the Previous period toggle, Show table / Show chart, the revenue time-zone note; toggles keep their state while data reloads. |
| **SourceRibbon** | `items` (`RibbonPart`: `key`, `label`, `value`), `label` (the figure's accessible caption), `className` | §6 signature; passed as a `TabbedPanel`'s `lead`. `ribbonParts(items)` gives the parts and the `swatch` map; `sourceParts(rows)` turns a source breakdown into parts; `withSwatches(items, swatch)` keys the list under it. |
| **TabbedPanel** | `title`, `tabs`, `render`, `aside`, `lead` | a titled list with underline tabs; `lead` sits between the title and the tabs (the ribbon). |
| **NoneValue** | | "—" for a count in an empty period, xl ink-3, "None" to screen readers. |
| **RowsSkeleton** | `rows` | a breakdown list's loading shape. |

## 8. Navigation

Implemented in `Shell.tsx` (`NAV`, `isCurrent`) and `CommandBar.tsx`.

**Sidebar (≥ 768 px)**, top to bottom:
1. Brand: hop mark (accent) + "Shorthop" 19/680 → `/`.
2. Search: pill button "Search… ⌘K" → command bar (below).
3. Workspace box: "Personal workspace" + the primary domain. With one domain it links to `/settings#domains` for people with `settings.manage`, otherwise static. With several it shows "+N" and opens a menu: each domain jumps to its links, plus "Manage short domains" (`settings.manage`).
4. Create link: primary button with `C` hint, only with `links.create`; opens the `LinkForm` dialog; on save goes to the link's page `/links/:domain/:slug`.
5. Nav, group 1: **Analytics** `/` (stats.view) · **All links** `/links` · **Bio pages** `/links?status=bio` · **Websites** `/sites` (stats.view; picker, dashboard `/sites/:id`) · **Recent hits** `/hits` (stats.view). Group 2 (18 px gap, no label): **Link health** `/health`, also current on `/misses` (health.manage) · **Import links** `/import` (links.create) · **Settings** `/settings`, also current on `/api-docs`.
   - Item: 34 px, icon 17 px ink-3, label ink-2 560. Hover: hover tint, ink. Current (`aria-current="page"`): panel surface + 1 px line ring + raise shadow, label ink 680, icon accent ink. All entries are router `Link`s, so Cmd/Ctrl-click works.
6. Footer: system status (only when a check isn't ok: one line with a warn/red dot, "N system checks to review" → `/#status`; no banner on pages) · AI assistants (MCP) → `/settings#mcp` (api.use) · Cloudflare features → `/settings#cloudflare` (settings.manage). Then the account row above a rule: initials avatar (accent wash/ink), name, role (Owner/Admin/Manager/User) → `/settings#account`; theme toggle (one click light ↔ dark; Settings → Appearance also offers Automatic); Log out (POST `/_admin/logout`).

**Phones (< 768 px):** sticky 56 px header (brand · search icon · primary create icon, all 44 px); fixed bottom tab bar with the entries that have a tab (Analytics, Links, Websites) + **More** (60 px items, current = ink 680 + accent icon); More opens a bottom Sheet with the remaining entries (current one tinted, › on each), the account row with theme toggle and Log out, the status line and the footer links. Page bottom padding clears the tab bar and the safe area.

**Always:** skip link ("Skip to content" → `#ui-main`), `document.title` = "{current entry} · Shorthop", scroll to top and close More on navigation, distinct landmark labels ("Main", "Main, phone").

**Command bar and shortcuts:** `⌘K`/`Ctrl+K` toggles, `/` opens, `c` creates a link (not while typing or while a dialog is open). Groups: found links (the Links page query) · Go to (every page in the nav, filtered by permission) · Actions (Create link, Switch theme). ↑/↓ move, Enter opens, Esc closes. No open/close animation.

**Routes** (under `/_admin`): `/` analytics home (gated `stats.view`, otherwise → `/links`), `/links`, `/links/:domain/:slug`, `/sites`, `/sites/:id`, `/sites/:id/guide`, `/sites/:id/settings`, `/hits`, `/health`, `/misses`, `/import`, `/settings`, `/api-docs`, `/kit` (component sheet). `/stats` redirects to `/`. Anything else → "Page not found" (`PageNotFound.tsx`).

## 9. Known limits

- The components in `src/client/components/` (LinkForm, QR studio, Share statistics, Disable/Enable, tag manager, shared reports) keep their Tailwind markup; `components.css` gives them the design (§1), including the danger fill + on-danger in place of their hardcoded white text. **Initial focus in their dialogs** is `components/ui.tsx` `Dialog`'s (Radix default: the ✕). The link page corrects it from outside for LinkForm (Edit: `useFocusFirstField` focuses Destination URL; Create already autofocuses it). QR studio, Share statistics and Disable/Enable still open on the ✕; the real fix is in `components/ui.tsx`.
- `components/LinkHistory` prints the QR code design and bio page fields as raw JSON. On the link page `app/link/History.tsx` rewrites those two values into words after render; the real fix is in LinkHistory's `Value`.
- The global focus ring is declared with zero specificity (`:where(:root[data-ui="app"]) :focus-visible`) so fields (halo), the command input (underline) and table rows (inset ring) draw their own focus instead of a second outline.
- Relative-colour clamping needs Chrome 119 / Safari 16.4 / Firefox 128; older browsers get the unclamped mixes (safe for the four presets, not for arbitrary picked colours).
