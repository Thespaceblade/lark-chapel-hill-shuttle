import type { Stop } from "./shuttles";

const EARTH_M = 6_371_000;

function haversineM(a: [number, number], b: [number, number]): number {
  const lat1 = (a[0] * Math.PI) / 180;
  const lon1 = (a[1] * Math.PI) / 180;
  const lat2 = (b[0] * Math.PI) / 180;
  const lon2 = (b[1] * Math.PI) / 180;
  const dlat = lat2 - lat1;
  const dlon = lon2 - lon1;
  const h =
    Math.sin(dlat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.sqrt(h));
}

function toXy(lat: number, lon: number, lat0: number, lon0: number) {
  const x =
    ((lon - lon0) * Math.PI) / 180 * Math.cos((lat0 * Math.PI) / 180) * EARTH_M;
  const y = ((lat - lat0) * Math.PI) / 180 * EARTH_M;
  return { x, y };
}

function fromXy(x: number, y: number, lat0: number, lon0: number): [number, number] {
  const lat = lat0 + (y / EARTH_M) * (180 / Math.PI);
  const lon =
    lon0 +
    (x / (EARTH_M * Math.cos((lat0 * Math.PI) / 180))) * (180 / Math.PI);
  return [lat, lon];
}

export type Projection = {
  lat: number;
  lon: number;
  sM: number;
  offsetM: number;
  loopFrac: number;
};

export class RouteLoop {
  readonly name: string;
  readonly stops: Stop[];
  readonly points: [number, number][];
  readonly cum: number[];
  readonly lengthM: number;
  private lat0: number;
  private lon0: number;
  private xy: { x: number; y: number }[];

  constructor(
    name: string,
    line: [number, number][],
    stops: Stop[] = [],
    close = true,
  ) {
    if (line.length < 2) throw new Error("loop needs >= 2 points");
    const pts: [number, number][] = line.map(([lat, lon]) => [lat, lon]);
    if (close && haversineM(pts[0], pts[pts.length - 1]) > 5) {
      pts.push([...pts[0]]);
    } else if (close) {
      pts[pts.length - 1] = [...pts[0]];
    }
    this.name = name;
    this.stops = stops;
    this.points = pts;
    this.cum = [0];
    for (let i = 0; i < pts.length - 1; i++) {
      this.cum.push(this.cum[i] + haversineM(pts[i], pts[i + 1]));
    }
    this.lengthM = this.cum[this.cum.length - 1];
    this.lat0 = pts[0][0];
    this.lon0 = pts[0][1];
    this.xy = pts.map(([lat, lon]) => toXy(lat, lon, this.lat0, this.lon0));
  }

  project(lat: number, lon: number): Projection {
    const p = toXy(lat, lon, this.lat0, this.lon0);
    let bestD2 = Infinity;
    let bestI = 0;
    let bestT = 0;
    let bestXy = this.xy[0];

    for (let i = 0; i < this.xy.length - 1; i++) {
      const a = this.xy[i];
      const b = this.xy[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const seg2 = dx * dx + dy * dy;
      let t = 0;
      let qx = a.x;
      let qy = a.y;
      if (seg2 > 1e-12) {
        t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / seg2));
        qx = a.x + t * dx;
        qy = a.y + t * dy;
      }
      const d2 = (p.x - qx) ** 2 + (p.y - qy) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestI = i;
        bestT = t;
        bestXy = { x: qx, y: qy };
      }
    }

    const snap = fromXy(bestXy.x, bestXy.y, this.lat0, this.lon0);
    let sM =
      this.cum[bestI] + bestT * (this.cum[bestI + 1] - this.cum[bestI]);
    if (sM >= this.lengthM) sM = 0;
    return {
      lat: snap[0],
      lon: snap[1],
      sM,
      offsetM: Math.sqrt(bestD2),
      loopFrac: sM / this.lengthM,
    };
  }

  nextStop(
    proj: Projection,
  ): { key: string; name: string; alongM: number } | null {
    if (!this.stops.length) return null;
    const atStopM = 35;
    let best: { key: string; name: string; alongM: number } | null = null;
    let bestAlong = Infinity;

    for (const stop of this.stops) {
      const sp = this.project(stop.lat, stop.lon);
      let ahead = (sp.sM - proj.sM) % this.lengthM;
      if (ahead < 0) ahead += this.lengthM;
      if (ahead < atStopM) continue;
      if (ahead < bestAlong) {
        bestAlong = ahead;
        best = { key: stop.key, name: stop.name, alongM: ahead };
      }
    }

    if (!best) {
      for (const stop of this.stops) {
        const sp = this.project(stop.lat, stop.lon);
        let ahead = (sp.sM - proj.sM) % this.lengthM;
        if (ahead < 0) ahead += this.lengthM;
        if (ahead < 1) ahead = this.lengthM;
        if (ahead < bestAlong) {
          bestAlong = ahead;
          best = { key: stop.key, name: stop.name, alongM: ahead };
        }
      }
    }
    return best;
  }
}

export function etaMinutes(
  alongM: number,
  speedMph: number | null,
  fallbackMph = 12,
): number {
  const mph = speedMph && speedMph > 1 ? speedMph : fallbackMph;
  const mps = mph * 0.44704;
  return alongM / mps / 60;
}

export function parseSpeedMph(speed: string | null | undefined): number | null {
  if (!speed) return null;
  const m = speed.match(/([\d.]+)/);
  return m ? Number(m[1]) : null;
}
