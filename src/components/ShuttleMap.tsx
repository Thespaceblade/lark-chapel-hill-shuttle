"use client";

import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  MapContainer,
  TileLayer,
  Polyline,
  CircleMarker,
  Marker,
  Tooltip,
  useMap,
} from "react-leaflet";
import L from "leaflet";
import type { FleetVehicle, LiveShuttle, ShuttleKey } from "@/lib/shuttles";
import { SHUTTLES, vehicleLabel } from "@/lib/shuttles";
import { isLatePickup } from "@/lib/schedule";
import "leaflet/dist/leaflet.css";
import styles from "./ShuttleMap.module.css";

/** Lerp duration — slightly longer than the 1s live poll so motion never stalls. */
const SMOOTH_MS = 1_150;
/** Teleport / first-fix: skip tween if the jump is unrealistically large. */
const SNAP_M = 280;

type Stop = { key: string; name: string; lat: number; lon: number };

type RoutesResponse = {
  express: { color: string; stops: Stop[]; line: [number, number][] };
  regular: { color: string; stops: Stop[]; line: [number, number][] };
};

type Props = {
  routes: RoutesResponse | null;
  shuttles: LiveShuttle[];
  fleet?: FleetVehicle[];
  focus: ShuttleKey | "both";
  holdSlots?: Partial<Record<ShuttleKey, number | null>>;
};

function FitToRoutes({
  routes,
  focus,
}: {
  routes: RoutesResponse | null;
  focus: ShuttleKey | "both";
}) {
  const map = useMap();
  useEffect(() => {
    if (!routes) return;
    const pts: [number, number][] = [];
    if (focus === "both" || focus === "express") pts.push(...routes.express.line);
    if (focus === "both" || focus === "regular") pts.push(...routes.regular.line);
    if (pts.length < 2) return;

    const mobile = window.matchMedia("(max-width: 720px)").matches;
    map.fitBounds(pts, {
      paddingTopLeft: mobile ? [24, 24] : [48, 48],
      paddingBottomRight: mobile ? [24, 24] : [48, 48],
      maxZoom: mobile ? 14 : 15,
    });
    // Intentionally ignore shuttle positions — live updates should move markers only.
  }, [map, routes, focus]);

  useEffect(() => {
    const onResize = () => {
      map.invalidateSize();
    };
    window.addEventListener("resize", onResize);
    // Leaflet often needs a tick after layout flips desktop↔mobile
    const t = window.setTimeout(onResize, 80);
    return () => {
      window.removeEventListener("resize", onResize);
      window.clearTimeout(t);
    };
  }, [map]);

  return null;
}

function busIcon(
  key: ShuttleKey | "oos",
  color: string,
  label: string,
) {
  // Always mount the arrow ring; visibility/rotation is driven via DOM so
  // CSS-module hashes aren't required inside Leaflet-injected HTML.
  const line = key === "oos" ? "express" : key;
  return L.divIcon({
    className: styles.busIconWrap,
    html: `<div class="${styles.busMarker}">
      <div class="lark-bus-arrow-ring" style="opacity:0">
         <div class="lark-bus-arrow" data-line="${line}"></div>
       </div>
      <div class="${styles.busIcon}" style="--bus:${color}"><span>${label}</span></div>
    </div>`,
    iconSize: [56, 56],
    iconAnchor: [28, 28],
  });
}

function haversineM(
  a: [number, number],
  b: [number, number],
): number {
  const toRad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toRad;
  const dLon = (b[1] - a[1]) * toRad;
  const lat1 = a[0] * toRad;
  const lat2 = b[0] * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

type LatLon = [number, number];

function toLocalXy(p: LatLon, lat0: number, lon0: number) {
  const EARTH = 6_371_000;
  const lat0r = (lat0 * Math.PI) / 180;
  return {
    x: ((p[1] - lon0) * Math.PI) / 180 * Math.cos(lat0r) * EARTH,
    y: ((p[0] - lat0) * Math.PI) / 180 * EARTH,
  };
}

/** Distance from point to polyline in meters. */
function distToPolylineM(p: LatLon, line: LatLon[]): number {
  if (line.length < 2) return Infinity;
  const lat0 = p[0];
  const lon0 = p[1];
  const pt = toLocalXy(p, lat0, lon0);
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const a = toLocalXy(line[i], lat0, lon0);
    const b = toLocalXy(line[i + 1], lat0, lon0);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const seg2 = dx * dx + dy * dy;
    let t = 0;
    if (seg2 > 1e-12) {
      t = Math.max(
        0,
        Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / seg2),
      );
    }
    const qx = a.x + t * dx;
    const qy = a.y + t * dy;
    best = Math.min(best, Math.hypot(pt.x - qx, pt.y - qy));
  }
  return best;
}

/**
 * Split a route into solo (solid) vs shared-with-other (dashed) runs.
 * Boundary vertices are duplicated so runs meet end-to-end on the road.
 */
function splitOverlapRuns(
  line: LatLon[],
  other: LatLon[],
  threshM: number,
): { solid: LatLon[][]; dashed: LatLon[][] } {
  if (line.length < 2) return { solid: [], dashed: [] };
  const overlap = line.map((p) => distToPolylineM(p, other) <= threshM);
  const solid: LatLon[][] = [];
  const dashed: LatLon[][] = [];
  let i = 0;
  while (i < line.length) {
    const isOverlap = overlap[i];
    const run: LatLon[] = [line[i]];
    let j = i + 1;
    while (j < line.length && overlap[j] === isOverlap) {
      run.push(line[j]);
      j++;
    }
    // Include the next vertex so adjacent solid/dashed pieces connect.
    if (j < line.length) run.push(line[j]);
    if (run.length >= 2) {
      (isOverlap ? dashed : solid).push(run);
    }
    i = j;
  }
  return { solid, dashed };
}

/** Dedicated panes: Express under Regular so dashed orange sits on shared blue. */
function RoutePanes() {
  const map = useMap();
  useEffect(() => {
    if (!map.getPane("routeExpress")) {
      const pane = map.createPane("routeExpress");
      pane.style.zIndex = "410";
    }
    if (!map.getPane("routeRegular")) {
      const pane = map.createPane("routeRegular");
      pane.style.zIndex = "420";
    }
  }, [map]);
  return null;
}

/**
 * Leaflet marker that eases toward each new GPS fix instead of jumping.
 * Drives setLatLng on the Leaflet instance so React isn't re-rendered every frame.
 */
function SmoothMarker({
  position,
  lineKey,
  color,
  label,
  bearing,
  showArrow,
  opacity,
  children,
}: {
  position: [number, number];
  lineKey: ShuttleKey | "oos";
  color: string;
  label: string;
  bearing: number | null;
  showArrow: boolean;
  opacity?: number;
  children?: ReactNode;
}) {
  const markerRef = useRef<L.Marker | null>(null);
  const displayRef = useRef<[number, number]>(position);
  const fromRef = useRef<[number, number]>(position);
  const toRef = useRef<[number, number]>(position);
  const startRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const primedRef = useRef(false);
  const iconPaintRef = useRef(`${lineKey}|${color}|${label}`);
  const lastBearingRef = useRef<number | null>(
    bearing != null && bearing >= 0 ? bearing : null,
  );
  const showArrowRef = useRef(showArrow);
  showArrowRef.current = showArrow;

  const initialIcon = useRef(busIcon(lineKey, color, label)).current;

  if (bearing != null && Number.isFinite(bearing) && bearing >= 0) {
    lastBearingRef.current = bearing;
  }

  const applyBearingTo = (marker: L.Marker) => {
    const ring = marker
      .getElement()
      ?.querySelector(".lark-bus-arrow-ring") as HTMLElement | null;
    if (!ring) return;
    const b = lastBearingRef.current;
    if (!showArrowRef.current || b == null || !Number.isFinite(b) || b < 0) {
      ring.style.opacity = "0";
      return;
    }
    ring.style.opacity = "1";
    ring.style.transform = `rotate(${((b % 360) + 360) % 360}deg)`;
  };

  const positionPrimeRef = useRef(position);
  positionPrimeRef.current = position;

  const setMarkerRef = useCallback((marker: L.Marker | null) => {
    markerRef.current = marker;
    if (!marker) return;
    if (!primedRef.current) {
      primedRef.current = true;
      const pos = positionPrimeRef.current;
      displayRef.current = pos;
      fromRef.current = pos;
      toRef.current = pos;
      marker.setLatLng(pos);
    }
    // Icon element may not exist until the marker is on the map.
    requestAnimationFrame(() => applyBearingTo(marker));
  }, []);

  // Unmount only — mid-flight retargets must not cancel the RAF loop.
  useEffect(() => {
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  // Rebuild icon only when paint identity changes (not every bearing tick).
  useEffect(() => {
    const marker = markerRef.current;
    if (!marker) return;
    const paint = `${lineKey}|${color}|${label}`;
    if (paint === iconPaintRef.current && primedRef.current) {
      applyBearingTo(marker);
      return;
    }
    iconPaintRef.current = paint;
    marker.setIcon(busIcon(lineKey, color, label));
    requestAnimationFrame(() => {
      if (markerRef.current) applyBearingTo(markerRef.current);
    });
  }, [lineKey, color, label]);

  // Ease heading via CSS transform on the existing arrow ring.
  useEffect(() => {
    const marker = markerRef.current;
    if (!marker) return;
    applyBearingTo(marker);
    const id = requestAnimationFrame(() => {
      if (markerRef.current) applyBearingTo(markerRef.current);
    });
    return () => cancelAnimationFrame(id);
  }, [bearing, showArrow]);

  useEffect(() => {
    const marker = markerRef.current;
    if (!marker) return;

    const next: [number, number] = [position[0], position[1]];
    const cur = displayRef.current;

    if (!primedRef.current) {
      primedRef.current = true;
      displayRef.current = next;
      fromRef.current = next;
      toRef.current = next;
      marker.setLatLng(next);
      return;
    }

    const jumpM = haversineM(cur, next);
    if (jumpM < 0.5) {
      toRef.current = next;
      return;
    }
    if (jumpM > SNAP_M) {
      displayRef.current = next;
      fromRef.current = next;
      toRef.current = next;
      startRef.current = 0;
      marker.setLatLng(next);
      return;
    }

    fromRef.current = cur;
    toRef.current = next;
    startRef.current = performance.now();

    if (rafRef.current != null) return; // loop already running; tick reads new from/to

    const tick = (now: number) => {
      const markerNow = markerRef.current;
      if (!markerNow) {
        rafRef.current = null;
        return;
      }
      if (startRef.current <= 0) {
        rafRef.current = null;
        return;
      }
      const t = Math.min(1, (now - startRef.current) / SMOOTH_MS);
      const e = easeOutCubic(t);
      const from = fromRef.current;
      const to = toRef.current;
      const pos: [number, number] = [
        from[0] + (to[0] - from[0]) * e,
        from[1] + (to[1] - from[1]) * e,
      ];
      displayRef.current = pos;
      markerNow.setLatLng(pos);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
        startRef.current = 0;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [position[0], position[1]]);

  return (
    <Marker
      ref={setMarkerRef}
      position={displayRef.current}
      icon={initialIcon}
      opacity={opacity}
    >
      {children}
    </Marker>
  );
}

export default function ShuttleMap({
  routes,
  shuttles,
  fleet = [],
  focus,
  holdSlots,
}: Props) {
  const showExpress = focus === "both" || focus === "express";
  const showRegular = focus === "both" || focus === "regular";
  const bothVisible = showExpress && showRegular;

  // Shared corridor (~same road): keep geometry on the road; dash only there.
  // Solo stretches stay solid. Dash phases are offset so blue/orange alternate.
  const OVERLAP_M = 28;
  const routePieces = useMemo(() => {
    if (!routes) {
      return {
        expressSolid: [] as LatLon[][],
        expressDash: [] as LatLon[][],
        regularSolid: [] as LatLon[][],
        regularDash: [] as LatLon[][],
      };
    }
    if (!bothVisible) {
      return {
        expressSolid: showExpress ? [routes.express.line] : [],
        expressDash: [] as LatLon[][],
        regularSolid: showRegular ? [routes.regular.line] : [],
        regularDash: [] as LatLon[][],
      };
    }
    const ex = splitOverlapRuns(
      routes.express.line,
      routes.regular.line,
      OVERLAP_M,
    );
    const rg = splitOverlapRuns(
      routes.regular.line,
      routes.express.line,
      OVERLAP_M,
    );
    return {
      expressSolid: ex.solid,
      expressDash: ex.dashed,
      regularSolid: rg.solid,
      regularDash: rg.dashed,
    };
  }, [routes, bothVisible, showExpress, showRegular]);

  // Prefer fleet markers (includes OOS). Fall back to service shuttles.
  const markers =
    fleet.length > 0
      ? fleet
          .filter((v) => v.lat != null && v.lon != null)
          .map((v) => {
            const service = v.inferredService;
            const visible =
              focus === "both"
                ? true
                : service != null
                  ? service === focus
                  : false;
            return { kind: "fleet" as const, v, visible };
          })
      : shuttles
          .filter((s) => s.lat != null && s.lon != null && s.rideable)
          .map((s) => ({
            kind: "shuttle" as const,
            s,
            visible: focus === "both" || focus === s.key,
          }));

  return (
    <div className={styles.mapRoot}>
      <MapContainer
        center={[35.91, -79.05]}
        zoom={14}
        className={styles.map}
        zoomControl={false}
        attributionControl={true}
      >
        <TileLayer
          attribution='Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ'
          url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"
          maxZoom={16}
        />
        <TileLayer
          attribution=""
          url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}"
          maxZoom={16}
          opacity={0.85}
        />
        <FitToRoutes routes={routes} focus={focus} />
        <RoutePanes />

        {routes &&
          routePieces.expressSolid.map((line, i) => (
            <Polyline
              key={`ex-solid-${i}`}
              positions={line}
              pathOptions={{
                pane: "routeExpress",
                color: routes.express.color,
                weight: 4,
                opacity: 0.9,
                lineCap: "round",
                lineJoin: "round",
              }}
            />
          ))}
        {routes &&
          routePieces.regularSolid.map((line, i) => (
            <Polyline
              key={`rg-solid-${i}`}
              positions={line}
              pathOptions={{
                pane: "routeRegular",
                color: routes.regular.color,
                weight: 4,
                opacity: 0.9,
                lineCap: "round",
                lineJoin: "round",
              }}
            />
          ))}
        {routes &&
          routePieces.expressDash.map((line, i) => (
            <Polyline
              key={`ex-dash-${i}`}
              positions={line}
              pathOptions={{
                pane: "routeExpress",
                color: routes.express.color,
                weight: 4,
                opacity: 0.95,
                lineCap: "butt",
                lineJoin: "round",
                dashArray: "12 12",
                dashOffset: "0",
              }}
            />
          ))}
        {routes &&
          routePieces.regularDash.map((line, i) => (
            <Polyline
              key={`rg-dash-${i}`}
              positions={line}
              pathOptions={{
                pane: "routeRegular",
                color: routes.regular.color,
                weight: 4,
                opacity: 0.95,
                lineCap: "butt",
                lineJoin: "round",
                // Phase-shifted so orange fills the gaps in the blue dashes.
                dashArray: "12 12",
                dashOffset: "12",
              }}
            />
          ))}

        {routes &&
          (showExpress ? routes.express.stops : [])
            .concat(showRegular ? routes.regular.stops : [])
            .filter(
              (s, i, arr) =>
                arr.findIndex((x) => x.key === s.key && x.lat === s.lat) === i,
            )
            .map((stop) => (
              <CircleMarker
                key={`${stop.key}-${stop.lat}`}
                center={[stop.lat, stop.lon]}
                radius={5}
                pathOptions={{
                  color: "#f3ebe0",
                  weight: 1,
                  fillColor: "#e8dcc4",
                  fillOpacity: 0.9,
                }}
              >
                <Tooltip direction="top" offset={[0, -6]}>
                  {stop.name}
                </Tooltip>
              </CircleMarker>
            ))}

        {markers.map((m) => {
          if (!m.visible) return null;
          if (m.kind === "fleet") {
            const v = m.v;
            if (v.lat == null || v.lon == null) return null;
            const service = v.inferredService;
            const paint = v.rideable && service ? SHUTTLES[service] : null;
            const color = paint?.color ?? "#6b7280";
            const label = paint?.bullet ?? "·";
            // Keep arrow while rideable off-curb; SmoothMarker holds last heading
            // when Motive briefly sends a null bearing (e.g. idle / light).
            const showArrow = v.rideable && !v.atLark;
            return (
              <SmoothMarker
                key={`fleet-${v.vehicleKey}`}
                position={[v.lat, v.lon]}
                lineKey={paint?.key ?? "oos"}
                color={color}
                label={label}
                bearing={v.bearing}
                showArrow={showArrow}
                opacity={v.rideable ? 1 : 0.55}
              >
                <Tooltip direction="top" offset={[0, -12]} permanent={false}>
                  <strong>
                    {v.vehicleNumber ?? vehicleLabel(v.vehicleKey)}
                  </strong>
                  <br />
                  {v.rideable
                    ? `Running ${service ? SHUTTLES[service].name : "—"}`
                    : v.statusReason ?? "Not rideable"}
                  {v.speed ? ` · ${v.speed}` : ""}
                  {v.assignmentNote ? (
                    <>
                      <br />
                      {v.assignmentNote}
                    </>
                  ) : null}
                </Tooltip>
              </SmoothMarker>
            );
          }

          const s = m.s;
          if (s.lat == null || s.lon == null) return null;
          const meta = SHUTTLES[s.key];
          const showArrow = s.rideable && !s.atLark;
          return (
            <SmoothMarker
              key={s.key}
              position={[s.lat, s.lon]}
              lineKey={s.key}
              color={meta.color}
              label={meta.bullet}
              bearing={s.bearing}
              showArrow={showArrow}
            >
              <Tooltip direction="top" offset={[0, -12]} permanent={false}>
                <strong>{s.name}</strong>
                <br />
                {s.atLark ? "at Lark" : s.state}
                {s.speed ? ` · ${s.speed}` : ""}
                {s.assignmentNote ? (
                  <>
                    <br />
                    {s.assignmentNote}
                  </>
                ) : null}
                {s.atLark ? (
                  <>
                    <br />
                    {s.larkSchedule && isLatePickup(s.larkSchedule)
                      ? "Boarding · leaving shortly"
                      : holdSlots?.[s.key] != null
                        ? "Holding for scheduled departure"
                        : "At Lark"}
                  </>
                ) : s.nextStop ? (
                  <>
                    <br />
                    Next: {s.nextStop.name}
                    {s.nextStop.etaMin != null
                      ? ` (~${s.nextStop.etaMin} min)`
                      : ""}
                  </>
                ) : null}
              </Tooltip>
            </SmoothMarker>
          );
        })}
      </MapContainer>
    </div>
  );
}
