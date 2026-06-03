const CODEX_GPT5_MODEL_PREFIX = /^gpt-5(?:[.-]|$)/u;
const CODEX_REASONING_MODEL_SUFFIX = /(?:\/(low|medium|high|xhigh)|\[(low|medium|high|xhigh)\])$/u;

function isCodexAgent(agent: string): boolean {
  return agent.trim().toLowerCase() === "codex";
}

function decomposeCodexReasoningModel(model: string): {
  model: string;
  reasoningEffort: string;
} | null {
  const match = CODEX_REASONING_MODEL_SUFFIX.exec(model);
  if (!match) return null;

  const baseModel = model.slice(0, model.length - match[0].length);
  if (!CODEX_GPT5_MODEL_PREFIX.test(baseModel)) {
    return {
      model,
      reasoningEffort: "",
    };
  }

  return {
    model: baseModel,
    reasoningEffort: match[1] || match[2] || "",
  };
}

export function extractSessionModel(sessionLog: string): string {
  for (const raw of sessionLog.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const entry = JSON.parse(raw) as Record<string, unknown>;
      if (entry.type === "session" && typeof entry.model === "string" && entry.model.trim()) {
        return entry.model.trim();
      }
    } catch {
      // Ignore malformed compact log entries.
    }
  }
  return "";
}

function normalizeDisplayModel(options: {
  agent: string;
  model: string;
  reasoningEffort: string;
}): { model: string; reasoningEffort: string } {
  const model = options.model.trim();
  const reasoningEffort = options.reasoningEffort.trim();

  if (isCodexAgent(options.agent)) {
    const decomposed = decomposeCodexReasoningModel(model);
    if (decomposed) return decomposed;
  }

  return { model, reasoningEffort };
}

export function buildModelDisplay(options: {
  agent: string;
  model: string;
  reasoningEffort: string;
  runnerName: string;
}): string {
  const display = normalizeDisplayModel({
    agent: options.agent,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
  });
  const parts = [
    options.agent.trim(),
    display.model || "default model",
    display.reasoningEffort,
    options.runnerName.trim(),
  ].filter(Boolean);
  return parts.length > 0 ? parts.map((part) => `\`${part}\``).join(" | ") : "";
}
