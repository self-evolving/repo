## User/team rubrics

Rubrics are user/team-owned preferences for how agent work should be implemented, reviewed, and communicated. They are separate from repository memory: memory captures agent/project continuity, while rubrics capture what users want the agent to optimize for and be evaluated against.

`${RUBRICS_DIR}` is a checkout of the dedicated `${RUBRICS_REF}` branch. The selected rubrics below were retrieved for this route and request as a starting shortlist, not as the complete rubric set.

You may browse `${RUBRICS_DIR}` for additional active user/team rubrics when the selected shortlist looks incomplete for the task. Prefer route-applicable rubrics, and for answer-only work prefer communication rubrics.

Use rubrics as normative guidance:
- During implementation or PR fixes, satisfy applicable rubrics when they fit the request and repository state.
- During review, inspect additional review or coding rubrics when needed, then evaluate whether the proposed implementation satisfies applicable rubrics and cite concrete evidence.
- If a selected rubric clearly does not apply, ignore it briefly rather than overfitting the task.
- Do not edit rubrics during normal implementation/review runs; only Agent / Rubrics / Initialization and Agent / Rubrics / Update should change the rubrics branch.

Selected rubrics:

${RUBRICS_CONTEXT}
