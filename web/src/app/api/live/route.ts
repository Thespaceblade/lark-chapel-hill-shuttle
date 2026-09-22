import { NextResponse } from "next/server";
import { fetchLiveShuttle } from "@/lib/motive";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const [express, regular] = await Promise.all([
      fetchLiveShuttle("express"),
      fetchLiveShuttle("regular"),
    ]);
    return NextResponse.json({
      fetchedAt: new Date().toISOString(),
      shuttles: [express, regular],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "live fetch failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
