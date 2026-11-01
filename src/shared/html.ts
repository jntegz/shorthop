/** Escapes text for HTML element content and quoted attribute values. Anything else is turned into text first. */
export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
