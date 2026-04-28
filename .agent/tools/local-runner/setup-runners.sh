#!/usr/bin/env bash
# Set up one or more GitHub Actions self-hosted runners.
#
# Usage:
#   ./setup-runners.sh <github_url> <registration_token> [num_runners]
#
# Examples:
#   ./setup-runners.sh https://github.com/my-org TOKEN
#   ./setup-runners.sh https://github.com/my-org/my-repo TOKEN 3

set -euo pipefail

GITHUB_URL=${1:-${GITHUB_URL:-}}
TOKEN=${2:-${RUNNER_TOKEN:-}}
NUM_RUNNERS=${3:-${NUM_RUNNERS:-1}}
BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNNER_VERSION=${RUNNER_VERSION:-2.332.0}

usage() {
  echo "Usage: $0 <github_url> <registration_token> [num_runners]"
  echo ""
  echo "Examples:"
  echo "  $0 https://github.com/my-org TOKEN"
  echo "  $0 https://github.com/my-org/my-repo TOKEN 3"
  echo ""
  echo "Create a token from GitHub Settings → Actions → Runners → New self-hosted runner."
}

detect_runner_platform() {
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64)
      echo "osx-arm64"
      ;;
    Darwin-x86_64)
      echo "osx-x64"
      ;;
    *)
      echo "Unsupported platform: $(uname -s) $(uname -m). Set RUNNER_PLATFORM explicitly if a runner package exists for this machine." >&2
      exit 1
      ;;
  esac
}

runner_arch_label() {
  case "$1" in
    *arm64*) echo "ARM64" ;;
    *x64*) echo "X64" ;;
    *) echo "$1" ;;
  esac
}

escape_basic_regex() {
  printf '%s' "$1" | sed 's/[][\\.^$*]/\\&/g'
}

runner_release_metadata() {
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    curl -fsSL \
      -H "Authorization: Bearer $GITHUB_TOKEN" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "https://api.github.com/repos/actions/runner/releases/tags/v${RUNNER_VERSION}"
  else
    curl -fsSL "https://api.github.com/repos/actions/runner/releases/tags/v${RUNNER_VERSION}"
  fi
}

runner_release_body() {
  runner_release_metadata | jq -r '.body // ""'
}

runner_sha256() {
  if [ -n "${RUNNER_SHA256:-}" ]; then
    echo "$RUNNER_SHA256"
    return
  fi

  escaped_asset=$(escape_basic_regex "$RUNNER_ASSET")
  runner_release_body \
    | sed -n "s/.*${escaped_asset}.*BEGIN SHA ${RUNNER_PLATFORM} -->\([0-9a-f]\{64\}\)<.*/\1/p"
}

verify_runner_tarball() {
  expected_sha=$(runner_sha256)

  if [ -z "$expected_sha" ]; then
    echo "Unable to find SHA-256 checksum for $RUNNER_ASSET. Set RUNNER_SHA256 explicitly to continue." >&2
    exit 1
  fi

  actual_sha=$(shasum -a 256 "$RUNNER_TAR" | awk '{print $1}')

  if [ "$actual_sha" != "$expected_sha" ]; then
    echo "Checksum mismatch for $RUNNER_TAR" >&2
    echo "expected: $expected_sha" >&2
    echo "actual:   $actual_sha" >&2
    exit 1
  fi
}

if [ -z "$GITHUB_URL" ] || [ -z "$TOKEN" ]; then
  usage
  exit 1
fi

if ! [[ "$NUM_RUNNERS" =~ ^[0-9]+$ ]] || [ "$NUM_RUNNERS" -lt 1 ]; then
  echo "num_runners must be a positive integer."
  exit 1
fi

case "$GITHUB_URL" in
  http://*|https://*) ;;
  *)
    echo "github_url must be a URL, for example: https://github.com/my-org"
    exit 1
    ;;
esac

if [ "${LOCAL_RUNNER_REQUIREMENTS_CHECKED:-0}" != "1" ]; then
  bash "$BASE_DIR/check-requirements.sh"
fi

RUNNER_PLATFORM=${RUNNER_PLATFORM:-$(detect_runner_platform)}
DEFAULT_LABELS="self-hosted,macOS,$(runner_arch_label "$RUNNER_PLATFORM")"
RUNNER_LABELS=${RUNNER_LABELS:-$DEFAULT_LABELS}
DEFAULT_RUNNER_NAME_PREFIX="$(hostname -s 2>/dev/null || hostname)-runner"
RUNNER_NAME_PREFIX=${RUNNER_NAME_PREFIX:-$DEFAULT_RUNNER_NAME_PREFIX}
RUNNER_CACHE_DIR="$BASE_DIR/actions-runner"
RUNNER_ASSET="actions-runner-${RUNNER_PLATFORM}-${RUNNER_VERSION}.tar.gz"
RUNNER_TAR="$RUNNER_CACHE_DIR/$RUNNER_ASSET"
RUNNER_URL="https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/$RUNNER_ASSET"

mkdir -p "$RUNNER_CACHE_DIR"

if [ ! -f "$RUNNER_TAR" ]; then
  echo "Downloading GitHub Actions runner $RUNNER_VERSION for $RUNNER_PLATFORM..."
  curl -fL -o "$RUNNER_TAR" "$RUNNER_URL"
fi

echo "Verifying $RUNNER_ASSET..."
verify_runner_tarball

for i in $(seq 1 "$NUM_RUNNERS"); do
  RUNNER_DIR="$BASE_DIR/runner-$i"
  RUNNER_NAME="$RUNNER_NAME_PREFIX-$i"

  if [ -d "$RUNNER_DIR" ] && [ -f "$RUNNER_DIR/.runner" ]; then
    echo "Runner $i already configured at $RUNNER_DIR; skipping setup."
    continue
  fi

  echo "=== Setting up runner $i in $RUNNER_DIR ==="
  mkdir -p "$RUNNER_DIR"
  tar xzf "$RUNNER_TAR" -C "$RUNNER_DIR"

  (
    cd "$RUNNER_DIR"
    ./config.sh --url "$GITHUB_URL" \
      --token "$TOKEN" \
      --name "$RUNNER_NAME" \
      --labels "$RUNNER_LABELS" \
      --unattended \
      --replace
  )

  echo "Runner $i configured as $RUNNER_NAME."
done

echo ""
echo "All $NUM_RUNNERS runner(s) configured. Start them with:"
echo "  ./start-runners.sh"
