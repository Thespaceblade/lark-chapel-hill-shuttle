import { NextResponse } from "next/server";
import { fetchLiveBoard } from "@/lib/motive";
import type { FleetVehicle, LiveShuttle } from "@/lib/shuttles";

export const runtime = "nodejs";
/** Allow CDN / ISR-style reuse of this GET for a few seconds. */
export const revalidate = 5;

const CACHE_TTL_MS = 5_000;

type LivePayload = {
  fetchedAt: string;
  shuttles: LiveShuttle[];
  fleet: FleetVehicle[];
};

type CacheEntry = {
  expiresAt: number;
  body: LivePayload;
};

/** Warm Fluid instances reuse one Motive fetch across 1s client polls. */
let memoryCache: CacheEntry | null = null;

const cacheHeaders = {
  "Cache-Control": "public, s-maxage=5, stale-while-revalidate=15",
};

export async function GET() {
  try {
    const now = Date.now();
    if (memoryCache && memoryCache.expiresAt > now) {
      return NextResponse.json(memoryCache.body, { headers: cacheHeaders });
    }

    const { shuttles, fleet } = await fetchLiveBoard();
    const body: LivePayload = {
      fetchedAt: new Date().toISOString(),
      shuttles,
      fleet,
    };
    memoryCache = { expiresAt: now + CACHE_TTL_MS, body };
    return NextResponse.json(body, { headers: cacheHeaders });
  } catch (err) {
    const message = err instanceof Error ? err.message : "live fetch failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
