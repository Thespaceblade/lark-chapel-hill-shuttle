#!/usr/bin/env bash
# Snapshot local shuttle history into data/ and push to GitHub on main.
# Relabels route_key before export so training data stays clean.
# Safe to run repeatedly — no-op if nothing changed.
# Always commits on main (never rebases the current feature branch).
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

# Backfill route labels + write history/prediction exports + data DB snapshot
python3 lark_shuttle.py label --db "$DB_LIVE" --out-dir "${ROOT}/data"

gh auth setup-git >/dev/null 2>&1 || true

START_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
# Detached HEAD / rebase → don't try to return to a branch name
if [[ "$START_BRANCH" == "HEAD" ]]; then
  START_BRANCH=""
fi

# Move snapshot commit onto main without rebasing a feature branch onto main.
git fetch origin main
git stash push -u -m "history-push-${STAMP}" -- data/shuttle_history.db data/history.json \
  data/train_pings.json data/predictions.json data/train_predictions.json >/dev/null || true
git checkout main
git pull --ff-only origin main

git stash pop >/dev/null 2>&1 || true

git add data/shuttle_history.db data/history.json data/train_pings.json \
        data/predictions.json data/train_predictions.json

if git diff --cached --quiet; then
  echo "[$STAMP] history unchanged — nothing to push"
  if [[ -n "$START_BRANCH" && "$START_BRANCH" != "main" ]]; then
    git checkout "$START_BRANCH" || true
  fi
  exit 0
fi

COUNT="$(python3 -c "import json; print(json.load(open('data/history.json'))['ping_count'])")"
TRAIN="$(python3 -c "import json; print(json.load(open('data/train_pings.json'))['ping_count'])")"
ARRIVED="$(python3 -c "import json; print(json.load(open('data/train_predictions.json'))['ping_count'])")"
git -c user.email="cursor-agent@users.noreply.github.com" \
    -c user.name="Cursor Agent" \
    commit -m "Update shuttle history snapshot (${COUNT} pings, ${TRAIN} train_ok, ${ARRIVED} arrived ETAs, ${STAMP})"

git push origin main
echo "[$STAMP] pushed history snapshot (${COUNT} pings, ${TRAIN} train_ok, ${ARRIVED} arrived ETAs)"

if [[ -n "$START_BRANCH" && "$START_BRANCH" != "main" ]]; then
  git checkout "$START_BRANCH" || true
fi
