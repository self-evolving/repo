#!/usr/bin/env bash
set -euo pipefail

script_dir="${GITHUB_ACTION_PATH:-$(dirname "$0")}"
if [ ! -f "${script_dir}/resolve-provider.js" ]; then
  script_dir="$(dirname "$0")"
fi
node "${script_dir}/resolve-provider.js"
