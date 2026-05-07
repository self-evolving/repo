#!/usr/bin/env bash
set -euo pipefail

# Pre-runtime guard for the scheduled Sepo update workflow. It keeps recurring
# update checks from opening duplicate PRs while an earlier update PR is pending.

DEFAULT_UPDATE_BRANCH_PREFIX="agent/update-agent-infra-"

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
  printf 'Invalid pending update PR gate configuration: %s\n' "$1" >&2
  exit 2
}

is_true() {
  case "$(lower "$(trim "$1")")" in
    true|1|yes|y) return 0 ;;
    *) return 1 ;;
  esac
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
  local reason="$2"
  local pr_url="${3:-}"
  local pr_number="${4:-}"
  local branch="${5:-}"

  write_output "skip" "$skip"
  write_output "reason" "$reason"
  write_output "pr_url" "$pr_url"
  write_output "pr_number" "$pr_number"
  write_output "branch" "$branch"

  jq -n \
    --argjson skip "$(json_bool "$skip")" \
    --arg reason "$reason" \
    --arg prUrl "$pr_url" \
    --arg prNumber "$pr_number" \
    --arg branch "$branch" \
    '{skip: $skip, reason: $reason, prUrl: $prUrl, prNumber: $prNumber, branch: $branch}'
}

main() {
  local repo prefix prs match pr_url pr_number branch
  repo="$(trim "${GITHUB_REPOSITORY:-${REPO_SLUG:-}}")"
  prefix="$(trim "${UPDATE_BRANCH_PREFIX:-$DEFAULT_UPDATE_BRANCH_PREFIX}")"

  if [ -z "$repo" ]; then
    fail_config "GITHUB_REPOSITORY or REPO_SLUG is required"
  fi
  if [ -z "$prefix" ]; then
    fail_config "UPDATE_BRANCH_PREFIX cannot be empty"
  fi

  if is_true "${ALLOW_EXISTING_UPDATE_PR:-false}"; then
    emit_result "false" "pending update PR override enabled"
    return 0
  fi

  prs="$(gh pr list \
    --repo "$repo" \
    --state open \
    --limit 100 \
    --json number,url,headRefName,isCrossRepository)"

  match="$(
    printf '%s' "$prs" |
      jq -c --arg prefix "$prefix" \
        '[.[] | select((.isCrossRepository | not) and (.headRefName | startswith($prefix)))][0] // empty'
  )"

  if [ -z "$match" ]; then
    emit_result "false" "no pending update PR"
    return 0
  fi

  pr_url="$(printf '%s' "$match" | jq -r '.url // ""')"
  pr_number="$(printf '%s' "$match" | jq -r '(.number // "") | tostring')"
  branch="$(printf '%s' "$match" | jq -r '.headRefName // ""')"
  emit_result "true" "pending update PR exists" "$pr_url" "$pr_number" "$branch"
}

main "$@"
