import type { ShuttleKey } from "./shuttles";

/** Clock-aligned departures from Lark (America/New_York). */
export const LARK_SCHEDULE: Record<
  ShuttleKey,
  { headwayMin: number; phaseMin: number }
> = {
  // :00, :15, :30, :45
  express: { headwayMin: 15, phaseMin: 0 },
  // :00, :30
  regular: { headwayMin: 30, phaseMin: 0 },
};

/** Still treat as "departing now" this long after a slot. */
export const LARK_DEPARTURE_GRACE_MIN = 2;

/** Geofence around the Lark curb pin. */
export const AT_LARK_RADIUS_M = 75;

export const LARK_STOP = {
  key: "lark",
  name: "Lark Chapel Hill",
  lat: 35.91913,
  lon: -79.05343,
} as const;

const TZ = "America/New_York";

export type LarkScheduleSnapshot = {
  headwayMin: number;
  /** Minutes from midnight (Chapel Hill) of the previous slot. */
  prevSlotMin: number;
  /** Minutes from midnight of the next slot. */
  nextSlotMin: number;
  minutesSincePrev: number;
  minutesUntilNext: number;
  nextDepartAtLabel: string;
  prevDepartAtLabel: string;
};

function chapelHillClock(date: Date): {
  minutes: number;
  second: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    minutes: get("hour") * 60 + get("minute"),
    second: get("second"),
  };
}

export function formatSlotLabel(slotMinute: number): string {
  const normalized = ((slotMinute % (24 * 60)) + 24 * 60) % (24 * 60);
  const h = Math.floor(normalized / 60);
  const m = normalized % 60;
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${m.toString().padStart(2, "0")} ${ampm}`;
}

export function larkScheduleSnapshot(
  key: ShuttleKey,
  now: Date = new Date(),
): LarkScheduleSnapshot {
  const { headwayMin, phaseMin } = LARK_SCHEDULE[key];
  const { minutes, second } = chapelHillClock(now);
  const nowMin = minutes + second / 60;
  const k = Math.floor((nowMin - phaseMin) / headwayMin);
  const prevSlotMin = phaseMin + k * headwayMin;
  const nextSlotMin = prevSlotMin + headwayMin;
  return {
    headwayMin,
    prevSlotMin,
    nextSlotMin,
    minutesSincePrev: nowMin - prevSlotMin,
    minutesUntilNext: nextSlotMin - nowMin,
    nextDepartAtLabel: formatSlotLabel(nextSlotMin),
    prevDepartAtLabel: formatSlotLabel(prevSlotMin),
  };
}

/** Haversine distance in meters. */
export function distanceM(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6_371_000;
  const lat1 = (a.lat * Math.PI) / 180;
  const lon1 = (a.lon * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const lon2 = (b.lon * Math.PI) / 180;
  const dlat = lat2 - lat1;
  const dlon = lon2 - lon1;
  const h =
    Math.sin(dlat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function isAtLark(
  lat: number,
  lon: number,
  radiusM: number = AT_LARK_RADIUS_M,
): boolean {
  return distanceM({ lat, lon }, LARK_STOP) <= radiusM;
}

/**
 * Board status while geofenced at Lark.
 *
 * `holdSlotMin` is the scheduled slot we started holding for when the
 * shuttle first arrived (tracked client-side). If omitted, falls back to
 * the upcoming clock slot (fine for early waits; late holds need the lock).
 */
export function larkHoldBoard(
  snap: LarkScheduleSnapshot,
  holdSlotMin: number | null,
  now: Date = new Date(),
): {
  mode: "departing_lark" | "departing_lark_now" | "lark_unscheduled";
  etaMin: number | null;
  departAtLabel: string | null;
  headwayMin: number;
} {
  const { minutes, second } = chapelHillClock(now);
  const nowMin = minutes + second / 60;
  const target = holdSlotMin ?? snap.nextSlotMin;
  const until = target - nowMin;
  // Handle target on previous day wrap rarely needed within a dwell.

  if (until <= LARK_DEPARTURE_GRACE_MIN && until >= -LARK_DEPARTURE_GRACE_MIN) {
    return {
      mode: until > 0 ? "departing_lark" : "departing_lark_now",
      etaMin: Math.max(0, Math.ceil(until)),
      departAtLabel: formatSlotLabel(target),
      headwayMin: snap.headwayMin,
    };
  }

  if (until < -LARK_DEPARTURE_GRACE_MIN) {
    return {
      mode: "lark_unscheduled",
      etaMin: null,
      departAtLabel: null,
      headwayMin: snap.headwayMin,
    };
  }

  return {
    mode: "departing_lark",
    etaMin: Math.max(0, Math.ceil(until)),
    departAtLabel: formatSlotLabel(target),
    headwayMin: snap.headwayMin,
  };
}
