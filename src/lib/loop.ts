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

/** Angle difference in degrees, 0–180. */
function bearingDiffDeg(a: number, b: number): number {
  return Math.abs(((((a - b) % 360) + 540) % 360) - 180);
}

/** Segment bearing in degrees clockwise from north. */
function segmentBearingDeg(
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax; // east
  const dy = by - ay; // north
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
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
  /** First service encounter of each stop along the loop from route start. */
  readonly stopSM: Map<string, number>;
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
    this.stopSM = new Map();
    for (const stop of stops) {
      const passages = this.passagesNearStop(stop);
      const primary = passages.length
        ? Math.min(...passages.map((p) => p.sM))
        : this.project(stop.lat, stop.lon).sM;
      this.stopSM.set(stop.key, primary);
    }
  }

  /**
   * Places along the polyline that pass near a stop pin.
   * Overlapping out-and-back / return legs create multiple passages; service
   * uses the earliest (primary) so a return past Memorial is not a stop again.
   */
  passagesNearStop(
    stop: Stop,
    maxOffsetM = 45,
    clusterGapM = 80,
  ): { sM: number; offsetM: number }[] {
    const p = toXy(stop.lat, stop.lon, this.lat0, this.lon0);
    const hits: { sM: number; offsetM: number }[] = [];
    for (let i = 0; i < this.xy.length - 1; i++) {
      const a = this.xy[i];
      const b = this.xy[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const seg2 = dx * dx + dy * dy;
      let t = 0;
      if (seg2 > 1e-12) {
        t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / seg2));
      }
      const qx = a.x + t * dx;
      const qy = a.y + t * dy;
      const offsetM = Math.hypot(p.x - qx, p.y - qy);
      if (offsetM <= maxOffsetM) {
        const sM = this.cum[i] + t * (this.cum[i + 1] - this.cum[i]);
        hits.push({ sM: sM % this.lengthM, offsetM });
      }
    }
    if (!hits.length) return [];
    hits.sort((a, b) => a.sM - b.sM);
    const clusters: { sM: number; offsetM: number }[][] = [];
    let cur: { sM: number; offsetM: number }[] = [hits[0]];
    for (let i = 1; i < hits.length; i++) {
      if (hits[i].sM - cur[cur.length - 1].sM > clusterGapM) {
        clusters.push(cur);
        cur = [hits[i]];
      } else {
        cur.push(hits[i]);
      }
    }
    clusters.push(cur);
    return clusters.map((c) =>
      c.reduce((best, h) => (h.offsetM < best.offsetM ? h : best)),
    );
  }

  /**
   * Snap a position onto the loop. When `bearingDeg` is set (Motive heading),
   * prefer segments traveling the same direction — critical where outbound and
   * return share the same road near Memorial / Columbia.
   */
  project(
    lat: number,
    lon: number,
    bearingDeg: number | null = null,
  ): Projection {
    const p = toXy(lat, lon, this.lat0, this.lon0);
    let bestScore = Infinity;
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
      let score = d2;
      if (bearingDeg != null && Number.isFinite(bearingDeg) && bearingDeg >= 0 && seg2 > 1e-6) {
        const segBrg = segmentBearingDeg(a.x, a.y, b.x, b.y);
        const diff = bearingDiffDeg(segBrg, bearingDeg);
        // ~30 m penalty at opposite heading — breaks outbound/return ties.
        score = d2 + (diff / 180) ** 2 * 30 ** 2;
      }
      if (score < bestScore) {
        bestScore = score;
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
      const sp = this.stopSM.get(stop.key) ?? this.project(stop.lat, stop.lon).sM;
      let ahead = (sp - proj.sM) % this.lengthM;
      if (ahead < 0) ahead += this.lengthM;
      if (ahead < atStopM) continue;
      if (ahead < bestAlong) {
        bestAlong = ahead;
        best = { key: stop.key, name: stop.name, alongM: ahead };
      }
    }

    if (!best) {
      for (const stop of this.stops) {
        const sp = this.stopSM.get(stop.key) ?? this.project(stop.lat, stop.lon).sM;
        let ahead = (sp - proj.sM) % this.lengthM;
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
  state: string | null = null,
): number {
  const mph = effectiveSpeedMph(speedMph, state);
  const mps = mph * 0.44704;
  return alongM / mps / 60;
}

/**
 * Campus-shuttle speed for ETA. Instant Motive speed is noisy:
 * idle → typical cruise; slow → trust live; fast → clamp + blend.
 */
export const ETA_TYPICAL_MPH = 13;
export const ETA_MAX_MPH = 18;

/** Soft caps on how fast a displayed ETA may move between polls. */
export const ETA_SMOOTH_MAX_UP_MIN = 1.1;
export const ETA_SMOOTH_MAX_DOWN_MIN = 2.25;
/** Believe drops (approaching) faster than spikes (crawl / snap). */
export const ETA_SMOOTH_ALPHA_UP = 0.22;
export const ETA_SMOOTH_ALPHA_DOWN = 0.48;

export type EtaSmoothState = {
  stopKey: string;
  etaMin: number;
  atMs: number;
};

/**
 * Dampen brief ETA spikes that do not last.
 * Same next-stop: rate-limit then asymmetric EMA. New stop: adopt raw.
 */
export function smoothEtaMinutes(
  rawEtaMin: number,
  stopKey: string,
  prev: EtaSmoothState | null | undefined,
  nowMs: number = Date.now(),
): EtaSmoothState {
  const raw = Math.max(0, rawEtaMin);
  if (!prev || prev.stopKey !== stopKey) {
    return { stopKey, etaMin: raw, atMs: nowMs };
  }

  const dtSec = Math.max(0.35, (nowMs - prev.atMs) / 1000);
  // Scale step limits with poll gap so 1s vs 10s collectors stay comparable.
  const maxUp = ETA_SMOOTH_MAX_UP_MIN * Math.min(2.5, dtSec / 1.0);
  const maxDown = ETA_SMOOTH_MAX_DOWN_MIN * Math.min(2.5, dtSec / 1.0);
  const delta = Math.max(-maxDown, Math.min(maxUp, raw - prev.etaMin));
  const stepped = prev.etaMin + delta;
  const alpha =
    stepped >= prev.etaMin ? ETA_SMOOTH_ALPHA_UP : ETA_SMOOTH_ALPHA_DOWN;
  const etaMin = Math.max(0, alpha * stepped + (1 - alpha) * prev.etaMin);
  return { stopKey, etaMin, atMs: nowMs };
}

/** Integer board minutes with hysteresis so 4.4↔4.6 does not flicker 4/5. */
export function displayEtaMinutes(
  etaMin: number,
  prevDisplayed: number | null | undefined,
): number {
  const rounded = Math.max(0, Math.round(etaMin));
  if (prevDisplayed == null || !Number.isFinite(prevDisplayed)) return rounded;
  if (rounded === prevDisplayed) return prevDisplayed;
  if (rounded > prevDisplayed) {
    return etaMin >= prevDisplayed + 0.65 ? rounded : prevDisplayed;
  }
  return etaMin <= prevDisplayed - 0.65 ? rounded : prevDisplayed;
}

export function effectiveSpeedMph(
  speedMph: number | null,
  state: string | null = null,
): number {
  const st = (state || "").toLowerCase();
  const live =
    speedMph != null && Number.isFinite(speedMph) ? speedMph : null;
  const isMoving = st === "moving" || (st === "" && live != null && live > 1);

  if (!isMoving || live == null || live <= 1) {
    return ETA_TYPICAL_MPH;
  }

  const capped = Math.min(ETA_MAX_MPH, live);
  if (capped < ETA_TYPICAL_MPH) return capped;
  return 0.55 * capped + 0.45 * ETA_TYPICAL_MPH;
}

export function parseSpeedMph(speed: string | null | undefined): number | null {
  if (!speed) return null;
  const m = speed.match(/([\d.]+)/);
  return m ? Number(m[1]) : null;
}
