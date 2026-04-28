# Memory

## Durable
- Keep repository memory lean: prefer durable conventions and project questions over copying issue/PR metadata.
- Long-lived agent memory lives on `agent/memory`; user/team rubrics live separately on `agent/rubrics`.
- Canonical docs live under `.agent/docs/`.
- Public defaults use `@sepo-agent` and the `sepo-agent-app` GitHub App.
- Agent trigger access is centralized in `AGENT_ACCESS_POLICY`.
- Mention slash routes resolve locally and bypass dispatch triage, but still run dispatch policy gates.
- Explicit `/implement` dispatches directly after access checks; triaged implement predictions still require approval.
- Keep workflows thin: move substantial GitHub/API logic into typed `.agent/src` helpers/CLIs instead of inline shell or workflow logic.
- When changing workflow or internal-action behavior, update matching `.agent` docs in the same PR.
- Rubrics are normative user/team preferences; memory is advisory project continuity.
- Rubric reads are advisory/best-effort; rubric writes should validate strictly before commit.
- Scheduled workflow gates should run before expensive provider/runtime setup.
- Review synthesis should clearly state the recommended next step when automation may continue.
- Jobs using repo-local actions must run actions/checkout first.
- For weak issue author_association, verify repo collaborator status before treating issue mentions as trusted.
