#!/usr/bin/env python3
"""Locate Lark Chapel Hill shuttles via Motive live-share links.

Commands:
  now       Live position (default)
  log       Poll and save history to SQLite
  history   Query saved positions
  match     Snap a vehicle's history onto its assigned loop; infer travel
  label     Backfill route_key on all pings; export clean train set
  discover  Print Linktree UUIDs + Motive API endpoint

Daily roster (America/New_York): Shuttle 1 is Express until 2:00 PM, then
Regular; Shuttle 2 swaps the other way. Physical Motive UUIDs are fixed.
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from route_loop import (
    RouteLoop,
    infer_legs,
    project_pings,
    resolve_route_key,
)
from label_route import label_all_pings, raw_geometry_label
from eta_predict import (
    ensure_predictions_table,
    maybe_record_prediction,
    parse_speed_mph,
)
LINKTREE_URL = "https://linktr.ee/larkchapelhill"
TRACKING_ORIGIN = "https://tracking.gomotive.com"
TRACKING_APP = f"{TRACKING_ORIGIN}/en-US/"
USER_AGENT = "lark-shuttle/1.3 (+personal automation)"
DEFAULT_DB = Path(__file__).resolve().parent / "shuttle_history.db"
DEFAULT_ROUTES = Path(__file__).resolve().parent / "intended_routes.json"
DEFAULT_LOG_INTERVAL = 10.0

FALLBACK = {
    "api_base": "https://api.keeptruckin.com",
    "api_version": "s1",
    "api_path": "live_shares",
    "web_share_api_key": (
        "3gCAa2VxLV3nlJfk7EhzJUEe5lg3IU9b50sNyOfUSSE6Fg2ACZr6GK5KqpMW55rn"
    ),
}

# Shuttle 1 runs Express until 2:00 PM America/New_York, then Regular
# (Shuttle 2 swaps the other way). Physical Motive UUIDs stay fixed.
ROSTER_SWAP_MINUTE = 14 * 60
TZ_CHAPEL_HILL = "America/New_York"

# Stable Motive share UUIDs (morning paint / history shuttle_key). Prefer these
# over Linktree title keywords — titles now say things like
# "Shuttle 1: Express → Regular (starting at 2 PM)".
KNOWN_SHARE_UUIDS = {
    "0c5a01f2-a549-11f1-83ea-4247aa532d4a": "1",  # Shuttle 1 (Motive)
    "2485bb70-a546-11f1-a663-320d2d4970d9": "2",  # Shuttle 2 (Motive)
}


# ── HTTP / discovery ─────────────────────────────────────────────────────────


def http_get(url: str, headers: dict[str, str] | None = None, timeout: float = 20.0) -> bytes:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT, "Accept": "*/*", **(headers or {})},
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def chapel_hill_minutes_of_day(when: datetime | None = None) -> int:
    """Whole minutes since local midnight in America/New_York."""
    when = when or datetime.now(timezone.utc)
    # ZoneInfo needs Python 3.9+; fall back to fixed offset estimate if missing.
    try:
        from zoneinfo import ZoneInfo

        local = when.astimezone(ZoneInfo(TZ_CHAPEL_HILL))
    except Exception:
        local = when.astimezone(timezone(timedelta(hours=-4)))
    return local.hour * 60 + local.minute


def roster_swapped(when: datetime | None = None) -> bool:
    return chapel_hill_minutes_of_day(when) >= ROSTER_SWAP_MINUTE


def home_service_for_vehicle(vehicle_id: str, when: datetime | None = None) -> str:
    """Soft usual passenger service for a physical bus (see ROSTER_SWAP_MINUTE)."""
    swapped = roster_swapped(when)
    vid = {"shuttle1": "1", "shuttle2": "2"}.get(vehicle_id, vehicle_id)
    if vid == "1":
        return "regular" if swapped else "express"
    if vid == "2":
        return "express" if swapped else "regular"
    return vehicle_id


def apply_daily_roster(
    shuttles: list[dict[str, str]], when: datetime | None = None
) -> list[dict[str, str]]:
    """Annotate buses with today's soft usual home service.

    History keys are vehicle numbers ``1`` / ``2`` (not Express/Regular).
    ``home_service`` is a roster hint only; ``route_key`` comes from GPS.
    """
    out: list[dict[str, str]] = []
    for s in shuttles:
        raw = s.get("vehicle_id") or s["key"]
        vehicle_id = {
            "shuttle1": "1",
            "shuttle2": "2",
            "express": "1",
            "regular": "2",
        }.get(raw, raw)
        row = dict(s)
        row["vehicle_id"] = vehicle_id
        row["key"] = vehicle_id  # history / logger identity
        row["home_service"] = home_service_for_vehicle(vehicle_id, when)
        row["name"] = s.get("share_name") or s.get("name") or f"Shuttle {vehicle_id}"
        out.append(row)
    return out


def discover_shuttles_from_linktree(url: str = LINKTREE_URL) -> list[dict[str, str]]:
    html = http_get(url).decode("utf-8", errors="replace")
    pairs: list[tuple[str, str]] = []
    pairs += re.findall(
        r'"title":"([^"]*[Ss]huttle[^"]*)".{0,400}?"url":"(https://tracking\.gomotive\.com[^"]+)"',
        html,
    )
    pairs += [
        (title, link)
        for link, title in re.findall(
            r'"url":"(https://tracking\.gomotive\.com[^"]+)".{0,400}?"title":"([^"]*[Ss]huttle[^"]*)"',
            html,
        )
    ]

    seen: set[str] = set()
    shuttles: list[dict[str, str]] = []
    for title, link in pairs:
        link = link.encode("utf-8").decode("unicode_escape")
        m = re.search(r"#/share/v/([0-9a-f-]{36})", link)
        if not m:
            continue
        uuid = m.group(1)
        if uuid in seen:
            continue
        seen.add(uuid)
        lower = title.lower()
        # Prefer known Motive UUIDs — Linktree titles can mention both services.
        if uuid in KNOWN_SHARE_UUIDS:
            vehicle_id = KNOWN_SHARE_UUIDS[uuid]
        elif "shuttle 1" in lower or "tracker 1" in lower:
            vehicle_id = "1"
        elif "shuttle 2" in lower or "tracker 2" in lower:
            vehicle_id = "2"
        elif "express" in lower and "regular" not in lower:
            vehicle_id = "1"
        elif "regular" in lower and "express" not in lower:
            vehicle_id = "2"
        else:
            vehicle_id = f"v{len(shuttles) + 1}"
        shuttles.append(
            {
                "vehicle_id": vehicle_id,
                "key": vehicle_id,  # remapped by apply_daily_roster
                "share_name": title,
                "name": title,
                "uuid": uuid,
                "tracking_url": link,
            }
        )
    if not shuttles:
        raise RuntimeError(f"No Motive shuttle share links found on {url}")
    return apply_daily_roster(shuttles)


def discover_motive_live_share_api() -> dict[str, str]:
    boot_html = http_get(TRACKING_APP).decode("utf-8", errors="replace")

    api_host = FALLBACK["api_base"]
    boot_js_name = re.search(r"boot\.[a-f0-9]+\.js", boot_html)
    if boot_js_name:
        boot_js = http_get(f"{TRACKING_APP}{boot_js_name.group(0)}").decode(
            "utf-8", errors="replace"
        )
        m = re.search(r'API_URL:"(https://[^"]+)"', boot_js)
        if m:
            api_host = m.group(1)

    pub_name = re.search(r"public\.module\.[a-f0-9]+\.js", boot_html)
    if not pub_name:
        raise RuntimeError("Could not find Motive public.module chunk")
    pub_js = http_get(f"{TRACKING_APP}{pub_name.group(0)}").decode("utf-8", errors="replace")

    chunk_expr = re.search(
        r'path:"share/:type/:uuid".{0,300}?Promise\.all\(\[([^\]]+)\]',
        pub_js,
    )
    if not chunk_expr:
        raise RuntimeError("Could not find share route chunk list in public.module")
    chunk_ids = re.findall(r"a\.e\((\d+)\)", chunk_expr.group(1))

    api_path = api_version = api_key = None
    for cid in chunk_ids:
        for fname in re.findall(rf"{cid}\.[a-f0-9]+\.js", boot_html):
            js = http_get(f"{TRACKING_APP}{fname}").decode("utf-8", errors="replace")
            if "live_shares" not in js and "X-Web-Share-Api-Key" not in js:
                continue
            path_m = re.search(r'API_PATH="([^"]+)"', js)
            ver_m = re.search(r'liveShareApiVer="([^"]+)"', js)
            key_m = re.search(r'X-Web-Share-Api-Key","([^"]+)"', js)
            if path_m:
                api_path = path_m.group(1)
            if ver_m:
                api_version = ver_m.group(1)
            if key_m:
                api_key = key_m.group(1)
            if api_path and api_version and api_key:
                break
        if api_path and api_version and api_key:
            break

    if not (api_path and api_version and api_key):
        raise RuntimeError("Could not extract live_shares path/version/key from Motive JS")

    return {
        "api_base": api_host.rstrip("/"),
        "api_version": api_version,
        "api_path": api_path,
        "web_share_api_key": api_key,
        "endpoint": f"{api_host.rstrip('/')}/api/{api_version}/{api_path}",
    }


def resolve_api(no_discover: bool) -> dict[str, str]:
    if no_discover:
        return {
            **FALLBACK,
            "endpoint": (
                f"{FALLBACK['api_base']}/api/{FALLBACK['api_version']}/{FALLBACK['api_path']}"
            ),
            "source": "fallback",
        }
    try:
        api = discover_motive_live_share_api()
        api["source"] = "discovered"
        return api
    except Exception as exc:  # noqa: BLE001
        return {
            **FALLBACK,
            "endpoint": (
                f"{FALLBACK['api_base']}/api/{FALLBACK['api_version']}/{FALLBACK['api_path']}"
            ),
            "source": f"fallback after discover error: {exc}",
        }


def fetch_live_share(endpoint: str, api_key: str, uuid: str, timeout: float = 15.0) -> dict[str, Any]:
    params = urllib.parse.urlencode({"type": "v", "uuid": uuid})
    url = f"{endpoint}?{params}"
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "X-Web-Share-Api-Key": api_key,
            "Origin": TRACKING_ORIGIN,
            "Referer": f"{TRACKING_ORIGIN}/",
            "User-Agent": USER_AGENT,
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code} for {uuid}: {body}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Network error for {uuid}: {exc}") from exc


def summarize(shuttle: dict[str, str], payload: dict[str, Any]) -> dict[str, Any]:
    share = payload.get("live_share") or {}
    vehicle = share.get("vehicle") or {}
    loc = vehicle.get("vehicle_location") or {}
    return {
        "key": shuttle["key"],
        "name": shuttle["name"],
        "vehicle_number": vehicle.get("number"),
        "make": vehicle.get("make"),
        "model": vehicle.get("model"),
        "state": loc.get("entity_state"),
        "speed": loc.get("speed"),
        "address": loc.get("formatted_address"),
        "city": loc.get("city"),
        "lat": loc.get("lat"),
        "lon": loc.get("lon"),
        "bearing": loc.get("bearing"),
        "compass": loc.get("compass"),
        "located_at": loc.get("located_at"),
        "maps_url": (
            f"https://www.google.com/maps?q={loc['lat']},{loc['lon']}"
            if loc.get("lat") is not None and loc.get("lon") is not None
            else None
        ),
        "tracking_url": share.get("tracking_url") or shuttle.get("tracking_url"),
        "expire_at": share.get("expire_at"),
        "uuid": shuttle["uuid"],
        "raw": payload,
    }


def format_human(summary: dict[str, Any]) -> str:
    located = summary.get("located_at")
    age = ""
    if located:
        try:
            ts = datetime.fromisoformat(located.replace("Z", "+00:00"))
            seconds = int((datetime.now(timezone.utc) - ts).total_seconds())
            if seconds < 60:
                age = f" ({seconds}s ago)"
            elif seconds < 3600:
                age = f" ({seconds // 60}m ago)"
            else:
                age = f" ({seconds // 3600}h {(seconds % 3600) // 60}m ago)"
        except ValueError:
            age = ""

    lines = [
        f"{summary['name']} — {summary.get('vehicle_number') or 'unknown vehicle'}",
        f"  Status:  {summary.get('state') or 'unknown'}"
        + (f" @ {summary['speed']}" if summary.get("speed") else ""),
        f"  Where:   {summary.get('address') or 'no address'}",
        f"  Lat/Lon: {summary.get('lat')}, {summary.get('lon')}"
        + (
            f"  bearing {summary.get('bearing')} ({summary.get('compass')})"
            if summary.get("bearing") is not None
            else ""
        ),
        f"  Updated: {located or 'n/a'}{age}",
    ]
    if summary.get("maps_url"):
        lines.append(f"  Maps:    {summary['maps_url']}")
    return "\n".join(lines)


def resolve_keys(which: str, shuttles: list[dict[str, str]]) -> list[dict[str, str]]:
    by_key = {s["key"]: s for s in shuttles}
    by_vehicle = {s.get("vehicle_id", s["key"]): s for s in shuttles}
    if which == "all":
        return shuttles
    raw = which.lower().strip()
    # Physical bus aliases always follow Shuttle 1 / 2, not morning paint.
    vehicle_aliases = {
        "1": "1",
        "shuttle1": "1",
        "express": "1",
        "2": "2",
        "shuttle2": "2",
        "regular": "2",
    }
    if raw in vehicle_aliases:
        vid = vehicle_aliases[raw]
        if vid in by_vehicle:
            return [by_vehicle[vid]]
    if raw in by_key:
        return [by_key[raw]]
    matches = [
        s
        for s in shuttles
        if raw in s["key"]
        or raw in s["name"].lower()
        or raw in (s.get("vehicle_id") or "")
    ]
    if len(matches) == 1:
        return matches
    known = ", ".join(
        f"{s['key']}({s.get('vehicle_id', '?')})" for s in shuttles
    )
    raise SystemExit(f"Unknown shuttle '{which}'. Known: {known}, all")


# ── SQLite history ───────────────────────────────────────────────────────────


def connect_db(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS pings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            recorded_at TEXT NOT NULL,
            shuttle_key TEXT NOT NULL,
            shuttle_name TEXT,
            uuid TEXT,
            vehicle_number TEXT,
            located_at TEXT,
            lat REAL,
            lon REAL,
            address TEXT,
            city TEXT,
            entity_state TEXT,
            speed TEXT,
            bearing REAL,
            compass TEXT,
            maps_url TEXT,
            UNIQUE(shuttle_key, located_at)
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_pings_shuttle_time "
        "ON pings(shuttle_key, located_at)"
    )
    _ensure_route_label_columns(conn)
    ensure_predictions_table(conn)
    conn.commit()
    return conn


_ROUTE_LABEL_COLUMNS: dict[str, str] = {
    "route_key": "TEXT",
    "route_status": "TEXT",
    "route_off_m": "REAL",
    "express_off_m": "REAL",
    "regular_off_m": "REAL",
    "train_ok": "INTEGER",
    "label_reason": "TEXT",
    "speed_mph": "REAL",
    "s_m": "REAL",
    "loop_frac": "REAL",
}


def _ensure_route_label_columns(conn: sqlite3.Connection) -> None:
    existing = {row[1] for row in conn.execute("PRAGMA table_info(pings)")}
    for col, typ in _ROUTE_LABEL_COLUMNS.items():
        if col not in existing:
            conn.execute(f"ALTER TABLE pings ADD COLUMN {col} {typ}")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_pings_route_time "
        "ON pings(route_key, located_at)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_pings_train "
        "ON pings(train_ok, route_key, located_at)"
    )

def save_ping(
    conn: sqlite3.Connection,
    summary: dict[str, Any],
    *,
    loops: dict[str, RouteLoop] | None = None,
) -> dict[str, Any]:
    """Insert a ping if Motive's located_at is new; record ETA prediction.

    Returns ``{inserted, ping_id, prediction}``.
    """
    empty: dict[str, Any] = {"inserted": False, "ping_id": None, "prediction": None}
    if summary.get("lat") is None or summary.get("lon") is None:
        return empty
    if not summary.get("located_at"):
        return empty

    from label_route import CLEAR_MARGIN_M, ON_ROUTE_MAX_M, STICKY_MAX_M
    from eta_predict import resolve_arrivals

    recorded_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    vehicle_key = summary["key"]
    lat = float(summary["lat"])
    lon = float(summary["lon"])
    speed_mph = parse_speed_mph(summary.get("speed"))

    if loops is None:
        loops = {
            "express": RouteLoop.from_routes_file("express"),
            "regular": RouteLoop.from_routes_file("regular"),
        }

    prev = conn.execute(
        """
        SELECT route_key, route_status FROM pings
        WHERE shuttle_key = ? AND route_status IS NOT NULL
        ORDER BY located_at DESC, id DESC LIMIT 1
        """,
        (vehicle_key,),
    ).fetchone()
    prev_route = None
    if prev and prev["route_key"] and prev["route_status"] in ("on_route", "at_lark"):
        prev_route = prev["route_key"]

    lab = raw_geometry_label(
        lat,
        lon,
        vehicle_key=vehicle_key,
        entity_state=summary.get("state"),
        loops=loops,
    )
    route_key = lab.route_key
    route_status = lab.route_status
    reason = lab.reason
    train_ok = bool(lab.train_ok)
    route_off_m = lab.route_off_m

    if route_status == "on_route" and prev_route:
        e_off = lab.express_off_m if lab.express_off_m is not None else 1e9
        r_off = lab.regular_off_m if lab.regular_off_m is not None else 1e9
        sticky_off = e_off if prev_route == "express" else r_off
        other_off = r_off if prev_route == "express" else e_off
        if sticky_off <= STICKY_MAX_M and not (
            other_off + CLEAR_MARGIN_M < sticky_off and other_off <= ON_ROUTE_MAX_M
        ):
            route_key = prev_route
            route_off_m = round(sticky_off, 1)
            reason = f"sticky:{prev_route}"
            train_ok = True
    elif route_status == "at_lark" and prev_route:
        route_key = prev_route
        train_ok = True
        reason = "at_lark_inherit"

    s_m = None
    loop_frac = None
    if route_key and route_key in loops:
        proj = loops[route_key].project(lat, lon)
        s_m = round(proj.s_m, 1)
        loop_frac = round(proj.loop_frac, 4)

    cur = conn.execute(
        """
        INSERT OR IGNORE INTO pings (
            recorded_at, shuttle_key, shuttle_name, uuid, vehicle_number,
            located_at, lat, lon, address, city, entity_state, speed,
            bearing, compass, maps_url,
            route_key, route_status, route_off_m, express_off_m, regular_off_m,
            train_ok, label_reason, speed_mph, s_m, loop_frac
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            recorded_at,
            vehicle_key,
            summary.get("name"),
            summary.get("uuid"),
            summary.get("vehicle_number"),
            summary.get("located_at"),
            lat,
            lon,
            summary.get("address"),
            summary.get("city"),
            summary.get("state"),
            summary.get("speed"),
            summary.get("bearing"),
            summary.get("compass"),
            summary.get("maps_url"),
            route_key,
            route_status,
            route_off_m,
            lab.express_off_m,
            lab.regular_off_m,
            1 if train_ok else 0,
            reason,
            speed_mph,
            s_m,
            loop_frac,
        ),
    )
    inserted = cur.rowcount > 0
    if inserted:
        ping_id = int(cur.lastrowid)
    else:
        row = conn.execute(
            "SELECT id FROM pings WHERE shuttle_key = ? AND located_at = ?",
            (vehicle_key, summary.get("located_at")),
        ).fetchone()
        ping_id = int(row["id"]) if row else None

    if inserted:
        pred_info = maybe_record_prediction(
            conn,
            ping_id=ping_id,
            shuttle_key=vehicle_key,
            route_key=route_key,
            route_status=route_status,
            lat=lat,
            lon=lon,
            located_at=summary.get("located_at"),
            entity_state=summary.get("state"),
            speed_raw=summary.get("speed"),
            loops=loops,
        )
    else:
        resolved = resolve_arrivals(
            conn,
            shuttle_key=vehicle_key,
            route_key=route_key,
            lat=lat,
            lon=lon,
            located_at=summary.get("located_at"),
            ping_id=ping_id,
            loops=loops,
        )
        pred_info = {"resolved": resolved, "prediction": None}

    conn.commit()
    return {"inserted": inserted, "ping_id": ping_id, "prediction": pred_info}



def apply_route_labels(
    conn: sqlite3.Connection,
    *,
    routes_path: Path | None = None,
) -> dict[str, Any]:
    """Backfill route_key / train_ok for every ping (vehicle identity unchanged)."""
    from route_loop import ON_ROUTE_MAX_M

    rows = list(
        conn.execute(
            "SELECT * FROM pings ORDER BY shuttle_key ASC, located_at ASC, id ASC"
        )
    )
    pings = [dict(r) for r in rows]
    labeled = label_all_pings(pings, routes_path=routes_path)
    by_id = {r["id"]: r for r in labeled if r.get("id") is not None}

    updated = 0
    loops = {
        "express": RouteLoop.from_routes_file("express", routes_path),
        "regular": RouteLoop.from_routes_file("regular", routes_path),
    }
    for row in rows:
        lab = by_id.get(row["id"])
        if not lab:
            continue
        speed_mph = parse_speed_mph(row["speed"] if "speed" in row.keys() else None)
        s_m = None
        loop_frac = None
        rk = lab.get("route_key")
        if rk in loops and row["lat"] is not None and row["lon"] is not None:
            proj = loops[rk].project(float(row["lat"]), float(row["lon"]))
            s_m = round(proj.s_m, 1)
            loop_frac = round(proj.loop_frac, 4)
        conn.execute(
            """
            UPDATE pings SET
                route_key = ?,
                route_status = ?,
                route_off_m = ?,
                express_off_m = ?,
                regular_off_m = ?,
                train_ok = ?,
                label_reason = ?,
                speed_mph = ?,
                s_m = ?,
                loop_frac = ?
            WHERE id = ?
            """,
            (
                lab.get("route_key"),
                lab.get("route_status"),
                lab.get("route_off_m"),
                lab.get("express_off_m"),
                lab.get("regular_off_m"),
                lab.get("train_ok", 0),
                lab.get("reason"),
                speed_mph,
                s_m,
                loop_frac,
                row["id"],
            ),
        )
        updated += 1
    conn.commit()

    stats: dict[str, Any] = {
        "updated": updated,
        "by_status": {},
        "by_route": {},
        "train_ok": 0,
        "train_ok_but_far": 0,
    }
    for lab in labeled:
        st = lab.get("route_status") or "unknown"
        stats["by_status"][st] = stats["by_status"].get(st, 0) + 1
        rk = lab.get("route_key") or "(none)"
        stats["by_route"][rk] = stats["by_route"].get(rk, 0) + 1
        if lab.get("train_ok"):
            stats["train_ok"] += 1
            if lab.get("route_status") == "on_route" and (lab.get("route_off_m") or 0) > ON_ROUTE_MAX_M:
                stats["train_ok_but_far"] += 1

    cross: dict[str, dict[str, int]] = {}
    for lab in labeled:
        vk = lab.get("shuttle_key") or "?"
        rk = lab.get("route_key") or "(none)"
        cross.setdefault(vk, {})
        cross[vk][rk] = cross[vk].get(rk, 0) + 1
    stats["vehicle_vs_route"] = cross
    return stats


def export_history_payload(conn: sqlite3.Connection) -> dict[str, Any]:
    ensure_predictions_table(conn)
    rows = [
        dict(r)
        for r in conn.execute(
            """
            SELECT id, recorded_at, shuttle_key, shuttle_name, vehicle_number,
                   located_at, lat, lon, address, city, entity_state, speed,
                   bearing, compass, speed_mph, s_m, loop_frac,
                   route_key, route_status, route_off_m,
                   express_off_m, regular_off_m, train_ok, label_reason
            FROM pings
            ORDER BY located_at ASC, id ASC
            """
        )
    ]
    predictions = [
        dict(r)
        for r in conn.execute(
            """
            SELECT id, created_at, ping_id, shuttle_key, route_key, located_at,
                   lat, lon, s_m, loop_frac, entity_state,
                   speed_raw_mph, speed_used_mph,
                   target_stop_key, target_stop_name, along_m, eta_min,
                   predicted_arrive_at, model_version,
                   resolved_at, actual_arrive_at, actual_min, error_min,
                   outcome, resolve_ping_id
            FROM predictions
            ORDER BY id ASC
            """
        )
    ]
    by_vehicle: dict[str, int] = {}
    by_route: dict[str, int] = {}
    train_rows = []
    for r in rows:
        by_vehicle[r["shuttle_key"]] = by_vehicle.get(r["shuttle_key"], 0) + 1
        rk = r.get("route_key") or "(none)"
        by_route[rk] = by_route.get(rk, 0) + 1
        if r.get("train_ok"):
            train_rows.append(r)
    arrived = [p for p in predictions if p.get("outcome") == "arrived"]
    return {
        "exported_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "ping_count": len(rows),
        "train_ok_count": len(train_rows),
        "prediction_count": len(predictions),
        "arrived_prediction_count": len(arrived),
        "notes": (
            "shuttle_key = Motive vehicle (1/2); "
            "route_key = passenger service (express/regular)."
        ),
        "by_vehicle": by_vehicle,
        "by_route": by_route,
        "pings": rows,
        "train_pings": train_rows,
        "predictions": predictions,
        "train_predictions": arrived,
    }


def cmd_label(args: argparse.Namespace) -> int:
    """Backfill route labels on the history DB and write clean train exports."""
    db_path = Path(args.db)
    if not db_path.exists():
        raise SystemExit(f"No history DB at {db_path}")

    routes_path = Path(args.routes) if getattr(args, "routes", None) else DEFAULT_ROUTES
    conn = connect_db(db_path)
    stats = apply_route_labels(conn, routes_path=routes_path)
    payload = export_history_payload(conn)
    conn.close()

    out_dir = Path(args.out_dir) if args.out_dir else (db_path.parent / "data")
    out_dir.mkdir(parents=True, exist_ok=True)

    history_path = out_dir / "history.json"
    train_path = out_dir / "train_pings.json"
    pred_path = out_dir / "predictions.json"
    train_pred_path = out_dir / "train_predictions.json"
    history_path.write_text(
        json.dumps(
            {
                k: v
                for k, v in payload.items()
                if k not in ("train_pings", "train_predictions")
            },
            indent=2,
        )
    )
    train_payload = {
        "exported_at": payload["exported_at"],
        "ping_count": payload["train_ok_count"],
        "by_route": {},
        "by_vehicle": {},
        "notes": (
            "train_ok pings only. shuttle_key = Motive vehicle; "
            "route_key = passenger service loop used for ETA training."
        ),
        "pings": payload["train_pings"],
    }
    for p in payload["train_pings"]:
        rk = p.get("route_key") or "(none)"
        vk = p.get("shuttle_key") or "?"
        train_payload["by_route"][rk] = train_payload["by_route"].get(rk, 0) + 1
        train_payload["by_vehicle"][vk] = train_payload["by_vehicle"].get(vk, 0) + 1
    train_path.write_text(json.dumps(train_payload, indent=2))

    pred_path.write_text(
        json.dumps(
            {
                "exported_at": payload["exported_at"],
                "prediction_count": payload["prediction_count"],
                "arrived_prediction_count": payload["arrived_prediction_count"],
                "notes": (
                    "All ETA predictions logged by the collector. "
                    "outcome=arrived rows include actual_min and error_min."
                ),
                "predictions": payload["predictions"],
            },
            indent=2,
        )
    )
    train_pred_path.write_text(
        json.dumps(
            {
                "exported_at": payload["exported_at"],
                "ping_count": payload["arrived_prediction_count"],
                "notes": (
                    "Resolved predictions only (arrived). Features at prediction "
                    "time + actual_min / error_min for supervised ETA training."
                ),
                "predictions": payload["train_predictions"],
            },
            indent=2,
        )
    )

    snap = out_dir / "shuttle_history.db"
    if db_path.resolve() != snap.resolve():
        import shutil

        shutil.copy2(db_path, snap)

    if args.json:
        print(json.dumps(stats, indent=2))
    else:
        print(_format_label_report(stats))
    print(f"Wrote {history_path} ({payload['ping_count']} pings)")
    print(f"Wrote {train_path} ({payload['train_ok_count']} train_ok)")
    print(
        f"Wrote {pred_path} ({payload['prediction_count']} preds, "
        f"{payload['arrived_prediction_count']} arrived)"
    )
    print(f"Wrote {train_pred_path}")
    return 0


def _format_label_report(stats: dict[str, Any]) -> str:
    lines = [
        f"Labeled {stats['updated']} pings  ·  train_ok={stats['train_ok']}  ·  "
        f"far-but-train_ok={stats.get('train_ok_but_far', 0)}",
        "By status: "
        + ", ".join(f"{k}={v}" for k, v in sorted(stats["by_status"].items())),
        "By route_key: "
        + ", ".join(f"{k}={v}" for k, v in sorted(stats["by_route"].items())),
        "Vehicle → route_key:",
    ]
    for vk, routes in sorted(stats.get("vehicle_vs_route", {}).items()):
        bits = ", ".join(f"{rk}={n}" for rk, n in sorted(routes.items()))
        lines.append(f"  {vk}: {bits}")
    return "\n".join(lines)



def query_history(
    conn: sqlite3.Connection,
    shuttle_key: str | None,
    since: datetime | None,
    until: datetime | None,
    limit: int,
) -> list[sqlite3.Row]:
    clauses: list[str] = []
    params: list[Any] = []
    if shuttle_key and shuttle_key != "all":
        clauses.append("shuttle_key = ?")
        params.append(shuttle_key)
    if since:
        clauses.append("located_at >= ?")
        params.append(since.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
    if until:
        clauses.append("located_at <= ?")
        params.append(until.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    sql = (
        f"SELECT * FROM pings {where} ORDER BY located_at DESC, id DESC LIMIT ?"
    )
    params.append(limit)
    return list(conn.execute(sql, params))


def format_history_row(row: sqlite3.Row) -> str:
    speed = f" @ {row['speed']}" if row["speed"] else ""
    return (
        f"{row['located_at']}  {row['shuttle_key']:8}  "
        f"{row['entity_state'] or '?'}{speed:12}  "
        f"{row['address'] or 'n/a'}  "
        f"({row['lat']}, {row['lon']})"
    )


def export_geojson(rows: list[sqlite3.Row]) -> dict[str, Any]:
    features = []
    for row in reversed(rows):  # chronological
        features.append(
            {
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [row["lon"], row["lat"]],
                },
                "properties": {
                    "shuttle_key": row["shuttle_key"],
                    "shuttle_name": row["shuttle_name"],
                    "located_at": row["located_at"],
                    "address": row["address"],
                    "entity_state": row["entity_state"],
                    "speed": row["speed"],
                    "bearing": row["bearing"],
                },
            }
        )
    return {"type": "FeatureCollection", "features": features}


# ── Commands ─────────────────────────────────────────────────────────────────


def collect_summaries(
    selected: list[dict[str, str]], api: dict[str, str]
) -> list[dict[str, Any]]:
    out = []
    for shuttle in selected:
        payload = fetch_live_share(api["endpoint"], api["web_share_api_key"], shuttle["uuid"])
        out.append(summarize(shuttle, payload))
    return out


def cmd_now(args: argparse.Namespace, shuttles: list[dict[str, str]], api: dict[str, str]) -> int:
    selected = resolve_keys(args.shuttle, shuttles)
    summaries = collect_summaries(selected, api)
    if getattr(args, "save", False):
        conn = connect_db(Path(args.db))
        for s in summaries:
            save_ping(conn, s)
        conn.close()

    if args.json:
        cleaned = [{k: v for k, v in s.items() if k != "raw"} for s in summaries]
        if args.raw:
            cleaned = summaries
        print(json.dumps(cleaned if len(cleaned) > 1 else cleaned[0], indent=2))
    else:
        print("\n\n".join(format_human(s) for s in summaries))
    return 0


def cmd_log(args: argparse.Namespace, shuttles: list[dict[str, str]], api: dict[str, str]) -> int:
    selected = resolve_keys(args.shuttle, shuttles)
    db_path = Path(args.db)
    conn = connect_db(db_path)
    loops = {
        "express": RouteLoop.from_routes_file("express"),
        "regular": RouteLoop.from_routes_file("regular"),
    }
    interval = args.interval
    print(
        f"Logging {', '.join(s['key'] for s in selected)} every {interval:g}s → {db_path}",
        flush=True,
    )
    try:
        while True:
            stamp = datetime.now().astimezone().isoformat(timespec="seconds")
            try:
                summaries = collect_summaries(selected, api)
            except RuntimeError as exc:
                print(f"[{stamp}] error: {exc}", flush=True)
                time.sleep(interval)
                continue

            for s in summaries:
                result = save_ping(conn, s, loops=loops)
                tag = "saved" if result["inserted"] else "dup"
                where = s.get("address") or f"{s.get('lat')},{s.get('lon')}"
                extra = ""
                pred = (result.get("prediction") or {}).get("prediction") or {}
                if pred and not pred.get("deduped"):
                    extra = (
                        f"  ETA {pred.get('eta_min')}m→{pred.get('target')} "
                        f"(spd {pred.get('speed_raw_mph')}→{pred.get('speed_used_mph')}mph)"
                    )
                resolved = (result.get("prediction") or {}).get("resolved") or []
                if resolved:
                    bits = ", ".join(
                        f"{r['target']} pred={r['eta_min']} act={r['actual_min']} err={r['error_min']}"
                        for r in resolved
                    )
                    extra += f"  resolved[{bits}]"
                print(
                    f"[{stamp}] {tag:5} {s['key']:8}  {s.get('state') or '?':7}  "
                    f"{where}  ({s.get('located_at')}){extra}",
                    flush=True,
                )
            time.sleep(interval)
    except KeyboardInterrupt:
        print("\nStopped.", flush=True)
        return 0
    finally:
        conn.close()


def cmd_history(args: argparse.Namespace) -> int:
    db_path = Path(args.db)
    if not db_path.exists():
        raise SystemExit(
            f"No history DB at {db_path}. Run: python3 lark_shuttle.py log"
        )
    conn = connect_db(db_path)

    since, until = _history_time_bounds(args)
    key = _normalize_shuttle_key(None if args.shuttle == "all" else args.shuttle)

    rows = query_history(conn, key, since, until, args.limit)
    conn.close()

    if args.geojson:
        print(json.dumps(export_geojson(rows), indent=2))
        return 0
    if args.json:
        print(json.dumps([dict(r) for r in rows], indent=2))
        return 0

    if not rows:
        print("No saved pings yet for that filter.")
        return 0

    print(f"{len(rows)} ping(s) from {db_path}")
    print("─" * 72)
    for row in rows:
        print(format_history_row(row))
    return 0


def _history_time_bounds(args: argparse.Namespace) -> tuple[datetime | None, datetime | None]:
    since = until = None
    if getattr(args, "hours", None) is not None:
        since = datetime.now(timezone.utc) - timedelta(hours=args.hours)
    if getattr(args, "since", None):
        since = datetime.fromisoformat(args.since.replace("Z", "+00:00"))
    if getattr(args, "until", None):
        until = datetime.fromisoformat(args.until.replace("Z", "+00:00"))
    return since, until


def _normalize_shuttle_key(key: str | None) -> str | None:
    """Normalize a vehicle id for history lookup (1/2)."""
    if not key or key == "all":
        return key
    from route_loop import normalize_vehicle_key

    return normalize_vehicle_key(key)


def _normalize_route_key(key: str | None) -> str | None:
    """Normalize passenger-service route key (express/regular)."""
    if not key:
        return key
    from route_loop import normalize_route_key, ROUTE_CANDIDATES

    raw = key.lower().strip()
    if raw == "all":
        return raw
    rk = normalize_route_key(raw)
    if rk not in ROUTE_CANDIDATES:
        raise SystemExit(f"--on-route must be express or regular, got {key!r}")
    return rk


def cmd_match(args: argparse.Namespace) -> int:
    """Snap a vehicle's saved pings onto the assigned route loop.

    ``shuttle`` is the Motive vehicle identity (``shuttle_key`` in the DB).
    Geometry is auto-inferred from GPS fit (or ``data/route_assignment.json`` /
    ``--on-route``). History rows are never rewritten.
    """
    db_path = Path(args.db)
    if not db_path.exists():
        raise SystemExit(f"No history DB at {db_path}. Run: python3 lark_shuttle.py log")

    vehicle_key = _normalize_shuttle_key(args.shuttle) or "1"
    if vehicle_key == "all":
        raise SystemExit("match needs a vehicle: 1 or 2")

    on_route = _normalize_route_key(getattr(args, "on_route", None))
    if on_route == "all":
        raise SystemExit("--on-route must be express or regular")

    routes_path = Path(args.routes)
    conn = connect_db(db_path)
    since, until = _history_time_bounds(args)

    if args.from_id is not None and args.to_id is not None:
        rows = list(
            conn.execute(
                "SELECT * FROM pings WHERE id IN (?, ?) ORDER BY located_at ASC, id ASC",
                (args.from_id, args.to_id),
            )
        )
        if len(rows) != 2:
            conn.close()
            raise SystemExit(f"Need both ping ids {args.from_id} and {args.to_id} in the DB")
        for row in rows:
            if row["shuttle_key"] != vehicle_key:
                conn.close()
                raise SystemExit(
                    f"Ping id {row['id']} is shuttle_key={row['shuttle_key']!r}, "
                    f"expected vehicle {vehicle_key!r}"
                )
    else:
        # Load by Motive vehicle identity; project onto assigned/inferred geometry.
        rows = query_history(conn, vehicle_key, since, until, args.limit)
        # query_history is newest-first; match wants chronological
        rows = list(reversed(rows))
    conn.close()

    pings = [dict(r) for r in rows if r["lat"] is not None and r["lon"] is not None]
    if len(pings) < 1:
        print("No saved pings to match.")
        return 0

    route_key, assign_meta = resolve_route_key(
        vehicle_key,
        on_route=on_route,
        pings=pings,
        routes_path=routes_path,
    )
    from route_loop import home_route_for_vehicle

    home = home_route_for_vehicle(vehicle_key)
    if route_key != home:
        assignment_note = (
            f"Shuttle {vehicle_key} · usual {home} · projecting onto {route_key}"
        )
    else:
        assignment_note = f"Shuttle {vehicle_key} · running {route_key}"

    try:
        loop = RouteLoop.from_routes_file(route_key, routes_path)
    except KeyError as exc:
        raise SystemExit(str(exc)) from exc

    projected = project_pings(loop, pings)

    if args.from_id is not None and args.to_id is not None:
        legs = infer_legs(loop, projected, min_forward_m=0.0)
    else:
        legs = infer_legs(loop, projected, min_forward_m=args.min_leg_m)

    payload = {
        "vehicle": vehicle_key,
        "route": route_key,
        "assignment_note": assignment_note,
        "assignment": assign_meta,
        "loop": {
            "name": loop.name,
            "length_m": round(loop.length_m, 1),
            "stops": loop.stops,
            "routes_file": str(routes_path),
        },
        "pings": [
            {
                "id": p.get("id"),
                "located_at": p.get("located_at"),
                "shuttle_key": p.get("shuttle_key"),
                "lat": p.get("lat"),
                "lon": p.get("lon"),
                "address": p.get("address"),
                "entity_state": p.get("entity_state"),
                "speed": p.get("speed"),
                "off_loop_m": p["loop"]["off_loop_m"],
                "s_m": round(p["loop"]["projection"]["s_m"], 1),
                "loop_frac": round(p["loop"]["projection"]["loop_frac"], 4),
                "snap_lat": p["loop"]["projection"]["lat"],
                "snap_lon": p["loop"]["projection"]["lon"],
                "nearest_stop": p["loop"]["nearest_stop"],
            }
            for p in projected
        ],
        "legs": [
            {
                "from_located_at": leg["from_located_at"],
                "to_located_at": leg["to_located_at"],
                "from_id": leg["from_id"],
                "to_id": leg["to_id"],
                "from_off_loop_m": leg["from_off_loop_m"],
                "to_off_loop_m": leg["to_off_loop_m"],
                "forward_m": leg["forward_m"],
                "forward_frac": leg["forward_frac"],
                "path_points": len(leg["path"]),
                "direction": leg.get("direction", "forward"),
                "raw_m": leg.get("raw_m"),
                **({"path": leg["path"]} if args.include_path or args.geojson else {}),
            }
            for leg in legs
        ],
    }

    if args.geojson:
        features: list[dict[str, Any]] = []
        for p in payload["pings"]:
            features.append(
                {
                    "type": "Feature",
                    "geometry": {
                        "type": "Point",
                        "coordinates": [p["lon"], p["lat"]],
                    },
                    "properties": {
                        "kind": "ping",
                        "id": p["id"],
                        "located_at": p["located_at"],
                        "off_loop_m": p["off_loop_m"],
                        "s_m": p["s_m"],
                        "nearest_stop": (p["nearest_stop"] or {}).get("name"),
                    },
                }
            )
            features.append(
                {
                    "type": "Feature",
                    "geometry": {
                        "type": "Point",
                        "coordinates": [p["snap_lon"], p["snap_lat"]],
                    },
                    "properties": {
                        "kind": "snap",
                        "id": p["id"],
                        "s_m": p["s_m"],
                    },
                }
            )
        for leg in legs:
            features.append(
                {
                    "type": "Feature",
                    "geometry": {
                        "type": "LineString",
                        "coordinates": [[lon, lat] for lat, lon in leg["path"]],
                    },
                    "properties": {
                        "kind": "inferred_leg",
                        "from_id": leg["from_id"],
                        "to_id": leg["to_id"],
                        "from_located_at": leg["from_located_at"],
                        "to_located_at": leg["to_located_at"],
                        "forward_m": leg["forward_m"],
                        "forward_frac": leg["forward_frac"],
                        "from_off_loop_m": leg["from_off_loop_m"],
                        "to_off_loop_m": leg["to_off_loop_m"],
                    },
                }
            )
        print(json.dumps({"type": "FeatureCollection", "features": features}, indent=2))
        return 0

    if args.json:
        print(json.dumps(payload, indent=2))
        return 0

    print(
        f"Vehicle '{vehicle_key}' → route '{route_key}'  "
        f"[{assign_meta.get('mode')}: {assign_meta.get('reason')}]  "
        f"loop {loop.length_m/1000:.2f} km ({len(loop.points)} pts)  "
        f"← {routes_path.name}"
    )
    if assignment_note:
        print(assignment_note)
    fits = assign_meta.get("fits") or {}
    if fits:
        bits = [
            f"{k} med={v['median_off_m']}m on={100*v['on_route_frac']:.0f}%"
            for k, v in fits.items()
        ]
        print("Fit: " + " · ".join(bits))
    print(f"{len(projected)} ping(s) snapped · {len(legs)} inferred leg(s)")
    print("─" * 78)
    for p in payload["pings"]:
        stop = p["nearest_stop"]
        stop_s = f" near {stop['name']} ({stop['along_m']:.0f}m)" if stop else ""
        print(
            f"{p['located_at']}  off={p['off_loop_m']:6.1f}m  "
            f"s={p['s_m']:7.0f}m ({100*p['loop_frac']:5.1f}%){stop_s}"
        )
    if legs:
        print("─" * 78)
        print("Inferred travel (forward along predetermined loop):")
        for leg in legs:
            print(
                f"  {leg['from_located_at']} → {leg['to_located_at']}  "
                f"{leg['forward_m']:.0f}m along loop "
                f"({100*leg['forward_frac']:.1f}%)  "
                f"gps-hop {leg.get('raw_m', '?')}m  "
                f"offs {leg['from_off_loop_m']:.0f}m → {leg['to_off_loop_m']:.0f}m"
            )
    return 0


def cmd_discover(args: argparse.Namespace, shuttles: list[dict[str, str]], api: dict[str, str]) -> int:
    swapped = roster_swapped()
    print(
        json.dumps(
            {
                "linktree": args.linktree,
                "roster": {
                    "timezone": TZ_CHAPEL_HILL,
                    "swap_at": "2:00 PM",
                    "swapped_now": swapped,
                    "note": (
                        "Shuttle 1 → Regular, Shuttle 2 → Express"
                        if swapped
                        else "Shuttle 1 → Express, Shuttle 2 → Regular"
                    ),
                },
                "shuttles": shuttles,
                "motive_api": {
                    "endpoint": api["endpoint"],
                    "api_base": api["api_base"],
                    "api_version": api["api_version"],
                    "api_path": api["api_path"],
                    "header": "X-Web-Share-Api-Key",
                    "web_share_api_key": api["web_share_api_key"],
                    "example": f"{api['endpoint']}?type=v&uuid={shuttles[0]['uuid']}",
                    "source": api.get("source"),
                },
            },
            indent=2,
        )
    )
    return 0


# ── CLI ──────────────────────────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "--linktree",
        default=LINKTREE_URL,
        help=f"Linktree URL (default: {LINKTREE_URL})",
    )
    common.add_argument(
        "--no-discover",
        action="store_true",
        help="Skip SPA scrape; use built-in Motive endpoint fallback",
    )
    common.add_argument(
        "--db",
        default=str(DEFAULT_DB),
        help=f"SQLite history DB (default: {DEFAULT_DB})",
    )

    parser = argparse.ArgumentParser(
        description="Lark Chapel Hill shuttle locator + history logger",
        parents=[common],
    )
    sub = parser.add_subparsers(dest="command")

    p_now = sub.add_parser(
        "now", parents=[common], help="Live position (also default with no subcommand)"
    )
    p_now.add_argument("shuttle", nargs="?", default="all")
    p_now.add_argument("--json", action="store_true")
    p_now.add_argument("--raw", action="store_true")
    p_now.add_argument(
        "--save",
        action="store_true",
        help="Also write this ping into the history DB",
    )

    p_log = sub.add_parser("log", parents=[common], help="Poll forever and save history")
    p_log.add_argument("shuttle", nargs="?", default="all")
    p_log.add_argument(
        "--interval",
        type=float,
        default=DEFAULT_LOG_INTERVAL,
        help=f"Seconds between polls (default: {DEFAULT_LOG_INTERVAL:g})",
    )

    p_hist = sub.add_parser("history", parents=[common], help="Show saved positions")
    p_hist.add_argument("shuttle", nargs="?", default="all")
    p_hist.add_argument("--hours", type=float, help="Only last N hours")
    p_hist.add_argument("--since", help="ISO timestamp lower bound")
    p_hist.add_argument("--until", help="ISO timestamp upper bound")
    p_hist.add_argument("--limit", type=int, default=50, help="Max rows (default 50)")
    p_hist.add_argument("--json", action="store_true")
    p_hist.add_argument("--geojson", action="store_true", help="Export GeoJSON trail")

    p_match = sub.add_parser(
        "match",
        parents=[common],
        help="Snap pings onto intended loop; infer travel between them",
    )
    p_match.add_argument(
        "shuttle",
        nargs="?",
        default="regular",
        help="Motive vehicle key (express/regular); pings loaded by shuttle_key",
    )
    p_match.add_argument(
        "--on-route",
        dest="on_route",
        help="Force route geometry (express/regular). Default: auto GPS fit",
    )
    p_match.add_argument("--hours", type=float, help="Only last N hours")
    p_match.add_argument("--since", help="ISO timestamp lower bound")
    p_match.add_argument("--until", help="ISO timestamp upper bound")
    p_match.add_argument("--limit", type=int, default=100, help="Max pings (default 100)")
    p_match.add_argument(
        "--routes",
        default=str(DEFAULT_ROUTES),
        help=f"intended_routes.json (default: {DEFAULT_ROUTES})",
    )
    p_match.add_argument(
        "--from-id",
        type=int,
        help="Ping row id (with --to-id) for a single inferred leg",
    )
    p_match.add_argument(
        "--to-id",
        type=int,
        help="Ping row id (with --from-id) for a single inferred leg",
    )
    p_match.add_argument(
        "--min-leg-m",
        type=float,
        default=15.0,
        help="Skip inferred legs shorter than this (default 15m)",
    )
    p_match.add_argument("--json", action="store_true")
    p_match.add_argument(
        "--include-path",
        action="store_true",
        help="With --json, include full leg path coordinates",
    )
    p_match.add_argument(
        "--geojson",
        action="store_true",
        help="Export pings, snaps, and inferred loop legs as GeoJSON",
    )

    p_label = sub.add_parser(
        "label",
        parents=[common],
        help="Backfill route_key on history; export train_ok pings",
    )
    p_label.add_argument(
        "--routes",
        default=str(DEFAULT_ROUTES),
        help=f"intended_routes.json (default: {DEFAULT_ROUTES})",
    )
    p_label.add_argument(
        "--out-dir",
        default="",
        help="Export dir for history.json + train_pings.json (default: ./data)",
    )
    p_label.add_argument("--json", action="store_true", help="Print stats as JSON")

    sub.add_parser("discover", parents=[common], help="Print discovered endpoint + UUIDs")

    return parser


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)

    # Backward-compatible shortcuts:
    #   lark_shuttle.py                -> now all
    #   lark_shuttle.py express        -> now express
    #   lark_shuttle.py --json         -> now all --json
    #   lark_shuttle.py --discover-only -> discover
    commands = {"now", "log", "history", "match", "label", "discover"}
    if argv and argv[0] in ("--discover-only",):
        argv = ["discover"]
    elif not argv or (argv[0] not in commands and not argv[0].startswith("-")):
        # first token is shuttle name or empty -> treat as `now`
        argv = ["now", *argv]
    elif argv and argv[0].startswith("-") and argv[0] not in (
        "-h",
        "--help",
    ):
        argv = ["now", *argv]

    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "history":
        return cmd_history(args)
    if args.command == "match":
        return cmd_match(args)
    if args.command == "label":
        return cmd_label(args)

    # now / log / discover need Linktree + API
    try:
        shuttles = discover_shuttles_from_linktree(args.linktree)
    except Exception as exc:  # noqa: BLE001
        if args.no_discover or args.command in {"now", "log"}:
            # minimal offline shuttle list from fallback UUIDs if Linktree fails
            raise SystemExit(f"Failed to read Linktree: {exc}") from exc
        raise SystemExit(f"Failed to read Linktree: {exc}") from exc

    api = resolve_api(args.no_discover)

    if args.command == "discover":
        return cmd_discover(args, shuttles, api)
    if args.command == "log":
        if args.interval <= 0:
            raise SystemExit("--interval must be > 0")
        return cmd_log(args, shuttles, api)
    if args.command == "now":
        return cmd_now(args, shuttles, api)

    parser.error(f"Unknown command: {args.command}")
    return 2


if __name__ == "__main__":
    sys.exit(main())
