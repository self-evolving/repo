#!/usr/bin/env bash
set -euo pipefail

# Pre-runtime scheduled workflow gate.
#
# This intentionally lives as a plain shell script instead of .agent/src/cli:
# scheduled workflows call it before setup-agent-runtime runs npm install/build
# or installs provider CLIs. That lets AGENT_SCHEDULE_POLICY=disabled skip cron
# work before provider/runtime setup can fail or spend time.

SCHEDULE_MODES="always_run skip_no_updates disabled"
DEFAULT_SCHEDULE_MODE="skip_no_updates"
STATE_FILENAME="state.json"

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

write_output() {
  local name="$1"
  local value="$2"
  if [ -z "${GITHUB_OUTPUT:-}" ]; then
    return 0
  fi
  local delim="DELIM_${RANDOM}_${RANDOM}_$$"
  {
    printf '%s<<%s\n' "$name" "$delim"
    printf '%s\n' "$value"
    printf '%s\n' "$delim"
  } >> "$GITHUB_OUTPUT"
}

fail_config() {
  printf 'Invalid scheduled activity gate configuration: %s\n' "$1" >&2
  exit 2
}

is_valid_mode() {
  case "$1" in
    always_run|skip_no_updates|disabled) return 0 ;;
    *) return 1 ;;
  esac
}

normalize_mode() {
  local value="$1"
  local label="$2"
  local normalized
  normalized="$(lower "$(trim "$value")")"
  if ! is_valid_mode "$normalized"; then
    fail_config "${label} must be one of ${SCHEDULE_MODES// /, } (got ${normalized:-empty})"
  fi
  printf '%s' "$normalized"
}

normalize_workflow() {
  lower "$(trim "$1")"
}

resolve_mode() {
  local policy_text workflow default_mode override_mode
  policy_text="$(trim "${AGENT_SCHEDULE_POLICY:-}")"
  workflow="$(normalize_workflow "${WORKFLOW_FILENAME:-}")"
  default_mode="$DEFAULT_SCHEDULE_MODE"
  override_mode=""

  if [ -z "$policy_text" ]; then
    if [ "$workflow" = "agent-memory-sync.yml" ]; then
      printf 'always_run'
    else
      printf '%s' "$DEFAULT_SCHEDULE_MODE"
    fi
    return 0
  fi

  if ! printf '%s' "$policy_text" | jq -e 'type == "object"' >/dev/null 2>&1; then
    fail_config "Schedule policy must be a JSON object"
  fi

  if [ "$(printf '%s' "$policy_text" | jq -r 'has("default_mode")')" = "true" ]; then
    local raw_default
    raw_default="$(printf '%s' "$policy_text" | jq -r 'if .default_mode == null then "" else (.default_mode | tostring) end')"
    if ! default_mode="$(normalize_mode "$raw_default" "default_mode")"; then
      return 2
    fi
  fi

  if [ "$(printf '%s' "$policy_text" | jq -r 'has("workflow_overrides")')" = "true" ]; then
    if ! printf '%s' "$policy_text" | jq -e '.workflow_overrides | type == "object"' >/dev/null 2>&1; then
      fail_config "workflow_overrides must be an object"
    fi

    while IFS=$'\t' read -r raw_key raw_value; do
      [ -n "$raw_key" ] || continue
      local key mode
      key="$(normalize_workflow "$raw_key")"
      if [[ ! "$key" =~ ^[a-z0-9][a-z0-9._-]*\.ya?ml$ ]]; then
        fail_config "Invalid workflow override key in schedule policy: ${key:-missing}"
      fi
      if ! mode="$(normalize_mode "$raw_value" "workflow_overrides.${key}")"; then
        return 2
      fi
      if [ -n "$workflow" ] && [ "$key" = "$workflow" ]; then
        override_mode="$mode"
      fi
    done < <(
      printf '%s' "$policy_text" |
        jq -r '.workflow_overrides | to_entries[] | [.key, (if .value == null then "" else (.value | tostring) end)] | @tsv'
    )
  fi

  if [ -n "$override_mode" ]; then
    printf '%s' "$override_mode"
  else
    printf '%s' "$default_mode"
  fi
}

json_bool() {
  if [ "$1" = "true" ]; then
    printf 'true'
  else
    printf 'false'
  fi
}

emit_result() {
  local skip="$1"
  local mode="$2"
  local reason="$3"
  local dependency_value="${4:-}"
  local self_value="${5:-}"

  write_output "skip" "$skip"
  write_output "mode" "$mode"
  write_output "reason" "$reason"
  write_output "dependency_value" "$dependency_value"
  write_output "self_value" "$self_value"

  jq -n \
    --arg mode "$mode" \
    --argjson skip "$(json_bool "$skip")" \
    --arg reason "$reason" \
    --arg dependencyValue "$dependency_value" \
    --arg selfValue "$self_value" \
    '{mode: $mode, skip: $skip, reason: $reason, dependencyValue: $dependencyValue, selfValue: $selfValue}'
}

resolve_remote_target() {
  local remote="$1"
  local repo token
  repo="${GITHUB_REPOSITORY:-${REPO_SLUG:-}}"
  token="${INPUT_GITHUB_TOKEN:-${GH_TOKEN:-}}"
  if [ -n "$repo" ] && [ -n "$token" ]; then
    printf 'https://x-access-token:%s@github.com/%s.git' "$token" "$repo"
  else
    printf '%s' "$remote"
  fi
}

fetch_json_state() {
  local ref="$1"
  local cwd="$2"
  local fetch_target fetch_log json
  fetch_target="$(resolve_remote_target origin)"
  fetch_log="$(mktemp "${RUNNER_TEMP:-/tmp}/scheduled-gate-fetch.XXXXXX.log")"

  if ! git -C "$cwd" fetch --no-tags "$fetch_target" "+${ref}:${ref}" >/dev/null 2>"$fetch_log"; then
    if grep -Eiq "couldn't find remote ref|no matching remote head" "$fetch_log"; then
      rm -f "$fetch_log"
      return 0
    fi
    cat "$fetch_log" >&2 || true
    rm -f "$fetch_log"
    return 1
  fi
  rm -f "$fetch_log"

  if ! json="$(git -C "$cwd" cat-file blob "${ref}:${STATE_FILENAME}" 2>/dev/null)"; then
    return 0
  fi
  if ! printf '%s' "$json" | jq -e 'type == "object"' >/dev/null 2>&1; then
    return 0
  fi
  printf '%s' "$json"
}

read_field() {
  local json="$1"
  local field="$2"
  if [ -z "$json" ] || [ -z "$field" ]; then
    return 0
  fi
  printf '%s' "$json" | jq -r --arg field "$field" 'if (.[$field] | type) == "string" then .[$field] else "" end'
}

parse_time() {
  local value="$1"
  if [ -z "$value" ]; then
    return 0
  fi
  # jq's fromdateiso8601 does not accept fractional seconds on the
  # GitHub-hosted runner version, while Date#toISOString() emits them.
  # Normalize second-precision before parsing so persisted schedule cursors
  # such as 2026-04-27T10:00:00.123Z remain usable by the pre-runtime gate.
  jq -nr --arg value "$value" '($value | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601?) // empty'
}

main() {
  local mode base_dependency base_self event activity_count count_number
  if ! mode="$(resolve_mode)"; then
    exit 2
  fi
  base_dependency=""
  base_self=""
  event="${GITHUB_EVENT_NAME:-}"

  if [ "$event" != "schedule" ]; then
    emit_result "false" "$mode" "non-scheduled run" "$base_dependency" "$base_self"
    return 0
  fi
  if [ "$mode" = "disabled" ]; then
    emit_result "true" "$mode" "schedule policy disabled workflow" "$base_dependency" "$base_self"
    return 0
  fi
  if [ "$mode" = "always_run" ]; then
    emit_result "false" "$mode" "schedule policy always_run" "$base_dependency" "$base_self"
    return 0
  fi

  activity_count="$(trim "${ACTIVITY_COUNT:-}")"
  if [ -n "$activity_count" ]; then
    count_number="$(jq -nr --arg value "$activity_count" 'try ($value | tonumber) catch empty')"
    if [ -z "$count_number" ]; then
      emit_result "false" "$mode" "invalid activity count" "$base_dependency" "$base_self"
      return 0
    fi
    if jq -en --argjson count "$count_number" '$count <= 0' >/dev/null; then
      emit_result "true" "$mode" "activity count is zero" "$base_dependency" "$base_self"
      return 0
    fi
    emit_result "false" "$mode" "activity count is nonzero" "$base_dependency" "$base_self"
    return 0
  fi

  local dependency_ref dependency_field self_ref self_field cwd dependency_json self_json dependency_value self_value dependency_time self_time
  dependency_ref="${DEPENDENCY_REF:-}"
  dependency_field="${DEPENDENCY_FIELD:-}"
  self_ref="${SELF_REF:-}"
  self_field="${SELF_FIELD:-}"

  if [ -z "$dependency_ref" ] || [ -z "$dependency_field" ] || [ -z "$self_ref" ] || [ -z "$self_field" ]; then
    emit_result "false" "$mode" "missing activity cursor configuration" "$base_dependency" "$base_self"
    return 0
  fi

  cwd="${GITHUB_WORKSPACE:-$(pwd)}"
  dependency_json="$(fetch_json_state "$dependency_ref" "$cwd")"
  self_json="$(fetch_json_state "$self_ref" "$cwd")"
  dependency_value="$(read_field "$dependency_json" "$dependency_field")"
  self_value="$(read_field "$self_json" "$self_field")"
  dependency_time="$(parse_time "$dependency_value")"
  self_time="$(parse_time "$self_value")"

  if [ -z "$dependency_time" ] || [ -z "$self_time" ]; then
    emit_result "false" "$mode" "missing or invalid activity cursor" "$dependency_value" "$self_value"
    return 0
  fi
  if [ "$dependency_time" -le "$self_time" ]; then
    emit_result "true" "$mode" "dependency cursor has not advanced" "$dependency_value" "$self_value"
    return 0
  fi
  emit_result "false" "$mode" "dependency cursor advanced" "$dependency_value" "$self_value"
}

main "$@"
