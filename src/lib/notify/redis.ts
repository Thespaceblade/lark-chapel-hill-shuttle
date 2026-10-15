import { Redis } from "@upstash/redis";

let cached: Redis | null = null;

export function redisConfigured(): boolean {
  return Boolean(
    process.env.UPSTASH_REDIS_REST_URL?.trim() &&
      process.env.UPSTASH_REDIS_REST_TOKEN?.trim(),
  );
}

export function getRedis(): Redis {
  if (!redisConfigured()) {
    throw new Error("Upstash Redis is not configured");
  }
  if (!cached) {
    cached = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    });
  }
  return cached;
}
