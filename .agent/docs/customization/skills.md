---
title: "Repository skills"
---

A repository skill is a `SKILL.md` file under the configured skill root, which
defaults to `.skills`. Invoke one with `@sepo-agent /skill <name>` or the
`agent/s/<name>` label.

```text
.skills/<name>/
  SKILL.md      # required agent instructions
  setup.sh      # optional setup hook
  README.md     # optional human docs
```

Skill names are normalized to lowercase by mention and label routing, so skill
directories should use lowercase names. Reusable workflow callers can override
the root with the `skill_root` input on `agent-router.yml`; the same root is
used for skill existence checks, optional setup, and runtime prompt loading.

## `SKILL.md`

`SKILL.md` is the prompt fragment the agent reads after the shared Sepo base
prompt, memory prompt, and rubrics prompt. Use it for one focused capability:
required inputs, guardrails, workflow steps, validation, and final response
expectations.

## Simple Setup

`setup.sh` is optional. When present, Sepo runs it after the skill file is found
and before the agent task starts. Missing setup scripts are a clean no-op.

Setup scripts run from the repository root with `bash`. Sepo exposes
`SKILL_NAME`, `SKILL_ROOT`, and `SKILL_DIR` to the script. Adding `setup.sh` is
the repository owner's opt-in to execute setup code inside the GitHub Actions
runner with the skill route's permissions.

Example:

```bash
#!/usr/bin/env bash
set -euo pipefail

npm install -g @your-org/release-notes-cli
```

Sepo refuses to run setup scripts on PR checkout refs so unreviewed PR heads
cannot supply executable setup. Run setup-backed skills from trusted
default-branch contexts such as an issue, discussion, issue comment, or the
`agent/s/<name>` label flow.

## Advanced Setup

For setup that needs native GitHub Actions features such as `uses`, `with`,
Docker actions, services, caches, or custom containers, edit the copied
`.github/workflows/agent-router.yml` directly. The skill job has a natural
customization point around `Run skill setup` and before `Run skill`.

Example:

```yaml
- name: Setup release skill
  if: needs.portal.outputs.skill == 'release-notes'
  uses: actions/setup-node@v4
  with:
    node-version: 22
```

Or a Docker action:

```yaml
- name: Setup deep research skill
  if: needs.portal.outputs.skill == 'deep-research'
  uses: docker://ghcr.io/example/research-env:latest
  with:
    args: prepare-research-env
```

Sepo intentionally keeps the default skill hook small instead of implementing a
second GitHub Actions language inside `.skills`.
