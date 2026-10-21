import { useQueryClient } from "@tanstack/react-query";
import { FileUp } from "lucide-react";
import Papa from "papaparse";
import { useMemo, useState, type ChangeEvent } from "react";
import { toast } from "sonner";
import type { ImportRowInput } from "../../shared/schemas";
import type { ImportResult, ImportRowResult } from "../../shared/types";
import { api, call, keys } from "../api";
import { Badge, Button, Card, CardHeader, Field, Notice, PageHeader, Select } from "../components/ui";
import { num } from "../lib/format";
import { linkKey, useDomains, useLinkLabel } from "../lib/links";

type Raw = Record<string, unknown>;

const GUESS = {
  slug: ["slug", "route", "short", "shortcode", "short_code", "key", "alias", "back-half", "backhalf", "path", "id", "short_url", "shorturl", "url"],
  target: ["target", "destination", "long_url", "longurl", "original_url", "originalurl", "redirect", "link", "url"],
  title: ["title", "name"],
  clicks: ["clicks", "imported_clicks", "click_count", "visits", "total_clicks"],
  created: ["createdat", "created_at", "created", "date"],
  tags: ["tags", "tag"],
  domain: ["domain", "host", "hostname"],
};

function guess(headers: string[], names: string[], avoid?: string): string {
  const lower = headers.map((h) => h.toLowerCase().trim());
  for (const n of names) {
    const i = lower.indexOf(n);
    if (i !== -1 && headers[i] !== avoid) return headers[i]!;
  }
  return "";
}

/** "sh.example/Guide", "https://sh.example/Guide" or "/Guide" → { domain, slug: "Guide" }. */
function splitSlug(v: string): { domain: string; slug: string } {
  const s = v.trim().replace(/^https?:\/\//, "");
  const i = s.lastIndexOf("/");
  if (i === -1) return { domain: "", slug: s };
  return { domain: s.slice(0, i).replace(/\/$/, ""), slug: s.slice(i + 1) };
}

interface Mapping {
  slug: string;
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

function mapRows(rows: Raw[], m: Mapping): Mapped[] {
  return rows
    .map((r) => {
      const split = splitSlug(String(r[m.slug] ?? ""));
      const slug = split.slug;
      const domain = (m.domain ? String(r[m.domain] ?? "").trim() : split.domain).toLowerCase();
      const created = m.created ? Date.parse(String(r[m.created] ?? "")) : NaN;
      const clicks = m.clicks ? Number(r[m.clicks]) : NaN;
      const row: Mapped = {
        domain,
        slug,
        target: String(r[m.target] ?? "").trim(),
        title: m.title ? String(r[m.title] ?? "").trim() || null : null,
        clicks: Number.isFinite(clicks) && clicks >= 0 ? Math.floor(clicks) : null,
        createdAt: Number.isFinite(created) ? Math.floor(created / 1000) : null,
      };
      if (m.tags && r[m.tags]) row.tags = String(r[m.tags]);
      return row;
    })
    .filter((r) => r.slug || r.target);
}

const CHUNK = 100;

export function Import() {
  const qc = useQueryClient();
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<Raw[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [m, setM] = useState<Mapping>({ slug: "", target: "", title: "", clicks: "", created: "", tags: "", domain: "" });
  const { domains: configured, primary, multiple } = useDomains();
  const label = useLinkLabel();
  /** Where rows without a domain go; empty means the primary domain. */
  const [defaultDomain, setDefaultDomain] = useState("");
  /** Import only this domain's rows; empty means every configured domain. */
  const [onlyDomain, setOnlyDomain] = useState("");
  const [mode, setMode] = useState<"skip" | "overwrite">("skip");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [filter, setFilter] = useState<"issues" | "all">("issues");

  const load = (data: Raw[]) => {
    const hs = [...new Set(data.flatMap((r) => Object.keys(r)))];
    setRows(data);
    setHeaders(hs);
    const slug = guess(hs, GUESS.slug);
    setM({
      slug,
      target: guess(hs, GUESS.target, slug),
      title: guess(hs, GUESS.title),
      clicks: guess(hs, GUESS.clicks),
      created: guess(hs, GUESS.created),
      tags: guess(hs, GUESS.tags),
      domain: guess(hs, GUESS.domain),
    });
    setResult(null);
  };

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    if (file.name.toLowerCase().endsWith(".json")) {
      file
        .text()
        .then((t) => {
          const parsed = JSON.parse(t) as unknown;
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

  const mapped = useMemo(() => (m.slug && m.target ? mapRows(rows, m) : []), [rows, m]);
  const fallback = defaultDomain || primary;
  const effective = (r: Mapped) => r.domain || fallback;
  // Rows on domains that aren't configured here (e.g. other domains of the previous shortener) are left out.
  const foreign = useMemo(
    () => [...new Set(mapped.map((r) => r.domain).filter((d) => d && !configured.includes(d)))],
    [mapped, configured],
  );
  const selected = useMemo(
    () => mapped.filter((r) => (!r.domain || configured.includes(r.domain)) && (!onlyDomain || (r.domain || fallback) === onlyDomain)),
    [mapped, configured, onlyDomain, fallback],
  );
  const leftOut = mapped.length - selected.length;

  const run = async (dryRun: boolean) => {
    const total = selected.length;
    setProgress({ done: 0, total });
    setResult(null);
    const acc: ImportResult = { dryRun, created: 0, updated: 0, skipped: 0, errors: 0, rows: [] };
    try {
      for (let i = 0; i < total; i += CHUNK) {
        const chunk = selected.slice(i, i + CHUNK).map((r) => ({ ...r, domain: r.domain || undefined }));
        const res = await call(api.import.$post({ json: { rows: chunk, mode, dryRun, defaultDomain: fallback || undefined } }));
        acc.created += res.created;
        acc.updated += res.updated;
        acc.skipped += res.skipped;
        acc.errors += res.errors;
        acc.rows.push(...res.rows);
        setProgress({ done: Math.min(i + CHUNK, total), total });
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

  const shown: ImportRowResult[] = result
    ? filter === "all"
      ? result.rows
      : result.rows.filter((r) => r.status === "error" || r.status === "skipped" || r.message)
    : [];

  const columnSelect = (key: keyof Mapping, label: string, required = false) => (
    <Field label={label} htmlFor={`col-${key}`}>
      <Select id={`col-${key}`} value={m[key]} onChange={(e) => setM((s) => ({ ...s, [key]: e.target.value }))}>
        <option value="">{required ? "Choose a column" : "Not mapped"}</option>
        {headers.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </Select>
    </Field>
  );

  return (
    <>
      <PageHeader
        title="Import links"
        description="A fresh workspace. The same trusted links. Bring your existing links from another shortener."
      />

      <div className="space-y-4">
        <Card className="p-5">
          <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed border-line bg-bg px-6 py-16 text-center transition-colors hover:border-accent hover:bg-accent-soft/30 focus-within:ring-2 focus-within:ring-accent">
            <FileUp className="mb-3 size-10 text-accent" />
            <span className="text-sm font-medium text-fg">{fileName || "Choose a CSV or JSON file"}</span>
            <span className="text-xs text-muted">CSV or JSON · Review your columns before importing</span>
            <input type="file" accept=".csv,.json,text/csv,application/json" className="sr-only" onChange={onFile} />
          </label>
        </Card>

        {headers.length > 0 ? (
          <Card>
            <CardHeader title="Columns" description={`${num(rows.length)} rows found. Check the mapping.`} />
            <div className="grid gap-4 px-4 pb-4 sm:grid-cols-2 lg:grid-cols-3">
              {columnSelect("slug", "Slug (or short URL)", true)}
              {columnSelect("target", "Destination URL", true)}
              {columnSelect("title", "Title")}
              {columnSelect("clicks", "Lifetime clicks")}
              {columnSelect("created", "Created date")}
              {columnSelect("tags", "Tags")}
              {columnSelect("domain", "Domain")}
              {multiple ? (
                <Field label="Domain for rows without one" htmlFor="default-domain">
                  <Select id="default-domain" value={fallback} onChange={(e) => setDefaultDomain(e.target.value)}>
                    {configured.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}
              {multiple ? (
                <Field label="Import" htmlFor="only-domain">
                  <Select id="only-domain" value={onlyDomain} onChange={(e) => setOnlyDomain(e.target.value)}>
                    <option value="">All your domains</option>
                    {configured.map((d) => (
                      <option key={d} value={d}>
                        Only {d}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}
              <Field label="Existing slugs" htmlFor="mode">
                <Select id="mode" value={mode} onChange={(e) => setMode(e.target.value as "skip" | "overwrite")}>
                  <option value="skip">Skip (keep what’s here)</option>
                  <option value="overwrite">Overwrite destination</option>
                </Select>
              </Field>
            </div>

            {foreign.length ? (
              <div className="px-4 pb-4">
                <Notice>
                  {num(leftOut)} {leftOut === 1 ? "row is" : "rows are"} left out: {foreign.join(", ")}{" "}
                  {foreign.length === 1 ? "isn't one of your short domains" : "aren't among your short domains"} ({configured.join(", ")}).
                </Notice>
              </div>
            ) : null}
            {selected.length > 0 ? (
              <div className="overflow-x-auto border-t border-line px-4 py-3">
                <p className="mb-2 text-xs text-muted">Preview of the first rows ({num(selected.length)} will be sent)</p>
                <table className="w-full min-w-[520px] text-sm">
                  <thead className="text-left text-xs text-muted">
                    <tr>
                      <th className="py-1 font-medium">Slug</th>
                      <th className="py-1 font-medium">Destination</th>
                      <th className="py-1 text-right font-medium">Clicks</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.slice(0, 8).map((r, i) => (
                      <tr key={`${linkKey(effective(r), r.slug)}-${i}`} className="border-t border-line">
                        <td className="py-1.5 font-mono text-xs">{label({ domain: effective(r), slug: r.slug })}</td>
                        <td className="max-w-md truncate py-1.5 text-muted">{r.target}</td>
                        <td className="tabular py-1.5 text-right">{r.clicks ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="px-4 pb-4">
                <Notice>Pick the slug and destination columns to continue.</Notice>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
              <Button variant="outline" onClick={() => void run(true)} disabled={!selected.length || progress !== null}>
                Check (dry run)
              </Button>
              <Button onClick={() => void run(false)} disabled={!selected.length || progress !== null}>
                Import {num(selected.length)} links
              </Button>
              {progress ? (
                <div className="flex min-w-48 flex-1 items-center gap-2 text-xs text-muted">
                  <div className="h-1.5 flex-1 rounded-full bg-surface-2">
                    <div className="h-1.5 rounded-full bg-accent transition-all" style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
                  </div>
                  {progress.done}/{progress.total}
                </div>
              ) : null}
            </div>
          </Card>
        ) : null}

        {result ? (
          <Card>
            <CardHeader
              title={result.dryRun ? "Dry run result (nothing was saved)" : "Import result"}
              description={`${num(result.created)} new · ${num(result.updated)} updated · ${num(result.skipped)} skipped · ${num(result.errors)} errors`}
              action={
                <Select className="h-8 w-auto text-xs" value={filter} onChange={(e) => setFilter(e.target.value as "issues" | "all")} aria-label="Rows to show">
                  <option value="issues">Issues and notes</option>
                  <option value="all">All rows</option>
                </Select>
              }
            />
            {!result.dryRun ? (
              <div className="px-4 pb-3">
                <Notice tone="accent">Your import is complete. Review the links in your workspace and test their destinations before switching your domain.</Notice>
              </div>
            ) : null}
            {shown.length ? (
              <div className="max-h-96 overflow-auto px-4 pb-4">
                <table className="w-full text-sm">
                  <tbody>
                    {shown.map((r, i) => (
                      <tr key={`${linkKey(r.domain, r.slug)}-${i}`} className="border-t border-line">
                        <td className="py-1.5 pr-3 font-mono text-xs">{label(r)}</td>
                        <td className="py-1.5 pr-3">
                          <Badge tone={r.status === "error" ? "danger" : r.status === "skipped" ? "neutral" : "good"}>{r.status}</Badge>
                        </td>
                        <td className="py-1.5 text-xs text-muted">{r.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="px-4 pb-4 text-sm text-muted">No issues.</p>
            )}
          </Card>
        ) : null}
      </div>
    </>
  );
}
