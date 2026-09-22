"use client";

import { useEffect } from "react";
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
import { SHUTTLES } from "@/lib/shuttles";
import "leaflet/dist/leaflet.css";
import styles from "./ShuttleMap.module.css";

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
  bearing: number | null,
  showArrow: boolean,
) {
  const rot =
    showArrow && bearing != null && Number.isFinite(bearing)
      ? ((bearing % 360) + 360) % 360
      : null;
  const arrow =
    rot == null
      ? ""
      : `<div class="${styles.busArrowRing}" style="transform:rotate(${rot}deg)">
           <div class="${styles.busArrow}" data-line="${key === "oos" ? "express" : key}"></div>
         </div>`;
  return L.divIcon({
    className: styles.busIconWrap,
    html: `<div class="${styles.busMarker}">
      ${arrow}
      <div class="${styles.busIcon}" style="--bus:${color}"><span>${label}</span></div>
    </div>`,
    iconSize: [44, 44],
    iconAnchor: [22, 22],
  });
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

        {routes && showExpress ? (
          <Polyline
            positions={routes.express.line}
            pathOptions={{
              color: routes.express.color,
              weight: 4,
              opacity: 0.75,
            }}
          />
        ) : null}
        {routes && showRegular ? (
          <Polyline
            positions={routes.regular.line}
            pathOptions={{
              color: routes.regular.color,
              weight: 4,
              opacity: 0.75,
            }}
          />
        ) : null}

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
            const moving =
              v.rideable &&
              (v.state || "").toLowerCase() === "moving" &&
              !v.atLark;
            const icon = busIcon(
              paint?.key ?? "oos",
              color,
              label,
              v.bearing,
              moving,
            );
            return (
              <Marker
                key={`fleet-${v.homeKey}`}
                position={[v.lat, v.lon]}
                icon={icon}
                opacity={v.rideable ? 1 : 0.55}
              >
                <Tooltip direction="top" offset={[0, -12]} permanent={false}>
                  <strong>{v.vehicleNumber ?? SHUTTLES[v.homeKey].name}</strong>
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
              </Marker>
            );
          }

          const s = m.s;
          if (s.lat == null || s.lon == null) return null;
          const meta = SHUTTLES[s.key];
          const moving =
            (s.state || "").toLowerCase() === "moving" && !s.atLark;
          const icon = busIcon(
            s.key,
            meta.color,
            meta.bullet,
            s.bearing,
            moving,
          );
          return (
            <Marker key={s.key} position={[s.lat, s.lon]} icon={icon}>
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
                    {holdSlots?.[s.key] != null
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
            </Marker>
          );
        })}
      </MapContainer>
    </div>
  );
}
