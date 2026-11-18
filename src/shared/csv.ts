// CSV cells, for every export on the server and in the admin: quoted as needed,
// with anything a spreadsheet would run as a formula turned into text.

/** A plain number: left as it is, so spreadsheets can add it up, refunds included. */
const PLAIN_NUMBER = /^-?\d{1,15}(\.\d{1,6})?$/;
const FORMULA_START = /^[=+\-@\t\r\n]/;

export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (FORMULA_START.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function csv(rows: readonly (readonly unknown[])[], eol = "\r\n"): string {
  return rows.map((r) => r.map(csvCell).join(",")).join(eol) + eol;
}
