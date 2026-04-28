#!/usr/bin/env bash
set -euo pipefail

echo "token=" >> "$GITHUB_OUTPUT"
echo "auth_mode=" >> "$GITHUB_OUTPUT"

if [ -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] || [ -z "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]; then
  echo "OIDC token request environment is unavailable; skipping hosted broker auth." >&2
  exit 0
fi

for cmd in curl jq; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "Missing required tool for hosted broker auth: ${cmd}; skipping hosted broker auth." >&2
    exit 0
  fi
done

run_with_retries() {
  local __result_var="$1"
  shift
  local __attempt=1
  local __delay=1
  local __result=""

  while true; do
    if __result="$("$@")"; then
      printf -v "${__result_var}" '%s' "${__result}"
      return 0
    fi

    if [ "${__attempt}" -ge 3 ]; then
      return 1
    fi

    sleep "${__delay}"
    __delay=$((__delay * 2))
    __attempt=$((__attempt + 1))
  done
}

oidc_request_url="${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${OIDC_AUDIENCE}"

if ! run_with_retries oidc_response \
  curl --fail --silent --show-error --max-time 30 \
    -H "Authorization: Bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" \
    "${oidc_request_url}"; then
  echo "Failed to fetch GitHub OIDC token; skipping hosted broker auth." >&2
  exit 0
fi

oidc_token="$(printf '%s' "${oidc_response}" | jq -r '.value // empty' 2>/dev/null || true)"
if [ -z "${oidc_token}" ]; then
  echo "OIDC token response did not include a token value; skipping hosted broker auth." >&2
  exit 0
fi
echo "::add-mask::${oidc_token}"

exchange_request_file="$(mktemp)"
exchange_response_file="$(mktemp)"
trap 'rm -f "${exchange_request_file}" "${exchange_response_file}"' EXIT

if ! jq -n \
  --arg oidc_token "${oidc_token}" \
  --arg repository "${GITHUB_REPOSITORY:-}" \
  --arg workflow_ref "${GITHUB_WORKFLOW_REF:-}" \
  --arg run_id "${GITHUB_RUN_ID:-}" \
  '{
    oidc_token: $oidc_token,
    repository: $repository,
    workflow_ref: $workflow_ref,
    run_id: $run_id
  }' > "${exchange_request_file}"; then
  echo "Failed to build hosted broker exchange request; skipping hosted broker auth." >&2
  exit 0
fi

if ! run_with_retries exchange_status \
  curl --silent --show-error --max-time 30 \
    -o "${exchange_response_file}" \
    -w '%{http_code}' \
    -H 'Content-Type: application/json' \
    -X POST \
    "${OIDC_EXCHANGE_URL}" \
    --data-binary @"${exchange_request_file}"; then
  echo "Hosted broker exchange request failed; skipping hosted broker auth." >&2
  exit 0
fi

if [ "${exchange_status}" -lt 200 ] || [ "${exchange_status}" -ge 300 ]; then
  broker_message="$(jq -r '.error.message // .message // empty' "${exchange_response_file}" 2>/dev/null || true)"
  if [ -n "${broker_message}" ]; then
    echo "Hosted broker exchange returned HTTP ${exchange_status}: ${broker_message}" >&2
  else
    echo "Hosted broker exchange returned HTTP ${exchange_status}; skipping hosted broker auth." >&2
  fi
  exit 0
fi

exchange_token="$(jq -r '.token // .app_token // empty' "${exchange_response_file}" 2>/dev/null || true)"

if [ -z "${exchange_token}" ]; then
  broker_keys="$(jq -r 'if type == "object" then (keys_unsorted | join(",")) else empty end' "${exchange_response_file}" 2>/dev/null || true)"
  if [ -n "${broker_keys}" ]; then
    echo "Hosted broker exchange response did not include a token field (saw keys: ${broker_keys}); skipping hosted broker auth." >&2
  else
    echo "Hosted broker exchange response did not include a token; skipping hosted broker auth." >&2
  fi
  exit 0
fi

echo "::add-mask::${exchange_token}"
{
  echo "token=${exchange_token}"
  echo "auth_mode=oidc_broker"
} >> "$GITHUB_OUTPUT"
