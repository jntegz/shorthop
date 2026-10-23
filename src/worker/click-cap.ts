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

  /** Counts one click if the limit allows it. */
  admit(limit: number): CapResult {
    const count = this.read();
    if (count >= limit) return { ok: false, count };
    this.ctx.storage.kv.put("count", count + 1);
    return { ok: true, count: count + 1 };
  }

  /** Whether a click would be allowed, without counting it (bots, previews). */
  peek(limit: number): CapResult {
    const count = this.read();
    return { ok: count < limit, count };
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

export async function capAdmit(env: Env, domain: string, slug: string, limit: number, countIt: boolean): Promise<CapResult> {
  const s = stub(env, domain, slug);
  const work = countIt ? s.admit(limit) : s.peek(limit);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("click counter timed out")), CAP_TIMEOUT_MS)))]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function capCount(env: Env, domain: string, slug: string): Promise<number> {
  return (await stub(env, domain, slug).peek(Number.MAX_SAFE_INTEGER)).count;
}

export async function capReset(env: Env, domain: string, slug: string): Promise<void> {
  await stub(env, domain, slug).reset();
}
