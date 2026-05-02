export function buildContinuationPrompt(promptVars: Record<string, string>): string {
  return [
    "Trigger metadata:",
    `- Triggering source kind: \`${promptVars.REQUEST_SOURCE_KIND || ""}\``,
    `- Triggering comment/review ID: \`${promptVars.REQUEST_COMMENT_ID || ""}\``,
    `- Triggering comment/review URL: \`${promptVars.REQUEST_COMMENT_URL || ""}\``,
    "",
    promptVars.REQUEST_TEXT || "",
  ].join("\n");
}

export function shouldReplayFullPromptOnResume(
  route: string,
  promptVars: Record<string, string>,
): boolean {
  return route === "fix-pr" && Boolean((promptVars.ORCHESTRATOR_CONTEXT || "").trim());
}

export function selectContinuationPromptForResume(options: {
  route: string;
  promptVars: Record<string, string>;
  continuationPrompt: string;
}): string | undefined {
  if (shouldReplayFullPromptOnResume(options.route, options.promptVars)) {
    return undefined;
  }
  return options.continuationPrompt;
}
