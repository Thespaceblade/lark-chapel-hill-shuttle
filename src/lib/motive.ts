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
    divertedTo: null,
    assignmentNote: null,
    // No schedule → UI must not show a departure countdown.
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
    rideable: false,
    serviceStatus: "out_of_service",
    divertedTo: null,
    assignmentNote: reason ?? "Not in service",
    // Parked/fueling: never show Lark departure timers.
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

function buildServiceShuttle(
  service: ShuttleKey,
  raw: RawVehicle,
  note: string | null,
  opts?: { divertedFrom?: ShuttleKey },
): LiveShuttle {
  const loop = getLoop(service);
  const atLark =
    raw.lat != null && raw.lon != null ? isAtLark(raw.lat, raw.lon) : false;
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
        nextStop = {
          key: nxt.key,
          name: nxt.name,
          alongM: Math.round(nxt.alongM),
          etaMin: Math.round(
            etaMinutes(nxt.alongM, raw.speedMph, raw.state) * 10,
          ) / 10,
        };
      }
    }
  }

  return {
    key: diverted ? opts!.divertedFrom! : service,
    name: SHUTTLES[diverted ? opts!.divertedFrom! : service].name,
    vehicleNumber: raw.vehicleNumber,
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
    rideable: !diverted,
    serviceStatus: diverted ? "diverted" : "active",
    divertedTo: diverted ? service : null,
    assignmentNote: note,
    // Only the active service board owns schedule / next-stop countdowns.
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
  const inferredByHome = new Map(inferred.map((v) => [v.homeKey, v]));

  const shuttles: LiveShuttle[] = (["express", "regular"] as ShuttleKey[]).map(
    (service) => {
      const pick = assignment[service];
      if (pick) {
        const raw = byHome.get(pick.homeKey);
        if (!raw) return emptyService(service);
        return buildServiceShuttle(service, raw, pick.statusReason);
      }

      // No bus assigned to this service — check the usual vehicle.
      const homeInf = inferredByHome.get(service);
      const homeRaw = byHome.get(service);
      if (!homeInf || !homeRaw) return emptyService(service);

      // Usual bus is covering the other line: mark diverted (not rideable)
      // without copying the other line's next-stop / departure ETA.
      if (
        homeInf.status === "in_service" &&
        homeInf.inferredService &&
        homeInf.inferredService !== service
      ) {
        const other = homeInf.inferredService;
        const note =
          homeInf.statusReason ??
          `Usually ${SHUTTLES[service].name} · running ${SHUTTLES[other].name}`;
        return buildServiceShuttle(other, homeRaw, note, {
          divertedFrom: service,
        });
      }

      // Usual bus is parked / fueling / off-network.
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
