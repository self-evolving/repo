# Local GitHub Actions Runner

Scripts for running one or more self-hosted GitHub Actions runners on a local macOS machine.

The repository is intentionally generic: provide your own GitHub organization or repository URL and a short-lived registration token when you set up the runners.

## What this does

- Downloads the GitHub Actions runner for your Mac (`osx-arm64` or `osx-x64`).
- Verifies the downloaded runner archive with the SHA-256 checksum from the GitHub runner release.
- Creates `runner-1`, `runner-2`, ... directories so each runner has its own working directory.
- Starts all configured runners and writes logs to `runner-N/runner.log`.
- Optionally installs a macOS `launchd` cleanup job that removes old runner diagnostic logs every 6 hours.

## Requirements

`bootstrap.sh` and `setup-runners.sh` run `check-requirements.sh` before registering runners. For the default agent workflows, the runner host needs:

- macOS with Bash, `git`, `gh`, `jq`, `curl`, `tar`, and `shasum`.
- Node.js 22.x and npm. This matches the default `node_version` in `.github/actions/setup-agent-runtime` for self-hosted runners.
- Admin access to the target GitHub organization or repository so you can create a self-hosted runner registration token.
- Docker is optional. Docker cleanup is disabled unless you explicitly opt in.

You do **not** need to preinstall `acpx`: each workflow runs `npm ci` in `.agent/`, and `acpx` is a package dependency exposed through `.agent/node_modules/.bin`.

You also do **not** need to preinstall `codex` or `claude` for normal secret-backed runs. The shared `setup-agent-runtime` action installs the selected provider CLI when it is missing. If you want to rely on local provider authentication instead of repository secrets, authenticate the provider CLI as the same macOS user that runs the GitHub runner service.

## Security note

Use local self-hosted runners only for private repositories or repositories whose workflows and pull requests you trust. Public repository forks can run untrusted workflow code on self-hosted runner machines, including machines with local credentials and persistent workspace state.

## Quick start

1. Create a registration token in GitHub:
   - Organization runner: `https://github.com/<OWNER>` → **Settings** → **Actions** → **Runners** → **New self-hosted runner**.
   - Repository runner: `https://github.com/<OWNER>/<REPO>` → **Settings** → **Actions** → **Runners** → **New self-hosted runner**.

2. Run the bootstrap script:

```bash
./bootstrap.sh https://github.com/<ORG_OR_USER> <REGISTRATION_TOKEN>
# or, for a repository-scoped runner:
./bootstrap.sh https://github.com/<ORG_OR_USER>/<REPO> <REGISTRATION_TOKEN>
```

To create multiple local runners:

```bash
./bootstrap.sh https://github.com/<ORG_OR_USER> <REGISTRATION_TOKEN> 3
```

`bootstrap.sh` configures the runner(s), installs the cleanup schedule on macOS, and then starts the runners. Press `Ctrl+C` to stop them.

> Registration tokens expire quickly. If setup fails with an authorization error, create a fresh token and run the command again. Do not commit tokens to the repository.

## Manual commands

Check host requirements without registering runners:

```bash
./check-requirements.sh
```

Set up runners without starting them:

```bash
./setup-runners.sh https://github.com/<ORG_OR_USER> <REGISTRATION_TOKEN> 3
```

Start all configured runners:

```bash
./start-runners.sh
```

Stop all running runner processes:

```bash
./stop-runners.sh
```

View logs:

```bash
tail -f runner-*/runner.log
```

## Configuration

You can customize setup with environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `GITHUB_URL` | none | Target organization or repository URL when it is not passed as an argument. |
| `RUNNER_TOKEN` | none | Registration token when it is not passed as an argument. |
| `NUM_RUNNERS` | `1` | Number of runners when it is not passed as an argument. |
| `LOCAL_RUNNER_NODE_VERSION` | `22` | Required Node.js major version checked before registering runners. Match this to any custom `setup-agent-runtime` `node_version`. |
| `RUNNER_VERSION` | `2.332.0` | GitHub Actions runner version to download. |
| `RUNNER_SHA256` | release checksum | Optional explicit SHA-256 checksum for the selected runner archive; useful if release checksum lookup is rate-limited. |
| `GITHUB_TOKEN` | none | Optional token used only for runner release checksum lookup to avoid anonymous GitHub API rate limits. |
| `RUNNER_PLATFORM` | auto-detected | Runner package platform, usually `osx-arm64` or `osx-x64`. |
| `RUNNER_LABELS` | `self-hosted,macOS,ARM64` or `self-hosted,macOS,X64` | Labels passed to GitHub during runner registration. |
| `RUNNER_NAME_PREFIX` | `<hostname>-runner` | Prefix for runner names. Runner numbers are appended. |
| `RUNNER_TOOL_CACHE` | `./shared-tool-cache` | Shared tool cache used when runners are started. |
| `LOCAL_RUNNER_DOCKER_PRUNE` | `0` | Set to `1` before running `bootstrap.sh` or `cleanup-runner.sh` to allow `docker system prune -f`. |

Example:

```bash
RUNNER_NAME_PREFIX=build-mac RUNNER_LABELS=self-hosted,macOS,ARM64,local \
  ./bootstrap.sh https://github.com/<OWNER> <REGISTRATION_TOKEN> 2
```

## Cleanup job

`cleanup-runner.sh` writes to `cleanup.log` and:

- deletes runner diagnostic logs older than 7 days from `runner-*/_diag`.

Docker pruning is disabled by default because it affects Docker resources outside these runners. To opt in:

```bash
LOCAL_RUNNER_DOCKER_PRUNE=1 bash cleanup-runner.sh
```

To opt in for the scheduled cleanup job, set `LOCAL_RUNNER_DOCKER_PRUNE=1` when you run `bootstrap.sh`.

`bootstrap.sh` renders `com.local-runner.cleanup.plist.template` with this repository's local absolute path, writes it to `~/Library/LaunchAgents/com.local-runner.cleanup.plist`, and loads it with `launchctl`.

Check the scheduled job:

```bash
launchctl list | grep local-runner.cleanup
```

Run cleanup manually:

```bash
bash cleanup-runner.sh
tail -f cleanup.log
```

Disable the scheduled job:

```bash
launchctl unload ~/Library/LaunchAgents/com.local-runner.cleanup.plist
rm ~/Library/LaunchAgents/com.local-runner.cleanup.plist
```

## Resetting runners

To recreate a runner from scratch:

1. Stop local runner processes: `./stop-runners.sh`.
2. Remove the runner from GitHub's **Actions → Runners** settings page.
3. Delete the matching local directory, for example `rm -rf runner-1`.
4. Run `setup-runners.sh` or `bootstrap.sh` again with a fresh registration token.

## Files created locally

The scripts create local runtime files that are ignored by Git:

- `actions-runner/` — downloaded runner tarballs.
- `runner-*/` — configured runner directories and workspaces.
- `shared-tool-cache/` — reusable tool cache for started runners.
- `*.log` — runner and cleanup logs.
