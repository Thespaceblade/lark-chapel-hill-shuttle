import webpush from "web-push";
import type { NotifySubscription } from "./types";

export function vapidConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim() &&
      process.env.VAPID_PRIVATE_KEY?.trim() &&
      process.env.VAPID_SUBJECT?.trim(),
  );
}

export function getVapidPublicKey(): string {
  const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim();
  if (!key) throw new Error("NEXT_PUBLIC_VAPID_PUBLIC_KEY is not set");
  return key;
}

function configureWebPush(): void {
  if (!vapidConfigured()) {
    throw new Error("VAPID keys are not configured");
  }
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT!.trim(),
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!.trim(),
    process.env.VAPID_PRIVATE_KEY!.trim(),
  );
}

export async function sendPush(
  sub: NotifySubscription,
  payload: { title: string; body: string; tag?: string; url?: string },
): Promise<"ok" | "gone" | "error"> {
  configureWebPush();
  try {
    await webpush.sendNotification(
      {
        endpoint: sub.endpoint,
        keys: sub.keys,
      },
      JSON.stringify({
        title: payload.title,
        body: payload.body,
        tag: payload.tag ?? "lark-shuttle",
        url: payload.url ?? "/",
      }),
      { TTL: 60 * 30 },
    );
    return "ok";
  } catch (err: unknown) {
    const status =
      err && typeof err === "object" && "statusCode" in err
        ? Number((err as { statusCode: number }).statusCode)
        : 0;
    if (status === 404 || status === 410) return "gone";
    console.error("web-push send failed", err);
    return "error";
  }
}
