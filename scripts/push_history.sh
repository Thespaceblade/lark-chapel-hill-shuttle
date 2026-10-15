#!/usr/bin/env bash
# Snapshot local shuttle history into data/ and push a PR branch.
# Relabels route_key before export so training data stays clean.
# Safe to run repeatedly — no-op if nothing changed.
# Pushes to HISTORY_BRANCH (default cursor/shuttle-history-a065) because
# main requires PRs (direct pushes are rejected by repo rules).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DB_LIVE="${ROOT}/shuttle_history.db"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
HISTORY_BRANCH="${HISTORY_BRANCH:-cursor/shuttle-history-a065}"
LOCK_FILE="${ROOT}/data/.push_history.lock"

if [[ ! -f "$DB_LIVE" ]]; then
  echo "[$STAMP] no live DB at $DB_LIVE — skip"
  exit 0
fi

mkdir -p "${ROOT}/data"

# Prevent overlapping push/label runs from clobbering JSON mid-write.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[$STAMP] another push_history is running — skip"
  exit 0
fi

gh auth setup-git >/dev/null 2>&1 || true

START_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$START_BRANCH" == "HEAD" ]]; then
  START_BRANCH=""
fi

git fetch origin main "${HISTORY_BRANCH}" 2>/dev/null || git fetch origin main

# Rebuild history branch tip from latest main each run.
git checkout -B "$HISTORY_BRANCH" origin/main

# Export AFTER checkout so files aren't replaced by an older tree.
python3 lark_shuttle.py label --db "$DB_LIVE" --out-dir "${ROOT}/data"

git add data/shuttle_history.db data/history.json data/train_pings.json \
        data/predictions.json data/train_predictions.json scripts/push_history.sh

if git diff --cached --quiet; then
  echo "[$STAMP] history unchanged — nothing to push"
  if [[ -n "$START_BRANCH" && "$START_BRANCH" != "$HISTORY_BRANCH" && "$START_BRANCH" != "main" ]]; then
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

for attempt in 1 2 3 4; do
  # force-with-lease: branch tip is intentionally rebuilt from main + latest snapshot
  if git push -u origin "$HISTORY_BRANCH" --force-with-lease="refs/heads/${HISTORY_BRANCH}:refs/remotes/origin/${HISTORY_BRANCH}" \
    || git push -u origin "$HISTORY_BRANCH" --force-with-lease; then
    echo "[$STAMP] pushed history snapshot to ${HISTORY_BRANCH} (${COUNT} pings, ${TRAIN} train_ok, ${ARRIVED} arrived ETAs)"
    break
  fi
  if [[ "$attempt" -eq 4 ]]; then
    echo "[$STAMP] push to ${HISTORY_BRANCH} failed after retries" >&2
    exit 1
  fi
  git fetch origin "${HISTORY_BRANCH}" || true
  sleep $((4 * attempt))
done

if [[ -n "$START_BRANCH" && "$START_BRANCH" != "$HISTORY_BRANCH" && "$START_BRANCH" != "main" ]]; then
  git checkout "$START_BRANCH" || true
fi
