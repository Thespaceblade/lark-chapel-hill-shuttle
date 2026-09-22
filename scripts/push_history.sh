#!/usr/bin/env bash
# Snapshot local shuttle history into data/ and push to GitHub.
# Safe to run repeatedly — no-op if nothing changed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DB_LIVE="${ROOT}/shuttle_history.db"
DB_SNAP="${ROOT}/data/shuttle_history.db"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [[ ! -f "$DB_LIVE" ]]; then
  echo "[$STAMP] no live DB at $DB_LIVE — skip"
  exit 0
fi

mkdir -p "${ROOT}/data"
cp -f "$DB_LIVE" "$DB_SNAP"

python3 <<'PY'
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

db = Path("shuttle_history.db")
out = Path("data/history.json")
conn = sqlite3.connect(db)
conn.row_factory = sqlite3.Row
rows = [
    dict(r)
    for r in conn.execute(
        """
        SELECT id, recorded_at, shuttle_key, shuttle_name, vehicle_number,
               located_at, lat, lon, address, city, entity_state, speed,
               bearing, compass
        FROM pings
        ORDER BY located_at ASC, id ASC
        """
    )
]
conn.close()
by: dict[str, int] = {}
for r in rows:
    by[r["shuttle_key"]] = by.get(r["shuttle_key"], 0) + 1
payload = {
    "exported_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "ping_count": len(rows),
    "by_shuttle": by,
    "pings": rows,
}
out.write_text(json.dumps(payload, indent=2))
print(f"exported {len(rows)} pings → {out}")
PY

gh auth setup-git >/dev/null 2>&1 || true

git add data/shuttle_history.db data/history.json

if git diff --cached --quiet; then
  echo "[$STAMP] history unchanged — nothing to push"
  exit 0
fi

COUNT="$(python3 -c "import json; print(json.load(open('data/history.json'))['ping_count'])")"
git -c user.email="cursor-agent@users.noreply.github.com" \
    -c user.name="Cursor Agent" \
    commit -m "Update shuttle history snapshot (${COUNT} pings, ${STAMP})"

git push origin HEAD
echo "[$STAMP] pushed history snapshot (${COUNT} pings)"
