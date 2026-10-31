// Settings → API, MCP & webhooks. The page shell (Settings.tsx) imports these
// three sections; keep their names and props.
//   ApiKeysSection  (#api-keys)  → api-keys.tsx
//   ApiSection      (#api, #mcp) → here
//   WebhooksSection (#webhooks)  → webhooks.tsx

import { Bookmark, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { SETTINGS_HELP } from "../../lib/help";
import { copy } from "../../lib/utils";
import { Badge, IconButton, Section, Segmented, Table, TD, TH } from "../ui";
import { CodeBlock, Fact, Facts, HelpTip } from "./parts";

export { ApiKeysSection } from "./api-keys";
export { WebhooksSection } from "./webhooks";

/** The main endpoints, grouped. All take and return JSON unless noted. */
const ENDPOINTS: { group: string; rows: [method: string, path: string, what: string][] }[] = [
  { group: "Account", rows: [["GET", "/me", "Who the key acts as, and what it may do"]] },
  {
    group: "Links",
    rows: [
      ["GET", "/links", "List links (q, tag, status, domain, sort, period)"],
      ["POST", "/links", "Create a link (url, slug, title, tags, routing, preview, password, maxClicks…); ?format=text returns just the short URL"],
      ["GET", "/links/{domain}/{slug}", "One link"],
      ["PATCH", "/links/{domain}/{slug}", "Change any of its settings"],
      ["DELETE", "/links/{domain}/{slug}", "Delete (restorable for 90 days)"],
      ["GET", "/links/{domain}/{slug}/history", "Its saved versions"],
      ["POST", "/links/{domain}/{slug}/history/{id}/restore", "Restore a version"],
      ["GET", "/links/by-target?url=", "Links that already go to a destination"],
      ["POST", "/links/bulk", "Enable, disable, tag, untag or delete many links (up to 20 per request, 100 on Workers Paid)"],
      ["GET", "/tags", "Tags with how many links have each"],
      ["POST", "/tags/rename", "Rename a tag on every link (or merge it into another)"],
      ["DELETE", "/tags/{tag}", "Remove a tag from every link"],
      ["GET", "/deleted", "Recently deleted links"],
      ["POST", "/import", "Import up to 20 rows per request (100 on Workers Paid)"],
      ["GET", "/export/links.csv", "Links as CSV (q, tag, status, domain, or links=domain/slug,…)"],
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
      ["POST", "/checks/links/{domain}/{slug}", "Check one link's destinations now"],
      ["GET", "/utm-presets", "UTM presets"],
      ["GET", "/qr/default", "The default QR design"],
      ["GET", "/webhooks", "Webhooks and their status"],
      ["GET", "/webhooks/{id}/deliveries", "A webhook's delivery log, with each payload"],
    ],
  },
];

/**
 * What the older API_TOKEN secret can't do unless API_TOKEN_SCOPE is "full"
 * (src/worker/app.ts, TOKEN_WRITES): every change but creating and importing
 * links, and the delivery log. Personal keys only need their permission.
 */
function needsFullToken(method: string, path: string): boolean {
  if (method === "GET") return path === "/webhooks/{id}/deliveries";
  return !(method === "POST" && (path === "/links" || path === "/import"));
}

/**
 * The API: base URL, the endpoints, a curl example, AI assistants (MCP), the
 * bookmarklet and the iOS Shortcut. tokenSet and tokenScope: admins only (null for others).
 */
export function ApiSection({ origin, tokenSet, tokenScope }: { origin: string; tokenSet: boolean | null; tokenScope: "create" | "full" | null }) {
  const limited = Boolean(tokenSet) && tokenScope !== "full";
  const base = `${origin}/api`;
  const example = `curl -X POST "${base}/links?format=text" \\
  -H "Authorization: Bearer $SHORTHOP_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://example.com/new-post","slug":"new-post"}'`;
  return (
    <Section id="api" title="API" sub="What scripts and tools can do with an API key. Every request needs one in the Authorization header." aside={<HelpTip help={SETTINGS_HELP.api} />}>
      <Facts>
        <Fact label="Base URL">
          <span className="settings-a-inline">
            <code className="settings-a-mono">{base}</code>
            <IconButton size="sm" icon={Copy} label="Copy base URL" onClick={() => void copy(base, "Base URL copied")} />
          </span>
        </Fact>
        <Fact label="Authorization">
          <code className="settings-a-mono">Authorization: Bearer shp_…</code> with a key from API keys above. Each person creates their own, limited to what they may do.
        </Fact>
        {tokenSet !== null ? (
          <Fact label="Server token (older)">
            <p className="settings-a-fact-lead">{tokenSet ? <Badge tone="warn">{tokenScope === "full" ? "Set, full access" : "Set, read, create and import"}</Badge> : "Not set"}</p>
            <p className="settings-a-quiet">
              {tokenSet ? (
                <>
                  A key set as the Cloudflare secret <code className="settings-a-mono">API_TOKEN</code> from the terminal, from before personal keys. It isn't shown here.{" "}
                  {tokenScope === "full" ? (
                    <>
                      With <code className="settings-a-mono">API_TOKEN_SCOPE</code> set to <code className="settings-a-mono">"full"</code> it can do everything an owner can.
                    </>
                  ) : (
                    <>
                      It can read, create links and import new ones; the endpoints marked <em>full</em> below need <code className="settings-a-mono">API_TOKEN_SCOPE = "full"</code>.
                    </>
                  )}{" "}
                  If your iOS Shortcut or a script still uses it, switch it to a personal key, then delete the secret with <code className="settings-a-mono">wrangler secret delete API_TOKEN</code>.
                </>
              ) : (
                <>Not set, so only personal API keys work. That's the safer setup.</>
              )}
            </p>
          </Fact>
        ) : null}
      </Facts>

      <div className="settings-a-block">
        <h3 className="settings-a-h3">Main endpoints</h3>
        <p className="settings-a-prose">
          The main endpoints are below.{" "}
          <Link to="/api-docs" className="ui-text-button">
            Full API reference
          </Link>{" "}
          has every endpoint with its parameters, and an OpenAPI file for API tools.
        </p>
        <Table label="Main API endpoints" dense className="settings-a-endpoints">
          <thead>
            <tr>
              <TH className="settings-a-method-col">Method</TH>
              <TH>Path and what it does</TH>
            </tr>
          </thead>
          {ENDPOINTS.map((g) => (
            <tbody key={g.group}>
              <tr className="settings-a-group-row">
                <th scope="colgroup" colSpan={2}>
                  {g.group}
                </th>
              </tr>
              {g.rows.map(([method, path, what]) => (
                <tr key={`${method} ${path}`}>
                  <TD>
                    <span className="settings-a-method" data-method={method}>
                      {method}
                    </span>
                  </TD>
                  <TD>
                    <div className="settings-a-endpoint">
                      <span className="settings-a-path">
                        <code className="settings-a-mono">{path}</code>
                        {limited && needsFullToken(method, path) ? (
                          <span className="settings-a-full" title='The older API_TOKEN secret needs API_TOKEN_SCOPE = "full"; personal keys only need their permission'>
                            full
                          </span>
                        ) : null}
                      </span>
                      <span className="settings-a-what">{what}</span>
                    </div>
                  </TD>
                </tr>
              ))}
            </tbody>
          ))}
        </Table>
      </div>

      <div className="settings-a-block">
        <CodeBlock title={<span className="settings-a-strong">Create a link from a terminal</span>} code={example} copied="Command copied" />
      </div>
      <AiAssistants base={base} />
      <Bookmarklet origin={origin} />
      <div className="settings-a-block">
        <h3 className="settings-a-h3">iOS Shortcut</h3>
        <p className="settings-a-prose">
          Get Contents of URL → POST to <code className="settings-a-mono">{base}/links?format=text</code> with the <code className="settings-a-mono">Authorization</code> header (a key that can create links) and a JSON body{" "}
          <code className="settings-a-mono">{"{ url: Shortcut Input }"}</code>, then Copy to Clipboard. Full steps are in docs/ios-shortcut.md.
        </p>
      </div>
    </Section>
  );
}

/**
 * "Shorten this page": drag it to the bookmarks bar; clicking it opens the
 * admin's create form with the page's address and title. It only opens the
 * admin, so it needs no key and works with your usual sign-in.
 */
function Bookmarklet({ origin }: { origin: string }) {
  const ref = useRef<HTMLAnchorElement>(null);
  const code = `javascript:(()=>{window.open('${origin}/_admin/links?new=1&url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title),'_blank')})()`;
  // React refuses javascript: in href, so the bookmarklet's address is set directly.
  useEffect(() => {
    ref.current?.setAttribute("href", code);
  }, [code]);
  return (
    <div className="settings-a-block">
      <h3 className="settings-a-h3">Bookmarklet</h3>
      <div className="settings-a-bookmarklet">
        <a ref={ref} className="ui-button" data-variant="primary" data-size="sm" onClick={(e) => e.preventDefault()} title="Drag this to your bookmarks bar">
          <Bookmark aria-hidden /> Shorten this page
        </a>
        <p className="settings-a-prose">
          Drag the button to your bookmarks bar. On any page, click it to open a new link already filled in. On a phone, install the admin (Add to Home Screen) and use Share → Shorthop.
        </p>
      </div>
    </div>
  );
}

type Client = "claude" | "cursor" | "vscode";

/** Copy-ready settings for AI assistants that speak MCP, using a personal API key. */
function AiAssistants({ base }: { base: string }) {
  const [client, setClient] = useState<Client>("claude");
  const url = `${base}/mcp`;
  const config: Record<Client, { label: string; where: string; text: string }> = {
    claude: {
      label: "Claude Code",
      where: "Run in a terminal, with the key in SHORTHOP_KEY:",
      text: `claude mcp add --transport http shorthop ${url} --header "Authorization: Bearer $SHORTHOP_KEY"`,
    },
    cursor: {
      label: "Cursor",
      where: "Add to .cursor/mcp.json (or ~/.cursor/mcp.json), with the key in SHORTHOP_KEY:",
      text: JSON.stringify({ mcpServers: { shorthop: { url, headers: { Authorization: "Bearer ${env:SHORTHOP_KEY}" } } } }, null, 2),
    },
    vscode: {
      label: "VS Code",
      where: "Add to .vscode/mcp.json; VS Code asks for the key once and keeps it secret:",
      text: JSON.stringify(
        {
          inputs: [{ type: "promptString", id: "shorthop-key", description: "Shorthop API key", password: true }],
          servers: { shorthop: { type: "http", url, headers: { Authorization: "Bearer ${input:shorthop-key}" } } },
        },
        null,
        2,
      ),
    },
  };
  const c = config[client];
  return (
    <div id="mcp" className="settings-a-block settings-a-anchor">
      <div className="settings-a-block-head">
        <h3 className="settings-a-h3">Connect an AI assistant (MCP)</h3>
        <Segmented<Client> label="Assistant" size="sm" value={client} onChange={setClient} options={(Object.keys(config) as Client[]).map((k) => ({ value: k, label: config[k].label }))} />
      </div>
      <p className="settings-a-prose">
        Assistants can create links and read statistics and revenue with an API key. Give the key only what the assistant should do: a key with Statistics only can't change links.
      </p>
      <CodeBlock title={c.where} code={c.text} copied="Copied" />
    </div>
  );
}
