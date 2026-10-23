import { Copy, KeyRound } from "lucide-react";
import { SETTINGS_HELP } from "../lib/help";
import { copy } from "../lib/utils";
import { Badge, Button, Card, CardHeader } from "./ui";

/**
 * The main endpoints, grouped. All take and return JSON unless noted. `full`:
 * the API token needs API_TOKEN_SCOPE = "full" (src/worker/app.ts, TOKEN_WRITES).
 */
const ENDPOINTS: { group: string; rows: [method: string, path: string, what: string, full?: true][] }[] = [
  {
    group: "Links",
    rows: [
      ["GET", "/links", "List links (q, tag, status, domain, sort, period)"],
      ["POST", "/links", "Create a link (url, slug, title, tags, routing, preview, password, maxClicks…); ?format=text returns just the short URL"],
      ["GET", "/links/{domain}/{slug}", "One link"],
      ["PATCH", "/links/{domain}/{slug}", "Change any of its settings", true],
      ["DELETE", "/links/{domain}/{slug}", "Delete (restorable for 90 days)", true],
      ["GET", "/links/{domain}/{slug}/history", "Its saved versions"],
      ["POST", "/links/{domain}/{slug}/history/{id}/restore", "Restore a version", true],
      ["GET", "/deleted", "Recently deleted links"],
      ["POST", "/import", "Import up to 100 rows at a time"],
      ["GET", "/export/links.csv", "Every link as CSV"],
    ],
  },
  {
    group: "Statistics",
    rows: [
      ["GET", "/stats/overview", "Totals, daily series, top links, comparison (range or from/to)"],
      ["GET", "/stats/links/{domain}/{slug}", "One link's statistics with every breakdown"],
      ["GET", "/stats/recent", "Latest hits (domain, slug, limit)"],
      ["GET", "/stats/export.csv", "Daily stats per link as CSV"],
    ],
  },
  {
    group: "Health and tools",
    rows: [
      ["GET", "/checks", "Destination checks for every link"],
      ["POST", "/checks/links/{domain}/{slug}", "Check one link's destinations now", true],
      ["GET", "/utm-presets", "UTM presets"],
      ["GET", "/qr/default", "The default QR design"],
      ["GET", "/webhooks", "Webhooks and their status"],
    ],
  },
];

const METHOD_TONE: Record<string, "good" | "accent" | "warn" | "danger"> = { GET: "good", POST: "accent", PATCH: "warn", DELETE: "danger" };

/** Settings → API: the token, the endpoints, a curl example and the iOS Shortcut. */
export function ApiCard({ origin, tokenSet, tokenScope }: { origin: string; tokenSet: boolean; tokenScope: "create" | "full" }) {
  const base = `${origin}/api`;
  const example = `curl -X POST "${base}/links?format=text" \\
  -H "Authorization: Bearer $SHORTHOP_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://example.com/new-post","slug":"new-post"}'`;
  return (
    <Card id="api" className="scroll-mt-6 lg:col-span-2">
      <CardHeader title="API" description="Scripts, automations and the iOS Shortcut use the API with a token, not your browser session." info={SETTINGS_HELP.api} />
      <div className="space-y-5 px-5 pb-5 text-sm">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-line p-3">
            <p className="text-xs text-muted">Base URL</p>
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{base}</code>
              <Button variant="ghost" size="icon-sm" aria-label="Copy base URL" onClick={() => void copy(base, "Base URL copied")}>
                <Copy />
              </Button>
            </div>
          </div>
          <div className="rounded-xl border border-line p-3">
            <p className="flex items-center gap-1.5 text-xs text-muted">
              <KeyRound className="size-3.5" aria-hidden /> Token
            </p>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-xs">
              {tokenSet ? <Badge tone="good">Set</Badge> : <Badge tone="warn">Not set</Badge>}
              {tokenScope === "full" ? <Badge tone="warn">Full access</Badge> : <Badge>Read, create, import</Badge>}
              <span className="text-muted">
                The Worker secret <code className="font-mono text-fg">API_TOKEN</code>, sent as <code className="font-mono text-fg">Authorization: Bearer …</code>.{" "}
                {tokenScope === "full" ? (
                  <>
                    With <code className="font-mono text-fg">API_TOKEN_SCOPE</code> set to <code className="font-mono text-fg">"full"</code> it can do everything the admin can, so keep it
                    private.
                  </>
                ) : (
                  <>
                    It can read, create links and import new ones; changing, deleting and restoring (marked <em>full</em> below) need{" "}
                    <code className="font-mono text-fg">API_TOKEN_SCOPE = "full"</code>. A lost token can't retarget your links.
                  </>
                )}{" "}
                Replace it with <code className="font-mono text-fg">wrangler secret put API_TOKEN</code>.
              </span>
            </p>
          </div>
        </div>

        <div className="overflow-hidden rounded-xl border border-line">
          <table className="w-full text-left text-xs">
            {ENDPOINTS.map((g) => (
                <tbody key={g.group}>
                  <tr className="bg-bg">
                    <th colSpan={3} className="px-3 py-2 text-[11px] font-semibold tracking-wide text-muted uppercase">
                      {g.group}
                    </th>
                  </tr>
                  {g.rows.map(([method, path, what, full]) => (
                    <tr key={`${method} ${path}`} className="border-t border-line align-top">
                      <td className="w-16 px-3 py-2">
                        <Badge tone={METHOD_TONE[method]}>{method}</Badge>
                      </td>
                      <td className="px-3 py-2 font-mono text-[11px] break-all text-fg">
                        {path}
                        {full && tokenScope !== "full" ? (
                          <span className="ml-1.5 font-sans text-[10px] font-medium text-muted" title='The API token needs API_TOKEN_SCOPE = "full"'>
                            full
                          </span>
                        ) : null}
                      </td>
                      <td className="hidden px-3 py-2 text-muted sm:table-cell">{what}</td>
                    </tr>
                  ))}
                </tbody>
            ))}
          </table>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="font-medium text-fg">Create a link from a terminal</p>
            <Button variant="ghost" size="sm" onClick={() => void copy(example, "Command copied")}>
              <Copy /> Copy
            </Button>
          </div>
          <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-xs text-fg">{example}</pre>
        </div>
        <p className="text-muted">
          <strong className="text-fg">iOS Shortcut:</strong> Get Contents of URL → POST to <code className="text-fg">{base}/links?format=text</code> with the{" "}
          <code className="text-fg">Authorization</code> header and a JSON body <code className="text-fg">{"{ url: Shortcut Input }"}</code>, then Copy to Clipboard. Full steps are
          in docs/ios-shortcut.md.
        </p>
      </div>
    </Card>
  );
}
