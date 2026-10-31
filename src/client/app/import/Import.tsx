// Import links: parsing (papaparse for CSV, JSON arrays and Shorthop's own
// export), vendor presets and detection, column mapping, domain choices,
// chunked POST /import (dry run or for real) and the pull from another
// shortener's API.

import { useQueryClient } from "@tanstack/react-query";
import { CloudDownload, Download, FileUp } from "lucide-react";
import Papa from "papaparse";
import { useId, useMemo, useState, type ChangeEvent, type DragEvent } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import type { ImportRowInput } from "../../../shared/schemas";
import { IMPORT_VENDORS, type ImportResult, type ImportRowResult, type ImportSource, type ImportVendor } from "../../../shared/types";
import { api, call, keys } from "../../api";
import { fullNum, num } from "../../lib/format";
import { IMPORT_HELP } from "../../lib/help";
import { linkKey, useDomains, useLinkLabel } from "../../lib/links";
import { useCan, useMe } from "../../lib/me";
import { cn } from "../../lib/utils";
import { HelpTip } from "../hits/HelpTip";
import { Badge, Button, Checkbox, errorText, Input, Notice, Section, Segmented, Select, Table, TD, TH } from "../ui";

type Raw = Record<string, unknown>;

/** Header names as compared: lowercase, with spaces and dashes as "_" ("Destination URL" → destination_url). */
const norm = (h: string) => h.toLowerCase().trim().replace(/[\s-]+/g, "_");

const GUESS = {
  slug: ["slug", "route", "short", "shortcode", "short_code", "key", "alias", "back_half", "backhalf", "slashtag", "path", "id", "short_link", "short_url", "shorturl", "url"],
  target: ["target", "destination", "destination_url", "long_url", "longurl", "original_url", "originalurl", "redirect", "link", "url"],
  title: ["title", "name"],
  // imported_clicks is the column the admin's links export writes.
  clicks: ["clicks", "click_count", "visits", "total_clicks", "engagements", "imported_clicks", "imported_clicks"],
  created: ["createdat", "created_at", "date_created", "created", "date"],
  tags: ["tags", "tag"],
  domain: ["domain", "host", "hostname"],
};

type Preset = "auto" | "bitly" | "rebrandly" | "shortio" | "dub" | "csv";
const PRESETS: { value: Preset; label: string }[] = [
  { value: "auto", label: "Detect automatically" },
  { value: "bitly", label: "Bitly export" },
  { value: "rebrandly", label: "Rebrandly export" },
  { value: "shortio", label: "Short.io export" },
  { value: "dub", label: "Dub export" },
  { value: "csv", label: "Another CSV" },
];

/** Each vendor's export columns, so their files map without guessing. */
const PRESET_COLUMNS: Partial<Record<Preset, Partial<Mapping>>> = {
  // Bitly: "Custom Link" is the branded back-half (what moves to your domain); "Link" is bit.ly's.
  bitly: { slug: "custom_link", slugFallback: "link", target: "destination_url", title: "title", clicks: "engagements", created: "date_created" },
  dub: { slug: "short_link", target: "destination_url", clicks: "clicks", created: "created_at" },
  shortio: { slug: "short_url", target: "original_url", title: "title", clicks: "clicks", created: "created_at", tags: "tags" },
  rebrandly: { slug: "shorturl", target: "destination", title: "title", clicks: "clicks", created: "createdat" },
};

/** Which vendor a file looks like, from its columns. */
function detect(headers: string[]): Preset {
  const h = new Set(headers.map(norm));
  if (h.has("custom_link") && h.has("destination_url")) return "bitly";
  if (h.has("short_link") && h.has("destination_url")) return "dub";
  if ((h.has("original_url") || h.has("originalurl")) && (h.has("path") || h.has("short_url"))) return "shortio";
  if (h.has("slashtag") || (h.has("destination") && h.has("shorturl"))) return "rebrandly";
  return "csv";
}

/** An example import file. Its column names are the ones the links export writes, so an export imports as is. */
function exampleCsv(domain: string): string {
  return [
    "slug,target,title,tags,created_at,imported_clicks",
    "guide,https://example.com/guide,Job search guide,\"guides,career\",2026-01-15,120",
    "cv,https://example.com/cv-template.pdf,CV template,,2025-11-02,",
    `${domain || "sh.example"}/talk,https://example.com/talks/2026,Conference talk,talks,,`,
  ].join("\n");
}

/** Saves text as a file, the way the exports do. */
function saveText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** The file's header matching one of `names` (compared normalized). */
function guess(headers: string[], names: string[], avoid?: string): string {
  const normalized = headers.map(norm);
  for (const n of names) {
    const i = normalized.indexOf(n);
    if (i !== -1 && headers[i] !== avoid) return headers[i]!;
  }
  return "";
}

/** "sh.example/Guide", "https://sh.example/Guide" or "Guide" → { domain, slug }. The slug is everything after the host. */
function splitSlug(v: string): { domain: string; slug: string } {
  const s = v.trim().replace(/^https?:\/\//, "");
  const i = s.indexOf("/");
  if (i === -1) return { domain: "", slug: s };
  // A host has a dot; "/guide" or "a/b" without one is a path, not a domain.
  const host = s.slice(0, i);
  if (!host.includes(".")) return { domain: "", slug: s.replace(/^\/+/, "") };
  return { domain: host.toLowerCase(), slug: s.slice(i + 1).replace(/\/$/, "") };
}

interface Mapping {
  slug: string;
  /** Used when the slug column is empty on a row (Bitly links without a branded back-half). */
  slugFallback: string;
  target: string;
  title: string;
  clicks: string;
  created: string;
  tags: string;
  domain: string;
}

interface Mapped extends ImportRowInput {
  /** From the domain column or the short URL; empty when the file doesn't say. */
  domain: string;
}

const EMPTY: Mapping = { slug: "", slugFallback: "", target: "", title: "", clicks: "", created: "", tags: "", domain: "" };

function mapRows(rows: Raw[], m: Mapping): Mapped[] {
  return rows
    .map((r) => {
      const raw = String(r[m.slug] ?? "").trim() || (m.slugFallback ? String(r[m.slugFallback] ?? "") : "");
      const split = splitSlug(raw);
      const domain = (m.domain ? String(r[m.domain] ?? "").trim() : split.domain).toLowerCase();
      const created = m.created ? Date.parse(String(r[m.created] ?? "")) : NaN;
      // "1,234" and "1 234" are numbers too.
      const clicks = m.clicks ? Number(String(r[m.clicks] ?? "").replace(/[\s,]/g, "")) : NaN;
      const row: Mapped = {
        domain,
        slug: split.slug,
        target: String(r[m.target] ?? "").trim(),
        title: m.title ? String(r[m.title] ?? "").trim() || null : null,
        clicks: Number.isFinite(clicks) && clicks >= 0 && String(r[m.clicks] ?? "").trim() !== "" ? Math.floor(clicks) : null,
        createdAt: Number.isFinite(created) ? Math.floor(created / 1000) : null,
      };
      if (m.tags && r[m.tags]) row.tags = String(r[m.tags]);
      return row;
    })
    .filter((r) => r.slug || r.target);
}

/** What the server would refuse for the whole batch, caught per row here instead. */
function rowProblem(r: Mapped): string | null {
  if (!r.slug) return "No slug";
  if (r.slug.length > 128) return "Slug longer than 128 characters";
  if (r.slug.includes("/")) return "Slashes aren't supported in slugs";
  if (!r.target) return "No destination";
  if (r.target.length > 4096) return "Destination longer than 4,096 characters";
  return null;
}

/** Rows per request until /me says what this Workers plan allows (the Free size, which always works). */
const DEFAULT_CHUNK = 20;

const VENDOR_LABEL: Record<ImportVendor, string> = { bitly: "Bitly", rebrandly: "Rebrandly", shortio: "Short.io", dub: "Dub" };
const VENDOR_KEY_HINT: Record<ImportVendor, string> = {
  bitly: "Bitly → Settings → API → Generate token. Works on every plan, Free included.",
  rebrandly: "Rebrandly → Account → API keys.",
  shortio: "Short.io → Integrations & API → API → Create API key (the secret key).",
  dub: "Dub → Settings → API keys → Create (read access to links is enough).",
};

const STATUS_TONE: Record<ImportRowResult["status"], "danger" | "neutral" | "good"> = { error: "danger", skipped: "neutral", created: "good", updated: "good" };
const STATUS_WORD: Record<ImportRowResult["status"], string> = { error: "Error", skipped: "Skipped", created: "New", updated: "Updated" };

export function ImportPage() {
  const canEdit = useCan()("links.edit");
  const chunkSize = useMe().data?.workspace.importRows ?? DEFAULT_CHUNK;
  const qc = useQueryClient();
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<Raw[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [m, setM] = useState<Mapping>(EMPTY);
  const [preset, setPreset] = useState<Preset>("auto");
  /** Rows that need no column mapping: pulled from an API, or another workspace's JSON export. */
  const [direct, setDirect] = useState<Mapped[] | null>(null);
  const [from, setFrom] = useState<ImportSource | null>(null);
  const { domains: configured, primary, multiple } = useDomains();
  const label = useLinkLabel();
  /** Where rows without a domain go; empty means the primary domain. */
  const [defaultDomain, setDefaultDomain] = useState("");
  /** Import only this domain's rows; empty means every configured domain. */
  const [onlyDomain, setOnlyDomain] = useState("");
  /** Rows on domains that aren't yours (bit.ly, dub.sh…): which of your domains they move to; "" leaves them out. */
  const [moves, setMoves] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<"skip" | "overwrite">("skip");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [filter, setFilter] = useState<"issues" | "all">("issues");
  const [tab, setTab] = useState<"file" | "pull">("file");
  const [dragging, setDragging] = useState(false);

  const reset = () => {
    setResult(null);
    setMoves({});
  };

  const applyPreset = (hs: string[], p: Preset) => {
    const chosen = p === "auto" ? detect(hs) : p;
    const fixed = PRESET_COLUMNS[chosen] ?? {};
    const pick = (k: keyof Mapping, names: string[], avoid?: string) => (fixed[k] ? guess(hs, [fixed[k]!]) : "") || guess(hs, names, avoid);
    const slug = pick("slug", GUESS.slug);
    setM({
      slug,
      slugFallback: fixed.slugFallback ? guess(hs, [fixed.slugFallback]) : "",
      target: pick("target", GUESS.target, slug),
      title: pick("title", GUESS.title),
      clicks: pick("clicks", GUESS.clicks),
      created: pick("created", GUESS.created),
      tags: pick("tags", GUESS.tags),
      domain: pick("domain", GUESS.domain),
    });
    setFrom(chosen === "auto" ? "csv" : chosen === "csv" ? "csv" : chosen);
  };

  const load = (data: Raw[]) => {
    const hs = [...new Set(data.flatMap((r) => Object.keys(r)))];
    setRows(data);
    setHeaders(hs);
    setDirect(null);
    applyPreset(hs, preset);
    reset();
  };

  const readFile = (file: File) => {
    setFileName(file.name);
    if (file.name.toLowerCase().endsWith(".json")) {
      file
        .text()
        .then((t) => {
          const parsed = JSON.parse(t) as unknown;
          // Another workspace's export (Settings → Exports → Links as JSON): rows with every setting.
          const exported = parsed as { format?: string; links?: unknown[] };
          if (exported.format === "shorthop-links" && Array.isArray(exported.links)) {
            setHeaders([]);
            setRows([]);
            setDirect(exported.links as Mapped[]);
            setFrom("json");
            reset();
            return;
          }
          const list = Array.isArray(parsed) ? parsed : (parsed as { data?: unknown[] }).data;
          if (!Array.isArray(list)) throw new Error("Expected an array of links");
          load(list as Raw[]);
        })
        .catch((err: unknown) => toast.error(`Couldn't read JSON: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    Papa.parse<Raw>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        if (res.errors.length) toast.warning(`${res.errors.length} CSV row(s) couldn't be parsed`);
        load(res.data);
      },
      error: (err) => toast.error(`Couldn't read CSV: ${err.message}`),
    });
  };

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) readFile(file);
    // The same file can be chosen again after a change to it.
    e.target.value = "";
  };
  const onDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) readFile(file);
  };

  const mapped = useMemo(() => direct ?? (m.slug && m.target ? mapRows(rows, m) : []), [direct, rows, m]);
  const fallback = defaultDomain || primary;
  const foreign = useMemo(() => [...new Set(mapped.map((r) => r.domain).filter((d) => d && !configured.includes(d)))].sort(), [mapped, configured]);
  /** Each row with the domain it will land on; null when it's left out. */
  const placed = useMemo(
    () =>
      mapped.map((r) => {
        if (!r.domain || configured.includes(r.domain)) return r;
        const to = moves[r.domain] ?? fallback;
        return to ? { ...r, domain: to } : null;
      }),
    [mapped, configured, moves, fallback],
  );
  const problems = useMemo(() => placed.map((r) => (r ? rowProblem(r) : null)), [placed]);
  const selected = useMemo(
    () => placed.filter((r, i): r is Mapped => r !== null && !problems[i] && (!onlyDomain || (r.domain || fallback) === onlyDomain)),
    [placed, problems, onlyDomain, fallback],
  );
  const skippedForeign = placed.filter((r) => r === null).length;
  const invalid = problems.filter(Boolean).length;

  const run = async (dryRun: boolean) => {
    const total = selected.length;
    setProgress({ done: 0, total });
    setResult(null);
    const acc: ImportResult = { dryRun, created: 0, updated: 0, skipped: 0, errors: 0, rows: [] };
    try {
      for (let i = 0; i < total; i += chunkSize) {
        const chunk = selected.slice(i, i + chunkSize).map((r) => ({ ...r, domain: r.domain || undefined }));
        const res = await call(api.import.$post({ json: { rows: chunk, mode, dryRun, defaultDomain: fallback || undefined, ...(from ? { from } : {}) } }));
        acc.created += res.created;
        acc.updated += res.updated;
        acc.skipped += res.skipped;
        acc.errors += res.errors;
        acc.rows.push(...res.rows);
        setProgress({ done: Math.min(i + chunkSize, total), total });
      }
      setResult(acc);
      if (!dryRun) {
        void qc.invalidateQueries({ queryKey: keys.allLinks });
        toast.success(`Imported ${acc.created + acc.updated} links`);
      }
    } catch (err) {
      setResult(acc);
      toast.error(err instanceof Error ? err.message : "Import failed");
    } finally {
      setProgress(null);
    }
  };

  const shown: ImportRowResult[] = result ? (filter === "all" ? result.rows : result.rows.filter((r) => r.status === "error" || r.status === "skipped" || r.message)) : [];

  const headerOptions = (required: boolean) => [{ value: "", label: required ? "Choose a column" : "Not mapped" }, ...headers.map((h) => ({ value: h, label: h }))];
  const columnSelect = (key: keyof Mapping, text: string, required = false) => (
    <Select label={text} value={m[key]} onChange={(e) => setM((s) => ({ ...s, [key]: e.target.value }))} options={headerOptions(required)} />
  );

  const ready = mapped.length > 0;
  const loaded = headers.length > 0 || direct !== null;
  const busy = progress !== null;

  return (
    <div className="ui-page import-page">
      <header className="ui-head">
        <div className="ui-head-main">
          <h1 className="ui-h1">Import links</h1>
          <p className="ui-head-sub">Bring your links from Bitly, Rebrandly, Short.io, Dub, another Shorthop or any CSV. Branded links keep working once their domain points here.</p>
        </div>
      </header>

      <div className="import-source">
        <Segmented<"file" | "pull">
          label="Import from"
          value={tab}
          onChange={setTab}
          options={[
            { value: "file", label: "A file" },
            { value: "pull", label: "Another shortener’s API", short: "A shortener’s API" },
          ]}
        />
      </div>

      {tab === "file" ? (
        <label
          className={cn("import-drop", dragging && "is-over", fileName && "has-file")}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <FileUp className="import-drop-icon" aria-hidden />
          <span className="import-drop-title">{fileName || "Choose a CSV or JSON file"}</span>
          <span className="import-drop-sub">{fileName ? "Choose another file, or drop it here" : "Or drop it here. A vendor’s export, Links → Export, or another workspace’s JSON export."}</span>
          <input type="file" accept=".csv,.json,text/csv,application/json" className="ui-sr" onChange={onFile} />
        </label>
      ) : (
        <PullPanel
          onRows={(vendor, list) => {
            setHeaders([]);
            setRows([]);
            setFileName("");
            setDirect(list);
            setFrom(vendor);
            reset();
          }}
        />
      )}

      {tab === "file" && !loaded ? (
        <Section
          title="File format"
          sub="A CSV with a header row, or JSON. Only slug and target are required; column names are matched automatically and you can change the mapping after choosing the file."
          aside={
            <>
              <HelpTip help={IMPORT_HELP.format} label="More about the import file format" />
              <Button size="sm" icon={Download} onClick={() => saveText("links-import-example.csv", exampleCsv(primary))}>
                Example CSV
              </Button>
            </>
          }
        >
          <pre className="import-code" tabIndex={0} aria-label="Example CSV">
            {exampleCsv(primary)}
          </pre>
          <ul className="import-list">
            <li>
              <strong>Bitly, Rebrandly, Short.io, Dub:</strong> their link exports import as they are; the columns are recognised. Bitly’s export needs a paid plan: on Free, use “Another shortener’s API” above.
            </li>
            <li>
              <strong>slug</strong>: the back-half, such as <code>guide</code>. A full short URL (<code>sh.example/guide</code>) works too and sets the domain.
            </li>
            <li>
              <strong>target</strong>: the destination URL.
            </li>
            <li>
              Optional: <strong>title</strong>, <strong>tags</strong> (comma-separated, in quotes), <strong>created_at</strong> (a date), <strong>imported_clicks</strong> (clicks counted elsewhere) and{" "}
              <strong>domain</strong>.
            </li>
            <li>Comma, semicolon or tab separated. A file from Links → Export CSV imports as is.</li>
            <li>
              JSON: an array of objects with the same keys, <code>{'{ "data": [...] }'}</code>, or another workspace’s Links as JSON export (with every link’s settings).
            </li>
          </ul>
        </Section>
      ) : null}

      {loaded ? (
        <Section
          title={direct ? (from === "json" ? "Links from another workspace" : `Links from ${from ? VENDOR_LABEL[from as ImportVendor] : "the API"}`) : "Columns"}
          sub={direct ? `${fullNum(direct.length)} links found${from === "json" ? ", with their settings" : ""}.` : `${fullNum(rows.length)} rows found. Check the mapping.`}
        >
          <div className="import-grid">
            {!direct ? (
              <>
                <Select
                  label="The file is"
                  value={preset}
                  onChange={(e) => {
                    const p = e.target.value as Preset;
                    setPreset(p);
                    applyPreset(headers, p);
                  }}
                  options={PRESETS}
                />
                {columnSelect("slug", "Slug (or short URL)", true)}
                {columnSelect("target", "Destination URL", true)}
                {columnSelect("title", "Title")}
                {columnSelect("clicks", "Lifetime clicks")}
                {columnSelect("created", "Created date")}
                {columnSelect("tags", "Tags")}
                {columnSelect("domain", "Domain")}
              </>
            ) : null}
            {multiple ? <Select label="Domain for rows without one" value={fallback} onChange={(e) => setDefaultDomain(e.target.value)} options={configured.map((d) => ({ value: d, label: d }))} /> : null}
            {multiple ? (
              <Select label="Import" value={onlyDomain} onChange={(e) => setOnlyDomain(e.target.value)} options={[{ value: "", label: "All your domains" }, ...configured.map((d) => ({ value: d, label: `Only ${d}` }))]} />
            ) : null}
            <Select
              label="Existing slugs"
              value={mode}
              onChange={(e) => setMode(e.target.value as "skip" | "overwrite")}
              // Overwriting changes existing links: Edit links.
              options={[{ value: "skip", label: "Skip (keep what’s here)" }, ...(canEdit ? [{ value: "overwrite", label: "Overwrite destination" }] : [])]}
            />
          </div>

          {foreign.length ? (
            <div className="import-group">
              <h3 className="import-h3">Links on other domains</h3>
              <p className="import-text">
                Some links are on domains that aren’t yours here. Choose where each one’s links go: they keep their back-half on your domain. The old addresses (such as <code>{foreign[0]}/…</code>) keep pointing
                at the other service; only a domain you own and point here keeps working on its own.
              </p>
              <div className="import-grid">
                {foreign.map((d) => (
                  <Select
                    key={d}
                    label={`Links on ${d}`}
                    value={moves[d] ?? fallback}
                    onChange={(e) => setMoves((s) => ({ ...s, [d]: e.target.value }))}
                    options={[...configured.map((c) => ({ value: c, label: `Move to ${c}` })), { value: "", label: "Leave them out" }]}
                  />
                ))}
              </div>
            </div>
          ) : null}

          {invalid || skippedForeign ? (
            <Notice tone={invalid ? "warn" : "info"} className="import-notice">
              {[
                skippedForeign ? `${fullNum(skippedForeign)} ${skippedForeign === 1 ? "row is" : "rows are"} left out by your choice above` : "",
                invalid ? `${fullNum(invalid)} ${invalid === 1 ? "row can't" : "rows can't"} be imported (${[...new Set(problems.filter(Boolean))].slice(0, 3).join("; ")})` : "",
              ]
                .filter(Boolean)
                .join(". ")}
              .
            </Notice>
          ) : null}

          {selected.length > 0 ? (
            <div className="import-group">
              <h3 className="import-h3">
                Preview <span className="import-h3-note">of the first rows, {fullNum(selected.length)} will be sent</span>
              </h3>
              <Table label="Preview of the first rows to import" dense className="import-preview">
                <thead>
                  <tr>
                    <TH>Slug</TH>
                    <TH>Destination</TH>
                    <TH numeric>Clicks</TH>
                  </tr>
                </thead>
                <tbody>
                  {selected.slice(0, 8).map((r, i) => (
                    <tr key={`${linkKey(r.domain || fallback, r.slug)}-${i}`}>
                      <TD className="import-slug">{label({ domain: r.domain || fallback, slug: r.slug })}</TD>
                      <TD className="import-target" title={r.target}>
                        {r.target}
                      </TD>
                      <TD numeric className={cn(r.clicks == null && "import-none")}>
                        {r.clicks == null ? "—" : fullNum(r.clicks)}
                      </TD>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          ) : !ready ? (
            <Notice className="import-notice">Pick the slug and destination columns to continue.</Notice>
          ) : null}

          <div className="import-actions">
            <Button onClick={() => void run(true)} disabled={!selected.length || busy}>
              Check (dry run)
            </Button>
            <Button variant="primary" onClick={() => void run(false)} disabled={!selected.length || busy}>
              Import {fullNum(selected.length)} {selected.length === 1 ? "link" : "links"}
            </Button>
            {progress ? <Progress done={progress.done} total={progress.total} /> : null}
          </div>
        </Section>
      ) : null}

      {result ? (
        <Section
          title={result.dryRun ? "Dry run result (nothing was saved)" : "Import result"}
          sub={`${fullNum(result.created)} new · ${fullNum(result.updated)} updated · ${fullNum(result.skipped)} skipped · ${fullNum(result.errors)} ${result.errors === 1 ? "error" : "errors"}`}
          aside={
            <Select
              label="Rows to show"
              hideLabel
              className="import-pill"
              value={filter}
              onChange={(e) => setFilter(e.target.value as "issues" | "all")}
              options={[
                { value: "issues", label: "Issues and notes" },
                { value: "all", label: "All rows" },
              ]}
            />
          }
        >
          {!result.dryRun ? (
            <Notice tone="good" className="import-notice">
              Your import is complete. Check the links’ destinations in <Link to="/health">Link health</Link>, then point your domain here: links on it keep working, and printed QR codes with it too.
            </Notice>
          ) : null}
          {shown.length ? (
            <div className="import-results" tabIndex={0} role="region" aria-label="Rows of the result">
              <Table label={filter === "all" ? "Every row" : "Rows with issues or notes"} dense className="import-result-table">
                <thead>
                  <tr>
                    <TH>Link</TH>
                    <TH>Result</TH>
                    <TH>Note</TH>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r, i) => (
                    <tr key={`${linkKey(r.domain, r.slug)}-${i}`}>
                      <TD className="import-slug">{label(r)}</TD>
                      <TD>
                        <Badge tone={STATUS_TONE[r.status]}>{STATUS_WORD[r.status]}</Badge>
                      </TD>
                      <TD className="import-msg">{r.message || "—"}</TD>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          ) : (
            <p className="ui-rows-empty">No issues.</p>
          )}
        </Section>
      ) : null}
    </div>
  );
}

function Progress({ done, total }: { done: number; total: number }) {
  const id = useId();
  return (
    <div className="import-progress">
      <span id={id} className="ui-sr">
        Import progress
      </span>
      <span className="import-progress-track" role="progressbar" aria-labelledby={id} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
        <span className="import-progress-bar" style={{ width: `${(done / Math.max(1, total)) * 100}%` }} />
      </span>
      <span className="import-progress-n">
        {num(done)}/{num(total)}
      </span>
    </div>
  );
}

/**
 * Reads every link from another shortener's API, a page at a time through the
 * Worker (their APIs don't allow the browser to call them). The key lives only
 * in this form; the Worker uses it for each page and keeps nothing.
 */
function PullPanel({ onRows }: { onRows: (vendor: ImportVendor, rows: Mapped[]) => void }) {
  const [vendor, setVendor] = useState<ImportVendor>("bitly");
  const [key, setKey] = useState("");
  const [clicks, setClicks] = useState(true);
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<Mapped[]>([]);
  /** Where a stopped read continues. */
  const [cursor, setCursor] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const read = async (resume: boolean) => {
    setBusy(true);
    setProblem(null);
    let next = resume ? cursor : null;
    const all = resume ? [...found] : [];
    const notes = new Set<string>();
    try {
      do {
        const page = await call(api.import.pull.$post({ json: { vendor, apiKey: key.trim(), cursor: next, clicks } }));
        all.push(...page.rows.map((r) => ({ ...r, tags: r.tags.join(",") })));
        if (page.note) notes.add(page.note);
        next = page.cursor;
        setFound([...all]);
        setCursor(next);
      } while (next);
      for (const n of notes) toast.info(n);
      onRows(vendor, all);
    } catch (err) {
      setProblem(errorText(err) ?? "Reading the links failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Read links from another shortener" sub="Your links, titles, tags, dates and lifetime clicks. The key is used only while this page reads, and isn’t saved." className="import-pull">
      <form
        className="import-pull-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (key.trim().length >= 8 && !busy) void read(false);
        }}
      >
        <div className="import-grid is-two">
          <Select
            label="Service"
            value={vendor}
            onChange={(e) => {
              setVendor(e.target.value as ImportVendor);
              setFound([]);
              setCursor(null);
              setProblem(null);
            }}
            options={IMPORT_VENDORS.map((v) => ({ value: v, label: VENDOR_LABEL[v] }))}
          />
          <Input label="API key" type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} hint={VENDOR_KEY_HINT[vendor]} />
        </div>
        {vendor === "bitly" ? (
          <Checkbox
            className="import-check"
            label="Include lifetime clicks"
            description="One Bitly API call per link: slower, and it counts toward Bitly’s monthly API allowance."
            checked={clicks}
            onCheckedChange={setClicks}
          />
        ) : null}
        {problem ? (
          <Notice
            tone="danger"
            title="Reading stopped."
            className="import-notice"
            action={
              cursor ? (
                <Button size="sm" onClick={() => void read(true)} loading={busy}>
                  Continue from {fullNum(found.length)}
                </Button>
              ) : undefined
            }
          >
            {problem}
          </Notice>
        ) : null}
        <div className="import-actions">
          <Button type="submit" variant="primary" icon={CloudDownload} loading={busy} disabled={key.trim().length < 8}>
            Read links
          </Button>
          {busy || found.length ? (
            <span className="import-count" aria-live="polite">
              {fullNum(found.length)} links read{busy ? "…" : ""}
            </span>
          ) : null}
        </div>
      </form>
    </Section>
  );
}
