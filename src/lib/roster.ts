import type { ShuttleKey } from "./shuttles";
import { chapelHillMinutesOfDay } from "./schedule";

/**
 * Physical Motive vehicles (bus numbers), not passenger services.
 * Vehicle 1 = Lark Chapel Hill 1 share UUID; Vehicle 2 = Lark Chapel Hill 2.
 */
export type VehicleKey = "1" | "2";

/** @deprecated Prefer VehicleKey */
export type VehicleId = VehicleKey;

/** Chapel Hill local time when assigned "usual" services swap. */
export const ROSTER_SWAP_MINUTE = 14 * 60; // 2:00 PM

export function rosterSwapped(now: Date = new Date()): boolean {
  return chapelHillMinutesOfDay(now) >= ROSTER_SWAP_MINUTE;
}

/**
 * Soft "usual" passenger service for a physical bus (schedule hint only).
 * Actual service is inferred from GPS. Either bus may run either route.
 *
 * Morning: 1 → Express, 2 → Regular
 * From 2:00 PM ET: 1 → Regular, 2 → Express
 */
export function homeServiceForVehicle(
  vehicleKey: VehicleKey,
  now: Date = new Date(),
): ShuttleKey {
  const swapped = rosterSwapped(now);
  if (vehicleKey === "1") return swapped ? "regular" : "express";
  return swapped ? "express" : "regular";
}

export function vehicleLabel(key: VehicleKey): string {
  return key === "1" ? "Shuttle 1" : "Shuttle 2";
}

/** @deprecated Share slots are no longer how we key vehicles. */
export function vehicleIdFromShareSlot(shareSlot: ShuttleKey): VehicleKey {
  return shareSlot === "express" ? "1" : "2";
}

export function vehicleKeyForHome(
  home: ShuttleKey,
  now: Date = new Date(),
): VehicleKey {
  const swapped = rosterSwapped(now);
  if (home === "express") return swapped ? "2" : "1";
  return swapped ? "1" : "2";
}

/** @deprecated Prefer vehicleKeyForHome */
export const vehicleIdForHome = vehicleKeyForHome;
