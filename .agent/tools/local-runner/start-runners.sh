#!/usr/bin/env bash
# Start all configured runners in background processes.
# Logs go to runner-N/runner.log.

set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
PIDS=()

cleanup() {
  echo ""
  echo "Stopping all runners..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  echo "All runners stopped."
}

trap cleanup SIGINT SIGTERM

# Share tool cache (Node, Python, etc.) across all runners to avoid re-downloading.
export RUNNER_TOOL_CACHE="${RUNNER_TOOL_CACHE:-$BASE_DIR/shared-tool-cache}"
mkdir -p "$RUNNER_TOOL_CACHE"

# Ask the GitHub runner wrapper to trap signals and forward them to the
# Runner.Listener process group. Without this, killing the backgrounded run.sh
# wrapper can leave listeners alive after Ctrl+C/SIGTERM.
export RUNNER_MANUALLY_TRAP_SIG=1

echo "Starting runners..."

for dir in "$BASE_DIR"/runner-*/; do
  [ -d "$dir" ] || continue
  [ -f "$dir/.runner" ] || { echo "Skipping unconfigured dir: $dir"; continue; }

  name=$(basename "$dir")
  echo "Starting $name (log: $dir/runner.log)"

  (cd "$dir" && ./run.sh >> runner.log 2>&1) &
  PIDS+=($!)
done

if [ ${#PIDS[@]} -eq 0 ]; then
  echo "No configured runners found. Run setup-runners.sh first."
  exit 1
fi

echo ""
echo "${#PIDS[@]} runner(s) started. Press Ctrl+C to stop all."
echo "To view logs: tail -f $BASE_DIR/runner-*/runner.log"

wait
