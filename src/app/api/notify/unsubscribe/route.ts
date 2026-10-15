import { NextResponse } from "next/server";
import { redisConfigured } from "@/lib/notify/redis";
import { deleteSubscription } from "@/lib/notify/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!redisConfigured()) {
    return NextResponse.json(
      { error: "Notifications are not configured" },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const endpoint =
    typeof (body as { endpoint?: string }).endpoint === "string"
      ? (body as { endpoint: string }).endpoint
      : "";
  if (!endpoint) {
    return NextResponse.json({ error: "Missing endpoint" }, { status: 400 });
  }

  await deleteSubscription(endpoint);
  return NextResponse.json({ ok: true });
}
