#!/usr/bin/env bash
set -euo pipefail

# Lightweight post-agent verification for generated workflow, runtime, and
# script changes. This intentionally stays small and repo-local.

history_changed_files=""
if [ -n "${VERIFY_BASE_SHA:-}" ]; then
  if git rev-parse --verify --quiet "${VERIFY_BASE_SHA}^{commit}" >/dev/null; then
    git diff --check "${VERIFY_BASE_SHA}..HEAD"
    history_changed_files="$(git diff --name-only "${VERIFY_BASE_SHA}..HEAD")"
  else
    echo "VERIFY_BASE_SHA does not resolve to a commit; cannot run history-aware verification." >&2
    exit 1
  fi
fi

git diff --check

changed_files="$(
  {
    printf '%s\n' "$history_changed_files"
    git diff --name-only
    git ls-files --others --exclude-standard
  } | sed '/^$/d' | sort -u
)"

if printf '%s\n' "$changed_files" | grep -q '^\.github/workflows/'; then
  ruby -e 'require "yaml"; Dir[".github/workflows/*.yml"].sort.each { |file| YAML.load_file(file) }'
fi

if printf '%s\n' "$changed_files" | grep -qE '^(\.agent/scripts/|\.agent/src/|\.agent/package(-lock)?\.json|\.agent/tsconfig\.json)'; then
  if [ -f .agent/package.json ] && [ -f .agent/tsconfig.json ]; then
    (
      cd .agent
      npm ci
      npm run build
    )
  fi

  test_files="$(find .agent/scripts -path '*/test/*.test.cjs' -type f | sort)"
  if [ -n "$test_files" ]; then
    node --test $test_files
  fi
fi
