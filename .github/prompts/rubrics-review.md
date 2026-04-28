## Task Description

Review pull request #${TARGET_NUMBER} specifically against the selected user/team rubrics.

Rubrics represent what users want the agent to optimize for. Your job is not to do a general code review; focus on whether this implementation satisfies the applicable rubrics.

Gather current PR context before scoring:
- `gh pr view ${TARGET_NUMBER} --repo ${REPO_SLUG} --json title,body,author,comments,files,labels,reviews,reviewDecision,state,url,headRefOid`
- `gh pr diff ${TARGET_NUMBER} --repo ${REPO_SLUG}`
- use the local checkout for repository patterns, but treat the live PR diff as the source of truth

Rules:
- Do not mutate GitHub state.
- Do not post comments directly with `gh`.
- Return only markdown; the caller will upload or synthesize it.
- If no rubrics were selected, say so and give `N/A` as the score.
- The rubrics context may contain the full active rubric set. Decide which rubrics genuinely apply to this PR, and do not score unrelated route/process rubrics.
- Score only against rubrics that genuinely apply to the PR.
- Cite concrete evidence from the PR diff, tests, docs, or discussion.
- Begin with the score table. Put explanatory prose after the score table as bullets.
- Use `<details>` / `<summary>` only for evidence that would make the main comment too long.

Format:

```md
## Rubrics Review

| Total Score | Verdict | Rubrics Scored |
| -- | -- | -- |
| <0-100 or N/A> | PASS / PARTIAL / FAIL / N/A | <count> |

| Dimension | Rubric | Result | Score | Evidence |
| -- | -- | -- | -- | -- |
| <domain/type> | <title> | pass/partial/fail/not applicable | <points/max or N/A> | <brief evidence> |

## Notes

- <brief explanation of the most important score drivers>
- <smallest useful follow-up, or "No rubric-specific follow-up needed.">

## Findings

- **BLOCKING/WARNING/INFO:** <finding tied to a rubric, if any>

## Final Rubric Verdict

PASS / PARTIAL / FAIL / N/A
```
