// Fills the LOCAL dev database with sample links and 120 days of fake rollup
// stats, so the admin UI has something to show. Never touches production.
//
//   npm run seed:dev   (then refresh http://localhost:5173/_admin/)

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { addDays, utcDate } from "../src/shared/dates";
import { linkKey, parseDomainList } from "../src/shared/domains";
import { fail, WRANGLER_BIN } from "./lib";
import { localConfig } from "./setup/template";

// The primary short domain: SHORT_DOMAINS from .dev.vars if set there, else from the config.
const devVars = existsSync(".dev.vars") ? readFileSync(".dev.vars", "utf8") : "";
const devDomains = /^SHORT_DOMAINS=(.*)$/m.exec(devVars)?.[1]?.trim().replace(/^"|"$/g, "");
const DOMAIN = parseDomainList(devDomains)[0] ?? localConfig().config.shortDomains[0] ?? fail("No short domain configured.");

const LINKS = [
  { slug: "guide", target: "https://example.com/guide", tags: "ebook,lead-magnet", title: "Getting started guide" },
  { slug: "pricing", target: "https://example.com/pricing", tags: "product", title: "Pricing page" },
  { slug: "newsletter", target: "https://example.com/newsletter", tags: "newsletter", title: "Newsletter signup" },
  { slug: "Talk26", target: "https://example.com/talks/2026", tags: "talks", title: "Conference talk slides" },
  { slug: "li-post", target: "https://www.linkedin.com/feed/", tags: "linkedin", title: null },
];

const COUNTRIES: [string, string, number][] = [
  ["US", "New York", 0.26],
  ["GB", "London", 0.12],
  ["DE", "Berlin", 0.1],
  ["IN", "Bengaluru", 0.1],
  ["BR", "São Paulo", 0.08],
  ["FR", "Paris", 0.08],
  ["CA", "Toronto", 0.07],
  ["AU", "Sydney", 0.05],
  ["JP", "Tokyo", 0.05],
  ["NL", "Amsterdam", 0.05],
];
const DEVICES: [string, number][] = [["mobile", 0.62], ["desktop", 0.33], ["tablet", 0.05]];
const SOURCES: [string, number][] = [["li", 0.48], ["nl", 0.22], ["direct", 0.14], ["qr", 0.06], ["google", 0.05], ["referral", 0.05]];
const OS: [string, number][] = [["iOS", 0.38], ["Android", 0.24], ["Windows", 0.2], ["macOS", 0.15], ["Linux", 0.03]];
const BROWSERS: [string, number][] = [["LinkedIn app", 0.3], ["Safari", 0.25], ["Chrome", 0.3], ["Edge", 0.08], ["Firefox", 0.07]];
const REFERRERS: [string, number][] = [["", 0.7], ["linkedin.com", 0.15], ["google.com", 0.05], ["example.com", 0.06], ["bing.com", 0.04]];
const LANGS: [string, number][] = [["en-us", 0.45], ["en-gb", 0.15], ["de-de", 0.1], ["fr-fr", 0.1], ["es-es", 0.1], ["pt-br", 0.1]];
const BOTS: [string, number][] = [["LinkedIn", 0.5], ["Email scanner", 0.2], ["Slack", 0.1], ["Facebook", 0.1], ["Google", 0.1]];

let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
const split = (n: number, weights: [string, number][]) => weights.map(([v, w]) => [v, Math.round(n * w * (0.7 + rand() * 0.6))] as const);
const q = (s: string | null) => (s === null ? "NULL" : `'${s.replaceAll("'", "''")}'`);

const today = utcDate();
const yesterday = addDays(today, -1);
const now = Math.floor(Date.now() / 1000);
const sql: string[] = ["DELETE FROM daily_stats;", "DELETE FROM daily_dims;"];
const DIMS = "INSERT INTO daily_dims (date, domain, slug, dim, value, clicks, uniques, bots) VALUES";
const kv: { key: string; value: string }[] = [];

LINKS.forEach((l, i) => {
  const created = now - (150 - i * 20) * 86400;
  sql.push(
    `INSERT INTO links (domain, slug, target, active, utm, tags, title, notes, source, created_at, updated_at) VALUES (${q(DOMAIN)}, ${q(l.slug)}, ${q(l.target)}, 1, 1, ${q(l.tags)}, ${q(l.title)}, '', 'native', ${created}, ${created}) ON CONFLICT (domain, slug) DO NOTHING;`,
  );
  kv.push({
    key: linkKey(DOMAIN, l.slug),
    value: JSON.stringify({ u: l.target, a: 1, e: null, utm: 1, qp: 0, t: "utm_source={domain}&utm_medium=shortlink&utm_campaign={slug}" }),
  });
});

for (let d = 120; d >= 1; d--) {
  const date = addDays(today, -d);
  LINKS.forEach((l, i) => {
    const base = [60, 25, 35, 12, 8][i]! * (1 + Math.sin(d / 9) * 0.4) * (d % 7 < 2 ? 0.55 : 1);
    const spike = d === 18 && i === 0 ? 9 : d === 46 && i === 2 ? 5 : 1;
    const clicks = Math.max(0, Math.round(base * spike * (0.6 + rand() * 0.8)));
    if (clicks === 0) return;
    const bots = Math.round(clicks * (0.15 + rand() * 0.2));
    const uniques = Math.round(clicks * (0.78 + rand() * 0.12));
    sql.push(`${DIMS} ('${date}', ${q(DOMAIN)}, ${q(l.slug)}, 'total', '', ${clicks}, ${uniques}, ${bots});`);
    for (const [country, n] of split(clicks, COUNTRIES.map(([c, , w]) => [c, w]))) {
      if (!n) continue;
      const [device] = DEVICES[Math.floor(rand() * DEVICES.length)]!;
      const [source] = SOURCES[Math.floor(rand() * 3)]!;
      sql.push(
        `INSERT OR REPLACE INTO daily_stats (date, domain, slug, country, device, source, clicks, uniques, bots) VALUES ('${date}', ${q(DOMAIN)}, ${q(l.slug)}, '${country}', '${device}', '${source}', ${n}, ${Math.round(n * 0.85)}, ${Math.round(n * 0.2)});`,
      );
    }
    const dims: [string, [string, number][]][] = [
      ["city", COUNTRIES.map(([c, city, w]) => [`${city}, ${c}`, w])],
      ["os", OS],
      ["browser", BROWSERS],
      ["referrer", REFERRERS],
      ["language", LANGS],
    ];
    for (const [dim, weights] of dims) {
      for (const [value, n] of split(clicks, weights)) if (n) sql.push(`${DIMS} ('${date}', ${q(DOMAIN)}, ${q(l.slug)}, '${dim}', ${q(value)}, ${n}, 0, 0);`);
    }
    for (const [value, n] of split(bots, BOTS)) if (n) sql.push(`${DIMS} ('${date}', ${q(DOMAIN)}, ${q(l.slug)}, 'bot', ${q(value)}, 0, 0, ${n});`);
  });
  if (d % 3 === 0) {
    sql.push(`${DIMS} ('${date}', ${q(DOMAIN)}, 'gudie', 'miss', '', ${1 + Math.floor(rand() * 3)}, 0, 0);`);
    sql.push(`${DIMS} ('${date}', ${q(DOMAIN)}, 'wp-login.php', 'miss', '', 0, 0, ${5 + Math.floor(rand() * 20)});`);
  }
}
sql.push(`INSERT INTO settings (key, value) VALUES ('last_rolled', '${yesterday}') ON CONFLICT (key) DO UPDATE SET value = excluded.value;`);
// Marks what was seeded, so Settings → Domains can remove it (and does once a real domain is added).
const demo = { domain: DOMAIN, links: LINKS.map((l) => l.slug), misses: ["gudie", "wp-login.php"] };
sql.push(`INSERT INTO settings (key, value) VALUES ('demo_data', ${q(JSON.stringify(demo))}) ON CONFLICT (key) DO UPDATE SET value = excluded.value;`);

await mkdir(".wrangler/seed", { recursive: true });
await writeFile(".wrangler/seed/seed.sql", sql.join("\n"));
await writeFile(".wrangler/seed/kv.json", JSON.stringify(kv));

const run = (cmd: string[]) => execFileSync(process.execPath, [WRANGLER_BIN, ...cmd], { stdio: "inherit" });
const config = ["--config", localConfig().file];
run(["d1", "execute", "DB", "--local", "--file", ".wrangler/seed/seed.sql", ...config]);
run(["kv", "bulk", "put", ".wrangler/seed/kv.json", "--binding", "LINKS", "--local", ...config]);
console.log(`\nSeeded ${LINKS.length} links and 120 days of fake stats into the local database.`);
console.log("Remove them in Settings → Domains; they also go on their own once a real domain is configured.");
