import { NextResponse } from "next/server";
import { fetchLiveBoard } from "@/lib/motive";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const { shuttles, fleet } = await fetchLiveBoard();
    return NextResponse.json({
      fetchedAt: new Date().toISOString(),
      shuttles,
      fleet,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "live fetch failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
