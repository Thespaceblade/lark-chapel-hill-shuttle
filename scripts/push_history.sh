#!/usr/bin/env bash
# Snapshot local shuttle history into data/ and push to GitHub.
# Relabels route_key before export so training data stays clean.
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

# Backfill route labels + write history.json / train_pings.json / data DB snapshot
python3 lark_shuttle.py label --db "$DB_LIVE" --out-dir "${ROOT}/data"

gh auth setup-git >/dev/null 2>&1 || true

git add data/shuttle_history.db data/history.json data/train_pings.json

if git diff --cached --quiet; then
  echo "[$STAMP] history unchanged — nothing to push"
  exit 0
fi

COUNT="$(python3 -c "import json; print(json.load(open('data/history.json'))['ping_count'])")"
TRAIN="$(python3 -c "import json; print(json.load(open('data/train_pings.json'))['ping_count'])")"
git -c user.email="cursor-agent@users.noreply.github.com" \
    -c user.name="Cursor Agent" \
    commit -m "Update shuttle history snapshot (${COUNT} pings, ${TRAIN} train_ok, ${STAMP})"

# Integrate any remote commits (Vercel bots / other agents) then push
git pull --rebase origin main
git push origin main
echo "[$STAMP] pushed history snapshot (${COUNT} pings, ${TRAIN} train_ok)"
