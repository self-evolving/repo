## Task Description

Your task is to directly respond to the following user's mention:

${MENTION_BODY}

Instructions:
- Answer the user's question directly, or explain the limitation if the routed request is unsupported.
- You may use `gh` and repository files to gather context, but do not post comments directly via `gh` or any other GitHub write API.
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
