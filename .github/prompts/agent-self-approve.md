## Task Description

Perform a high-level self-approval gate for pull request #${TARGET_NUMBER}.

This is not a duplicate low-level code review. Decide whether the PR is aligned
with the repository's long-term goals, user/team rubrics, automation safety
expectations, and the right product direction for Sepo. Review the code again
carefully enough to avoid approving a change that is technically or strategically
unsafe.

Gather current PR context before deciding:
- `gh pr view ${TARGET_NUMBER} --repo ${REPO_SLUG} --json title,body,author,comments,files,labels,reviews,reviewDecision,state,url,headRefOid`
- `gh pr diff ${TARGET_NUMBER} --repo ${REPO_SLUG}`
- inspect the local repository patterns and relevant docs
- inspect selected rubrics and, when needed, browse `$RUBRICS_DIR` for active
  rubrics that materially apply

The workflow captured the PR head before this agent run:

- Expected head SHA: `${SELF_APPROVE_EXPECTED_HEAD_SHA}`

Rules:
- Do not mutate GitHub state.
- Do not submit a PR review yourself.
- Do not post comments directly with `gh`.
- Return exactly one JSON object and nothing else.
- Use `APPROVE` only when agent approval is genuinely appropriate.
- If the request context says review synthesis recommended `HUMAN_DECISION`
  after a non-`SHIP` verdict, do not approve; use `REQUEST_CHANGES` for concrete
  follow-up work or `BLOCKED` when the decision should remain with a human.
- Use `REQUEST_CHANGES` when follow-up implementation work is appropriate.
- Use `BLOCKED` when the decision should stay with a human or required context
  is missing.

Ask and answer concrete questions about the implementation from these dimensions:

Functionality:
- What behavior changed? Does the implementation match the issue/parent-plan scope?
- Is the change aligned with the repo's goal? Is the current implementation the right way to solve the problem?

Code Quality:
- Does it contain "patched" code? Can you think of other cleaner or more idiomatic ways for implementing the function?
- Is any awkwardness acceptable for this slice, or should it become a required fix?

Maintenance and Bug Handling:
- What happens in edge cases and reruns?
- Are the likely long-term maintenance and safety costs acceptable?

Return:

```json
{
  "verdict": "APPROVE | REQUEST_CHANGES | BLOCKED",
  "reason": "Concise rationale for the self-approval decision.",
  "handoff_context": "Concrete follow-up instructions when verdict is REQUEST_CHANGES; otherwise optional.",
  "inspected_head_sha": "${SELF_APPROVE_EXPECTED_HEAD_SHA}"
}
```
