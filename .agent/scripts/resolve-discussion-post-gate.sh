#!/usr/bin/env bash
set -euo pipefail

# Pre-runtime discussion posting gate.
#
# Daily summary generation is only useful when the target repository can accept
# the summary discussion. Keep this as shell so the workflow can run it before
# setup-agent-runtime builds the TypeScript CLIs or installs provider tools.

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
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
  write_output "skip" "$skip"
  write_output "reason" "$reason"

  jq -n \
    --argjson skip "$(json_bool "$skip")" \
    --arg reason "$reason" \
    '{skip: $skip, reason: $reason}'
}

fail_config() {
  printf 'Invalid discussion post gate configuration: %s\n' "$1" >&2
  exit 2
}

main() {
  local repo_slug category owner repo extra response enabled category_exists
  repo_slug="$(trim "${GITHUB_REPOSITORY:-${REPO_SLUG:-}}")"
  category="$(trim "${DISCUSSION_CATEGORY:-}")"

  if [ -z "$repo_slug" ]; then
    fail_config "GITHUB_REPOSITORY is required"
  fi
  if [ -z "$category" ]; then
    fail_config "DISCUSSION_CATEGORY is required"
  fi

  IFS='/' read -r owner repo extra <<< "$repo_slug"
  if [ -z "${owner:-}" ] || [ -z "${repo:-}" ] || [ -n "${extra:-}" ]; then
    fail_config "GITHUB_REPOSITORY must be owner/repo (got: ${repo_slug})"
  fi

  response="$(
    gh api graphql \
      -F owner="$owner" \
      -F repo="$repo" \
      -f query='
        query($owner: String!, $repo: String!) {
          repository(owner: $owner, name: $repo) {
            hasDiscussionsEnabled
            discussionCategories(first: 100) {
              nodes { name }
            }
          }
        }
      '
  )"

  if ! printf '%s' "$response" | jq -e '.data.repository | type == "object"' >/dev/null; then
    printf 'Repository not found or GraphQL response was malformed for %s\n' "$repo_slug" >&2
    exit 1
  fi

  enabled="$(printf '%s' "$response" | jq -r '.data.repository.hasDiscussionsEnabled == true')"
  if [ "$enabled" != "true" ]; then
    emit_result "true" "repository discussions are disabled"
    return 0
  fi

  category_exists="$(
    printf '%s' "$response" |
      jq -r --arg category "$category" '
        [.data.repository.discussionCategories.nodes[]?.name] | any(. == $category)
      '
  )"
  if [ "$category_exists" != "true" ]; then
    emit_result "true" "discussion category '${category}' was not found"
    return 0
  fi

  emit_result "false" "discussion posting is available"
}

main "$@"
