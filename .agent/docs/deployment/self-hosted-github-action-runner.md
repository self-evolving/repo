# Self-hosted GitHub Action runner

Self-hosted runners run GitHub Actions jobs on infrastructure you operate, such as a local Mac mini, instead of on GitHub-hosted runners.

Self-hosted runners are a good fit when you want:

- faster runs by avoiding repeated environment setup
- more control over security and network boundaries
- lower cost at larger scale
- extra flexibility, including richer local tooling or agent capabilities

## Local runner setup

For the maintained setup scripts and step-by-step instructions, use [`.agent/tools/local-runner`](../../tools/local-runner/README.md). That folder contains the host requirement check, bootstrap, setup, start, stop, cleanup, and launchd template files for running local macOS self-hosted runners.

Keep this deployment page focused on the decision to use self-hosted runners; keep machine-specific setup details in the local runner tool folder.

## Runner requirements

At a high level, the runner host needs Node support compatible with `.github/actions/setup-agent-runtime`, `git`, `gh`, `jq`, `curl`, `bash`, and network access. It also needs either repository secrets for the selected agent providers or local provider authentication available to the same user that runs the GitHub runner. Docker is optional unless your workflows require it.

## Provider auth note

On self-hosted runners, an explicit `AGENT_DEFAULT_PROVIDER=codex` or `AGENT_DEFAULT_PROVIDER=claude` is treated as an operator choice. The provider resolver will select that provider even if the matching repository secret is absent, so single-agent runs and review synthesis can use local Codex or Claude authentication already configured on the machine. In `auto` mode, provider detection still relies on repository secrets and prefers Codex when both provider secrets are present. The review workflow still attempts explicit Claude and Codex reviewer lanes; provider resolution controls the synthesis step that combines successful reviewer outputs.

## Continuity note

Repositories with sticky self-hosted runners can choose to set `AGENT_SESSION_BUNDLE_MODE=never` to prefer local session state over artifact bundles. For the trade-offs behind that setting, see [Session continuity](../technical-details/session-continuity.md).
