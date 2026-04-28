## Task Description

A pull request in this repository was just closed. Update agent memory with any durable lessons worth carrying forward — no more, no less.

Pull request: #${TARGET_NUMBER} at ${TARGET_URL}

Instructions:
1. Read the PR history, not just the final state:
   - `gh pr view ${TARGET_NUMBER} --repo ${REPO_SLUG} --json title,body,author,mergedAt,closedAt,state,files,labels,reviews,reviewDecision,baseRefName,headRefName,url`
   - `gh api repos/${REPO_SLUG}/issues/${TARGET_NUMBER}/comments --paginate` for issue-comment history on the PR
   - `gh api repos/${REPO_SLUG}/pulls/${TARGET_NUMBER}/comments --paginate` for inline review-comment history
   - `gh api repos/${REPO_SLUG}/pulls/${TARGET_NUMBER}/reviews --paginate` for review history
   - `gh pr diff ${TARGET_NUMBER} --repo ${REPO_SLUG}` if file-level changes matter for the lesson.
2. Follow linkage before composing updates. If the PR references parent issues, related PRs, or existing memory notes, read that linked context too.
3. Skim current memory before composing updates. At minimum read `${MEMORY_DIR}/PROJECT.md` and `${MEMORY_DIR}/MEMORY.md`. For broader lookups use the `memory/search.js` CLI.
4. Record a concise daily bullet for the PR closure, tracking the key task or outcome that landed:
   - `node .agent/dist/cli/memory/update.js daily-append --dir "${MEMORY_DIR}" "<one-line summary of what landed>"`
   - Keep it factual, under ~140 characters, no PR number padding — the github/ mirror already links back.
5. Consider whether any **durable** memory update is warranted. A durable update is justified when the PR reveals:
   - a stable convention or preference the team wants future runs to respect
   - an architectural decision or constraint likely to outlast the next few weeks
   - a recurring workflow rule (naming, review cadence, branch policy) that agents keep getting wrong
   If no durable update is warranted, skip this step — most PRs produce zero `MEMORY.md` edits.
6. When a durable update is warranted, add it:
   - `node .agent/dist/cli/memory/update.js add --dir "${MEMORY_DIR}" --file MEMORY.md --section Durable "<bullet>"`
   - Or surface a strategic question onto the project board:
   - `node .agent/dist/cli/memory/update.js add --dir "${MEMORY_DIR}" --file PROJECT.md --section "Open Questions" "<bullet>"`
   - For simple bullet-shaped edits, prefer the CLI above. If a different note shape is warranted, you may edit repo-local memory files under `${MEMORY_DIR}` directly with normal tools while keeping the existing memory tree coherent.

Guardrails:
- Prefer precise repo-specific statements over generic advice.
- Do not paste PR metadata (numbers, dates) into `MEMORY.md`.
- Do not `git commit` — the workflow does the commit and push.
- Return a short plain-text summary of what you recorded, or "no memory changes" if you chose not to touch memory.
