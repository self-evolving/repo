# Install Into An Existing Repository

This page documents the minimal path for adding the Sepo agent backend to a repository that did not start from this template. If you are starting from this repository as a template, use the main [README quick start](../../../README.md) instead.

In practice, the cleanest install path is:

1. open a normal PR in the target repository that adds the agent backend files
2. merge that PR
3. use the repository's own GitHub Actions workflows to bootstrap `agent/memory` and, optionally, `agent/rubrics`

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

- GitHub Actions enabled for the repository
- `OPENAI_API_KEY` and/or `CLAUDE_CODE_OAUTH_TOKEN` as repository secrets

See [Setup guide](setup-guide.md) for the auth options and trade-offs.

## First verification

After the files and secrets are in place:

1. open an issue in the target repository
2. mention `@sepo-agent` in the issue body or a comment
3. wait for the `👀` reaction and the follow-up workflow run

## Memory Setup

### Setup memory branch from GitHub Actions

After setting up the repo, you can manually dispatch the github action `Agent / Memory / Initialization` or run a local command to setup the memory branch.

That workflow:

- rejects the run if `agent/memory` already exists, so it stays a one-time initializer
- creates `agent/memory` on the runner when it does not exist yet
- seeds `PROJECT.md`, `MEMORY.md`, plus `.gitkeep` placeholders in `daily/` and `github/`
- commits and pushes the bootstrap branch without requiring a local checkout
- runs the initial GitHub artifact sync and recent-activity curation inline after the bootstrap commit

The workflow reuses the same branch to populate `github/*.json`, then runs the agentic memory curation pass on top of that seeded state.

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
    <li>seeds <code>PROJECT.md</code> and <code>MEMORY.md</code>, plus <code>.gitkeep</code> placeholders in <code>daily/</code> and <code>github/</code></li>
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
