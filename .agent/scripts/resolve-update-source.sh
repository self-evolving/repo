#!/usr/bin/env bash
set -euo pipefail

# Resolve the Sepo source revision before the update agent runs. Scheduled runs
# default to the latest stable GitHub Release tag, while manual dispatch can
# provide an explicit ref for testing branches, main, or specific tags.

DEFAULT_UPDATE_SOURCE_REPO="self-evolving/repo"
DEFAULT_UPDATE_SOURCE_FALLBACK_REF="main"

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

fail_config() {
  printf 'Invalid update source configuration: %s\n' "$1" >&2
  exit 2
}

resolve_commit_sha() {
  local repo="$1"
  local ref="$2"
  local label="$3"
  local payload sha

  if ! payload="$(gh api "repos/${repo}/commits/${ref}")"; then
    fail_config "could not resolve ${label} ref ${repo}@${ref}"
  fi

  sha="$(printf '%s' "$payload" | jq -r '.sha // ""')"
  if [ -z "$sha" ]; then
    fail_config "resolved ${label} ref ${repo}@${ref} did not include a commit SHA"
  fi
  printf '%s' "$sha"
}

lookup_latest_stable_release() {
  local repo="$1"
  local releases

  if ! releases="$(gh api "repos/${repo}/releases?per_page=100")"; then
    fail_config "could not list stable releases for ${repo}"
  fi

  printf '%s' "$releases" |
    jq -c '[.[] | select((.draft | not) and (.prerelease | not))][0] // {}'
}

emit_result() {
  local repo="$1"
  local ref="$2"
  local sha="$3"
  local kind="$4"
  local fallback="$5"
  local reason="${6:-}"
  local release_url="${7:-}"

  write_output "source_repo" "$repo"
  write_output "source_ref" "$ref"
  write_output "source_sha" "$sha"
  write_output "source_kind" "$kind"
  write_output "fallback" "$fallback"
  write_output "reason" "$reason"
  write_output "release_url" "$release_url"

  jq -n \
    --arg repo "$repo" \
    --arg ref "$ref" \
    --arg sha "$sha" \
    --arg kind "$kind" \
    --argjson fallback "$(json_bool "$fallback")" \
    --arg reason "$reason" \
    --arg releaseUrl "$release_url" \
    '{
      sourceRepo: $repo,
      sourceRef: $ref,
      sourceSha: $sha,
      sourceKind: $kind,
      fallback: $fallback,
      reason: $reason,
      releaseUrl: $releaseUrl
    }'
}

main() {
  local repo manual_ref fallback_ref release_json tag release_url sha reason
  repo="$(trim "${UPDATE_SOURCE_REPO:-$DEFAULT_UPDATE_SOURCE_REPO}")"
  manual_ref="$(trim "${UPDATE_SOURCE_REF:-}")"
  fallback_ref="$(trim "${DEFAULT_UPDATE_SOURCE_REF:-$DEFAULT_UPDATE_SOURCE_FALLBACK_REF}")"

  if [ -z "$repo" ]; then
    fail_config "UPDATE_SOURCE_REPO cannot be empty"
  fi
  if [ -z "$fallback_ref" ]; then
    fail_config "DEFAULT_UPDATE_SOURCE_REF cannot be empty"
  fi

  if [ -n "$manual_ref" ]; then
    sha="$(resolve_commit_sha "$repo" "$manual_ref" "manual")"
    emit_result "$repo" "$manual_ref" "$sha" "manual" "false"
    return 0
  fi

  release_json="$(lookup_latest_stable_release "$repo")"
  tag="$(printf '%s' "$release_json" | jq -r '.tag_name // ""')"
  release_url="$(printf '%s' "$release_json" | jq -r '.html_url // ""')"
  if [ -n "$tag" ]; then
    sha="$(resolve_commit_sha "$repo" "$tag" "release")"
    emit_result "$repo" "$tag" "$sha" "latest-release" "false" "" "$release_url"
    return 0
  fi

  if [ "$(printf '%s' "$release_json" | jq -r 'length')" = "0" ]; then
    sha="$(resolve_commit_sha "$repo" "$fallback_ref" "fallback")"
    reason="no stable Sepo release found; falling back to ${fallback_ref}"
    emit_result "$repo" "$fallback_ref" "$sha" "fallback-main" "true" "$reason"
    return 0
  fi

  fail_config "latest stable release for ${repo} did not include tag_name"
}

main "$@"
