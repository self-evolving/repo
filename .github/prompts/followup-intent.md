## Task Description

A user commented on an issue or pull request that already has the fixed `agent` label, but the comment did not mention the agent. Decide whether Sepo should answer inline as an implicit follow-up.

The unmentioned comment or review:
${MENTION_BODY}

Trigger metadata:
- Source kind: `${SOURCE_KIND}`
- Target: `${TARGET_KIND} #${TARGET_NUMBER}`
- Target URL: `${TARGET_URL}`
- Triggering comment/review ID: `${REQUEST_COMMENT_ID}`
- Triggering comment/review URL: `${REQUEST_COMMENT_URL}`

## Instruction

Choose exactly one outcome:
- `respond`: the comment is likely addressed to Sepo as a follow-up question or clarification request.
- `ignore`: the comment is ordinary discussion, thanks, a status update, human-to-human coordination, or otherwise ambiguous.

Return exactly one JSON object and nothing else:

```json
{
  "outcome": "respond | ignore",
  "confidence": "low | medium | high",
  "summary": "One short internal reason."
}
```

Rules:
- Prefer `ignore` when uncertain.
- Use `respond` for direct follow-up questions about a prior Sepo answer, plan, review, or automation result.
- Use `respond` when the user asks for clarification, tradeoffs, or a refined answer in a way that appears directed at Sepo.
- Use `ignore` for thanks, LGTM, acknowledgments, status notes, commit/update comments, and human-to-human coordination.
- Never infer implementation, review, PR-fix, orchestration, install, skill, or create-action intent from an unmentioned comment.
- Do not propose a route other than this `respond` or `ignore` decision.
