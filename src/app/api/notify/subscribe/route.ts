import { NextResponse } from "next/server";
import { redisConfigured } from "@/lib/notify/redis";
import { vapidConfigured } from "@/lib/notify/push";
import { saveSubscription } from "@/lib/notify/store";
import type { NotifyLine, NotifySubscription } from "@/lib/notify/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_HORIZONS = new Set([2, 5, 10]);

function parseLine(v: unknown): NotifyLine | null {
  if (v === "both" || v === "express" || v === "regular") return v;
  return null;
}

export async function POST(req: Request) {
  if (!vapidConfigured() || !redisConfigured()) {
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

  const b = body as Record<string, unknown>;
  const endpoint = typeof b.endpoint === "string" ? b.endpoint : "";
  const keys = b.keys as { p256dh?: string; auth?: string } | undefined;
  const line = parseLine(b.line);
  const stopKey = typeof b.stopKey === "string" ? b.stopKey : "";
  const stopName =
    typeof b.stopName === "string" && b.stopName.trim()
      ? b.stopName.trim()
      : stopKey;
  const horizonsRaw = Array.isArray(b.horizons) ? b.horizons : [5, 2];
  const horizons = [
    ...new Set(
      horizonsRaw
        .map((h) => Number(h))
        .filter((h) => ALLOWED_HORIZONS.has(h))
        .sort((a, b) => b - a),
    ),
  ];

  if (
    !endpoint ||
    !keys?.p256dh ||
    !keys?.auth ||
    !line ||
    !stopKey ||
    !horizons.length
  ) {
    return NextResponse.json({ error: "Missing subscription fields" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const sub: NotifySubscription = {
    endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
    line,
    stopKey,
    stopName,
    horizons,
    createdAt: now,
    updatedAt: now,
  };

  const id = await saveSubscription(sub);
  return NextResponse.json({ ok: true, id });
}
