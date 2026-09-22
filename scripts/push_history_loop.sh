#!/usr/bin/env bash
# Run history snapshot + push every 2 hours.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INTERVAL_SEC="${HISTORY_PUSH_INTERVAL_SEC:-7200}"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] history push loop every ${INTERVAL_SEC}s"
while true; do
  bash "${ROOT}/scripts/push_history.sh" || echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] push failed (will retry)"
  sleep "$INTERVAL_SEC"
done
