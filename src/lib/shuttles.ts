export type ShuttleKey = "express" | "regular";

export type Stop = {
  key: string;
  name: string;
  lat: number;
  lon: number;
};

export type LiveShuttle = {
  key: ShuttleKey;
  name: string;
  vehicleNumber: string | null;
  state: string | null;
  speed: string | null;
  address: string | null;
  lat: number | null;
  lon: number | null;
  bearing: number | null;
  compass: string | null;
  locatedAt: string | null;
  mapsUrl: string | null;
  nextStop: {
    key: string;
    name: string;
    alongM: number;
    etaMin: number | null;
  } | null;
  loopFrac: number | null;
  offLoopM: number | null;
};

export const SHUTTLES: Record<
  ShuttleKey,
  { key: ShuttleKey; name: string; uuid: string; color: string; bullet: string }
> = {
  express: {
    key: "express",
    name: "Express",
    uuid: "0c5a01f2-a549-11f1-83ea-4247aa532d4a",
    color: "#0039a6",
    bullet: "E",
  },
  regular: {
    key: "regular",
    name: "Regular",
    uuid: "2485bb70-a546-11f1-a663-320d2d4970d9",
    color: "#ff6319",
    bullet: "R",
  },
};

export const MOTIVE = {
  endpoint: "https://api.keeptruckin.com/api/s1/live_shares",
  userAgent: "lark-shuttle-web/0.1 (+vercel)",
};

/**
 * Public Motive web-share key (same value embedded in tracking.gomotive.com JS /
 * lark_shuttle.py FALLBACK). Env MOTIVE_WEB_SHARE_API_KEY overrides when set.
 */
export const MOTIVE_PUBLIC_WEB_SHARE_API_KEY =
  "3gCAa2VxLV3nlJfk7EhzJUEe5lg3IU9b50sNyOfUSSE6Fg2ACZr6GK5KqpMW55rn";

/** Strip paste mistakes (quotes/whitespace) from env values. */
export function normalizeMotiveApiKey(raw?: string | null): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const unquoted = trimmed.replace(/^["']|["']$/g, "").trim();
  return unquoted || undefined;
}

/** Server-only Motive share key — env override, else public share key. */
export function getMotiveApiKey(): string {
  return (
    normalizeMotiveApiKey(process.env.MOTIVE_WEB_SHARE_API_KEY) ??
    MOTIVE_PUBLIC_WEB_SHARE_API_KEY
  );
}
