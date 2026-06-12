#!/usr/bin/env bash
# Post-job cleanup hook for self-hosted runners.
#
# Wired in via ACTIONS_RUNNER_HOOK_JOB_COMPLETED in each runner's .env. The
# runner invokes this script after every job, with GITHUB_* and RUNNER_*
# env vars populated. It must never fail the runner — always exit 0.
#
# Behavior:
#   * Trim runner-N/_diag to the last 30 files and drop anything > 3 days old.
#   * Remove runner-N/_work/<repo> dirs not touched in the last 24h, skipping
#     the current job's repo so checkout caching stays warm.

set -u
trap 'exit 0' ERR

WORKSPACE="${RUNNER_WORKSPACE:-}"
[ -n "$WORKSPACE" ] || exit 0

WORK_DIR="$(dirname "$WORKSPACE")"
RUNNER_ROOT="$(dirname "$WORK_DIR")"
DIAG_DIR="$RUNNER_ROOT/_diag"
LOG="$RUNNER_ROOT/cleanup-hook.log"

ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

current_repo="${GITHUB_REPOSITORY##*/}"

log "post-job: repo=${GITHUB_REPOSITORY:-?} workflow=${GITHUB_WORKFLOW:-?} run=${GITHUB_RUN_ID:-?}"

if [ -d "$DIAG_DIR" ]; then
  before=$(du -sk "$DIAG_DIR" 2>/dev/null | awk '{print $1}')
  ls -1t "$DIAG_DIR" 2>/dev/null | awk 'NR>30' | while read -r f; do
    rm -f "$DIAG_DIR/$f" 2>/dev/null || true
  done
  find "$DIAG_DIR" -type f -mtime +3 -delete 2>/dev/null || true
  after=$(du -sk "$DIAG_DIR" 2>/dev/null | awk '{print $1}')
  log "_diag trimmed: ${before:-?}K -> ${after:-?}K"
fi

if [ -d "$WORK_DIR" ]; then
  for d in "$WORK_DIR"/*; do
    [ -d "$d" ] || continue
    name=$(basename "$d")
    case "$name" in
      _*|"$current_repo") continue ;;
    esac
    if [ -z "$(find "$d" -maxdepth 0 -mtime -1 -print 2>/dev/null)" ]; then
      size=$(du -sk "$d" 2>/dev/null | awk '{print $1}')
      rm -rf "$d" 2>/dev/null && log "pruned _work/$name (${size:-?}K)"
    fi
  done
fi

exit 0
