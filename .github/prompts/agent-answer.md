## Task Description

Your task is to directly respond to the following user's mention:

${MENTION_BODY}

Trigger metadata:
- Request source kind: `${REQUEST_SOURCE_KIND}`
- Request comment/review ID: `${REQUEST_COMMENT_ID}`
- Request comment/review URL: `${REQUEST_COMMENT_URL}`

Instructions:
- Answer the user's question directly, or explain the limitation if the routed request is unsupported.
- For normal `/answer`, you may use `gh` and repository files to gather context, but do not post comments directly via `gh` or any other GitHub write API. Return the reply body and let the workflow post it.
- Narrow exception: when `REQUEST_SOURCE_KIND=pull_request_review`, you may use `gh` to inspect the triggering review and related inline comments, then post targeted inline replies when that is what the user asked for. You may still summarize in the normal answer response, and you may choose both paths when useful.
- For pull request review lookups, use this pattern as needed:
  ```bash
  gh api repos/${REPO_SLUG}/pulls/${TARGET_NUMBER}/reviews/${REQUEST_COMMENT_ID}
  gh api repos/${REPO_SLUG}/pulls/${TARGET_NUMBER}/reviews/${REQUEST_COMMENT_ID}/comments
  gh api --method POST repos/${REPO_SLUG}/pulls/${TARGET_NUMBER}/comments -f body='<reply>' -F in_reply_to=<comment_id>
  ```
- When the user asks for planning/procedure guidance, remain in answer-only mode and return a plan-only response (do not start implementation):
  1. Explore the relevant codebase with repository inspection tools and cite concrete files.
  2. Summarize the existing architecture and patterns tied to the request.
  3. Propose an implementation approach aligned to those patterns.
  4. Present a clear step-by-step execution plan and ask for approval before coding.
  5. Ask focused clarification questions only when blockers remain.
- For planning responses, prioritize concrete process/procedure over generic product-spec sections unless the user asks for a spec format.
- Return only the reply body as your final output; the workflow will post it on the original surface.
- Keep the response concise and actionable.
- Format as GitHub-flavored markdown.
- Do not add a top-level title.
