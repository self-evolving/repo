#!/usr/bin/env bash
# One-stop setup: configure runner(s), install the cleanup schedule, and start running.
#
# Usage:
#   ./bootstrap.sh <github_url> <registration_token> [num_runners]
#
# Examples:
#   ./bootstrap.sh https://github.com/my-org TOKEN
#   ./bootstrap.sh https://github.com/my-org/my-repo TOKEN 3

set -euo pipefail

GITHUB_URL=${1:-${GITHUB_URL:-}}
TOKEN=${2:-${RUNNER_TOKEN:-}}
NUM_RUNNERS=${3:-${NUM_RUNNERS:-1}}
BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST_TEMPLATE="$BASE_DIR/com.local-runner.cleanup.plist.template"
PLIST_PATH="$HOME/Library/LaunchAgents/com.local-runner.cleanup.plist"
LOCAL_RUNNER_DOCKER_PRUNE=${LOCAL_RUNNER_DOCKER_PRUNE:-0}

xml_escape() {
  printf '%s' "$1" \
    | sed \
      -e 's/&/\&amp;/g' \
      -e 's/</\&lt;/g' \
      -e 's/>/\&gt;/g' \
      -e 's/"/\&quot;/g' \
      -e "s/'/\&apos;/g"
}

sed_replacement_escape() {
  printf '%s' "$1" | sed 's/[\\&|]/\\&/g'
}

usage() {
  echo "Usage: $0 <github_url> <registration_token> [num_runners]"
  echo ""
  echo "Examples:"
  echo "  $0 https://github.com/my-org TOKEN"
  echo "  $0 https://github.com/my-org/my-repo TOKEN 3"
  echo ""
  echo "Create a token from GitHub Settings → Actions → Runners → New self-hosted runner."
}

if [ -z "$GITHUB_URL" ] || [ -z "$TOKEN" ]; then
  usage
  exit 1
fi

if ! [[ "$NUM_RUNNERS" =~ ^[0-9]+$ ]] || [ "$NUM_RUNNERS" -lt 1 ]; then
  echo "num_runners must be a positive integer."
  exit 1
fi

if [ "$LOCAL_RUNNER_DOCKER_PRUNE" != "0" ] && [ "$LOCAL_RUNNER_DOCKER_PRUNE" != "1" ]; then
  echo "LOCAL_RUNNER_DOCKER_PRUNE must be 0 or 1."
  exit 1
fi

case "$GITHUB_URL" in
  http://*|https://*) ;;
  *)
    echo "github_url must be a URL, for example: https://github.com/my-org"
    exit 1
    ;;
esac

echo "=== Step 0: Check runner host requirements ==="
bash "$BASE_DIR/check-requirements.sh"

echo ""
echo "=== Step 1: Setup runner(s) ==="
LOCAL_RUNNER_REQUIREMENTS_CHECKED=1 bash "$BASE_DIR/setup-runners.sh" "$GITHUB_URL" "$TOKEN" "$NUM_RUNNERS"

echo ""
echo "=== Step 2: Activate cleanup schedule (every 6 hours) ==="
if [ "$(uname -s)" = "Darwin" ]; then
  if [ ! -f "$PLIST_TEMPLATE" ]; then
    echo "Missing launchd template: $PLIST_TEMPLATE"
    exit 1
  fi

  mkdir -p "$HOME/Library/LaunchAgents"

  if [ -L "$PLIST_PATH" ] || [ -f "$PLIST_PATH" ]; then
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    rm -f "$PLIST_PATH"
  fi

  # Render the template with this checkout's absolute path. Escape first for XML,
  # then for sed replacement syntax so XML-sensitive path characters remain valid.
  ESCAPED_BASE_DIR=$(sed_replacement_escape "$(xml_escape "$BASE_DIR")")
  sed \
    -e "s|__PROJECT_DIR__|$ESCAPED_BASE_DIR|g" \
    -e "s|__LOCAL_RUNNER_DOCKER_PRUNE__|$LOCAL_RUNNER_DOCKER_PRUNE|g" \
    "$PLIST_TEMPLATE" > "$PLIST_PATH"

  launchctl load "$PLIST_PATH"
  echo "Cleanup scheduled: $PLIST_PATH"
else
  echo "Skipping launchd setup because this is not macOS. Run cleanup-runner.sh manually if needed."
fi

echo ""
echo "=== Step 3: Starting runner(s) ==="
exec bash "$BASE_DIR/start-runners.sh"
