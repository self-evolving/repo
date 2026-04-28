#!/usr/bin/env bash
# Cleanup script for local self-hosted GitHub Actions runners.
# Intended to run every 6 hours via launchd on macOS.

set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="$BASE_DIR/cleanup.log"
exec >> "$LOG_FILE" 2>&1

echo "=== Cleanup started: $(date) ==="

if [ "${LOCAL_RUNNER_DOCKER_PRUNE:-0}" = "1" ]; then
  if command -v docker >/dev/null 2>&1; then
    echo "Pruning unused Docker containers, images, and networks..."
    docker system prune -f 2>/dev/null || echo "Docker prune skipped (Docker not running or not reachable)."
  else
    echo "Docker not installed; skipping Docker prune."
  fi
else
  echo "Docker prune disabled. Set LOCAL_RUNNER_DOCKER_PRUNE=1 to enable it."
fi

# Remove old runner diagnostic logs (older than 7 days) from all configured runners.
echo "Cleaning runner diagnostic logs older than 7 days..."
find "$BASE_DIR" -path "$BASE_DIR/runner-*/_diag/*.log" -type f -mtime +7 -delete 2>/dev/null || true

echo "Disk: $(df -h / | awk 'NR==2{print $4 " free"}')"
echo "=== Cleanup finished: $(date) ==="
