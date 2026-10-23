import { zValidator } from "@hono/zod-validator";
import type { ValidationTargets } from "hono";
import type { ZodType } from "zod";
import type { Actor } from "../shared/permissions";

export type AppEnv = {
  Bindings: Env;
  /** actor: who is asking and what they may do. identity: how history records them. */
  Variables: { actor: Actor; identity: string; sessionExp?: number };
};

/** zValidator with a consistent `{ error, details }` 400 response. */
export function validate<T extends ZodType, Target extends keyof ValidationTargets>(target: Target, schema: T) {
  return zValidator(target, schema, (result, c) => {
    if (!result.success) {
      const issues = result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
      const first = issues[0];
      return c.json({ error: first ? `${first.path ? `${first.path}: ` : ""}${first.message}` : "Invalid request", details: issues }, 400);
    }
  });
}

/** CSV cell escaping, including spreadsheet formula injection. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function csv(rows: unknown[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
