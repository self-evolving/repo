# Repository Skills

Repository skills are Sepo's v1 extension package format. A skill lives under
the configured skill root, defaults to `.skills`, and can be invoked with
`@sepo-agent /skill <name>` or the `agent/s/<name>` label.

```text
.skills/<name>/
  SKILL.md            # required agent instructions
  skill-setup.yaml    # optional executable setup manifest
  README.md           # optional human docs
```

Skill names are normalized to lowercase by mention and label routing, so skill
directories should use lowercase names. Reusable workflow callers can override
the root with the `skill_root` input on `agent-router.yml`; the same root is
used for skill existence checks, optional setup, and runtime prompt loading.

## `SKILL.md`

`SKILL.md` is the prompt fragment the agent reads after the shared Sepo base
prompt, memory prompt, and rubrics prompt. Treat it like an instruction file for
one focused capability: required inputs, guardrails, workflow steps, validation,
and final response expectations.

## `skill-setup.yaml`

`skill-setup.yaml` is optional. When present, Sepo validates and runs it after
the skill file is found and before the agent task starts. Missing setup
manifests are a clean no-op.

Version 1 schema:

```yaml
version: 1
env:
  TOOL_CACHE: .cache/tool
steps:
  - name: Install helper CLI
    run: npm install -g @example/helper-cli
    shell: bash
    env:
      NPM_CONFIG_FUND: "false"
    timeout_minutes: 5
```

Fields:

- `version`: required, must be `1`.
- `env`: optional string map added to every setup step.
- `steps`: required non-empty array.
- `steps[].name`: required display name.
- `steps[].run`: required shell command.
- `steps[].shell`: optional shell command name or path, defaults to `bash`.
- `steps[].env`: optional string map for one step.
- `steps[].timeout_minutes`: optional per-step timeout, defaults to `10`, max
  `360`.

Setup commands run from the repository root. Sepo also exposes `SKILL_NAME`,
`SKILL_ROOT`, and `SKILL_DIR` to setup steps. The setup manifest is not GitHub
Actions YAML and does not support dynamic `uses:` steps.

## Trust Boundary

Adding `skill-setup.yaml` is the repository owner's opt-in to execute setup code
inside the GitHub Actions runner with the skill route's permissions. Sepo
refuses to run setup manifests on raw `pull_request` event checkouts so
unreviewed PR heads cannot supply executable setup. Run setup-backed skills from
trusted default-branch contexts such as an issue, discussion, issue comment, or
the `agent/s/<name>` label flow.

## Examples

Repo-local release notes skill:

```text
.skills/release-notes/
  SKILL.md
  skill-setup.yaml
```

```yaml
version: 1
env:
  NPM_CONFIG_FUND: "false"
steps:
  - name: Install release notes CLI
    run: npm install -g @your-org/release-notes-cli
    timeout_minutes: 5
```

Deep research skill using an external tool:

```text
.skills/deep-research/
  SKILL.md
  skill-setup.yaml
```

```yaml
version: 1
steps:
  - name: Install agent papers CLI
    run: python -m pip install agent-papers-cli
    timeout_minutes: 10
```

`SKILL.md` should then tell the agent which command the setup step installed,
what research question or repository context to read first, and what output
format to return.
