import type { ShuttleKey } from "./shuttles";
import { chapelHillMinutesOfDay } from "./schedule";

/**
 * Physical Motive vehicles (UUID slots), not passenger services.
 * Shuttle 1 = morning Express share; Shuttle 2 = morning Regular share.
 */
export type VehicleId = "shuttle1" | "shuttle2";

/** Chapel Hill local time when Shuttle 1 switches Express → Regular (and 2 swaps). */
export const ROSTER_SWAP_MINUTE = 14 * 60; // 2:00 PM

export function rosterSwapped(now: Date = new Date()): boolean {
  return chapelHillMinutesOfDay(now) >= ROSTER_SWAP_MINUTE;
}

/**
 * Usual passenger service for a physical bus.
 *
 * Morning: Shuttle 1 → Express, Shuttle 2 → Regular
 * From 2:00 PM ET: Shuttle 1 → Regular, Shuttle 2 → Express
 */
export function homeServiceForVehicle(
  vehicleId: VehicleId,
  now: Date = new Date(),
): ShuttleKey {
  const swapped = rosterSwapped(now);
  if (vehicleId === "shuttle1") return swapped ? "regular" : "express";
  return swapped ? "express" : "regular";
}

/** Motive share key used at boot (morning paint) → physical vehicle id. */
export function vehicleIdFromShareSlot(shareSlot: ShuttleKey): VehicleId {
  return shareSlot === "express" ? "shuttle1" : "shuttle2";
}

export function vehicleIdForHome(
  home: ShuttleKey,
  now: Date = new Date(),
): VehicleId {
  const swapped = rosterSwapped(now);
  if (home === "express") return swapped ? "shuttle2" : "shuttle1";
  return swapped ? "shuttle1" : "shuttle2";
}
