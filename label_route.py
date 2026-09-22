"""Label each GPS ping with the passenger route it is actually on.

``shuttle_key`` stays as Motive vehicle identity. ``route_key`` is the service
loop (express / regular) for matching, ETA, and model training. Off-network
and lot/behind-Lark points are marked unusable for along-route training.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Sequence

from route_loop import (
    ON_ROUTE_MAX_M,
    RouteLoop,
    haversine_m,
)

LARK_STOP = (35.91913, -79.05343)
AT_LARK_RADIUS_M = 75.0
BEHIND_LARK_M = 220.0
OFF_NETWORK_M = 160.0
# Prefer a loop when it is clearly closer by this much.
CLEAR_MARGIN_M = 25.0
# Stick to previous route while still within this of that loop.
STICKY_MAX_M = 120.0
ROUTE_CANDIDATES = ("express", "regular")


@dataclass(frozen=True)
class PingLabel:
    route_key: str | None
    route_status: str  # on_route | at_lark | behind_lark | off_network | no_gps
    route_off_m: float | None
    express_off_m: float | None
    regular_off_m: float | None
    train_ok: bool
    reason: str

    def as_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["train_ok"] = 1 if self.train_ok else 0
        return d


def _load_loops(routes_path: Path | None = None) -> dict[str, RouteLoop]:
    return {
        "express": RouteLoop.from_routes_file("express", routes_path),
        "regular": RouteLoop.from_routes_file("regular", routes_path),
    }


def raw_geometry_label(
    lat: float,
    lon: float,
    *,
    vehicle_key: str,
    entity_state: str | None = None,
    loops: dict[str, RouteLoop] | None = None,
) -> PingLabel:
    """Single-ping geometry decision (no temporal smoothing)."""
    loops = loops or _load_loops()
    pe = loops["express"].project(lat, lon)
    pr = loops["regular"].project(lat, lon)
    e_off = pe.offset_m
    r_off = pr.offset_m
    dist_lark = haversine_m([lat, lon], list(LARK_STOP))
    at_lark = dist_lark <= AT_LARK_RADIUS_M
    st = (entity_state or "").lower()
    moving = st == "moving"

    if at_lark:
        return PingLabel(
            route_key=None,
            route_status="at_lark",
            route_off_m=round(min(e_off, r_off), 1),
            express_off_m=round(e_off, 1),
            regular_off_m=round(r_off, 1),
            train_ok=False,  # filled in after sticky trip context
            reason="at_lark_hub",
        )

    behind = (
        dist_lark <= BEHIND_LARK_M
        and not moving
        and e_off > ON_ROUTE_MAX_M
        and r_off > ON_ROUTE_MAX_M
    )
    if behind or (st in ("off", "idling") and dist_lark <= BEHIND_LARK_M and not moving):
        # Parked in lot / behind property — not passenger service geometry.
        if e_off > ON_ROUTE_MAX_M and r_off > ON_ROUTE_MAX_M:
            return PingLabel(
                route_key=None,
                route_status="behind_lark",
                route_off_m=round(min(e_off, r_off), 1),
                express_off_m=round(e_off, 1),
                regular_off_m=round(r_off, 1),
                train_ok=False,
                reason="parked_near_lark",
            )

    on_e = e_off <= ON_ROUTE_MAX_M
    on_r = r_off <= ON_ROUTE_MAX_M

    if not on_e and not on_r:
        status = "off_network" if min(e_off, r_off) > OFF_NETWORK_M else "off_network"
        return PingLabel(
            route_key=None,
            route_status=status,
            route_off_m=round(min(e_off, r_off), 1),
            express_off_m=round(e_off, 1),
            regular_off_m=round(r_off, 1),
            train_ok=False,
            reason="off_both_loops",
        )

    if on_e and not on_r:
        return PingLabel(
            route_key="express",
            route_status="on_route",
            route_off_m=round(e_off, 1),
            express_off_m=round(e_off, 1),
            regular_off_m=round(r_off, 1),
            train_ok=True,
            reason="only_express",
        )
    if on_r and not on_e:
        return PingLabel(
            route_key="regular",
            route_status="on_route",
            route_off_m=round(r_off, 1),
            express_off_m=round(e_off, 1),
            regular_off_m=round(r_off, 1),
            train_ok=True,
            reason="only_regular",
        )

    # Both on-route (shared corridor). Prefer clearer fit, else vehicle home.
    gap = abs(e_off - r_off)
    if gap >= CLEAR_MARGIN_M:
        key = "express" if e_off < r_off else "regular"
        off = e_off if key == "express" else r_off
        return PingLabel(
            route_key=key,
            route_status="on_route",
            route_off_m=round(off, 1),
            express_off_m=round(e_off, 1),
            regular_off_m=round(r_off, 1),
            train_ok=True,
            reason=f"shared_clearer:{key}",
        )

    home = vehicle_key if vehicle_key in ROUTE_CANDIDATES else (
        "express" if e_off <= r_off else "regular"
    )
    off = e_off if home == "express" else r_off
    return PingLabel(
        route_key=home,
        route_status="on_route",
        route_off_m=round(off, 1),
        express_off_m=round(e_off, 1),
        regular_off_m=round(r_off, 1),
        train_ok=True,
        reason="shared_prefer_home",
    )


def label_vehicle_series(
    pings: Sequence[dict[str, Any]],
    *,
    vehicle_key: str,
    routes_path: Path | None = None,
) -> list[PingLabel]:
    """Label a chronological vehicle trail with sticky route context.

    Sticky rule: once a service is established, keep it while the ping stays
    within ``STICKY_MAX_M`` of that loop unless the other loop is clearly
    better. At-Lark hub points inherit the active trip's route so departures
    / arrivals stay in the train set.
    """
    loops = _load_loops(routes_path)
    raw = [
        raw_geometry_label(
            float(p["lat"]),
            float(p["lon"]),
            vehicle_key=vehicle_key,
            entity_state=p.get("entity_state") or p.get("state"),
            loops=loops,
        )
        if p.get("lat") is not None and p.get("lon") is not None
        else PingLabel(
            route_key=None,
            route_status="no_gps",
            route_off_m=None,
            express_off_m=None,
            regular_off_m=None,
            train_ok=False,
            reason="no_gps",
        )
        for p in pings
    ]

    sticky: str | None = None
    forward: list[PingLabel] = []
    for lab in raw:
        if lab.route_status == "on_route" and lab.route_key:
            e_off = lab.express_off_m if lab.express_off_m is not None else 1e9
            r_off = lab.regular_off_m if lab.regular_off_m is not None else 1e9
            if sticky and sticky in ROUTE_CANDIDATES:
                sticky_off = e_off if sticky == "express" else r_off
                other = "regular" if sticky == "express" else "express"
                other_off = r_off if sticky == "express" else e_off
                if sticky_off <= STICKY_MAX_M and not (
                    other_off + CLEAR_MARGIN_M < sticky_off
                    and other_off <= ON_ROUTE_MAX_M
                ):
                    chosen = sticky
                    reason = f"sticky:{sticky}"
                else:
                    chosen = lab.route_key
                    reason = lab.reason
                    sticky = chosen
            else:
                chosen = lab.route_key
                reason = lab.reason
                sticky = chosen
            off = e_off if chosen == "express" else r_off
            forward.append(
                PingLabel(
                    route_key=chosen,
                    route_status="on_route",
                    route_off_m=round(off, 1),
                    express_off_m=lab.express_off_m,
                    regular_off_m=lab.regular_off_m,
                    train_ok=True,
                    reason=reason,
                )
            )
        elif lab.route_status == "at_lark":
            # Inherit trip context; still a valid stop for training.
            forward.append(
                PingLabel(
                    route_key=sticky,
                    route_status="at_lark",
                    route_off_m=lab.route_off_m,
                    express_off_m=lab.express_off_m,
                    regular_off_m=lab.regular_off_m,
                    train_ok=bool(sticky),
                    reason="at_lark_inherit" if sticky else "at_lark_hub",
                )
            )
        else:
            # Off-network / lot breaks the trip sticky state.
            if lab.route_status in ("off_network", "behind_lark", "no_gps"):
                sticky = None
            forward.append(lab)

    # Backward pass: fill leading at_lark points with the route that follows.
    next_route: str | None = None
    out = list(forward)
    for i in range(len(out) - 1, -1, -1):
        lab = out[i]
        if lab.route_status == "on_route" and lab.route_key:
            next_route = lab.route_key
        elif lab.route_status == "at_lark" and lab.route_key is None and next_route:
            out[i] = PingLabel(
                route_key=next_route,
                route_status="at_lark",
                route_off_m=lab.route_off_m,
                express_off_m=lab.express_off_m,
                regular_off_m=lab.regular_off_m,
                train_ok=True,
                reason="at_lark_inherit_fwd",
            )
        elif lab.route_status in ("off_network", "behind_lark", "no_gps"):
            next_route = None

    return out


def label_all_pings(
    pings: Sequence[dict[str, Any]],
    *,
    routes_path: Path | None = None,
) -> list[dict[str, Any]]:
    """Attach label fields to each ping dict (grouped by shuttle_key)."""
    by_vehicle: dict[str, list[tuple[int, dict[str, Any]]]] = {}
    for i, p in enumerate(pings):
        key = str(p.get("shuttle_key") or p.get("key") or "unknown")
        by_vehicle.setdefault(key, []).append((i, p))

    labeled: list[dict[str, Any] | None] = [None] * len(pings)
    for vehicle_key, items in by_vehicle.items():
        # Chronological within vehicle
        items_sorted = sorted(
            items,
            key=lambda t: (t[1].get("located_at") or "", t[1].get("id") or 0),
        )
        series = [p for _, p in items_sorted]
        labels = label_vehicle_series(
            series, vehicle_key=vehicle_key, routes_path=routes_path
        )
        for (orig_i, ping), lab in zip(items_sorted, labels):
            row = dict(ping)
            row.update(lab.as_dict())
            labeled[orig_i] = row

    return [r for r in labeled if r is not None]
