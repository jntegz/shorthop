// Writes skills/shorthop/references/api.md from the API catalog (src/worker/openapi.ts),
// so the Agent Skills package lists the same endpoints the server documents.
// Run: npx tsx scripts/skill-reference.ts

import { writeFileSync } from "node:fs";
import { CATALOG } from "../src/worker/openapi";
import { RULES } from "../src/worker/permissions";

const groups = new Map<string, string[]>();
for (const [key, route] of Object.entries(CATALOG)) {
  const rule = RULES[key];
  const need = !rule ? "" : rule.need === "signed-in" ? "any key" : typeof rule.need === "string" ? rule.need : "any" in rule.need ? rule.need.any.join(" or ") : "all" in rule.need ? rule.need.all.join(" and ") : "";
  const line = `| \`${key.replace(/:([a-z]+)/gi, "{$1}")}\` | ${route.summary.replaceAll("|", "\\|")} | ${need} |`;
  groups.set(route.tag, [...(groups.get(route.tag) ?? []), line]);
}

const out = [
  "# Shorthop API reference",
  "",
  "Generated from the server's own catalog (`scripts/skill-reference.ts`). Base URL: `https://<admin host>/api`. Every request: `Authorization: Bearer shp_…`. The full OpenAPI document is at `GET /api/openapi.json`.",
  "",
  ...[...groups].flatMap(([tag, lines]) => [`## ${tag}`, "", "| Endpoint | What it does | Permission |", "|---|---|---|", ...lines, ""]),
].join("\n");

writeFileSync(new URL("../skills/shorthop/references/api.md", import.meta.url), out);
console.log(`Wrote ${Object.keys(CATALOG).length} endpoints`);
