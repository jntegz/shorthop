// Verifies that every exported slug redirects to the same target on the new
// Worker. Exits non-zero on any mismatch.
//
//   npx tsx scripts/check-slugs.ts --base http://localhost:5173 \
//     [--data data/links.json] [--live [https://old.example]] [--probe] [--concurrency 8]
//   npx tsx scripts/check-slugs.ts --per-domain          # after the move
//
// --base        the Worker to check. Each row's domain is sent as X-Shorthop-Domain,
//               which localhost and workers.dev honor (production hosts ignore it).
// --per-domain  checks https://<row's domain>/<slug> instead of --base.
// --live        also asks the current production host (the old shortener before the move)
//               and compares its Location header and status code. Without a
//               value, each row's own domain is asked.
// --probe       tests how the live host treats case, trailing slashes and query
//               strings, so the Worker's behavior can be matched.
// Rows without a domain count as --default-domain.

import { mkdir, writeFile } from "node:fs/promises";
import { args, fail, pool, readExport, sameUrl } from "./lib";

// Recognized as a monitor by the bot detector, so checks never count as clicks.
const UA = "shorthop-check/1 (+https://github.com/jntegz/shorthop)";

const { flags, opts } = args();
const perDomain = flags.has("per-domain");
const base = perDomain ? null : (opts.get("base") ?? fail("Pass --base (e.g. http://localhost:5173) or --per-domain")).replace(/\/+$/, "");
const liveFixed = opts.get("live")?.replace(/\/+$/, "");
const liveOn = flags.has("live") || liveFixed !== undefined;
const concurrency = Number(opts.get("concurrency") ?? 8);
if (!Number.isInteger(concurrency) || concurrency < 1) fail("--concurrency must be a whole number of 1 or more.");
const rows = await readExport(opts.get("data") ?? "data/links.json");
const defaultDomain =
  opts.get("default-domain") ?? (rows.every((r) => r.domain) ? "" : fail("Some rows have no domain: pass --default-domain (your primary short domain)."));

interface Probe {
  status: number;
  location: string | null;
}

async function probe(url: string, headers: Record<string, string> = {}): Promise<Probe> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { redirect: "manual", headers: { "User-Agent": UA, ...headers } });
      await res.body?.cancel();
      return { status: res.status, location: res.headers.get("location") };
    } catch (err) {
      if (attempt >= 2) return { status: 0, location: `fetch failed: ${String(err)}` };
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
}

const path = (slug: string) => `/${encodeURIComponent(slug).replaceAll("%7E", "~")}`;

interface Result {
  domain: string;
  slug: string;
  expected: string;
  worker: Probe;
  live?: Probe;
  problems: string[];
}

const where = base ?? "each row's domain";
console.log(`Checking ${rows.length} slugs on ${where}${liveOn ? ` and ${liveFixed ?? "each row's live domain"}` : ""}…`);
let done = 0;
const results = await pool(rows, concurrency, async (r): Promise<Result> => {
  const domain = r.domain ?? defaultDomain;
  const worker = base ? await probe(`${base}${path(r.slug)}`, { "X-Shorthop-Domain": domain }) : await probe(`https://${domain}${path(r.slug)}`);
  const liveRes = liveOn ? await probe(`${liveFixed ?? `https://${domain}`}${path(r.slug)}`) : undefined;
  const problems: string[] = [];
  if (worker.status !== 302) problems.push(`worker status ${worker.status}`);
  if (!sameUrl(worker.location, r.target)) problems.push(`worker → ${worker.location ?? "(none)"}, export says ${r.target}`);
  if (liveRes) {
    if (liveRes.status < 300 || liveRes.status >= 400) problems.push(`live status ${liveRes.status}`);
    else if (!sameUrl(worker.location, liveRes.location)) problems.push(`live → ${liveRes.location ?? "(none)"}, worker → ${worker.location ?? "(none)"}`);
  }
  done++;
  if (done % 25 === 0 || done === rows.length) process.stdout.write(`\r${done}/${rows.length}`);
  return { domain, slug: r.slug, expected: r.target, worker, live: liveRes, problems };
});

const bad = results.filter((r) => r.problems.length);
const liveStatuses = new Map<number, number>();
for (const r of results) if (r.live) liveStatuses.set(r.live.status, (liveStatuses.get(r.live.status) ?? 0) + 1);

console.log(`\n\n${results.length - bad.length} match, ${bad.length} differ`);
if (liveStatuses.size) {
  console.log(`Live status codes: ${[...liveStatuses.entries()].map(([s, n]) => `${s}×${n}`).join(", ")}`);
  if (liveStatuses.has(301)) {
    console.log("ℹ The live host sends 301s. Browsers cache those, so some repeat visitors may skip the new Worker until their cache expires.");
  }
}
for (const r of bad.slice(0, 50)) console.log(`  ✖ ${r.domain}/${r.slug}: ${r.problems.join("; ")}`);
if (bad.length > 50) console.log(`  … and ${bad.length - 50} more`);

if (flags.has("probe") && liveOn) {
  console.log("\nProbing live behavior on a sample:");
  const sample = rows.slice(0, 5);
  for (const r of sample) {
    const live = liveFixed ?? `https://${r.domain ?? defaultDomain}`;
    const flipped = r.slug === r.slug.toLowerCase() ? r.slug.toUpperCase() : r.slug.toLowerCase();
    const [caseRes, slashRes, queryRes] = await Promise.all([
      probe(`${live}${path(flipped)}`),
      probe(`${live}${path(r.slug)}/`),
      probe(`${live}${path(r.slug)}?probe=1`),
    ]);
    console.log(`  ${r.domain ?? defaultDomain}/${r.slug}`);
    console.log(`    case-flipped /${flipped}: ${caseRes.status} ${caseRes.location ?? ""}`);
    console.log(`    trailing slash: ${slashRes.status} ${slashRes.location ?? ""}`);
    console.log(`    ?probe=1: ${queryRes.status} ${queryRes.location ?? ""}${queryRes.location?.includes("probe=1") ? "  ← passes query through" : ""}`);
  }
}

await mkdir("data", { recursive: true });
await writeFile("data/check-report.json", JSON.stringify(results, null, 2));
console.log("\nFull report: data/check-report.json");
process.exit(bad.length ? 1 : 0);
