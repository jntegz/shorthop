// Exact click limits. One Durable Object per capped link holds its count;
// requests to an object run one at a time, so the last allowed click can't be
// handed out twice, however many arrive at once. Links without a limit never
// touch this.

import { DurableObject } from "cloudflare:workers";

export interface CapResult {
  ok: boolean;
  count: number;
}

export class ClickCap extends DurableObject<Env> {
  private read(): number {
    return this.ctx.storage.kv.get<number>("count") ?? 0;
  }

  /** `since` newer than the last one seen: the link came back through an import, and clicks counted before don't apply. */
  private startFrom(since: number): void {
    if (since <= (this.ctx.storage.kv.get<number>("since") ?? 0)) return;
    this.ctx.storage.kv.put("since", since);
    this.ctx.storage.kv.put("count", 0);
  }

  /** Counts one click if the limit allows it. */
  admit(limit: number, since = 0): CapResult {
    this.startFrom(since);
    const count = this.read();
    if (count >= limit) return { ok: false, count };
    this.ctx.storage.kv.put("count", count + 1);
    return { ok: true, count: count + 1 };
  }

  /** Whether a click would be allowed, without counting it (bots, previews). */
  peek(limit: number, since = 0): CapResult {
    this.startFrom(since);
    const count = this.read();
    return { ok: count < limit, count };
  }

  /** Gives one click back (the visitor it was counted for never got through). */
  release(): void {
    const count = this.read();
    if (count > 0) this.ctx.storage.kv.put("count", count - 1);
  }

  reset(): void {
    this.ctx.storage.kv.put("count", 0);
  }
}

/** Budget for the counter on the click path: past it, the visitor gets the "try again" page. */
const CAP_TIMEOUT_MS = 2000;

function stub(env: Env, domain: string, slug: string) {
  return env.CLICK_CAPS.get(env.CLICK_CAPS.idFromName(`${domain}/${slug}`));
}

/**
 * Admits (and counts) or peeks at one click. If the object doesn't answer in
 * time, the visitor is turned away; should the object still have counted that
 * click, it is given back in the background so the limit isn't spent on
 * someone who never got through.
 */
export async function capAdmit(env: Env, domain: string, slug: string, limit: number, countIt: boolean, ctx?: { waitUntil(p: Promise<unknown>): void }, since = 0): Promise<CapResult> {
  const s = stub(env, domain, slug);
  const work = countIt ? s.admit(limit, since) : s.peek(limit, since);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error("click counter timed out"));
        }, CAP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (timedOut && countIt) {
      const giveBack = work.then((r) => (r.ok ? s.release() : undefined)).catch(() => undefined);
      if (ctx) ctx.waitUntil(giveBack);
    }
  }
}

export async function capCount(env: Env, domain: string, slug: string, since = 0): Promise<number> {
  return (await stub(env, domain, slug).peek(Number.MAX_SAFE_INTEGER, since)).count;
}

export async function capReset(env: Env, domain: string, slug: string): Promise<void> {
  await stub(env, domain, slug).reset();
}
