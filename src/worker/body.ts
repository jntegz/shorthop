// Request bodies read with a size cap. Content-Length can be missing (a chunked
// body), so the stream itself is counted and abandoned past the limit.

/** The body's bytes, or null when it's larger than `max`. */
export async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  if (Number(req.headers.get("Content-Length") ?? 0) > max) return null;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** The body as UTF-8 text, or null when it's larger than `max` bytes. */
export async function readTextCapped(req: Request, max: number): Promise<string | null> {
  const bytes = await readCapped(req, max);
  return bytes && new TextDecoder().decode(bytes);
}
