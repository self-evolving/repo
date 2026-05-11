Run a Sepo agent infrastructure update check for this repository.

Confirmed inputs:
- target repository: {{TARGET_REPOSITORY}}
- target default branch: {{TARGET_DEFAULT_BRANCH}}
- source agent repo/ref: {{SOURCE_REPO}}@{{SOURCE_REF}}
- source agent SHA: {{SOURCE_SHA}}
- source resolution: {{SOURCE_KIND}}
- update branch: use `{{UPDATE_BRANCH_PREFIX}}<yyyymmdd>`
- update .skills directories: {{UPDATE_SKILLS}}
- update AGENT.md when agent-owned: {{UPDATE_AGENT_MD}}
- remove obsolete or legacy files: false
- post-merge workflows: document only

Open a pull request only when the update produces changes. If the target
is already current, leave no PR and report that no update was needed.
When a PR is opened, title and summarize it as:
`Update Sepo from <installed version/ref> to {{SOURCE_REF}}/{{SOURCE_SHA}}`.
