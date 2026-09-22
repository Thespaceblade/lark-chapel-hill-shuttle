"use client";

import { useEffect, useMemo } from "react";
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
import type { LiveShuttle, ShuttleKey } from "@/lib/shuttles";
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
  focus: ShuttleKey | "both";
};

function FitBounds({
  routes,
  shuttles,
  focus,
}: {
  routes: RoutesResponse | null;
  shuttles: LiveShuttle[];
  focus: ShuttleKey | "both";
}) {
  const map = useMap();
  useEffect(() => {
    const pts: [number, number][] = [];
    if (routes) {
      if (focus === "both" || focus === "express") pts.push(...routes.express.line);
      if (focus === "both" || focus === "regular") pts.push(...routes.regular.line);
    }
    for (const s of shuttles) {
      if (s.lat != null && s.lon != null) {
        if (focus === "both" || focus === s.key) pts.push([s.lat, s.lon]);
      }
    }
    if (pts.length >= 2) {
      map.fitBounds(pts, { padding: [48, 48], maxZoom: 15 });
    } else if (pts.length === 1) {
      map.setView(pts[0], 14);
    }
  }, [map, routes, shuttles, focus]);
  return null;
}

function busIcon(color: string, label: string) {
  return L.divIcon({
    className: styles.busIconWrap,
    html: `<div class="${styles.busIcon}" style="--bus:${color}"><span>${label}</span></div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

export default function ShuttleMap({ routes, shuttles, focus }: Props) {
  const showExpress = focus === "both" || focus === "express";
  const showRegular = focus === "both" || focus === "regular";

  const icons = useMemo(
    () => ({
      express: busIcon(SHUTTLES.express.color, "E"),
      regular: busIcon(SHUTTLES.regular.color, "R"),
    }),
    [],
  );

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
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        />
        <FitBounds routes={routes} shuttles={shuttles} focus={focus} />

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

        {shuttles.map((s) => {
          if (s.lat == null || s.lon == null) return null;
          if (focus !== "both" && focus !== s.key) return null;
          return (
            <Marker
              key={s.key}
              position={[s.lat, s.lon]}
              icon={icons[s.key]}
            >
              <Tooltip direction="top" offset={[0, -12]} permanent={false}>
                <strong>{s.name}</strong>
                <br />
                {s.state}
                {s.speed ? ` · ${s.speed}` : ""}
                {s.nextStop ? (
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
