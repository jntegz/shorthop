// Terminal prompts for the setup wizard (Node built-ins only).

import { createInterface } from "node:readline/promises";
import { fail, promptHidden } from "../lib";

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
export const color = {
  bold,
  dim,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

export function requireTty(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail("Run the setup in an interactive terminal.");
}

export function heading(step: string): void {
  console.log(`\n${bold(color.cyan(`── ${step} `))}${color.cyan("─".repeat(Math.max(2, 60 - step.length)))}`);
}

export const info = (s: string) => console.log(s);
export const ok = (s: string) => console.log(`${color.green("✔")} ${s}`);
export const warn = (s: string) => console.log(`${color.yellow("!")} ${s}`);
export const bad = (s: string) => console.log(`${color.red("✖")} ${s}`);

async function line(question: string): Promise<string> {
  // One interface per question, so the hidden prompt can take raw mode in between.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** Asks until `check` returns null. An empty answer takes the default; with `allowEmpty`, "-" clears it. */
export async function ask(question: string, opts: { default?: string; check?: (v: string) => string | null; allowEmpty?: boolean } = {}): Promise<string> {
  for (;;) {
    const suffix = opts.default ? dim(` [${opts.default}]`) : "";
    const typed = (await line(`${question}${suffix}: `)).trim();
    if (opts.allowEmpty && typed === "-") return "";
    const answer = typed || opts.default || "";
    if (!answer && !opts.allowEmpty) {
      console.log(color.yellow("  An answer is needed."));
      continue;
    }
    const problem = answer && opts.check ? opts.check(answer) : null;
    if (!problem) return answer;
    console.log(color.yellow(`  ${problem}`));
  }
}

export async function confirm(question: string, def = true): Promise<boolean> {
  for (;;) {
    const a = (await line(`${question} ${dim(def ? "[Y/n]" : "[y/N]")} `)).trim().toLowerCase();
    if (!a) return def;
    if (a === "y" || a === "yes") return true;
    if (a === "n" || a === "no") return false;
  }
}

export interface Choice<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

export async function choose<T extends string>(question: string, choices: Choice<T>[], def?: T): Promise<T> {
  console.log(question);
  choices.forEach((c, i) => console.log(`  ${bold(String(i + 1))}. ${c.label}${c.hint ? dim(`  ${c.hint}`) : ""}`));
  const defIndex = def ? choices.findIndex((c) => c.value === def) + 1 : 0;
  for (;;) {
    const a = (await line(`Choose 1-${choices.length}${defIndex ? dim(` [${defIndex}]`) : ""}: `)).trim();
    const n = a ? Number(a) : defIndex;
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1]!.value;
  }
}

/** Hidden input; asks until `check` returns null. */
export async function secret(question: string, check?: (v: string) => string | null): Promise<string> {
  for (;;) {
    const v = (await promptHidden(`${question}: `)).trim();
    const problem = check ? check(v) : v ? null : "An answer is needed.";
    if (!problem) return v;
    console.log(color.yellow(`  ${problem}`));
  }
}
