// The API reference (/api-docs): every endpoint of the public API, generated
// from its own OpenAPI description (query key ["openapi"]). Search, one
// section per tag, a row per operation that opens its description,
// parameters, body schema and a curl example to copy. openapi.json downloads
// with the admin session. Look: docs.css (prefix docs-), code blocks from
// sitepages.

import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Download } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { api, call, downloadFile } from "../../api";
import { Button, Empty, ErrorState, Input, Section, Skeleton, Table, TD, TH } from "../ui";
import { Code } from "../sitepages/parts";

interface Operation {
  method: string;
  path: string;
  tags: string[];
  summary: string;
  description: string;
  parameters: { name: string; in: string; required?: boolean; schema?: Record<string, unknown> }[];
  requestBody?: { content: Record<string, { schema: Record<string, unknown> }> };
}

/** An example curl for an operation, with placeholders for the path and an example body from the schema. */
function curl(base: string, op: Operation): string {
  const path = op.path.replace(/\{(\w+)\}/g, (_m, n: string) => `<${n}>`);
  const body = op.requestBody?.content["application/json"]?.schema;
  const example = body ? exampleOf(body) : null;
  return [
    `curl -X ${op.method.toUpperCase()} "${base}${path}" \\`,
    `  -H "Authorization: Bearer $SHORTHOP_KEY"${example ? " \\" : ""}`,
    ...(example ? [`  -H "Content-Type: application/json" \\`, `  -d '${JSON.stringify(example)}'`] : []),
  ].join("\n");
}

/** The required fields of a JSON schema, with a placeholder value each. */
function exampleOf(schema: Record<string, unknown>): Record<string, unknown> | null {
  const props = (schema.properties ?? {}) as Record<string, { type?: string; enum?: unknown[] }>;
  const required = (schema.required as string[] | undefined) ?? Object.keys(props).slice(0, 2);
  const out: Record<string, unknown> = {};
  for (const k of required) {
    const p = props[k];
    out[k] = p?.enum?.[0] ?? (p?.type === "number" || p?.type === "integer" ? 1 : p?.type === "boolean" ? true : p?.type === "array" ? [] : k === "url" || k === "target" ? "https://example.com/" : "…");
  }
  return Object.keys(out).length ? out : null;
}

/** Fetches openapi.json with the admin session, then saves it. */
function DownloadSpec() {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      icon={Download}
      loading={busy}
      title="For Postman, Insomnia, client generators and AI assistants"
      onClick={() => {
        setBusy(true);
        downloadFile("/_admin/api/openapi.json")
          .catch((e: unknown) => toast.error(e instanceof Error ? e.message : "Export failed"))
          .finally(() => setBusy(false));
      }}
    >
      openapi.json
    </Button>
  );
}

/** Settings → API → Full reference: every endpoint, generated from the API's own OpenAPI description. */
export function ApiDocsPage() {
  const spec = useQuery({
    queryKey: ["openapi"],
    queryFn: () => call(api["openapi.json"].$get()) as Promise<{ servers: { url: string }[]; paths: Record<string, Record<string, Omit<Operation, "method" | "path">>> }>,
  });
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const ops = useMemo(() => {
    const list: Operation[] = [];
    for (const [path, methods] of Object.entries(spec.data?.paths ?? {})) for (const [method, op] of Object.entries(methods)) list.push({ ...op, method, path });
    const needle = q.trim().toLowerCase();
    return needle ? list.filter((o) => `${o.method} ${o.path} ${o.summary} ${o.tags.join(" ")}`.toLowerCase().includes(needle)) : list;
  }, [spec.data, q]);
  const groups = useMemo(() => {
    const m = new Map<string, Operation[]>();
    for (const o of ops) m.set(o.tags[0] ?? "Other", [...(m.get(o.tags[0] ?? "Other") ?? []), o]);
    return [...m.entries()];
  }, [ops]);
  // The public API lives on /api with a key; the admin reads the same document on its own path.
  const base = spec.data?.servers[0]?.url.replace(/\/_admin\/api$/, "/api") ?? "";

  return (
    <div className="ui-page docs-page">
      <header className="ui-head">
        <div className="ui-head-main">
          <h1 className="ui-h1">API reference</h1>
          <p className="ui-head-sub">
            Every endpoint, its parameters and its permission. Requests need a personal API key: <code className="sitepage-c">Authorization: Bearer shp_…</code>.
          </p>
          <p className="docs-links">
            <Link className="ui-text-button" to="/settings#api">
              API settings
            </Link>
            <Link className="ui-text-button" to="/settings#mcp">
              Connect an AI assistant (MCP)
            </Link>
          </p>
        </div>
        <div className="ui-head-tools">
          <DownloadSpec />
        </div>
      </header>
      <div className="docs-search">
        <Input type="search" label="Search endpoints" hideLabel placeholder="Search endpoints…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {spec.isPending ? (
        <div aria-busy aria-label="Loading the API reference">
          {[5, 3].map((n, g) => (
            <div key={g} className="ui-section">
              <Skeleton className="ui-skel-text" style={{ width: 120, height: 18, marginBottom: 16 }} />
              {Array.from({ length: n }, (_, i) => (
                <div key={i} className="docs-op-skel">
                  <Skeleton className="ui-skel-text" style={{ width: 52 }} />
                  <Skeleton className="ui-skel-text" style={{ width: `${30 + ((i * 13) % 30)}%` }} />
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : spec.isError ? (
        <ErrorState what="The API reference" error={spec.error} onRetry={() => void spec.refetch()} retrying={spec.isFetching} />
      ) : !groups.length ? (
        <Empty
          title={q.trim() ? `No endpoints match “${q.trim()}”.` : "No endpoints are described."}
          action={
            q.trim() ? (
              <Button size="sm" onClick={() => setQ("")}>
                Clear the search
              </Button>
            ) : undefined
          }
        >
          {q.trim() ? "Search looks at the method, the path, the summary and the group." : null}
        </Empty>
      ) : (
        groups.map(([tag, list]) => (
          <Section key={tag} title={tag} sub={`${list.length} ${list.length === 1 ? "endpoint" : "endpoints"}`}>
            <ul className="docs-ops">
              {list.map((o) => {
                const id = `${o.method} ${o.path}`;
                const isOpen = open === id;
                const domId = `op-${o.method}-${o.path.replace(/[^a-z0-9]+/gi, "-")}`;
                return (
                  <li key={id} className="docs-op" data-open={isOpen ? "" : undefined}>
                    <button type="button" className="docs-op-row" onClick={() => setOpen(isOpen ? null : id)} aria-expanded={isOpen} aria-controls={domId}>
                      <span className="docs-method" data-method={o.method}>{o.method.toUpperCase()}</span>
                      <code className="docs-path">{o.path}</code>
                      <span className="docs-summary">{o.summary}</span>
                      <ChevronDown aria-hidden className="docs-chevron" />
                    </button>
                    {isOpen ? <OperationDetail id={domId} op={o} example={curl(base, o)} /> : null}
                  </li>
                );
              })}
            </ul>
          </Section>
        ))
      )}
    </div>
  );
}

function OperationDetail({ id, op, example }: { id: string; op: Operation; example: string }) {
  const body = op.requestBody?.content["application/json"]?.schema;
  return (
    <div className="docs-detail" id={id}>
      {op.summary ? <p className="docs-detail-summary">{op.summary}</p> : null}
      {op.description ? <p className="docs-desc">{op.description}</p> : null}
      {op.parameters.length ? (
        <Table label={`Parameters of ${op.method.toUpperCase()} ${op.path}`} className="docs-params">
          <thead>
            <tr>
              <TH>Parameter</TH>
              <TH>In</TH>
              <TH>Type</TH>
            </tr>
          </thead>
          <tbody>
            {op.parameters.map((p) => (
              <tr key={`${p.in}:${p.name}`}>
                <TD>
                  <code className="sitepage-c">{p.name}</code>
                  {p.required ? (
                    <span className="docs-required">
                      {" "}
                      <span aria-hidden>*</span>
                      <span className="ui-sr">required</span>
                    </span>
                  ) : null}
                </TD>
                <TD className="docs-muted">{p.in}</TD>
                <TD className="docs-muted">
                  {String(p.schema?.type ?? (p.schema?.enum ? "enum" : "string"))}
                  {Array.isArray(p.schema?.enum) ? `: ${(p.schema!.enum as unknown[]).join(", ")}` : ""}
                </TD>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : null}
      {body ? (
        <details className="sitepage-more">
          <summary>Request body (JSON schema)</summary>
          <div className="sitepage-more-body">
            <Code label="request body schema">{JSON.stringify(body, null, 2)}</Code>
          </div>
        </details>
      ) : null}
      <div>
        <p className="sitepage-label">Example</p>
        <Code label="example">{example}</Code>
      </div>
    </div>
  );
}
