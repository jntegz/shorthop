// A tiny evaluator for the Analytics Engine SQL this project sends, run over
// data points captured from real redirects. Good enough to test aggregation.

import { vi } from "vitest";

export interface StoredPoint {
  ts: number;
  index1: string;
  blobs: string[];
  doubles: number[];
}

export function aePoint(p: AnalyticsEngineDataPoint, ts: number): StoredPoint {
  return {
    ts,
    index1: String(p.indexes?.[0] ?? ""),
    blobs: (p.blobs ?? []).map((b) => String(b ?? "")),
    doubles: p.doubles ?? [],
  };
}

function col(p: StoredPoint, name: string): string | number {
  const m = /^blob(\d+)$/.exec(name);
  if (m) return p.blobs[Number(m[1]) - 1] ?? "";
  const d = /^double(\d+)$/.exec(name);
  if (d) return p.doubles[Number(d[1]) - 1] ?? 0;
  if (name === "index1") return p.index1;
  if (name === "toUnixTimestamp(toStartOfDay(timestamp))") return Math.floor(p.ts / 86400) * 86400;
  if (name === "toUnixTimestamp(timestamp)") return p.ts;
  throw new Error(`mock AE: unknown expression ${name}`);
}

function cond(p: StoredPoint, expr: string): boolean {
  const list = /^(\w+) IN \((.*)\)$/.exec(expr.trim());
  if (list) return list[2]!.split(",").map((v) => v.trim().replace(/^'|'$/g, "")).includes(String(col(p, list[1]!)));
  const m = /^(\w+)\s*(=|!=)\s*'?([^']*)'?$/.exec(expr.trim());
  if (!m) throw new Error(`mock AE: unknown condition ${expr}`);
  const [, name = "", op, raw = ""] = m;
  const v = col(p, name);
  const target = typeof v === "number" ? Number(raw) : raw;
  return op === "=" ? v === target : v !== target;
}

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Splits on top-level " AND " (not inside parentheses). */
function splitAnd(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
    else if (depth === 0 && s.startsWith(" AND ", i)) {
      out.push(s.slice(start, i));
      start = i + 5;
    }
  }
  out.push(s.slice(start));
  return out;
}

function matches(p: StoredPoint, where: string): boolean {
  return splitAnd(where).every((c) => {
    const not = /^NOT \((.*)\)$/.exec(c.trim());
    if (not) return !matches(p, not[1]!);
    const t = /timestamp (>=|<) toDateTime\((\d+)\)/.exec(c);
    if (t) return t[1] === ">=" ? p.ts >= Number(t[2]) : p.ts < Number(t[2]);
    return cond(p, c);
  });
}

function runSql(points: StoredPoint[], sql: string): Record<string, unknown>[] {
  const s = sql.replace(/\s+/g, " ");
  const select = /^SELECT (.*?) FROM \w+/.exec(s)?.[1] ?? "";
  const where = /WHERE (.*?)( GROUP BY| ORDER BY| LIMIT| FORMAT)/.exec(s)?.[1] ?? "";
  const groupBy = /GROUP BY (.*?)( ORDER BY| LIMIT| FORMAT)/.exec(s)?.[1];
  const limit = Number(/LIMIT (\d+)/.exec(s)?.[1] ?? 1e9);

  const filtered = points.filter((p) => matches(p, where));

  const items = splitTop(select).map((item) => {
    const m = /^(.*) AS (\w+)$/.exec(item);
    if (!m) throw new Error(`mock AE: select item without alias: ${item}`);
    return { expr: m[1]!.trim(), alias: m[2]! };
  });
  // Like the real SQL API, which rejects ORDER BY on a column it didn't select.
  const orderBy = /ORDER BY (\w+)/.exec(s)?.[1];
  if (orderBy && !items.some((i) => i.alias === orderBy)) throw new Error(`mock AE: ORDER BY ${orderBy} is not a select alias`);

  if (!groupBy) {
    const sorted = [...filtered].sort((a, b) => b.ts - a.ts).slice(0, limit);
    return sorted.map((p) => Object.fromEntries(items.map((i) => [i.alias, col(p, i.expr)])));
  }

  const keys = groupBy.split(",").map((k) => k.trim());
  const groups = new Map<string, { row: Record<string, unknown>; members: StoredPoint[] }>();
  for (const p of filtered) {
    const row: Record<string, unknown> = {};
    for (const k of keys) {
      const item = items.find((i) => i.alias === k);
      if (!item) throw new Error(`mock AE: GROUP BY ${k} is not a select alias`);
      row[k] = col(p, item.expr);
    }
    const key = JSON.stringify(row);
    const g = groups.get(key) ?? { row, members: [] };
    g.members.push(p);
    groups.set(key, g);
  }

  const out = [...groups.values()].map(({ row, members }) => {
    const r = { ...row };
    for (const { expr, alias } of items) {
      if (keys.includes(alias)) continue;
      const sumIf = /^sumIf\(_sample_interval, (.*)\)$/.exec(expr);
      const distinct = /^count\(DISTINCT (\w+)\)$/.exec(expr);
      if (sumIf) r[alias] = String(members.filter((p) => cond(p, sumIf[1]!)).length);
      else if (distinct) r[alias] = String(new Set(members.map((p) => col(p, distinct[1]!))).size);
      else throw new Error(`mock AE: unknown aggregate ${expr}`);
    }
    return r;
  });
  return out.slice(0, limit);
}

/** Routes Analytics Engine SQL API calls to runSql; everything else passes through. */
export function mockAeSql(points: StoredPoint[]) {
  const real = globalThis.fetch;
  const queries: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (/\/analytics_engine\/sql$/.test(url)) {
      const sql = typeof init?.body === "string" ? init.body : await (input as Request).text();
      queries.push(sql);
      return Response.json({ data: runSql(points, sql), rows: 0 });
    }
    return real(input, init);
  });
  return queries;
}
