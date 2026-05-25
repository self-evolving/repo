#!/usr/bin/env bash
set -euo pipefail

if [ -n "${PI_AUTH_JSON_B64:-}" ] && [ -n "${PI_AUTH_JSON:-}" ]; then
  echo "PI_AUTH_JSON_B64 and PI_AUTH_JSON are both set; configure only one Pi auth secret." >&2
  exit 1
fi

if [ -z "${PI_AUTH_JSON_B64:-}" ] && [ -z "${PI_AUTH_JSON:-}" ]; then
  exit 0
fi

if [ -z "${RUNNER_TEMP:-}" ]; then
  echo "RUNNER_TEMP is required to restore Pi auth into an isolated directory." >&2
  exit 1
fi

if [ -z "${GITHUB_ENV:-}" ]; then
  echo "GITHUB_ENV is required to publish PI_CODING_AGENT_DIR." >&2
  exit 1
fi

decode_base64() {
  local decoder=()
  if printf '' | base64 --decode >/dev/null 2>&1; then
    decoder=(base64 --decode)
  elif printf '' | base64 -d >/dev/null 2>&1; then
    decoder=(base64 -d)
  elif printf '' | base64 -D >/dev/null 2>&1; then
    decoder=(base64 -D)
  else
    echo "No supported base64 decoder is available." >&2
    return 1
  fi

  printf '%s' "$1" | "${decoder[@]}"
}

pi_agent_dir="${RUNNER_TEMP%/}/pi-agent"
auth_file="$pi_agent_dir/auth.json"
mkdir -p "$pi_agent_dir"

if [ -n "${PI_AUTH_JSON_B64:-}" ]; then
  decode_base64 "$PI_AUTH_JSON_B64" > "$auth_file"
else
  printf '%s' "$PI_AUTH_JSON" > "$auth_file"
fi

chmod 600 "$auth_file"
{
  echo "PI_CODING_AGENT_DIR=$pi_agent_dir"
  if [ -n "${HOME:-}" ]; then
    pi_session_dir="${HOME%/}/.pi/agent/sessions"
    mkdir -p "$pi_session_dir"
    echo "PI_CODING_AGENT_SESSION_DIR=$pi_session_dir"
  fi
  echo "PI_AUTH_RESTORED=true"
} >> "$GITHUB_ENV"
