# Actions

This section documents the action layer inside the `.agent` backend.

The docs use three terms consistently:

- **Workflows** are GitHub workflow files in `.github/workflows/`. They define triggers, jobs, permissions, and dispatch boundaries. See [Supported workflows](../architecture/supported-workflows.md).
- **Internal actions** are shared composite GitHub Actions in `.github/actions/`. They scaffold the runtime, resolve GitHub auth, and run agent tasks for workflows.
- **Agent actions** are route-level behaviors such as `answer`, `implement`, `fix-pr`, and `review`. They are selected by mention, label, approval, or workflow dispatch, and are implemented through workflow wiring plus prompts.

## Documentation model

These pages are hand-written for now. The desired long-term pattern is to keep small `agent-doc` metadata blocks near the YAML workflows, composite actions, and prompt files, then render this section from that metadata.

Until that renderer exists:

- [Internal actions](internal-actions.md) is the canonical place for `.github/actions/*` details.
- [Agent actions](agent-actions.md) is the canonical place for route behavior, prompt consumption, session policy, and generated-doc metadata conventions.

Avoid duplicating internal action details in setup or architecture pages. Those pages should explain user-facing behavior and link here for implementation details.
