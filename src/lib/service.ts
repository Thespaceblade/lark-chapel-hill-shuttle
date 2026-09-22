import type { ShuttleKey, VehicleKey } from "./shuttles";
import type { RouteLoop } from "./loop";
import { LARK_STOP, distanceM, isAtLark } from "./schedule";
import { homeServiceForVehicle, vehicleLabel } from "./roster";

/** On-route if snapped within this many meters of a service loop. */
export const ON_ROUTE_MAX_M = 90;

/** Farther than this from both loops (and not at Lark curb) → not rideable. */
export const OFF_NETWORK_M = 160;

/** Near Lark property but not at the curb pickup (parked behind / lot). */
export const BEHIND_LARK_M = 220;

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
  vehicleKey: VehicleKey;
  /** Soft roster usual service (hint only — not identity). */
  homeKey: ShuttleKey;
  inferredService: ShuttleKey | null;
  status: VehicleServiceStatus;
  statusReason: string | null;
  fits: Record<ShuttleKey, ServiceFit>;
  atLark: boolean;
};

export function classifyVehicle(args: {
  vehicleKey: VehicleKey;
  lat: number | null;
  lon: number | null;
  state: string | null;
  speedMph: number | null;
  loops: Record<ShuttleKey, RouteLoop>;
}): InferredVehicle {
  const { vehicleKey, lat, lon, state, speedMph, loops } = args;
  const homeKey = homeServiceForVehicle(vehicleKey);
  const st = (state || "").toLowerCase();
  const moving = st === "moving" && (speedMph == null || speedMph > 1);

  if (lat == null || lon == null) {
    return {
      vehicleKey,
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

  if (behindLark) {
    return {
      vehicleKey,
      homeKey,
      inferredService: null,
      status: "out_of_service",
      statusReason: "Parked near Lark (not at pickup)",
      fits,
      atLark,
    };
  }

  if (
    !atLark &&
    fits.express.offLoopM > OFF_NETWORK_M &&
    fits.regular.offLoopM > OFF_NETWORK_M
  ) {
    return {
      vehicleKey,
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
      vehicleKey,
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
    const d = fits.express.offLoopM - fits.regular.offLoopM;
    if (Math.abs(d) < 20) inferred = homeKey;
    else inferred = d < 0 ? "express" : "regular";
  } else if (atLark) {
    inferred = homeKey;
  }

  if (!inferred) {
    return {
      vehicleKey,
      homeKey,
      inferredService: null,
      status: moving ? "deadheading" : "out_of_service",
      statusReason: "Not on a published route",
      fits,
      atLark,
    };
  }

  return {
    vehicleKey,
    homeKey,
    inferredService: inferred,
    status: "in_service",
    statusReason: `${vehicleLabel(vehicleKey)} · running ${routeLabel(inferred)}`,
    fits,
    atLark,
  };
}

function routeLabel(key: ShuttleKey): string {
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

  for (const v of vehicles) {
    if (v.status !== "in_service" || !v.inferredService) continue;
    const taken = out[v.inferredService];
    if (taken && taken.vehicleKey === v.vehicleKey) continue;
    if (taken && taken.vehicleKey !== v.vehicleKey) {
      const other: ShuttleKey =
        v.inferredService === "express" ? "regular" : "express";
      if (!out[other] && v.fits[other].offLoopM <= ON_ROUTE_MAX_M * 1.4) {
        out[other] = {
          ...v,
          inferredService: other,
          statusReason: `${vehicleLabel(v.vehicleKey)} · running ${routeLabel(other)}`,
        };
      }
    }
  }

  return out;
}
