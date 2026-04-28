#!/usr/bin/env bash
set -euo pipefail

normalize_provider() {
  printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

validate_provider() {
  case "$1" in
    auto|codex|claude) return 0 ;;
    *) return 1 ;;
  esac
}

write_outputs() {
  echo "provider=${provider}" >> "$GITHUB_OUTPUT"
  echo "reason=${reason}" >> "$GITHUB_OUTPUT"
  echo "install_codex=$([ "$provider" = codex ] && echo true || echo false)" >> "$GITHUB_OUTPUT"
  echo "install_claude=$([ "$provider" = claude ] && echo true || echo false)" >> "$GITHUB_OUTPUT"
}

route="${ROUTE:-}"
route_provider="$(normalize_provider "${ROUTE_PROVIDER:-}")"
default_provider="$(normalize_provider "${DEFAULT_PROVIDER:-auto}")"
required="$(normalize_provider "${REQUIRED:-true}")"

if [ -z "$default_provider" ]; then
  default_provider=auto
fi

case "$required" in
  true|false) ;;
  *)
    echo "Invalid required flag '$required' for route '$route'. Use true or false." >&2
    exit 1
    ;;
esac

has_codex=false
has_claude=false
if [ -n "${OPENAI_API_KEY:-}" ]; then
  has_codex=true
fi
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  has_claude=true
fi

for candidate in "$route_provider" "$default_provider"; do
  if [ -n "$candidate" ] && ! validate_provider "$candidate"; then
    echo "Invalid agent provider '$candidate' for route '$route'. Use auto, codex, or claude." >&2
    exit 1
  fi
done

requested_provider="$default_provider"
requested_reason="AGENT_DEFAULT_PROVIDER"
explicit_provider=false
if [ -n "$route_provider" ]; then
  requested_provider="$route_provider"
  requested_reason="route override for $route"
fi
if [ "$requested_provider" != auto ]; then
  explicit_provider=true
fi

provider=""
reason=""
if [ "$explicit_provider" = true ]; then
  provider="$requested_provider"
  reason="$requested_reason"
elif [ "$has_codex" = true ]; then
  # Keep auto mode deterministic and compatible with prior Codex-first behavior.
  provider=codex
  reason="OPENAI_API_KEY is configured"
elif [ "$has_claude" = true ]; then
  provider=claude
  reason="CLAUDE_CODE_OAUTH_TOKEN is configured"
else
  echo "No configured agent provider for route '$route'. Set AGENT_DEFAULT_PROVIDER to codex or claude, or configure OPENAI_API_KEY or CLAUDE_CODE_OAUTH_TOKEN." >&2
  if [ "$required" = true ]; then
    exit 1
  fi
  provider=""
  reason="no configured provider"
  write_outputs
  echo "Agent provider for $route is unresolved ($reason)."
  exit 0
fi

if [ "$explicit_provider" = true ] && [ "$provider" = codex ] && [ "$has_codex" != true ]; then
  echo "Resolved provider codex for route '$route' without OPENAI_API_KEY; relying on local Codex authentication if available." >&2
fi
if [ "$explicit_provider" = true ] && [ "$provider" = claude ] && [ "$has_claude" != true ]; then
  echo "Resolved provider claude for route '$route' without CLAUDE_CODE_OAUTH_TOKEN; relying on local Claude authentication if available." >&2
fi

write_outputs
echo "Resolved agent provider for $route: $provider ($reason)."
