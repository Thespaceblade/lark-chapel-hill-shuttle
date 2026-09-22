import {
  MOTIVE,
  MOTIVE_PUBLIC_WEB_SHARE_API_KEY,
  SHUTTLES,
  getMotiveApiKey,
  normalizeMotiveApiKey,
  type LiveShuttle,
  type ShuttleKey,
} from "./shuttles";
import { RouteLoop, etaMinutes, parseSpeedMph } from "./loop";
import type { Stop } from "./shuttles";
import routesData from "../../data/intended_routes.json";

type MotivePayload = {
  live_share?: {
    expire_at?: string;
    vehicle?: {
      number?: string;
      vehicle_location?: {
        lat?: number;
        lon?: number;
        formatted_address?: string;
        located_at?: string;
        bearing?: number;
        compass?: string;
        speed?: string | number;
        entity_state?: string;
      };
    };
  };
};

function getLoop(key: ShuttleKey): RouteLoop {
  const route = routesData[key] as {
    line: [number, number][];
    stops: Stop[];
  };
  return new RouteLoop(key, route.line, route.stops, true);
}

async function requestLiveShare(uuid: string, apiKey: string): Promise<Response> {
  const url = `${MOTIVE.endpoint}?type=v&uuid=${encodeURIComponent(uuid)}`;
  return fetch(url, {
    headers: {
      "User-Agent": MOTIVE.userAgent,
      Accept: "application/json",
      "X-Web-Share-Api-Key": apiKey,
      Origin: "https://tracking.gomotive.com",
      Referer: "https://tracking.gomotive.com/",
    },
    cache: "no-store",
  });
}

export async function fetchLiveShuttle(key: ShuttleKey): Promise<LiveShuttle> {
  const meta = SHUTTLES[key];
  const envKey = normalizeMotiveApiKey(process.env.MOTIVE_WEB_SHARE_API_KEY);
  const primaryKey = getMotiveApiKey();
  let res = await requestLiveShare(meta.uuid, primaryKey);

  // Wrong/quoted env key → 403 unauthorized; retry with the public share key.
  if (
    res.status === 403 &&
    envKey &&
    envKey !== MOTIVE_PUBLIC_WEB_SHARE_API_KEY
  ) {
    res = await requestLiveShare(meta.uuid, MOTIVE_PUBLIC_WEB_SHARE_API_KEY);
  }

  if (!res.ok) {
    const body = (await res.text()).trim().slice(0, 200);
    const hint =
      res.status === 403
        ? " (bad X-Web-Share-Api-Key — check MOTIVE_WEB_SHARE_API_KEY)"
        : "";
    throw new Error(
      `Motive ${key} HTTP ${res.status}${hint}${body ? `: ${body}` : ""}`,
    );
  }
  const payload = (await res.json()) as MotivePayload;
  const vehicle = payload.live_share?.vehicle;
  const loc = vehicle?.vehicle_location;
  const lat = loc?.lat ?? null;
  const lon = loc?.lon ?? null;
  const bearing = loc?.bearing ?? null;
  const speed =
    loc?.speed == null
      ? null
      : typeof loc.speed === "number"
        ? `${loc.speed} mph`
        : String(loc.speed);

  let nextStop: LiveShuttle["nextStop"] = null;
  let loopFrac: number | null = null;
  let offLoopM: number | null = null;

  if (lat != null && lon != null) {
    const loop = getLoop(key);
    // Bearing disambiguates overlapping outbound/return geometry (e.g. past Memorial).
    const proj = loop.project(lat, lon, bearing);
    loopFrac = proj.loopFrac;
    offLoopM = Math.round(proj.offsetM * 10) / 10;
    const nxt = loop.nextStop(proj);
    if (nxt) {
      const mph = parseSpeedMph(speed);
      nextStop = {
        key: nxt.key,
        name: nxt.name,
        alongM: Math.round(nxt.alongM),
        etaMin: Math.round(etaMinutes(nxt.alongM, mph) * 10) / 10,
      };
    }
  }

  return {
    key,
    name: meta.name,
    vehicleNumber: vehicle?.number ?? null,
    state: loc?.entity_state ?? null,
    speed,
    address: loc?.formatted_address ?? null,
    lat,
    lon,
    bearing,
    compass: loc?.compass ?? null,
    locatedAt: loc?.located_at ?? null,
    mapsUrl:
      lat != null && lon != null
        ? `https://www.google.com/maps?q=${lat},${lon}`
        : null,
    nextStop,
    loopFrac,
    offLoopM,
  };
}
