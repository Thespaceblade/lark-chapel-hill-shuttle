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

/** Server-only Motive share key — set MOTIVE_WEB_SHARE_API_KEY in env. */
export function getMotiveApiKey(): string {
  const key = process.env.MOTIVE_WEB_SHARE_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "Missing MOTIVE_WEB_SHARE_API_KEY. Add it in Vercel → Project → Settings → Environment Variables (or web/.env.local).",
    );
  }
  return key;
}
