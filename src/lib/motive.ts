import {
  MOTIVE,
  MOTIVE_PUBLIC_WEB_SHARE_API_KEY,
  SHUTTLES,
  VEHICLES,
  getMotiveApiKey,
  normalizeMotiveApiKey,
  type FleetVehicle,
  type LiveShuttle,
  type ShuttleKey,
  type VehicleKey,
} from "./shuttles";
import { RouteLoop, etaMinutes, parseSpeedMph, smoothEtaMinutes } from "./loop";
import type { EtaSmoothState } from "./loop";
import type { Stop } from "./shuttles";
import routesData from "../../data/intended_routes.json";
import { isAtLark, larkScheduleSnapshot, distanceM, AT_STOP_RADIUS_M } from "./schedule";
import { assignServices, classifyVehicle } from "./service";
import { homeServiceForVehicle } from "./roster";

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
  vehicleKey: VehicleKey;
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

/** Per board-line ETA memory so brief spikes do not flash on /api/live. */
const etaSmoothByService = new Map<string, EtaSmoothState>();

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

async function fetchRawVehicle(vehicleKey: VehicleKey): Promise<RawVehicle> {
  const meta = VEHICLES[vehicleKey];
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
    vehicleKey,
    homeKey: homeServiceForVehicle(vehicleKey),
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
  return {
    key,
    name: SHUTTLES[key].name,
    vehicleNumber: null,
    vehicleKey: null,
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
    atStop: false,
    rideable: false,
    serviceStatus: "no_bus",
    divertedTo: null,
    assignmentNote: null,
    larkSchedule: null,
    loopFrac: null,
    offLoopM: null,
  };
}

function outOfServiceBoard(
  key: ShuttleKey,
  raw: RawVehicle,
  reason: string | null,
): LiveShuttle {
  const atLark =
    raw.lat != null && raw.lon != null ? isAtLark(raw.lat, raw.lon) : false;
  const bearing = normalizeBearing(raw.bearing);
  return {
    key,
    name: SHUTTLES[key].name,
    vehicleNumber: raw.vehicleNumber,
    vehicleKey: raw.vehicleKey,
    vehicleHome: raw.homeKey,
    state: raw.state,
    speed: raw.speed,
    address: raw.address,
    lat: raw.lat,
    lon: raw.lon,
    bearing,
    compass: bearing == null ? null : raw.compass,
    locatedAt: raw.locatedAt,
    mapsUrl:
      raw.lat != null && raw.lon != null
        ? `https://www.google.com/maps?q=${raw.lat},${raw.lon}`
        : null,
    nextStop: null,
    atLark,
    atStop: atLark,
    rideable: false,
    serviceStatus: "out_of_service",
    divertedTo: null,
    assignmentNote: reason ?? "Not in service",
    larkSchedule: null,
    loopFrac: null,
    offLoopM: null,
  };
}

/** Motive uses -1 (or other negatives) when heading is unknown. */
function normalizeBearing(bearing: number | null): number | null {
  if (bearing == null || !Number.isFinite(bearing) || bearing < 0) return null;
  return ((bearing % 360) + 360) % 360;
}

function nearPublishedStop(
  lat: number,
  lon: number,
  stops: Stop[],
): boolean {
  for (const stop of stops) {
    if (distanceM({ lat, lon }, stop) <= AT_STOP_RADIUS_M) return true;
  }
  return false;
}

function buildServiceShuttle(
  service: ShuttleKey,
  raw: RawVehicle,
  note: string | null,
  opts?: { divertedFrom?: ShuttleKey },
): LiveShuttle {
  const loop = getLoop(service);
  const atLark =
    raw.lat != null && raw.lon != null ? isAtLark(raw.lat, raw.lon) : false;
  const atStop =
    atLark ||
    (raw.lat != null &&
      raw.lon != null &&
      nearPublishedStop(raw.lat, raw.lon, loop.stops));
  const snap = larkScheduleSnapshot(service);
  const bearing = normalizeBearing(raw.bearing);
  let nextStop: LiveShuttle["nextStop"] = null;
  let loopFrac: number | null = null;
  let offLoopM: number | null = null;
  const diverted = opts?.divertedFrom != null;

  // Diverted boards must not mirror the other line's next-stop / Lark ETA —
  // that duplicated identical Sitterson timers on Express + Regular.
  if (!diverted && raw.lat != null && raw.lon != null) {
    const proj = loop.project(raw.lat, raw.lon, bearing);
    loopFrac = proj.loopFrac;
    offLoopM = Math.round(proj.offsetM * 10) / 10;
    if (!atLark) {
      const nxt = loop.nextStop(proj);
      if (nxt) {
        const boardKey = diverted ? opts!.divertedFrom! : service;
        const rawEta = etaMinutes(nxt.alongM, raw.speedMph, raw.state);
        const smoothed = smoothEtaMinutes(
          rawEta,
          nxt.key,
          etaSmoothByService.get(boardKey),
        );
        etaSmoothByService.set(boardKey, smoothed);
        nextStop = {
          key: nxt.key,
          name: nxt.name,
          alongM: Math.round(nxt.alongM),
          etaMin: Math.round(smoothed.etaMin * 10) / 10,
        };
      }
    }
  }

  return {
    key: diverted ? opts!.divertedFrom! : service,
    name: SHUTTLES[diverted ? opts!.divertedFrom! : service].name,
    vehicleNumber: raw.vehicleNumber,
    vehicleKey: raw.vehicleKey,
    vehicleHome: raw.homeKey,
    state: raw.state,
    speed: raw.speed,
    address: raw.address,
    lat: raw.lat,
    lon: raw.lon,
    bearing,
    compass: bearing == null ? null : raw.compass,
    locatedAt: raw.locatedAt,
    mapsUrl:
      raw.lat != null && raw.lon != null
        ? `https://www.google.com/maps?q=${raw.lat},${raw.lon}`
        : null,
    nextStop,
    atLark,
    atStop,
    rideable: !diverted,
    serviceStatus: diverted ? "diverted" : "active",
    divertedTo: diverted ? service : null,
    assignmentNote: note,
    larkSchedule: diverted
      ? null
      : {
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
    fetchRawVehicle("1"),
    fetchRawVehicle("2"),
  ]);

  const inferred = raws.map((raw) =>
    classifyVehicle({
      vehicleKey: raw.vehicleKey,
      lat: raw.lat,
      lon: raw.lon,
      state: raw.state,
      speedMph: raw.speedMph,
      loops,
    }),
  );

  const assignment = assignServices(inferred);
  const byVehicle = new Map(raws.map((r) => [r.vehicleKey, r]));
  const inferredByVehicle = new Map(
    inferred.map((v) => [v.vehicleKey, v]),
  );

  const shuttles: LiveShuttle[] = (["express", "regular"] as ShuttleKey[]).map(
    (service) => {
      const pick = assignment[service];
      if (pick) {
        const raw = byVehicle.get(pick.vehicleKey);
        if (!raw) return emptyService(service);
        return buildServiceShuttle(service, raw, pick.statusReason);
      }

      // Soft roster: which vehicle is "usually" this service today?
      const usualVehicle: VehicleKey =
        homeServiceForVehicle("1") === service ? "1" : "2";
      const homeInf = inferredByVehicle.get(usualVehicle);
      const homeRaw = byVehicle.get(usualVehicle);
      if (!homeInf || !homeRaw) return emptyService(service);

      // Usual bus is on the other line — this route simply has no bus.
      // Don't say "on Regular" on the Express board (or vice versa).
      if (
        homeInf.status === "in_service" &&
        homeInf.inferredService &&
        homeInf.inferredService !== service
      ) {
        return emptyService(service);
      }

      if (
        homeInf.status === "out_of_service" ||
        homeInf.status === "deadheading"
      ) {
        return outOfServiceBoard(service, homeRaw, homeInf.statusReason);
      }

      return emptyService(service);
    },
  );

  const fleet: FleetVehicle[] = inferred.map((inf, i) => {
    const raw = raws[i];
    return {
      vehicleKey: raw.vehicleKey,
      homeKey: raw.homeKey,
      vehicleNumber: raw.vehicleNumber,
      state: raw.state,
      speed: raw.speed,
      address: raw.address,
      lat: raw.lat,
      lon: raw.lon,
      bearing: normalizeBearing(raw.bearing),
      locatedAt: raw.locatedAt,
      atLark: inf.atLark,
      rideable: inf.status === "in_service",
      inferredService: inf.inferredService,
      status: inf.status,
      statusReason: inf.statusReason,
      assignmentNote: inf.statusReason,
    };
  });

  return { shuttles, fleet };
}
