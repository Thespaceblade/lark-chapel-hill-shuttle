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
  /** Motive share this GPS comes from (usual Express/Regular paint). */
  vehicleHome: ShuttleKey | null;
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
  /** True when GPS is inside the Lark curb geofence. */
  atLark: boolean;
  /** True when GPS is near a published stop on this service (incl. Lark). */
  atStop: boolean;
  /** False when parked/off-route/gas/diverted — not boarding this line. */
  rideable: boolean;
  /**
   * active = bus on this service;
   * diverted = usual bus is covering the other line (still live-tracked);
   * out_of_service = usual bus parked/fueling/off-network;
   * no_bus = nothing to show.
   */
  serviceStatus: "active" | "diverted" | "out_of_service" | "no_bus";
  /** When diverted, which line the bus is actually running. */
  divertedTo: ShuttleKey | null;
  /** e.g. "Usually Express · running Regular" / parked reason */
  assignmentNote: string | null;
  /** Clock schedule snapshot for Lark departures (Chapel Hill time). */
  larkSchedule: {
    headwayMin: number;
    nextSlotMin: number;
    prevSlotMin: number;
    minutesUntilNext: number;
    minutesSincePrev: number;
    nextDepartAtLabel: string;
    prevDepartAtLabel: string;
  } | null;
  loopFrac: number | null;
  offLoopM: number | null;
};

/** Physical Motive vehicles (may run either passenger service). */
export type FleetVehicle = {
  homeKey: ShuttleKey;
  vehicleNumber: string | null;
  state: string | null;
  speed: string | null;
  address: string | null;
  lat: number | null;
  lon: number | null;
  bearing: number | null;
  locatedAt: string | null;
  atLark: boolean;
  rideable: boolean;
  inferredService: ShuttleKey | null;
  status: "in_service" | "out_of_service" | "deadheading";
  statusReason: string | null;
  assignmentNote: string | null;
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
