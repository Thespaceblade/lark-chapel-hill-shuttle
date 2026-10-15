import { NextResponse } from "next/server";
import { fetchLiveBoard } from "@/lib/motive";
import { redisConfigured } from "@/lib/notify/redis";
import { sendPush, vapidConfigured } from "@/lib/notify/push";
import {
  deleteSubscription,
  listSubscriptions,
  markFired,
  wasFired,
} from "@/lib/notify/store";
import type { LiveShuttle, ShuttleKey } from "@/lib/shuttles";
import { SHUTTLES } from "@/lib/shuttles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorize(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const auth = req.headers.get("authorization") || "";
  if (auth === `Bearer ${secret}`) return true;
  const url = new URL(req.url);
  if (url.searchParams.get("secret") === secret) return true;
  return false;
}

function lineMatches(
  subLine: "both" | ShuttleKey,
  shuttleKey: ShuttleKey,
): boolean {
  return subLine === "both" || subLine === shuttleKey;
}

function stopEta(
  shuttle: LiveShuttle,
  stopKey: string,
): { name: string; notifyEtaMin: number } | null {
  const hits = [
    ...(shuttle.upcomingStops || []),
    ...(shuttle.nextStop ? [shuttle.nextStop] : []),
  ];
  for (const s of hits) {
    if (s.key !== stopKey) continue;
    if (s.notifyEtaMin == null || !Number.isFinite(s.notifyEtaMin)) continue;
    return { name: s.name, notifyEtaMin: s.notifyEtaMin };
  }
  return null;
}

async function runTick() {
  if (!vapidConfigured() || !redisConfigured()) {
    return {
      ok: false,
      error: "Notifications are not configured",
      sent: 0,
      skipped: 0,
      gone: 0,
    };
  }

  const { shuttles } = await fetchLiveBoard();
  const byKey = new Map(shuttles.map((s) => [s.key, s]));
  const subs = await listSubscriptions();

  let sent = 0;
  let skipped = 0;
  let gone = 0;

  for (const { id, sub } of subs) {
    const horizons = [...sub.horizons].sort((a, b) => a - b);
    const lines: ShuttleKey[] =
      sub.line === "both" ? ["express", "regular"] : [sub.line];

    let best: {
      shuttle: LiveShuttle;
      eta: number;
      stopName: string;
    } | null = null;

    for (const line of lines) {
      const shuttle = byKey.get(line);
      if (!shuttle || shuttle.serviceStatus !== "active") continue;
      const hit = stopEta(shuttle, sub.stopKey);
      if (!hit) continue;
      if (!best || hit.notifyEtaMin < best.eta) {
        best = {
          shuttle,
          eta: hit.notifyEtaMin,
          stopName: hit.name || sub.stopName,
        };
      }
    }

    if (!best) {
      skipped += 1;
      continue;
    }

    for (const horizon of horizons) {
      if (best.eta > horizon) continue;
      if (await wasFired(id, sub.stopKey, horizon)) {
        skipped += 1;
        continue;
      }

      const lineLabel =
        sub.line === "both"
          ? SHUTTLES[best.shuttle.key].name
          : SHUTTLES[sub.line].name;
      const mins = Math.max(0, Math.round(best.eta));
      const body = `${lineLabel} · ${best.stopName} in ${mins} min`;
      const result = await sendPush(sub, {
        title: "LARK",
        body,
        tag: `lark-${sub.stopKey}-${horizon}`,
        url: "/",
      });

      if (result === "ok") {
        await markFired(id, sub.stopKey, horizon);
        sent += 1;
      } else if (result === "gone") {
        await deleteSubscription(sub.endpoint);
        gone += 1;
        break;
      } else {
        skipped += 1;
      }
    }
  }

  return { ok: true, sent, skipped, gone, subs: subs.length };
}

export async function GET(req: Request) {
  if (!authorize(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await runTick();
    const status = result.ok ? 200 : 503;
    return NextResponse.json(result, { status });
  } catch (err) {
    const message = err instanceof Error ? err.message : "tick failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  return GET(req);
}
