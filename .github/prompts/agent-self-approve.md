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

If this run came from review handoff, the orchestrator also passed:

- Source review verdict: `${SELF_APPROVE_SOURCE_CONCLUSION}`
- Source recommended next step: `${SELF_APPROVE_SOURCE_RECOMMENDED_NEXT_STEP}`

For `HUMAN_DECISION` review handoffs, make the decision here instead of
routing back to a human by default. Use `APPROVE` only when the trusted
current-head review verdict is `SHIP`, or when a current-head review synthesis
explicitly recommended `HUMAN_DECISION` and you judge the remaining concerns to
be acceptable product/maintenance tradeoffs. For other non-`SHIP` verdicts,
return `REQUEST_CHANGES` when concrete follow-up is needed, or `BLOCKED` only
when safety checks, missing context, or automation limits prevent a reliable
decision.

Rules:
- Do not mutate GitHub state.
- Do not submit a PR review yourself.
- Do not post comments directly with `gh`.
- Return exactly one JSON object and nothing else.
- Use `APPROVE` only when agent approval is genuinely appropriate.
- Use `REQUEST_CHANGES` when follow-up implementation work is appropriate.
- Use `BLOCKED` only when required context is missing, safety checks fail, or
  automation cannot make a reliable decision.

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
