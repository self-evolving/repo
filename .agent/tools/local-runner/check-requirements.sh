#!/usr/bin/env bash
# Verify that this macOS or Linux host has the tools the agent workflows expect
# on a self-hosted runner. Provider CLIs are handled by setup-agent-runtime, so
# this script focuses on host tools that must exist before a workflow starts.

set -euo pipefail

REQUIRED_NODE_MAJOR=${LOCAL_RUNNER_NODE_VERSION:-22}

missing=()
for cmd in git gh jq curl tar node npm; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    missing+=("$cmd")
  fi
done

# The runner download is checksum-verified with sha256sum (Linux/coreutils) or
# shasum (macOS). Require at least one of them.
if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
  missing+=("sha256sum-or-shasum")
fi

if [ "${#missing[@]}" -ne 0 ]; then
  echo "Missing required runner tools: ${missing[*]}" >&2
  echo "" >&2
  echo "Install the missing tools before registering local agent runners." >&2
  echo "On macOS with Homebrew:" >&2
  echo "  brew install git gh jq node@22" >&2
  echo "On Debian/Ubuntu:" >&2
  echo "  sudo apt-get install -y git jq curl tar coreutils   # plus gh + Node.js 22.x" >&2
  echo "On RHEL/Rocky/Fedora:" >&2
  echo "  sudo dnf install -y git jq curl tar coreutils        # plus gh + Node.js 22.x" >&2
  echo "  (gh: https://github.com/cli/cli#installation, Node.js: https://github.com/nodesource/distributions)" >&2
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

# The GitHub Actions runner is a .NET application that needs ICU (libicu) on
# Linux. Full desktop/server distros ship it, but minimal images may not. Warn
# (do not fail) so the operator can install it or run the runner's bundled
# bin/installdependencies.sh before starting runners.
if [ "$(uname -s)" = "Linux" ] && command -v ldconfig >/dev/null 2>&1; then
  if ! ldconfig -p 2>/dev/null | grep -qi 'libicu'; then
    echo "Warning: libicu was not found in the dynamic linker cache. The GitHub Actions" >&2
    echo "runner needs it. Install it before starting runners, for example:" >&2
    echo "  Debian/Ubuntu: sudo apt-get install -y libicu-dev" >&2
    echo "  RHEL/Rocky:    sudo dnf install -y libicu" >&2
    echo "or run ./bin/installdependencies.sh from a configured runner-* directory." >&2
  fi
fi

echo ""
echo "Agent runtime tools:"
echo "- acpx is installed per workflow by npm ci from .agent/package.json; no host install is required."
echo "- codex and claude are installed on demand by .github/actions/setup-agent-runtime when the selected provider needs them."
echo "- if you rely on local provider auth instead of repository secrets, authenticate the provider CLI as the same user that runs the runner before running jobs."

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
