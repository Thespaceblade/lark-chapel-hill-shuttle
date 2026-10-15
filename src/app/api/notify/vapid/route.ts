import { NextResponse } from "next/server";
import { getVapidPublicKey, vapidConfigured } from "@/lib/notify/push";
import { redisConfigured } from "@/lib/notify/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!vapidConfigured() || !redisConfigured()) {
    return NextResponse.json(
      {
        error: "Notifications are not configured on this deployment",
        configured: false,
      },
      { status: 503 },
    );
  }
  return NextResponse.json({
    configured: true,
    publicKey: getVapidPublicKey(),
  });
}
