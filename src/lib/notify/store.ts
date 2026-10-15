import { createHash } from "crypto";
import { getRedis } from "./redis";
import type { NotifySubscription } from "./types";

const SUBS_SET = "notify:subs";

export function subIdFromEndpoint(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex").slice(0, 32);
}

function subKey(id: string): string {
  return `notify:sub:${id}`;
}

function firedKey(id: string, stopKey: string, horizon: number): string {
  return `notify:fired:${id}:${stopKey}:${horizon}`;
}

export async function saveSubscription(
  sub: NotifySubscription,
): Promise<string> {
  const redis = getRedis();
  const id = subIdFromEndpoint(sub.endpoint);
  await redis.set(subKey(id), sub);
  await redis.sadd(SUBS_SET, id);
  return id;
}

export async function deleteSubscription(endpoint: string): Promise<boolean> {
  const redis = getRedis();
  const id = subIdFromEndpoint(endpoint);
  const removed = await redis.srem(SUBS_SET, id);
  await redis.del(subKey(id));
  return removed > 0;
}

export async function listSubscriptions(): Promise<
  { id: string; sub: NotifySubscription }[]
> {
  const redis = getRedis();
  const ids = (await redis.smembers(SUBS_SET)) as string[];
  if (!ids.length) return [];

  const out: { id: string; sub: NotifySubscription }[] = [];
  for (const id of ids) {
    const sub = (await redis.get(subKey(id))) as NotifySubscription | null;
    if (sub && sub.endpoint) {
      out.push({ id, sub });
    } else {
      await redis.srem(SUBS_SET, id);
    }
  }
  return out;
}

/** True if this horizon was already alerted for the current approach. */
export async function wasFired(
  id: string,
  stopKey: string,
  horizon: number,
): Promise<boolean> {
  const redis = getRedis();
  const v = await redis.get(firedKey(id, stopKey, horizon));
  return v != null;
}

/** Mark fired for ~45 minutes (one approach). */
export async function markFired(
  id: string,
  stopKey: string,
  horizon: number,
): Promise<void> {
  const redis = getRedis();
  await redis.set(firedKey(id, stopKey, horizon), "1", { ex: 45 * 60 });
}
