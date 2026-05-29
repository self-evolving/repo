import { test } from "node:test";
import { strict as assert } from "node:assert";

import { buildSharedEnv } from "../runtime-env.js";

test("buildSharedEnv mirrors OpenAI key for Codex ACPX auth selection", () => {
  const env = buildSharedEnv({
    INPUT_OPENAI_API_KEY: "openai-token",
  });

  assert.equal(env.OPENAI_API_KEY, "openai-token");
  assert.equal(env.ACPX_AUTH_OPENAI_API_KEY, "openai-token");
  assert.equal(env.ACPX_AUTH_CODEX_API_KEY, "openai-token");
});

test("buildSharedEnv carries secondary GitHub token without replacing primary auth", () => {
  const env = buildSharedEnv({
    INPUT_GITHUB_TOKEN: "primary-token",
    INPUT_SECONDARY_GITHUB_TOKEN: "secondary-token",
  });

  assert.equal(env.GH_TOKEN, "primary-token");
  assert.equal(env.GITHUB_TOKEN, "primary-token");
  assert.equal(env.INPUT_SECONDARY_GITHUB_TOKEN, "secondary-token");
});

test("buildSharedEnv maps reasoning effort for shared runtime consumers", () => {
  const env = buildSharedEnv({
    MODEL_REASONING_EFFORT: "high",
  });

  assert.equal(env.MODEL_REASONING_EFFORT, "high");
  assert.equal(env.CLAUDE_CODE_EFFORT_LEVEL, "high");
});

test("buildSharedEnv preserves Claude credentials without unsupported ACPX aliases", () => {
  const env = buildSharedEnv({
    CLAUDE_CODE_OAUTH_TOKEN: "claude-token",
    ANTHROPIC_API_KEY: "anthropic-token",
  });

  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "claude-token");
  assert.equal(env.ANTHROPIC_API_KEY, "anthropic-token");
  assert.equal("ACPX_AUTH_CLAUDE_CODE_OAUTH_TOKEN" in env, false);
  assert.equal("ACPX_AUTH_ANTHROPIC_API_KEY" in env, false);
});
