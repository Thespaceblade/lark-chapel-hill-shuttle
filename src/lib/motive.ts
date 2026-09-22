import {
  MOTIVE,
  MOTIVE_PUBLIC_WEB_SHARE_API_KEY,
  SHUTTLES,
  getMotiveApiKey,
  normalizeMotiveApiKey,
  type FleetVehicle,
  type LiveShuttle,
  type ShuttleKey,
} from "./shuttles";
import { RouteLoop, etaMinutes, parseSpeedMph } from "./loop";
import type { Stop } from "./shuttles";
import routesData from "../../data/intended_routes.json";
import { isAtLark, larkScheduleSnapshot } from "./schedule";
import { assignServices, classifyVehicle } from "./service";

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

type RawVehicle = {
  homeKey: ShuttleKey;
  vehicleNumber: string | null;
  state: string | null;
  speed: string | null;
  speedMph: number | null;
  address: string | null;
  lat: number | null;
  lon: number | null;
  bearing: number | null;
  compass: string | null;
  locatedAt: string | null;
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

async function fetchMotive(uuid: string): Promise<MotivePayload> {
  const envKey = normalizeMotiveApiKey(process.env.MOTIVE_WEB_SHARE_API_KEY);
  const primaryKey = getMotiveApiKey();
  let res = await requestLiveShare(uuid, primaryKey);
  if (
    res.status === 403 &&
    envKey &&
    envKey !== MOTIVE_PUBLIC_WEB_SHARE_API_KEY
  ) {
    res = await requestLiveShare(uuid, MOTIVE_PUBLIC_WEB_SHARE_API_KEY);
  }
  if (!res.ok) {
    const body = (await res.text()).trim().slice(0, 200);
    const hint =
      res.status === 403
        ? " (bad X-Web-Share-Api-Key — check MOTIVE_WEB_SHARE_API_KEY)"
        : "";
    throw new Error(`Motive HTTP ${res.status}${hint}${body ? `: ${body}` : ""}`);
  }
  return (await res.json()) as MotivePayload;
}

async function fetchRawVehicle(homeKey: ShuttleKey): Promise<RawVehicle> {
  const meta = SHUTTLES[homeKey];
  const payload = await fetchMotive(meta.uuid);
  const vehicle = payload.live_share?.vehicle;
  const loc = vehicle?.vehicle_location;
  const speed =
    loc?.speed == null
      ? null
      : typeof loc.speed === "number"
        ? `${loc.speed} mph`
        : String(loc.speed);
  return {
    homeKey,
    vehicleNumber: vehicle?.number ?? null,
    state: loc?.entity_state ?? null,
    speed,
    speedMph: parseSpeedMph(speed),
    address: loc?.formatted_address ?? null,
    lat: loc?.lat ?? null,
    lon: loc?.lon ?? null,
    bearing: loc?.bearing ?? null,
    compass: loc?.compass ?? null,
    locatedAt: loc?.located_at ?? null,
  };
}

function emptyService(key: ShuttleKey): LiveShuttle {
  const snap = larkScheduleSnapshot(key);
  return {
    key,
    name: SHUTTLES[key].name,
    vehicleNumber: null,
    vehicleHome: null,
    state: null,
    speed: null,
    address: null,
    lat: null,
    lon: null,
    bearing: null,
    compass: null,
    locatedAt: null,
    mapsUrl: null,
    nextStop: null,
    atLark: false,
    rideable: false,
    serviceStatus: "no_bus",
    assignmentNote: null,
    larkSchedule: {
      headwayMin: snap.headwayMin,
      nextSlotMin: snap.nextSlotMin,
      prevSlotMin: snap.prevSlotMin,
      minutesUntilNext: snap.minutesUntilNext,
      minutesSincePrev: snap.minutesSincePrev,
      nextDepartAtLabel: snap.nextDepartAtLabel,
      prevDepartAtLabel: snap.prevDepartAtLabel,
    },
    loopFrac: null,
    offLoopM: null,
  };
}

function buildServiceShuttle(
  service: ShuttleKey,
  raw: RawVehicle,
  note: string | null,
): LiveShuttle {
  const loop = getLoop(service);
  const atLark =
    raw.lat != null && raw.lon != null ? isAtLark(raw.lat, raw.lon) : false;
  const snap = larkScheduleSnapshot(service);
  let nextStop: LiveShuttle["nextStop"] = null;
  let loopFrac: number | null = null;
  let offLoopM: number | null = null;

  if (raw.lat != null && raw.lon != null) {
    const proj = loop.project(raw.lat, raw.lon, raw.bearing);
    loopFrac = proj.loopFrac;
    offLoopM = Math.round(proj.offsetM * 10) / 10;
    if (!atLark) {
      const nxt = loop.nextStop(proj);
      if (nxt) {
        nextStop = {
          key: nxt.key,
          name: nxt.name,
          alongM: Math.round(nxt.alongM),
          etaMin: Math.round(etaMinutes(nxt.alongM, raw.speedMph) * 10) / 10,
        };
      }
    }
  }

  return {
    key: service,
    name: SHUTTLES[service].name,
    vehicleNumber: raw.vehicleNumber,
    vehicleHome: raw.homeKey,
    state: raw.state,
    speed: raw.speed,
    address: raw.address,
    lat: raw.lat,
    lon: raw.lon,
    bearing: raw.bearing,
    compass: raw.compass,
    locatedAt: raw.locatedAt,
    mapsUrl:
      raw.lat != null && raw.lon != null
        ? `https://www.google.com/maps?q=${raw.lat},${raw.lon}`
        : null,
    nextStop,
    atLark,
    rideable: true,
    serviceStatus: "active",
    assignmentNote: note,
    larkSchedule: {
      headwayMin: snap.headwayMin,
      nextSlotMin: snap.nextSlotMin,
      prevSlotMin: snap.prevSlotMin,
      minutesUntilNext: snap.minutesUntilNext,
      minutesSincePrev: snap.minutesSincePrev,
      nextDepartAtLabel: snap.nextDepartAtLabel,
      prevDepartAtLabel: snap.prevDepartAtLabel,
    },
    loopFrac,
    offLoopM,
  };
}

/** @deprecated Prefer fetchLiveBoard — kept for simple single-key callers. */
export async function fetchLiveShuttle(key: ShuttleKey): Promise<LiveShuttle> {
  const board = await fetchLiveBoard();
  return board.shuttles.find((s) => s.key === key) ?? emptyService(key);
}

export async function fetchLiveBoard(): Promise<{
  shuttles: LiveShuttle[];
  fleet: FleetVehicle[];
}> {
  const loops = {
    express: getLoop("express"),
    regular: getLoop("regular"),
  };

  const raws = await Promise.all([
    fetchRawVehicle("express"),
    fetchRawVehicle("regular"),
  ]);

  const inferred = raws.map((raw) =>
    classifyVehicle({
      homeKey: raw.homeKey,
      lat: raw.lat,
      lon: raw.lon,
      state: raw.state,
      speedMph: raw.speedMph,
      loops,
    }),
  );

  const assignment = assignServices(inferred);
  const byHome = new Map(raws.map((r) => [r.homeKey, r]));

  const shuttles: LiveShuttle[] = (["express", "regular"] as ShuttleKey[]).map(
    (service) => {
      const pick = assignment[service];
      if (!pick) return emptyService(service);
      const raw = byHome.get(pick.homeKey);
      if (!raw) return emptyService(service);
      return buildServiceShuttle(service, raw, pick.statusReason);
    },
  );

  const fleet: FleetVehicle[] = inferred.map((inf, i) => {
    const raw = raws[i];
    return {
      homeKey: raw.homeKey,
      vehicleNumber: raw.vehicleNumber,
      state: raw.state,
      speed: raw.speed,
      address: raw.address,
      lat: raw.lat,
      lon: raw.lon,
      bearing: raw.bearing,
      locatedAt: raw.locatedAt,
      atLark: inf.atLark,
      rideable: inf.status === "in_service",
      inferredService: inf.inferredService,
      status: inf.status,
      statusReason: inf.statusReason,
      assignmentNote:
        inf.status === "in_service" &&
        inf.inferredService &&
        inf.inferredService !== inf.homeKey
          ? inf.statusReason
          : null,
    };
  });

  return { shuttles, fleet };
}
