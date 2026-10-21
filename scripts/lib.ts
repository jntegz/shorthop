// Small helpers shared by the scripts (Node 22+).

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * One link in an export file: a JSON array of these, read by import.ts and
 * check-slugs.ts. Convert your old shortener's export to this shape (the admin's
 * Import page takes CSV files directly).
 */
export interface ExportRow {
  /** The short domain; rows without one count as the default domain. */
  domain?: string;
  slug: string;
  target: string;
  title?: string | null;
  /** Lifetime clicks on the old shortener. */
  clicks?: number | null;
  /** Unix seconds. */
  createdAt?: number | null;
}

/** Flags that never take a value, so `--dry-run domains` can't read "domains" as its value. */
const BOOLEAN_FLAGS = new Set(["dry-run", "rotate", "salt", "overwrite", "per-domain", "probe", "generate"]);

export function args(argv = process.argv.slice(2)): { flags: Set<string>; opts: Map<string, string> } {
  const flags = new Set<string>();
  const opts = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const [key, inline] = a.slice(2).split("=", 2) as [string, string | undefined];
    const next = argv[i + 1];
    if (inline !== undefined) opts.set(key, inline);
    else if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith("--")) {
      opts.set(key, next);
      i++;
    } else flags.add(key);
  }
  return { flags, opts };
}

/** Wrangler's CLI, run with this Node binary: works on Windows without a shell, and from any directory. */
export const WRANGLER_BIN = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));

export function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

/** Reads a line from the terminal without echoing it. */
export function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const done = (err?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return done();
        if (ch === "\u0003") return done(new Error("Cancelled"));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/** Everything piped into stdin, without the trailing newline. */
export async function readStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) data += String(chunk);
  return data.replace(/\r?\n$/, "");
}

export async function readExport(path: string): Promise<ExportRow[]> {
  const text = await readFile(path, "utf8").catch(() => fail(`Can't read ${path}. Pass --data with a JSON export (see ExportRow in scripts/lib.ts).`));
  const data = JSON.parse(text) as unknown;
  if (!Array.isArray(data)) fail(`${path} must contain a JSON array`);
  return data as ExportRow[];
}

/** Same URL for a browser: compares normalized hrefs. */
export function sameUrl(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a === b;
  }
}

/** Runs `fn` over items with a fixed number of workers. */
export async function pool<T, R>(items: T[], concurrency: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}
