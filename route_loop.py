"""Project GPS pings onto a predetermined shuttle loop and infer travel along it.

Given two observations, even if they sit far off the drawn path, snap each to the
nearest point on the loop and treat the forward arc between those snaps as the
path the bus travelled.
"""

from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

DEFAULT_ROUTES = Path(__file__).resolve().parent / "intended_routes.json"
DEFAULT_ASSIGNMENT = Path(__file__).resolve().parent / "data" / "route_assignment.json"
EARTH_M = 6_371_000.0
ROUTE_CANDIDATES = ("express", "regular")
# Prefer a loop when median off is clearly better by this much (meters).
AUTO_MARGIN_M = 25.0
# Treat a ping as "on" a loop when offset ≤ this (matches web ON_ROUTE_MAX_M).
ON_ROUTE_MAX_M = 90.0


def load_route_assignment(path: Path | None = None) -> dict[str, Any]:
    """Load assignment config: mode + optional per-vehicle overrides."""
    path = path or DEFAULT_ASSIGNMENT
    if not path.exists():
        return {"mode": "auto", "vehicle_to_route": {}}
    data = json.loads(path.read_text())
    mapping = data.get("vehicle_to_route") or {}
    return {
        "mode": str(data.get("mode") or "auto").lower(),
        "vehicle_to_route": {str(k): str(v) for k, v in mapping.items()},
        "notes": data.get("notes"),
        "updated_at": data.get("updated_at"),
    }


def infer_route_from_pings(
    vehicle_key: str,
    pings: Sequence[dict[str, Any]],
    *,
    routes_path: Path | None = None,
    margin_m: float = AUTO_MARGIN_M,
) -> tuple[str, dict[str, Any]]:
    """Pick loop geometry from GPS fit. Returns (route_key, diagnostics)."""
    routes_path = routes_path or DEFAULT_ROUTES
    usable = [
        p
        for p in pings
        if p.get("lat") is not None and p.get("lon") is not None
    ]
    diag: dict[str, Any] = {
        "mode": "auto",
        "ping_count": len(usable),
        "fits": {},
        "reason": None,
    }
    if not usable:
        diag["reason"] = "no_pings_default_home"
        return vehicle_key, diag

    fits: dict[str, dict[str, float]] = {}
    for key in ROUTE_CANDIDATES:
        loop = RouteLoop.from_routes_file(key, routes_path)
        offs = [
            loop.project(float(p["lat"]), float(p["lon"])).offset_m for p in usable
        ]
        offs_sorted = sorted(offs)
        mid = offs_sorted[len(offs_sorted) // 2]
        p90 = offs_sorted[max(0, int(0.9 * len(offs_sorted)) - 1)]
        on_frac = sum(1 for o in offs if o <= ON_ROUTE_MAX_M) / len(offs)
        fits[key] = {
            "median_off_m": round(mid, 1),
            "p90_off_m": round(p90, 1),
            "on_route_frac": round(on_frac, 3),
        }
    diag["fits"] = fits

    # Rank by median offset (closer wins).
    ranked = sorted(ROUTE_CANDIDATES, key=lambda k: fits[k]["median_off_m"])
    best, second = ranked[0], ranked[1]
    best_m = fits[best]["median_off_m"]
    second_m = fits[second]["median_off_m"]
    gap = second_m - best_m
    best_on = fits[best]["on_route_frac"]
    second_on = fits[second]["on_route_frac"]

    if gap >= margin_m:
        diag["reason"] = f"clearer_fit:{best}_by_{gap:.0f}m"
        return best, diag

    # More pings actually on one loop (shared corridor can fool median alone).
    if best_on - second_on >= 0.2:
        diag["reason"] = f"clearer_on_frac:{best}"
        return best, diag

    home_m = fits.get(vehicle_key, {}).get("median_off_m", float("inf"))
    home_on = fits.get(vehicle_key, {}).get("on_route_frac", 0.0)

    # Home paint is not actually on its loop — take the closer service.
    if home_m > ON_ROUTE_MAX_M or home_on < 0.5:
        diag["reason"] = f"home_off_prefer:{best}"
        return best, diag

    # Ambiguous shared corridor / Lark: prefer usual role.
    if home_m <= ON_ROUTE_MAX_M * 1.5:
        diag["reason"] = "ambiguous_prefer_home"
        return vehicle_key, diag

    diag["reason"] = f"ambiguous_prefer_closer:{best}"
    return best, diag


def resolve_route_key(
    vehicle_key: str,
    *,
    on_route: str | None = None,
    assignment_path: Path | None = None,
    pings: Sequence[dict[str, Any]] | None = None,
    routes_path: Path | None = None,
) -> tuple[str, dict[str, Any]]:
    """Which intended_routes geometry to use for this Motive vehicle.

    Priority: ``--on-route`` override → static map value (if not auto) →
    GPS auto-infer from ``pings`` → vehicle home key.
    """
    if on_route:
        return on_route, {"mode": "override", "reason": "cli_on_route"}

    cfg = load_route_assignment(assignment_path)
    mapped = (cfg.get("vehicle_to_route") or {}).get(vehicle_key)
    # Explicit fixed mapping wins over auto (e.g. "express": "regular").
    if mapped and mapped.lower() not in ("auto", ""):
        return mapped, {
            "mode": "static",
            "reason": f"assignment:{vehicle_key}->{mapped}",
        }

    mode = cfg.get("mode") or "auto"
    if mode == "auto" and pings is not None:
        return infer_route_from_pings(
            vehicle_key, pings, routes_path=routes_path
        )

    # auto with no pings, or mode=home / unknown → identity
    return vehicle_key, {
        "mode": mode if mode != "auto" else "home",
        "reason": "default_home",
    }


def haversine_m(a: Sequence[float], b: Sequence[float]) -> float:
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    h = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    )
    return 2 * EARTH_M * math.asin(math.sqrt(h))


def _to_xy_m(lat: float, lon: float, lat0: float, lon0: float) -> tuple[float, float]:
    """Local equirectangular meters around (lat0, lon0)."""
    x = math.radians(lon - lon0) * math.cos(math.radians(lat0)) * EARTH_M
    y = math.radians(lat - lat0) * EARTH_M
    return x, y


def _from_xy_m(x: float, y: float, lat0: float, lon0: float) -> list[float]:
    lat = lat0 + math.degrees(y / EARTH_M)
    lon = lon0 + math.degrees(x / (EARTH_M * math.cos(math.radians(lat0))))
    return [lat, lon]


@dataclass(frozen=True)
class Projection:
    lat: float
    lon: float
    s_m: float
    offset_m: float
    segment_i: int
    t: float  # 0..1 along that segment
    loop_frac: float  # 0..1 around the full loop

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class LoopTravel:
    from_proj: Projection
    to_proj: Projection
    forward_m: float
    forward_frac: float
    path: list[list[float]]  # [lat, lon] along the loop, inclusive

    def as_dict(self) -> dict[str, Any]:
        return {
            "from": self.from_proj.as_dict(),
            "to": self.to_proj.as_dict(),
            "forward_m": round(self.forward_m, 1),
            "forward_frac": round(self.forward_frac, 4),
            "path_points": len(self.path),
            "path": self.path,
        }


class RouteLoop:
    """Closed (or nearly closed) polyline parameterized by arc length."""

    def __init__(
        self,
        line: Sequence[Sequence[float]],
        *,
        name: str = "loop",
        stops: Sequence[dict[str, Any]] | None = None,
        close: bool = True,
    ) -> None:
        if len(line) < 2:
            raise ValueError("loop needs at least 2 points")
        pts = [[float(p[0]), float(p[1])] for p in line]
        if close and haversine_m(pts[0], pts[-1]) > 5.0:
            pts.append(pts[0][:])
        elif close and haversine_m(pts[0], pts[-1]) <= 5.0:
            pts[-1] = pts[0][:]

        self.name = name
        self.stops = list(stops or [])
        self.points = pts
        self.cum: list[float] = [0.0]
        for i in range(len(pts) - 1):
            self.cum.append(self.cum[-1] + haversine_m(pts[i], pts[i + 1]))
        self.length_m = self.cum[-1]
        if self.length_m <= 0:
            raise ValueError("loop has zero length")

        # local projection origin
        self._lat0 = pts[0][0]
        self._lon0 = pts[0][1]
        self._xy = [_to_xy_m(p[0], p[1], self._lat0, self._lon0) for p in pts]

    @classmethod
    def from_routes_file(
        cls,
        key: str,
        path: Path | None = None,
    ) -> "RouteLoop":
        path = path or DEFAULT_ROUTES
        data = json.loads(path.read_text())
        if key not in data or not isinstance(data[key], dict):
            known = [k for k in data if isinstance(data.get(k), dict) and "line" in data[k]]
            raise KeyError(f"No route '{key}' in {path}. Known: {known}")
        route = data[key]
        return cls(route["line"], name=key, stops=route.get("stops") or [], close=True)

    def project(self, lat: float, lon: float) -> Projection:
        px, py = _to_xy_m(lat, lon, self._lat0, self._lon0)
        best_d2 = float("inf")
        best_i = 0
        best_t = 0.0
        best_xy = self._xy[0]

        for i in range(len(self._xy) - 1):
            ax, ay = self._xy[i]
            bx, by = self._xy[i + 1]
            dx, dy = bx - ax, by - ay
            seg2 = dx * dx + dy * dy
            if seg2 <= 1e-12:
                t = 0.0
                qx, qy = ax, ay
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg2))
                qx, qy = ax + t * dx, ay + t * dy
            d2 = (px - qx) ** 2 + (py - qy) ** 2
            if d2 < best_d2:
                best_d2 = d2
                best_i = i
                best_t = t
                best_xy = (qx, qy)

        snap = _from_xy_m(best_xy[0], best_xy[1], self._lat0, self._lon0)
        s_m = self.cum[best_i] + best_t * (self.cum[best_i + 1] - self.cum[best_i])
        # Prefer s in [0, length) for a closed loop
        if s_m >= self.length_m:
            s_m = 0.0
        offset_m = math.sqrt(best_d2)
        return Projection(
            lat=snap[0],
            lon=snap[1],
            s_m=s_m,
            offset_m=offset_m,
            segment_i=best_i,
            t=best_t,
            loop_frac=s_m / self.length_m,
        )

    def point_at(self, s_m: float) -> list[float]:
        s = s_m % self.length_m
        # binary search cum
        lo, hi = 0, len(self.cum) - 1
        while lo < hi:
            mid = (lo + hi) // 2
            if self.cum[mid] <= s:
                lo = mid + 1
            else:
                hi = mid
        i = max(0, lo - 1)
        if i >= len(self.points) - 1:
            return self.points[-1][:]
        seg = self.cum[i + 1] - self.cum[i]
        t = 0.0 if seg <= 0 else (s - self.cum[i]) / seg
        a, b = self.points[i], self.points[i + 1]
        return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]

    def nearest_stop(self, proj: Projection) -> dict[str, Any] | None:
        if not self.stops:
            return None
        best = None
        best_d = float("inf")
        for stop in self.stops:
            sp = self.project(float(stop["lat"]), float(stop["lon"]))
            # forward distance along loop from stop to ping
            ahead = (proj.s_m - sp.s_m) % self.length_m
            back = (sp.s_m - proj.s_m) % self.length_m
            d = min(ahead, back)
            if d < best_d:
                best_d = d
                best = {
                    "key": stop.get("key"),
                    "name": stop.get("name"),
                    "along_m": round(d, 1),
                    "stop_s_m": round(sp.s_m, 1),
                }
        return best

    def forward_distance(self, s_from: float, s_to: float) -> float:
        return (s_to - s_from) % self.length_m

    def slice_forward(self, s_from: float, s_to: float) -> tuple[list[list[float]], float]:
        """Vertices along the loop travelling forward from s_from to s_to."""
        dist = self.forward_distance(s_from, s_to)
        if dist < 1e-6:
            p = self.point_at(s_from)
            return [p, p[:]], 0.0

        start = s_from % self.length_m
        end = (s_from + dist) % self.length_m
        path = [self.point_at(start)]

        # walk vertices with cum in (start, start+dist] on unwrapped axis
        unwrap_end = start + dist
        for i, c in enumerate(self.cum):
            # consider this vertex once per wrap if needed
            for wrap in (0.0, self.length_m):
                sc = c + wrap
                if start < sc <= unwrap_end + 1e-9:
                    pt = self.points[i % (len(self.points) - 1)]
                    if haversine_m(path[-1], pt) > 0.5:
                        path.append(pt[:])

        end_pt = self.point_at(end)
        if haversine_m(path[-1], end_pt) > 0.5:
            path.append(end_pt)
        elif path:
            path[-1] = end_pt
        return path, dist

    def travel(self, a_lat: float, a_lon: float, b_lat: float, b_lon: float) -> LoopTravel:
        fa = self.project(a_lat, a_lon)
        fb = self.project(b_lat, b_lon)
        path, dist = self.slice_forward(fa.s_m, fb.s_m)
        return LoopTravel(
            from_proj=fa,
            to_proj=fb,
            forward_m=dist,
            forward_frac=dist / self.length_m,
            path=path,
        )


def project_pings(
    loop: RouteLoop,
    pings: Iterable[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Attach loop projection fields to each ping (expects lat/lon keys)."""
    out: list[dict[str, Any]] = []
    for ping in pings:
        lat, lon = ping.get("lat"), ping.get("lon")
        if lat is None or lon is None:
            continue
        proj = loop.project(float(lat), float(lon))
        stop = loop.nearest_stop(proj)
        row = dict(ping)
        row["loop"] = {
            "name": loop.name,
            "length_m": round(loop.length_m, 1),
            "projection": proj.as_dict(),
            "nearest_stop": stop,
            "off_loop_m": round(proj.offset_m, 1),
        }
        out.append(row)
    return out


def infer_legs(
    loop: RouteLoop,
    projected: Sequence[dict[str, Any]],
    *,
    min_forward_m: float = 15.0,
    directed: bool = True,
) -> list[dict[str, Any]]:
    """For consecutive projected pings (chronological), infer travel along the loop.

    By default (directed=True) uses the loop's forward direction — the service
    orientation. If that arc is wildly longer than the raw GPS hop (typical when
    a ping pair moves slightly backward near the seam), the leg is skipped so we
    don't invent a nearly-full lap.
    """
    legs: list[dict[str, Any]] = []
    for a, b in zip(projected, projected[1:]):
        pa = a["loop"]["projection"]
        pb = b["loop"]["projection"]
        raw_m = haversine_m([a["lat"], a["lon"]], [b["lat"], b["lon"]])

        fwd = loop.forward_distance(pa["s_m"], pb["s_m"])
        back = loop.forward_distance(pb["s_m"], pa["s_m"])

        if directed:
            dist = fwd
            direction = "forward"
            # Reject impossible wraps: bus barely moved in GPS but forward arc
            # is most of the loop (noise / slight reverse near a stop).
            if dist >= min_forward_m and dist > max(400.0, 4.0 * max(raw_m, 1.0)) and dist > 0.5 * loop.length_m:
                continue
        else:
            if fwd <= back:
                dist, direction = fwd, "forward"
            else:
                dist, direction = back, "backward"

        if dist < min_forward_m:
            continue

        if direction == "forward":
            path, _ = loop.slice_forward(pa["s_m"], pb["s_m"])
        else:
            path, _ = loop.slice_forward(pb["s_m"], pa["s_m"])
            path = list(reversed(path))

        legs.append(
            {
                "from_located_at": a.get("located_at"),
                "to_located_at": b.get("located_at"),
                "from_id": a.get("id"),
                "to_id": b.get("id"),
                "from_off_loop_m": round(pa["offset_m"], 1),
                "to_off_loop_m": round(pb["offset_m"], 1),
                "forward_m": round(dist, 1),
                "forward_frac": round(dist / loop.length_m, 4),
                "direction": direction,
                "raw_m": round(raw_m, 1),
                "path": path,
            }
        )
    return legs
