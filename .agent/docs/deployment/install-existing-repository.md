# Install Into An Existing Repository

This page documents the minimal path for adding the Sepo agent backend to a repository that did not start from this template. If you are starting from this repository as a template, use the main [README quick start](../../../README.md) instead.

In practice, the cleanest install path is:

1. open a normal PR in the target repository that adds the agent backend files
2. merge that PR
3. use the repository's own GitHub Actions workflows to bootstrap `agent/memory` and, optionally, `agent/rubrics`

From `self-evolving/repo`, authorized users can ask Sepo to prepare that PR for
a public target repository:

```md
@sepo-agent /install owner/repo
```

The `/install` command is a first-class route for authorization, then executes
the bundled `install-agent` skill. It still requires a target repository slug in
`owner/repo` form, resolves the install source to the latest non-draft Sepo
release, and records that source revision in the PR body. If no stable release
exists yet, the skill may use the latest non-draft prerelease. Opening the PR
requires the resolved GitHub token to have write access to the target
repository. The v1 install flow does not switch to a different token or create a
fork after the skill starts. If Sepo can clone the public repository but the
already-resolved token cannot push a branch and open a PR, the run should stop
as blocked. Rerun only after the workflow is configured so the token resolved at
startup already has target write access, or use a manual/fork-based install path
outside this v1 command.

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
- `OPENAI_API_KEY` and/or `CLAUDE_CODE_OAUTH_TOKEN` as repository secrets

See [Setup guide](setup-guide.md) for the auth options and trade-offs.

Install PRs should include a structured setup section that mirrors the
onboarding setup check:

1. install the Sepo GitHub App on the target repository, or choose another auth
   path from the setup guide
2. add at least one provider credential secret: `OPENAI_API_KEY` and/or
   `CLAUDE_CODE_OAUTH_TOKEN`
3. run `Agent / Onboarding / Check Setup`
4. review the `Sepo setup check` issue and complete any remaining setup it
   reports
5. initialize `agent/memory` if missing
6. optionally initialize `agent/rubrics` if the repo wants rubric steering

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
