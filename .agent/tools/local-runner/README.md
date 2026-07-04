# Local GitHub Actions Runner

Scripts for running one or more self-hosted GitHub Actions runners on a local macOS or Linux machine.

The repository is intentionally generic: provide your own GitHub organization or repository URL and a short-lived registration token when you set up the runners.

## What this does

- Downloads the GitHub Actions runner for your host: `osx-arm64` / `osx-x64` on macOS, or `linux-x64` / `linux-arm64` on Linux (auto-detected; override with `RUNNER_PLATFORM`).
- Verifies the downloaded runner archive with the SHA-256 checksum from the GitHub runner release.
- Creates `runner-1`, `runner-2`, ... directories so each runner has its own working directory.
- Starts all configured runners and writes logs to `runner-N/runner.log`.
- Optionally installs a cleanup job that removes old runner diagnostic logs every 6 hours — via `launchd` on macOS or `cron` on Linux.

## Requirements

`bootstrap.sh` and `setup-runners.sh` run `check-requirements.sh` before registering runners. For the default agent workflows, the runner host needs:

- macOS or Linux with Bash, `git`, `gh`, `jq`, `curl`, `tar`, and a SHA-256 tool (`sha256sum` on Linux, `shasum` on macOS — either is accepted).
- Node.js 22.x and npm. This matches the default `node_version` in `.github/actions/setup-agent-runtime` for self-hosted runners.
- On Linux, the ICU library (`libicu`) that the .NET-based runner depends on. Most desktop/server distros ship it; minimal images may need `sudo apt-get install -y libicu-dev` (Debian/Ubuntu) or `sudo dnf install -y libicu` (RHEL/Rocky/Fedora). `check-requirements.sh` warns if it is missing.
- Admin access to the target GitHub organization or repository so you can create a self-hosted runner registration token.
- Docker is optional. Docker cleanup is disabled unless you explicitly opt in.

You do **not** need to preinstall `acpx`: each workflow runs `npm ci` in `.agent/`, and `acpx` is a package dependency exposed through `.agent/node_modules/.bin`.

You also do **not** need to preinstall `codex` or `claude` for normal secret-backed runs. The shared `setup-agent-runtime` action installs the selected provider CLI when it is missing. If you want to rely on local provider authentication instead of repository secrets, authenticate the provider CLI as the same OS user that runs the GitHub runner.

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

`bootstrap.sh` configures the runner(s), installs the cleanup schedule (`launchd` on macOS, `cron` on Linux), and then starts the runners. Press `Ctrl+C` to stop them.

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
| `RUNNER_PLATFORM` | auto-detected | Runner package platform: `osx-arm64` / `osx-x64` on macOS, `linux-x64` / `linux-arm64` on Linux. |
| `RUNNER_LABELS` | `self-hosted,<macOS\|Linux>,<ARM64\|X64>` | Labels passed to GitHub during runner registration (OS and arch auto-detected). |
| `RUNNER_NAME_PREFIX` | `<hostname>-runner` | Prefix for runner names. Runner numbers are appended. |
| `LOCAL_RUNNER_ROOT` | this checkout | Directory that holds the runner working dirs (`runner-N`, downloaded runner cache, `_work`, tool cache, logs). Point it at a roomier filesystem when the checkout lives on a size- or inode-constrained one (see "Hosting the runner off a constrained filesystem"). |
| `RUNNER_TOOL_CACHE` | `$LOCAL_RUNNER_ROOT/shared-tool-cache` | Shared tool cache used when runners are started. |
| `LOCAL_RUNNER_DOCKER_PRUNE` | `0` | Set to `1` before running `bootstrap.sh` or `cleanup-runner.sh` to allow `docker system prune -f`. |

Example:

```bash
RUNNER_NAME_PREFIX=build-mac RUNNER_LABELS=self-hosted,macOS,ARM64,local \
  ./bootstrap.sh https://github.com/<OWNER> <REGISTRATION_TOKEN> 2
```

## Hosting the runner off a constrained filesystem

By default the runner directories live inside this checkout. On many servers that
is fine, but on HPC login nodes and other managed hosts the home filesystem often
has a per-user **quota** — not just on bytes, but on **inode count** (number of
files). A GitHub Actions runner is inode-heavy: the base install is ~20k+ files,
each agent job's `npm ci` adds tens of thousands more under `_work`, and the
runner's periodic self-update briefly writes a *second* full copy of itself. Any
of these can blow an inode quota, and the failure surfaces as a confusing
`Disk quota exceeded` error mid-job (or during self-update).

Set `LOCAL_RUNNER_ROOT` to a filesystem with room (scratch, project, or pool
storage) so all runner state lands there instead of the quota'd home:

```bash
export LOCAL_RUNNER_ROOT=/path/to/roomy/storage/github-runners
./bootstrap.sh https://github.com/<ORG_OR_USER>/<REPO> <REGISTRATION_TOKEN>
```

`setup-runners.sh`, `start-runners.sh`, `stop-runners.sh`, and `cleanup-runner.sh`
all honor `LOCAL_RUNNER_ROOT`, so export it (or prefix each command with it)
consistently. Only the scripts and the post-job hook stay in the checkout; all
runner *data* lives under `LOCAL_RUNNER_ROOT`.

To move an already-configured runner without re-registering it, stop it, move the
directories across (registration travels with the `runner-N` directory), then
restart with the variable set:

```bash
./stop-runners.sh
mv runner-* actions-runner shared-tool-cache /path/to/roomy/storage/github-runners/
export LOCAL_RUNNER_ROOT=/path/to/roomy/storage/github-runners
./start-runners.sh
```

Check inode usage with `df -i <path>` (and, where available, `quota -s`) before
and after.

## Post-job cleanup hook

`hooks/post-job-cleanup.sh` runs after every job via the runner's
`ACTIONS_RUNNER_HOOK_JOB_COMPLETED` mechanism. `setup-runners.sh` wires it into
each runner's `.env`. On every job completion it:

- trims `runner-N/_diag` to the last 30 files and drops anything older than 3 days;
- removes `runner-N/_work/<repo>` checkouts not touched in the last 24 hours,
  skipping the current job's repo so the checkout cache stays warm.

It never fails the runner — errors are swallowed and progress is written to
`runner-N/cleanup-hook.log`. Restart runners after editing the hook for the new
behavior to take effect.

To wire the hook into already-configured runners on a host that predates this
change, rerun `setup-runners.sh` and restart. The script reconciles every
existing `runner-*/.env` regardless of `num_runners`, so any non-empty token
works (use a fresh registration token if you also want to add more runners):

```bash
./setup-runners.sh https://github.com/<ORG_OR_USER> <REGISTRATION_TOKEN>
./stop-runners.sh && ./start-runners.sh
```

Or append the line manually to each `runner-N/.env` and restart:

```
ACTIONS_RUNNER_HOOK_JOB_COMPLETED=/absolute/path/to/local-runner/hooks/post-job-cleanup.sh
```

## Cleanup job

`cleanup-runner.sh` writes to `cleanup.log` and:

- deletes runner diagnostic logs older than 7 days from `runner-*/_diag`.

Docker pruning is disabled by default because it affects Docker resources outside these runners. To opt in:

```bash
LOCAL_RUNNER_DOCKER_PRUNE=1 bash cleanup-runner.sh
```

To opt in for the scheduled cleanup job, set `LOCAL_RUNNER_DOCKER_PRUNE=1` when you run `bootstrap.sh`.

`bootstrap.sh` installs the schedule differently per OS:

- **macOS (`launchd`):** renders `com.local-runner.cleanup.plist.template` with this repository's local absolute path, writes it to `~/Library/LaunchAgents/com.local-runner.cleanup.plist`, and loads it with `launchctl`.
- **Linux (`cron`):** adds a user crontab entry that runs `cleanup-runner.sh` every 6 hours (`0 */6 * * *`). A systemd `--user` timer is intentionally not used because it needs a user D-Bus session and lingering, which are often unavailable on shared/HPC hosts. Cleanup only runs while the cron daemon (`crond`) is active, and some managed hosts disable per-user `crontab` entirely — `bootstrap.sh` reports this and falls back to manual cleanup rather than failing.

Run cleanup manually (any OS):

```bash
bash cleanup-runner.sh
tail -f "${LOCAL_RUNNER_ROOT:-.}/cleanup.log"
```

Check the scheduled job:

```bash
launchctl list | grep local-runner.cleanup     # macOS
crontab -l | grep local-runner-cleanup          # Linux
```

Disable the scheduled job:

```bash
# macOS
launchctl unload ~/Library/LaunchAgents/com.local-runner.cleanup.plist
rm ~/Library/LaunchAgents/com.local-runner.cleanup.plist

# Linux (remove the local-runner-cleanup line)
crontab -l | grep -v local-runner-cleanup | crontab -
```

## Resetting runners

To recreate a runner from scratch:

1. Stop local runner processes: `./stop-runners.sh`.
2. Remove the runner from GitHub's **Actions → Runners** settings page.
3. Delete the matching local directory, for example `rm -rf runner-1`.
4. Run `setup-runners.sh` or `bootstrap.sh` again with a fresh registration token.

## Files created locally

The scripts create runtime files under `LOCAL_RUNNER_ROOT` (the checkout by
default, where they are ignored by Git):

- `actions-runner/` — downloaded runner tarballs.
- `runner-*/` — configured runner directories and workspaces.
- `shared-tool-cache/` — reusable tool cache for started runners.
- `*.log` — runner and cleanup logs.

When `LOCAL_RUNNER_ROOT` points outside the checkout, these live there instead
and Git never sees them.
