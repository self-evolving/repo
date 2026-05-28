const CODEX_ACPX_AUTH_METHOD_IDS = ["openai-api-key", "codex-api-key"] as const;

function acpxAuthEnvName(methodId: string): string | undefined {
  const token = methodId
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return token ? `ACPX_AUTH_${token}` : undefined;
}

function setCredentialEnv(options: {
  output: Record<string, string>;
  input: NodeJS.ProcessEnv;
  sourceName: string;
  ambientName: string;
  acpxAuthMethodIds?: readonly string[];
}): void {
  const credential = options.input[options.sourceName];
  if (!credential) return;

  options.output[options.ambientName] = credential;
  for (const methodId of options.acpxAuthMethodIds ?? []) {
    const envName = acpxAuthEnvName(methodId);
    if (envName) options.output[envName] = credential;
  }
}

export function buildSharedEnv(inputEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  if (inputEnv.INPUT_GITHUB_TOKEN) {
    env.GH_TOKEN = inputEnv.INPUT_GITHUB_TOKEN;
    env.GITHUB_TOKEN = inputEnv.INPUT_GITHUB_TOKEN;
  }
  env.INPUT_SECONDARY_GITHUB_TOKEN = inputEnv.INPUT_SECONDARY_GITHUB_TOKEN || "";
  setCredentialEnv({
    output: env,
    input: inputEnv,
    sourceName: "INPUT_OPENAI_API_KEY",
    ambientName: "OPENAI_API_KEY",
    acpxAuthMethodIds: CODEX_ACPX_AUTH_METHOD_IDS,
  });
  if (inputEnv.MODEL_REASONING_EFFORT) {
    env.MODEL_REASONING_EFFORT = inputEnv.MODEL_REASONING_EFFORT;
    // Claude Code reads effort from this env var directly, so both the
    // flow path and the direct path pick it up without session setup.
    env.CLAUDE_CODE_EFFORT_LEVEL = inputEnv.MODEL_REASONING_EFFORT;
  }
  setCredentialEnv({
    output: env,
    input: inputEnv,
    sourceName: "CLAUDE_CODE_OAUTH_TOKEN",
    ambientName: "CLAUDE_CODE_OAUTH_TOKEN",
  });
  setCredentialEnv({
    output: env,
    input: inputEnv,
    sourceName: "ANTHROPIC_API_KEY",
    ambientName: "ANTHROPIC_API_KEY",
  });
  return env;
}
