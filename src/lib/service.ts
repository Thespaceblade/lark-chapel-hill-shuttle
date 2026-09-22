import type { ShuttleKey } from "./shuttles";
import type { RouteLoop } from "./loop";
import { LARK_STOP, distanceM, isAtLark } from "./schedule";

/** On-route if snapped within this many meters of a service loop. */
export const ON_ROUTE_MAX_M = 90;

/** Farther than this from both loops (and not at Lark curb) → not rideable. */
export const OFF_NETWORK_M = 160;

/** Near Lark property but not at the curb pickup (parked behind / lot). */
export const BEHIND_LARK_M = 220;

export type VehicleHome = ShuttleKey;

export type ServiceFit = {
  key: ShuttleKey;
  offLoopM: number;
  loopFrac: number;
  onRoute: boolean;
};

export type VehicleServiceStatus =
  | "in_service"
  | "out_of_service"
  | "deadheading";

export type InferredVehicle = {
  homeKey: VehicleHome;
  inferredService: ShuttleKey | null;
  status: VehicleServiceStatus;
  statusReason: string | null;
  fits: Record<ShuttleKey, ServiceFit>;
  atLark: boolean;
};

export function classifyVehicle(args: {
  homeKey: VehicleHome;
  lat: number | null;
  lon: number | null;
  state: string | null;
  speedMph: number | null;
  loops: Record<ShuttleKey, RouteLoop>;
}): InferredVehicle {
  const { homeKey, lat, lon, state, speedMph, loops } = args;
  const st = (state || "").toLowerCase();
  const moving = st === "moving" && (speedMph == null || speedMph > 1);

  if (lat == null || lon == null) {
    return {
      homeKey,
      inferredService: null,
      status: "out_of_service",
      statusReason: "No GPS",
      fits: {
        express: {
          key: "express",
          offLoopM: Infinity,
          loopFrac: 0,
          onRoute: false,
        },
        regular: {
          key: "regular",
          offLoopM: Infinity,
          loopFrac: 0,
          onRoute: false,
        },
      },
      atLark: false,
    };
  }

  const atLark = isAtLark(lat, lon);
  const distLark = distanceM({ lat, lon }, LARK_STOP);
  const fits = {
    express: fitLoop("express", loops.express, lat, lon),
    regular: fitLoop("regular", loops.regular, lat, lon),
  } as Record<ShuttleKey, ServiceFit>;

  const onE = fits.express.onRoute;
  const onR = fits.regular.onRoute;
  const behindLark =
    !atLark &&
    distLark <= BEHIND_LARK_M &&
    (st === "off" || st === "idling" || !moving);

  // Parked behind Lark / lot — not boarding.
  if (behindLark) {
    return {
      homeKey,
      inferredService: null,
      status: "out_of_service",
      statusReason: "Parked near Lark (not at pickup)",
      fits,
      atLark,
    };
  }

  // Clearly off both passenger loops (gas run, yard, random deadhead).
  if (
    !atLark &&
    fits.express.offLoopM > OFF_NETWORK_M &&
    fits.regular.offLoopM > OFF_NETWORK_M
  ) {
    return {
      homeKey,
      inferredService: null,
      status: moving ? "deadheading" : "out_of_service",
      statusReason: moving
        ? "Off-route (not rideable)"
        : "Off-route / not in service",
      fits,
      atLark,
    };
  }

  if (st === "off" && !atLark && !onE && !onR) {
    return {
      homeKey,
      inferredService: null,
      status: "out_of_service",
      statusReason: "Vehicle off",
      fits,
      atLark,
    };
  }

  let inferred: ShuttleKey | null = null;
  if (onE && !onR) inferred = "express";
  else if (onR && !onE) inferred = "regular";
  else if (onE && onR) {
    // Shared corridor / near Lark geometry — pick closer, else home paint.
    const d = fits.express.offLoopM - fits.regular.offLoopM;
    if (Math.abs(d) < 20) inferred = homeKey;
    else inferred = d < 0 ? "express" : "regular";
  } else if (atLark) {
    // At curb with ambiguous geometry: assume usual role until it commits
    // to a loop after departure.
    inferred = homeKey;
  }

  if (!inferred) {
    return {
      homeKey,
      inferredService: null,
      status: moving ? "deadheading" : "out_of_service",
      statusReason: "Not on a published route",
      fits,
      atLark,
    };
  }

  return {
    homeKey,
    inferredService: inferred,
    status: "in_service",
    statusReason:
      inferred !== homeKey
        ? `Usually ${label(homeKey)} · running ${label(inferred)}`
        : null,
    fits,
    atLark,
  };
}

function label(key: ShuttleKey): string {
  return key === "express" ? "Express" : "Regular";
}

function fitLoop(
  key: ShuttleKey,
  loop: RouteLoop,
  lat: number,
  lon: number,
): ServiceFit {
  const proj = loop.project(lat, lon);
  const offLoopM = Math.round(proj.offsetM * 10) / 10;
  return {
    key,
    offLoopM,
    loopFrac: proj.loopFrac,
    onRoute: offLoopM <= ON_ROUTE_MAX_M,
  };
}

/**
 * Pick at most one in-service vehicle per passenger service.
 * Closer-to-loop wins if two buses claim the same service.
 */
export function assignServices(
  vehicles: InferredVehicle[],
): Record<ShuttleKey, InferredVehicle | null> {
  const out: Record<ShuttleKey, InferredVehicle | null> = {
    express: null,
    regular: null,
  };

  for (const service of ["express", "regular"] as ShuttleKey[]) {
    const candidates = vehicles.filter(
      (v) => v.status === "in_service" && v.inferredService === service,
    );
    if (!candidates.length) continue;
    candidates.sort(
      (a, b) => a.fits[service].offLoopM - b.fits[service].offLoopM,
    );
    out[service] = candidates[0];
  }

  // If both vehicles inferred the same service, the loser may still be a
  // valid second service if it's reasonably near the other loop.
  for (const v of vehicles) {
    if (v.status !== "in_service" || !v.inferredService) continue;
    const taken = out[v.inferredService];
    if (taken && taken.homeKey === v.homeKey) continue;
    if (taken && taken.homeKey !== v.homeKey) {
      // This vehicle lost the contested service — try the other loop.
      const other: ShuttleKey =
        v.inferredService === "express" ? "regular" : "express";
      if (!out[other] && v.fits[other].offLoopM <= ON_ROUTE_MAX_M * 1.4) {
        out[other] = {
          ...v,
          inferredService: other,
          statusReason:
            v.homeKey !== other
              ? `Usually ${label(v.homeKey)} · running ${label(other)}`
              : null,
        };
      }
    }
  }

  return out;
}
