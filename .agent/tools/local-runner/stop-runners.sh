#!/usr/bin/env bash
# Stop all running GitHub Actions runner processes created from runner-* directories.

set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
FOUND=0

for dir in "$BASE_DIR"/runner-*/; do
  [ -d "$dir" ] || continue
  FOUND=1
  runner_path="${dir%/}"
  name=$(basename "$runner_path")

  pids=$(pgrep -f "$runner_path/bin/Runner.Listener" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "Stopping $name (PID(s): $(echo "$pids" | tr '\n' ' '))"
    kill $pids 2>/dev/null || true
  else
    echo "$name is not running"
  fi
done

if [ "$FOUND" -eq 0 ]; then
  echo "No runner-* directories found."
fi

echo "Done."
