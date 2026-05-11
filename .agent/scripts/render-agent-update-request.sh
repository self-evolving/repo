#!/usr/bin/env bash
set -euo pipefail

if [ -n "${GITHUB_WORKSPACE:-}" ]; then
  repo_root="${GITHUB_WORKSPACE}"
elif [ -f ".github/prompts/agent-update.md" ]; then
  repo_root="${PWD}"
elif [ -f "../.github/prompts/agent-update.md" ]; then
  repo_root="$(cd .. && pwd)"
else
  echo "could not locate repository root for agent update prompt" >&2
  exit 1
fi

template_path="${UPDATE_REQUEST_TEMPLATE:-${repo_root}/.github/prompts/agent-update.md}"
if [ ! -f "${template_path}" ]; then
  echo "agent update prompt template not found: ${template_path}" >&2
  exit 1
fi

request_text="$(cat "${template_path}")"

replace_token() {
  local token="$1"
  local value="$2"
  request_text="${request_text//"{{${token}}}"/${value}}"
}

replace_token "TARGET_REPOSITORY" "${TARGET_REPOSITORY:?TARGET_REPOSITORY is required}"
replace_token "TARGET_DEFAULT_BRANCH" "${TARGET_DEFAULT_BRANCH:?TARGET_DEFAULT_BRANCH is required}"
replace_token "SOURCE_REPO" "${SOURCE_REPO:?SOURCE_REPO is required}"
replace_token "SOURCE_REF" "${SOURCE_REF:?SOURCE_REF is required}"
replace_token "SOURCE_SHA" "${SOURCE_SHA:?SOURCE_SHA is required}"
replace_token "SOURCE_KIND" "${SOURCE_KIND:?SOURCE_KIND is required}"
replace_token "UPDATE_BRANCH_PREFIX" "${UPDATE_BRANCH_PREFIX:?UPDATE_BRANCH_PREFIX is required}"
replace_token "UPDATE_SKILLS" "${UPDATE_SKILLS:?UPDATE_SKILLS is required}"
replace_token "UPDATE_AGENT_MD" "${UPDATE_AGENT_MD:?UPDATE_AGENT_MD is required}"

write_output() {
  local name="$1"
  local value="$2"
  local delim="DELIM_${RANDOM}_${RANDOM}_$$"
  {
    printf '%s<<%s\n' "$name" "$delim"
    printf '%s\n' "$value"
    printf '%s\n' "$delim"
  } >> "$GITHUB_OUTPUT"
}

write_output "request_text" "${request_text}"
