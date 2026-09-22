/** Passenger service / route loop (board lines). Not a physical bus. */
export type RouteKey = "express" | "regular";

/** @deprecated Prefer RouteKey — board/service key. */
export type ShuttleKey = RouteKey;

/** Physical Motive tracker / bus number. */
export type VehicleKey = "1" | "2";

export type Stop = {
  key: string;
  name: string;
  lat: number;
  lon: number;
};

export type LiveShuttle = {
  /** Passenger service this board row represents. */
  key: RouteKey;
  name: string;
  vehicleNumber: string | null;
  /** Which Motive vehicle (1/2) is providing this GPS. */
  vehicleKey: VehicleKey | null;
  /**
   * Soft roster "usual" service for this vehicle (may differ from key).
   * @deprecated Prefer vehicleKey + inferred route; kept for older UI copy.
   */
  vehicleHome: RouteKey | null;
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
  atLark: boolean;
  atStop: boolean;
  rideable: boolean;
  serviceStatus: "active" | "diverted" | "out_of_service" | "no_bus";
  divertedTo: RouteKey | null;
  /** e.g. "Shuttle 1 · running Regular" */
  assignmentNote: string | null;
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
  vehicleKey: VehicleKey;
  /** Soft roster usual service (hint only). */
  homeKey: RouteKey;
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
  inferredService: RouteKey | null;
  status: "in_service" | "out_of_service" | "deadheading";
  statusReason: string | null;
  assignmentNote: string | null;
};

/** Board lines / route geometry — not Motive vehicles. */
export const SHUTTLES: Record<
  RouteKey,
  { key: RouteKey; name: string; color: string; bullet: string }
> = {
  express: {
    key: "express",
    name: "Express",
    color: "#0039a6",
    bullet: "E",
  },
  regular: {
    key: "regular",
    name: "Regular",
    color: "#ff6319",
    bullet: "R",
  },
};

/** Motive trackers. UUIDs are the live-share links for each physical bus. */
export const VEHICLES: Record<
  VehicleKey,
  { key: VehicleKey; label: string; uuid: string }
> = {
  "1": {
    key: "1",
    label: "Shuttle 1",
    uuid: "0c5a01f2-a549-11f1-83ea-4247aa532d4a",
  },
  "2": {
    key: "2",
    label: "Shuttle 2",
    uuid: "2485bb70-a546-11f1-a663-320d2d4970d9",
  },
};

export const MOTIVE = {
  endpoint: "https://api.keeptruckin.com/api/s1/live_shares",
  userAgent: "lark-shuttle-web/0.1 (+vercel)",
};

export const MOTIVE_PUBLIC_WEB_SHARE_API_KEY =
  "3gCAa2VxLV3nlJfk7EhzJUEe5lg3IU9b50sNyOfUSSE6Fg2ACZr6GK5KqpMW55rn";

export function normalizeMotiveApiKey(raw?: string | null): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const unquoted = trimmed.replace(/^["']|["']$/g, "").trim();
  return unquoted || undefined;
}

export function getMotiveApiKey(): string {
  return (
    normalizeMotiveApiKey(process.env.MOTIVE_WEB_SHARE_API_KEY) ??
    MOTIVE_PUBLIC_WEB_SHARE_API_KEY
  );
}

export { vehicleLabel } from "./roster";
