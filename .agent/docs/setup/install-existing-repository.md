---
title: "Install into an existing repository"
---

This page documents the minimal path for adding the Sepo agent backend to a repository that did not start from this template. If you are starting from this repository as a template, use the main [README quick start](https://github.com/self-evolving/repo/blob/main/README.md) instead.

## Choose an install path

### Public repositories

For public repositories, the quickest path is to open the [Install Sepo into another repository](https://github.com/self-evolving/repo/issues/new?template=install-sepo.yml) issue form in `self-evolving/repo` and paste the target GitHub URL. Sepo prepares or reuses a focused install PR in that repo, comments with the PR link, and closes the request issue when the PR is ready.

Authorized users can also make the same request with `/install`:

```md
@sepo-agent /install can you install Sepo into https://github.com/owner/repo?
```

### Private repositories

For private target repositories, keep the install in a trusted local
environment. Run an agent locally with access to this source checkout and the
private target repository, then ask it to use the `.skills/install-agent` skill.
That skill opens a normal PR in the target repository while preserving
target-owned files and following the validation/setup checklist below. Do not put
private repository URLs or private setup details in a public Sepo issue.

Both paths produce the same target-repository outcome:

1. open a normal PR in the target repository that adds the agent backend files
2. merge that PR
3. use the repository's own GitHub Actions workflows to bootstrap `agent/memory` and, optionally, `agent/rubrics`

## Public `/install` route details

The `/install` command is a first-class route for authorization, then runs the
dedicated `agent-install` prompt. Route detection only recognizes the command;
install-specific helper code resolves the target from the request text,
accepting an `owner/repo` slug, a GitHub URL, or a clear natural-language
repository reference. If the target is missing or ambiguous, the route stops
with a clarification instead of guessing. When the target is clear, it resolves
the install source to the latest non-draft Sepo release and records that source
revision in the PR body. If no stable release exists yet, the route may use the
latest non-draft prerelease.

The public `/install` route uses a dedicated install credential in the Sepo
source repository. Normal routes keep the standard GitHub auth resolver order:
GitHub App, hosted OIDC, `AGENT_PAT`, then the workflow token. The install
credential must be able to create or reuse a fork, push a branch, and open pull
requests for public repositories.

The dedicated install prompt uses the built-in fork/PR helper to prepare a
fork-backed worktree, push `agent/install-agent-infra`, and reuse or open the
install PR. If the secret is absent, the route stops before the prompt runs and
posts that install is not configured. If the secret is present but the helper
cannot read the public target, create/reuse the fork, push the branch, or
open/reuse the PR, the route reports a blocked result with the specific
permission gap and next step. An existing open install PR from the same token
owner is reused; an open install PR from another owner is treated as a duplicate
blocked state. Install runs disable source-repo memory writes so this target
token is not used to update `agent/memory`. When `/install` is requested from an
issue, the target install PR body links back to the source request. After the
publish helper creates or reuses the target PR and the install response is
posted, the workflow best-effort closes that source request issue with a short
comment linking the install PR. If that close step fails, the install PR remains
the source of truth and the workflow does not undo it.

Use `AGENT_ACCESS_POLICY.route_overrides.install` to restrict who may trigger
external installs independently from general `/skill` runs:

```json
{
  "route_overrides": {
    "install": ["OWNER", "MEMBER"]
  }
}
```

## Minimal file layout

Copy these directories into the target repository:

- `.agent/`
- `.github/`

Copy the current `.github/` directory as a unit so the workflows, composite actions, and prompt templates stay in sync.

Also merge these generated-output rules into the target repository's existing `.gitignore` without replacing target-owned entries:

```gitignore
.agent/dist/
.agent/node_modules/
```

The workflows build `.agent/dist/` on GitHub-hosted runners. Keeping generated runtime outputs ignored prevents them from being committed accidentally.

## Repository configuration

At minimum, configure:

- Issues enabled in `Settings > General > Features > Issues`
- GitHub Actions enabled in `Settings > Actions > General`
- the Sepo GitHub App installed on the selected repository
- `OPENAI_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, and/or `ANTHROPIC_API_KEY` as repository secrets

See [Setup guide](setup-guide.md) for the auth options and trade-offs.

The helper CLI keeps the token in `GH_TOKEN` and accepts explicit flags:

```sh
GH_TOKEN="$GH_TOKEN" node .agent/dist/cli/install-fork-pr.js prepare \
  --target-repo "owner/repo"

GH_TOKEN="$GH_TOKEN" node .agent/dist/cli/install-fork-pr.js publish \
  --target-repo "owner/repo" \
  --workdir "<prepared-workdir>" \
  --fork-repo "<fork-owner/repo>" \
  --default-branch "<default-branch>" \
  --branch "agent/install-agent-infra" \
  --pr-title "Install Sepo agent infrastructure" \
  --pr-body-file "<body-file>"
```

The publish command requires the prepare-state file written into the returned
workdir by the prepare command, so rerun prepare instead of substituting an
arbitrary checkout path. For issue-backed install requests, the helper derives
the source request URL from the runtime envelope and adds it to the install PR
body before opening or updating the PR. The publish helper also normalizes the
`Required setup after merge` section so it appears near the top and uses
target-repository links for the setup actions.

Install PRs should use this high-level order:

1. summary
2. required setup after merge
3. source revision
4. installed files, preserved/skipped files, validation details, and skipped
   checks
5. source install request link, when the request came from an issue

The structured setup section mirrors the onboarding setup check:

1. install the Sepo GitHub App on the target repository, or choose another auth
   path from the setup guide
2. add at least one provider credential secret: `OPENAI_API_KEY`,
   `CLAUDE_CODE_OAUTH_TOKEN`, and/or `ANTHROPIC_API_KEY`
3. run the target repository's `Agent / Onboarding / Check Setup` workflow
4. review the target repository's `Sepo setup check` issue and complete any
   remaining setup it reports
5. run `Agent / Memory / Initialization` if `agent/memory` is missing
6. optionally run `Agent / Rubrics / Initialization` if the repo wants rubric
   steering

## First verification

After the files and secrets are in place:

1. run `Agent / Onboarding / Check Setup` from GitHub Actions
2. review the `Sepo setup check` issue that the workflow opens or updates
3. run a copyable test command from that issue's status comment, or open another issue and mention `@sepo-agent`
4. wait for the `👀` reaction and the follow-up workflow run

The onboarding workflow is safe to rerun. It creates the built-in trigger labels
(`agent/answer`, `agent/implement`, `agent/create-action`, `agent/review`,
`agent/fix-pr`, and `agent/orchestrate`) when they are missing, then updates the
same setup issue comment with GitHub auth, provider credentials, memory, rubrics,
remaining setup, and test commands.

## Memory Setup

### Setup memory branch from GitHub Actions

After setting up the repo, you can manually dispatch the github action `Agent / Memory / Initialization` or run a local command to setup the memory branch.

That workflow:

- rejects the run if `agent/memory` already exists, so it stays a one-time initializer
- creates `agent/memory` on the runner when it does not exist yet
- seeds `PROJECT.md`, `MEMORY.md`, plus `.gitkeep` placeholders in `daily/`, `github/`, and `github/<owner>/<repo>/`
- commits and pushes the bootstrap branch without requiring a local checkout
- runs the initial GitHub artifact sync and recent-activity curation inline after the bootstrap commit

The workflow reuses the same branch to populate `github/<owner>/<repo>/*.json`, then runs the agentic memory curation pass on top of that seeded state.

<details>
  <summary>Alternative: local memory bootstrap</summary>
  <p>If you want to create the <code>agent/memory</code> branch locally before the workflows do it for you:</p>
  <pre><code class="language-bash">npm --prefix .agent ci
npm --prefix .agent run build
npm --prefix .agent run bootstrap:memory -- --repo &lt;owner/repo&gt;
git push origin agent/memory</code></pre>
  <p>If <code>origin/agent/memory</code> already exists and your clone predates it, run <code>git fetch origin</code> first so the bootstrap command can reuse the remote-tracking branch instead of starting a fresh local one.</p>
  <p>That command:</p>
  <ul>
    <li>creates or updates a local <code>agent/memory</code> branch without changing your current checkout</li>
    <li>reuses <code>origin/agent/memory</code> when it already exists locally as a remote-tracking branch, otherwise seeds a fresh branch</li>
    <li>seeds <code>PROJECT.md</code> and <code>MEMORY.md</code>, plus <code>.gitkeep</code> placeholders in <code>daily/</code>, <code>github/</code>, and <code>github/&lt;owner&gt;/&lt;repo&gt;/</code></li>
    <li>commits the initialization locally when the branch needs it</li>
  </ul>
  <p>If you skip this step, the GitHub Actions workflows above can bootstrap the branch for you.</p>
</details>

### Run memory workflows from actions

Use `Agent / Memory / Initialization` only for first-time setup. It will fail if `agent/memory` already exists.

After the branch exists, you can manually dispatch the ongoing memory workflows from GitHub Actions:

- `Agent / Memory / Sync GitHub Artifacts`
- `Agent / Memory / Curate Recent Activity`
- `Agent / Memory / Record PR Closure`

`Agent / Memory / Initialization` is the first-run initializer. It does not require
`agent/memory` to exist yet, but it will reject reruns once that branch has
already been created.

## Rubrics Setup

After setting up the repo, you can manually dispatch `Agent / Rubrics / Initialization` to create the dedicated `agent/rubrics` branch.

That workflow:

- rejects the run if `agent/rubrics` already exists, so it stays a one-time initializer
- creates `agent/rubrics` on the runner when it does not exist yet
- seeds the rubrics branch layout (`README.md` plus `rubrics/coding/`, `rubrics/communication/`, and `rubrics/workflow/` placeholders)
- runs a provider-backed initialization prompt that can populate initial rubrics from supplied context
- if no context is supplied, asks the agent to inspect recent merged PRs and trusted contributor feedback for durable user/team preferences
- validates rubric YAML before committing and pushing the branch
- fails if the branch cannot be committed and pushed, so first-run setup cannot silently skip persistence

The initialization workflow accepts free-form context. Use it to point the agent at important PRs, issues, review comments, or team preferences that should shape the first rubric set. After the branch exists, use `Agent / Rubrics / Update` for ongoing rubric learning.
