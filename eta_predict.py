"""Stable ETA + prediction/outcome logging for training.

Instantaneous Motive speed is noisy (lights, crawls). We clamp to a realistic
cruise band, then temporally smooth so brief spikes do not dominate the
logged / displayed ETA. Predictions resolve when the vehicle reaches the stop.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any

from route_loop import RouteLoop

# Display / training ETA uses a clamped cruise speed, not raw GPS crawl.
ETA_FALLBACK_MPH = 12.0
ETA_MIN_MPH = 8.0
ETA_MAX_MPH = 28.0
ETA_MAX_MINUTES = 40.0
# Arrivals slower than this are a later lap / stale open pred — not a valid outcome.
MAX_ARRIVAL_AGE_MIN = ETA_MAX_MINUTES + 10.0
AT_STOP_ARRIVE_M = 45.0
MODEL_VERSION = "eta_smooth_v1"

_SPEED_RE = re.compile(r"([\d.]+)")

# Temporal smoothing — brief spikes (crawl / GPS snap) should not dominate.
ETA_SMOOTH_MAX_UP_MIN = 1.1
ETA_SMOOTH_MAX_DOWN_MIN = 2.25
ETA_SMOOTH_ALPHA_UP = 0.22
ETA_SMOOTH_ALPHA_DOWN = 0.48

# In-process memory: vehicle_key → {stop, eta, at}
_eta_smooth: dict[str, dict[str, Any]] = {}


def parse_speed_mph(speed: str | float | int | None) -> float | None:
    if speed is None:
        return None
    if isinstance(speed, (int, float)):
        return float(speed)
    m = _SPEED_RE.search(str(speed))
    return float(m.group(1)) if m else None


def effective_speed_mph(
    raw_mph: float | None,
    *,
    entity_state: str | None = None,
    fallback_mph: float = ETA_FALLBACK_MPH,
    min_mph: float = ETA_MIN_MPH,
    max_mph: float = ETA_MAX_MPH,
) -> float:
    """Speed used for whole-trip ETA (clamped; ignores crawls)."""
    st = (entity_state or "").lower()
    if raw_mph is None or raw_mph <= 1.0 or st in ("idling", "off"):
        mph = fallback_mph
    else:
        mph = raw_mph
    return max(min_mph, min(max_mph, mph))


def eta_minutes(
    along_m: float,
    raw_mph: float | None,
    *,
    entity_state: str | None = None,
) -> tuple[float, float]:
    """Return (eta_min, speed_used_mph)."""
    used = effective_speed_mph(raw_mph, entity_state=entity_state)
    mps = used * 0.44704
    minutes = (along_m / mps / 60.0) if mps > 0 else ETA_MAX_MINUTES
    minutes = max(0.0, min(ETA_MAX_MINUTES, minutes))
    return round(minutes, 2), used


def smooth_eta_minutes(
    raw_eta_min: float,
    *,
    vehicle_key: str,
    stop_key: str,
    now: datetime | None = None,
) -> float:
    """Rate-limit + asymmetric EMA so short-lived extremes do not flash."""
    now = now or datetime.now(timezone.utc)
    raw = max(0.0, float(raw_eta_min))
    prev = _eta_smooth.get(vehicle_key)
    if not prev or prev.get("stop_key") != stop_key:
        _eta_smooth[vehicle_key] = {
            "stop_key": stop_key,
            "eta_min": raw,
            "at": now,
        }
        return raw

    prev_at = prev.get("at")
    if isinstance(prev_at, datetime):
        dt_sec = max(0.35, (now - prev_at).total_seconds())
    else:
        dt_sec = 10.0
    max_up = ETA_SMOOTH_MAX_UP_MIN * min(2.5, dt_sec / 1.0)
    max_down = ETA_SMOOTH_MAX_DOWN_MIN * min(2.5, dt_sec / 1.0)
    prev_eta = float(prev["eta_min"])
    delta = max(-max_down, min(max_up, raw - prev_eta))
    stepped = prev_eta + delta
    alpha = ETA_SMOOTH_ALPHA_UP if stepped >= prev_eta else ETA_SMOOTH_ALPHA_DOWN
    eta = max(0.0, alpha * stepped + (1.0 - alpha) * prev_eta)
    _eta_smooth[vehicle_key] = {
        "stop_key": stop_key,
        "eta_min": eta,
        "at": now,
    }
    return round(eta, 2)


def next_stop_ahead(
    loop: RouteLoop,
    proj_s_m: float,
    *,
    at_stop_m: float = 35.0,
) -> dict[str, Any] | None:
    """Next stop forward along the loop (skip if already at a stop)."""
    if not loop.stops:
        return None
    best: dict[str, Any] | None = None
    best_along = float("inf")
    for stop in loop.stops:
        sp = loop.project(float(stop["lat"]), float(stop["lon"])).s_m
        ahead = (sp - proj_s_m) % loop.length_m
        if ahead < at_stop_m:
            continue
        if ahead < best_along:
            best_along = ahead
            best = {
                "key": stop.get("key"),
                "name": stop.get("name"),
                "along_m": ahead,
                "stop_s_m": sp,
            }
    if best:
        return best
    # Fallback: full loop to nearest forward stop including wrap.
    for stop in loop.stops:
        sp = loop.project(float(stop["lat"]), float(stop["lon"])).s_m
        ahead = (sp - proj_s_m) % loop.length_m
        if ahead < 1.0:
            ahead = loop.length_m
        if ahead < best_along:
            best_along = ahead
            best = {
                "key": stop.get("key"),
                "name": stop.get("name"),
                "along_m": ahead,
                "stop_s_m": sp,
            }
    return best


def iso_utc(dt: datetime | None = None) -> str:
    dt = dt or datetime.now(timezone.utc)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(ts: str | None) -> datetime | None:
    if not ts:
        return None
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


PREDICTIONS_DDL = """
CREATE TABLE IF NOT EXISTS predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    ping_id INTEGER,
    shuttle_key TEXT NOT NULL,
    route_key TEXT,
    located_at TEXT,
    lat REAL,
    lon REAL,
    s_m REAL,
    loop_frac REAL,
    entity_state TEXT,
    speed_raw_mph REAL,
    speed_used_mph REAL,
    target_stop_key TEXT,
    target_stop_name TEXT,
    along_m REAL,
    eta_min REAL,
    predicted_arrive_at TEXT,
    model_version TEXT NOT NULL,
    resolved_at TEXT,
    actual_arrive_at TEXT,
    actual_min REAL,
    error_min REAL,
    outcome TEXT,
    resolve_ping_id INTEGER
)
"""


def ensure_predictions_table(conn: Any) -> None:
    conn.execute(PREDICTIONS_DDL)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_pred_open "
        "ON predictions(shuttle_key, outcome, target_stop_key)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_pred_resolved "
        "ON predictions(outcome, route_key, target_stop_key)"
    )


def open_prediction(
    conn: Any,
    *,
    ping_id: int | None,
    shuttle_key: str,
    route_key: str | None,
    located_at: str | None,
    lat: float,
    lon: float,
    s_m: float | None,
    loop_frac: float | None,
    entity_state: str | None,
    speed_raw_mph: float | None,
    speed_used_mph: float,
    target_stop_key: str | None,
    target_stop_name: str | None,
    along_m: float,
    eta_min: float,
    model_version: str = MODEL_VERSION,
) -> int:
    created = iso_utc()
    located = parse_iso(located_at) or datetime.now(timezone.utc)
    predicted_arrive = iso_utc(located + timedelta(minutes=eta_min))
    cur = conn.execute(
        """
        INSERT INTO predictions (
            created_at, ping_id, shuttle_key, route_key, located_at,
            lat, lon, s_m, loop_frac, entity_state,
            speed_raw_mph, speed_used_mph,
            target_stop_key, target_stop_name, along_m, eta_min,
            predicted_arrive_at, model_version,
            outcome
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        """,
        (
            created,
            ping_id,
            shuttle_key,
            route_key,
            located_at,
            lat,
            lon,
            s_m,
            loop_frac,
            entity_state,
            speed_raw_mph,
            speed_used_mph,
            target_stop_key,
            target_stop_name,
            round(along_m, 1),
            eta_min,
            predicted_arrive,
            model_version,
        ),
    )
    return int(cur.lastrowid)


def resolve_arrivals(
    conn: Any,
    *,
    shuttle_key: str,
    route_key: str | None,
    lat: float,
    lon: float,
    located_at: str | None,
    ping_id: int | None,
    loops: dict[str, RouteLoop],
) -> list[dict[str, Any]]:
    """Mark open predictions as arrived when vehicle is at their target stop."""
    if not route_key or route_key not in loops:
        return []
    loop = loops[route_key]
    located = parse_iso(located_at) or datetime.now(timezone.utc)
    resolved: list[dict[str, Any]] = []

    open_rows = list(
        conn.execute(
            """
            SELECT * FROM predictions
            WHERE shuttle_key = ? AND outcome IS NULL AND target_stop_key IS NOT NULL
            ORDER BY id ASC
            """,
            (shuttle_key,),
        )
    )
    for row in open_rows:
        stop_key = row["target_stop_key"]
        stop = next((s for s in loop.stops if s.get("key") == stop_key), None)
        if not stop:
            continue
        dist = __import__("route_loop").haversine_m(
            [lat, lon], [float(stop["lat"]), float(stop["lon"])]
        )
        # Also accept loop-arc proximity to the stop.
        proj = loop.project(lat, lon)
        stop_s = loop.project(float(stop["lat"]), float(stop["lon"])).s_m
        along_to = min(
            (stop_s - proj.s_m) % loop.length_m,
            (proj.s_m - stop_s) % loop.length_m,
        )
        if dist > AT_STOP_ARRIVE_M and along_to > AT_STOP_ARRIVE_M:
            continue

        pred_at = parse_iso(row["located_at"]) or parse_iso(row["created_at"])
        if not pred_at:
            continue
        actual_min = (located - pred_at).total_seconds() / 60.0
        if actual_min < 0:
            actual_min = 0.0
        # Stale open prediction (idle / later lap) — not a real arrival outcome.
        if actual_min > MAX_ARRIVAL_AGE_MIN:
            conn.execute(
                """
                UPDATE predictions SET
                    resolved_at = ?, outcome = 'superseded',
                    actual_arrive_at = NULL, actual_min = NULL, error_min = NULL,
                    resolve_ping_id = ?
                WHERE id = ?
                """,
                (iso_utc(), ping_id, row["id"]),
            )
            continue
        # Ignore instant "arrivals" (already there when predicted).
        if actual_min < 0.25 and (row["along_m"] or 0) > 80:
            continue
        error = actual_min - float(row["eta_min"] or 0)
        conn.execute(
            """
            UPDATE predictions SET
                resolved_at = ?,
                actual_arrive_at = ?,
                actual_min = ?,
                error_min = ?,
                outcome = 'arrived',
                resolve_ping_id = ?
            WHERE id = ?
            """,
            (
                iso_utc(),
                iso_utc(located),
                round(actual_min, 2),
                round(error, 2),
                ping_id,
                row["id"],
            ),
        )
        resolved.append(
            {
                "id": row["id"],
                "target": stop_key,
                "eta_min": row["eta_min"],
                "actual_min": round(actual_min, 2),
                "error_min": round(error, 2),
            }
        )
    return resolved


def supersede_stale(
    conn: Any,
    *,
    shuttle_key: str,
    current_target_key: str | None,
    route_key: str | None,
) -> int:
    """Close open predictions that no longer match the active next stop / route."""
    n = 0
    rows = list(
        conn.execute(
            """
            SELECT id, target_stop_key, route_key FROM predictions
            WHERE shuttle_key = ? AND outcome IS NULL
            """,
            (shuttle_key,),
        )
    )
    for row in rows:
        stale = False
        if route_key and row["route_key"] and row["route_key"] != route_key:
            stale = True
        if (
            current_target_key
            and row["target_stop_key"]
            and row["target_stop_key"] != current_target_key
        ):
            stale = True
        if not route_key:
            stale = True
        if stale:
            conn.execute(
                """
                UPDATE predictions SET
                    resolved_at = ?, outcome = 'superseded',
                    actual_arrive_at = NULL, actual_min = NULL, error_min = NULL
                WHERE id = ?
                """,
                (iso_utc(), row["id"]),
            )
            n += 1
    return n


def maybe_record_prediction(
    conn: Any,
    *,
    ping_id: int | None,
    shuttle_key: str,
    route_key: str | None,
    route_status: str | None,
    lat: float,
    lon: float,
    located_at: str | None,
    entity_state: str | None,
    speed_raw: str | float | None,
    loops: dict[str, RouteLoop],
) -> dict[str, Any] | None:
    """Resolve arrivals, then open a new prediction for the current next stop."""
    raw_mph = parse_speed_mph(speed_raw)
    resolved = resolve_arrivals(
        conn,
        shuttle_key=shuttle_key,
        route_key=route_key,
        lat=lat,
        lon=lon,
        located_at=located_at,
        ping_id=ping_id,
        loops=loops,
    )

    if not route_key or route_key not in loops:
        supersede_stale(
            conn, shuttle_key=shuttle_key, current_target_key=None, route_key=None
        )
        return {"resolved": resolved, "prediction": None}

    if route_status not in ("on_route", "at_lark"):
        # Off-network / lot / unknown — close every open pred (do not leave
        # Memorial Hall ETAs hanging for a later lap to falsely "arrive").
        supersede_stale(
            conn, shuttle_key=shuttle_key, current_target_key=None, route_key=None
        )
        return {"resolved": resolved, "prediction": None}

    loop = loops[route_key]
    proj = loop.project(lat, lon)
    nxt = next_stop_ahead(loop, proj.s_m)
    if not nxt or not nxt.get("key"):
        return {"resolved": resolved, "prediction": None}

    supersede_stale(
        conn,
        shuttle_key=shuttle_key,
        current_target_key=str(nxt["key"]),
        route_key=route_key,
    )

    # Dedup: if last open prediction is same stop and < 20s old, skip.
    last = conn.execute(
        """
        SELECT id, created_at, target_stop_key, located_at FROM predictions
        WHERE shuttle_key = ? AND outcome IS NULL
        ORDER BY id DESC LIMIT 1
        """,
        (shuttle_key,),
    ).fetchone()
    if last and last["target_stop_key"] == nxt["key"]:
        last_t = parse_iso(last["located_at"]) or parse_iso(last["created_at"])
        now_t = parse_iso(located_at) or datetime.now(timezone.utc)
        if last_t and (now_t - last_t).total_seconds() < 20:
            return {"resolved": resolved, "prediction": {"id": last["id"], "deduped": True}}

    eta_raw, used = eta_minutes(
        float(nxt["along_m"]), raw_mph, entity_state=entity_state
    )
    located_dt = parse_iso(located_at) or datetime.now(timezone.utc)
    eta_min = smooth_eta_minutes(
        eta_raw,
        vehicle_key=shuttle_key,
        stop_key=str(nxt["key"]),
        now=located_dt,
    )
    pred_id = open_prediction(
        conn,
        ping_id=ping_id,
        shuttle_key=shuttle_key,
        route_key=route_key,
        located_at=located_at,
        lat=lat,
        lon=lon,
        s_m=round(proj.s_m, 1),
        loop_frac=round(proj.loop_frac, 4),
        entity_state=entity_state,
        speed_raw_mph=raw_mph,
        speed_used_mph=used,
        target_stop_key=str(nxt["key"]),
        target_stop_name=nxt.get("name"),
        along_m=float(nxt["along_m"]),
        eta_min=eta_min,
    )
    return {
        "resolved": resolved,
        "prediction": {
            "id": pred_id,
            "target": nxt["key"],
            "along_m": round(float(nxt["along_m"]), 1),
            "eta_min": eta_min,
            "speed_raw_mph": raw_mph,
            "speed_used_mph": used,
        },
    }
