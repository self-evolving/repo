#!/usr/bin/env bash
# Verify that this macOS host has the tools the agent workflows expect on a
# self-hosted runner. Provider CLIs are handled by setup-agent-runtime, so this
# script focuses on host tools that must exist before a workflow starts.

set -euo pipefail

REQUIRED_NODE_MAJOR=${LOCAL_RUNNER_NODE_VERSION:-22}

missing=()
for cmd in git gh jq curl tar shasum node npm; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    missing+=("$cmd")
  fi
done

if [ "${#missing[@]}" -ne 0 ]; then
  echo "Missing required runner tools: ${missing[*]}" >&2
  echo "" >&2
  echo "Install the missing tools before registering local agent runners." >&2
  echo "On macOS with Homebrew, this usually means:" >&2
  echo "  brew install git gh jq node@22" >&2
  echo "" >&2
  echo "The agent workflows install acpx and provider CLIs as needed, but they" >&2
  echo "require these base tools to be available before the workflow starts." >&2
  exit 1
fi

installed_node=$(node -p 'process.versions.node')
installed_npm=$(npm --version)
installed_node_major=${installed_node%%.*}

if [ -n "$REQUIRED_NODE_MAJOR" ] && [ "$installed_node_major" != "$REQUIRED_NODE_MAJOR" ]; then
  echo "Node.js ${installed_node} is installed, but agent workflows currently require ${REQUIRED_NODE_MAJOR}.x on self-hosted runners." >&2
  echo "Install Node.js ${REQUIRED_NODE_MAJOR}.x, or set LOCAL_RUNNER_NODE_VERSION to match a custom setup-agent-runtime node_version." >&2
  exit 1
fi

echo "Base runner tools available."
echo "Node.js: ${installed_node}"
echo "npm: ${installed_npm}"

npm_global_prefix=$(npm prefix -g 2>/dev/null || true)
if [ -n "$npm_global_prefix" ] && [ ! -w "$npm_global_prefix" ] && [ ! -w "$(dirname "$npm_global_prefix")" ]; then
  echo "Warning: npm global prefix is not writable by this user: $npm_global_prefix" >&2
  echo "If a workflow needs to install Codex, preinstall it or use a user-writable Node/npm installation." >&2
fi

echo ""
echo "Agent runtime tools:"
echo "- acpx is installed per workflow by npm ci from .agent/package.json; no host install is required."
echo "- codex and claude are installed on demand by .github/actions/setup-agent-runtime when the selected provider needs them."
echo "- if you rely on local provider auth instead of repository secrets, authenticate the provider CLI as this macOS user before running jobs."

if command -v codex >/dev/null 2>&1; then
  echo "Optional Codex CLI: found ($(command -v codex))"
else
  echo "Optional Codex CLI: not found; workflows can install it when needed."
fi

if command -v claude >/dev/null 2>&1; then
  echo "Optional Claude CLI: found ($(command -v claude))"
else
  echo "Optional Claude CLI: not found; workflows can install it when needed."
fi
