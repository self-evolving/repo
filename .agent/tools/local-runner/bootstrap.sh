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
# Runner working directories may live outside this checkout (see LOCAL_RUNNER_ROOT
# in setup-runners.sh). setup/start/stop read it from the environment; we only
# need it here to point scheduled cleanup at the same location.
RUNNER_ROOT="${LOCAL_RUNNER_ROOT:-$BASE_DIR}"
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

  # Render path placeholders after escaping first for XML, then for sed
  # replacement syntax so XML-sensitive path characters remain valid.
  ESCAPED_BASE_DIR=$(sed_replacement_escape "$(xml_escape "$BASE_DIR")")
  ESCAPED_RUNNER_ROOT=$(sed_replacement_escape "$(xml_escape "$RUNNER_ROOT")")
  sed \
    -e "s|__PROJECT_DIR__|$ESCAPED_BASE_DIR|g" \
    -e "s|__LOCAL_RUNNER_ROOT__|$ESCAPED_RUNNER_ROOT|g" \
    -e "s|__LOCAL_RUNNER_DOCKER_PRUNE__|$LOCAL_RUNNER_DOCKER_PRUNE|g" \
    "$PLIST_TEMPLATE" > "$PLIST_PATH"

  launchctl load "$PLIST_PATH"
  echo "Cleanup scheduled: $PLIST_PATH"
elif [ "$(uname -s)" = "Linux" ]; then
  # Linux has no launchd. Prefer cron, which does not require a user D-Bus
  # session or lingering the way a systemd --user timer would.
  if command -v crontab >/dev/null 2>&1; then
    CRON_MARKER="# local-runner-cleanup ($BASE_DIR)"
    # The trailing marker is a shell comment when cron runs the line, so it is
    # ignored at execution time but lets us find and replace our own entry.
    CRON_LINE="0 */6 * * * LOCAL_RUNNER_ROOT=\"$RUNNER_ROOT\" LOCAL_RUNNER_DOCKER_PRUNE=$LOCAL_RUNNER_DOCKER_PRUNE /bin/bash \"$BASE_DIR/cleanup-runner.sh\" $CRON_MARKER"

    # `crontab -l` exits non-zero when no crontab exists; capture without tripping set -e.
    if EXISTING_CRON="$(crontab -l 2>/dev/null)"; then :; else EXISTING_CRON=""; fi

    # Keep every existing line except a prior entry for this checkout, then
    # append the refreshed schedule. `|| true` swallows grep's no-match exit.
    FILTERED_CRON="$(printf '%s\n' "$EXISTING_CRON" | grep -vF "$CRON_MARKER" | sed '/^[[:space:]]*$/d' || true)"
    NEW_CRON="${FILTERED_CRON:+$FILTERED_CRON$'\n'}$CRON_LINE"

    if printf '%s\n' "$NEW_CRON" | crontab -; then
      echo "Cleanup scheduled via cron (every 6 hours): $BASE_DIR/cleanup-runner.sh"
      echo "Note: cleanup only runs while the cron daemon (crond) is active on this host."
    else
      echo "Could not install cron job. Run cleanup-runner.sh manually or add it to your crontab."
    fi
  else
    echo "crontab not found. Skipping scheduled cleanup; run cleanup-runner.sh manually if needed."
  fi
else
  echo "Skipping scheduled cleanup setup on $(uname -s). Run cleanup-runner.sh manually if needed."
fi

echo ""
echo "=== Step 3: Starting runner(s) ==="
exec bash "$BASE_DIR/start-runners.sh"
