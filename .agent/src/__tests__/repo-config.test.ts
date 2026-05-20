import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  DEFAULT_REPO_CONFIG_VARIABLES,
  formatRepoConfigSummary,
  parseRepoConfigPlan,
} from "../repo-config.js";

const repoRoot = resolve(__dirname, "../../..");

test("repo config allowlist matches documented repository variables", () => {
  const docs = readFileSync(
    resolve(repoRoot, ".agent/docs/customization/configuration-list.md"),
    "utf8",
  );
  const repositoryVariablesSection = docs.split("## Repository secrets")[0] || docs;
  const documented = Array.from(
    repositoryVariablesSection.matchAll(/^\| `(AGENT_[A-Z0-9_]+)` \|/gm),
    ([, name]) => name,
  ).sort();

  assert.deepEqual([...DEFAULT_REPO_CONFIG_VARIABLES].sort(), documented);
});

test("parseRepoConfigPlan validates set and unset operations", () => {
  const plan = parseRepoConfigPlan(`
\`\`\`json
{
  "operations": [
    {
      "action": "set",
      "name": "agent_auto_update",
      "value": false,
      "reason": "Disable scheduled updates"
    },
    {
      "action": "unset",
      "name": "AGENT_STATUS_LABEL_ENABLED",
      "reason": "Use default label behavior"
    }
  ]
}
\`\`\`
`);

  assert.deepEqual(plan.operations, [
    {
      action: "set",
      name: "AGENT_AUTO_UPDATE",
      value: "false",
      reason: "Disable scheduled updates",
    },
    {
      action: "unset",
      name: "AGENT_STATUS_LABEL_ENABLED",
      reason: "Use default label behavior",
    },
  ]);
});

test("parseRepoConfigPlan validates variable-specific value contracts", () => {
  const plan = parseRepoConfigPlan(JSON.stringify({
    operations: [
      {
        action: "set",
        name: "AGENT_RUNS_ON",
        value: "[ \"ubuntu-latest\", \"self-hosted\" ]",
      },
      {
        action: "set",
        name: "AGENT_ACCESS_POLICY",
        value: "{\"allowed_associations\":[\"owner\"]}",
      },
      {
        action: "set",
        name: "AGENT_DEFAULT_PROVIDER",
        value: " Codex ",
      },
      {
        action: "set",
        name: "AGENT_RUBRICS_LIMIT",
        value: "all",
      },
      {
        action: "set",
        name: "AGENT_MEMORY_REF",
        value: "agent/memory",
      },
    ],
  }));

  assert.deepEqual(
    plan.operations.map((operation) => [operation.name, operation.value]),
    [
      ["AGENT_RUNS_ON", "[\"ubuntu-latest\",\"self-hosted\"]"],
      ["AGENT_ACCESS_POLICY", "{\"allowed_associations\":[\"owner\"]}"],
      ["AGENT_DEFAULT_PROVIDER", "codex"],
      ["AGENT_RUBRICS_LIMIT", "all"],
      ["AGENT_MEMORY_REF", "agent/memory"],
    ],
  );
});

test("parseRepoConfigPlan rejects missing, empty, unknown, and ambiguous plans", () => {
  assert.throws(() => parseRepoConfigPlan("no json"), /JSON object/);
  assert.throws(() => parseRepoConfigPlan('{"operations":[]}'), /at least one operation/);
  assert.throws(
    () => parseRepoConfigPlan('{"operations":[{"action":"set","name":"AGENT_SECRET","value":"x"}]}'),
    /not allowed/,
  );
  assert.throws(
    () => parseRepoConfigPlan('{"operations":[{"action":"delete","name":"AGENT_AUTO_UPDATE"}]}'),
    /Unsupported repo config action/,
  );
  assert.throws(
    () => parseRepoConfigPlan('{"operations":[{"action":"set","name":"AGENT_AUTO_UPDATE"}]}'),
    /must include value/,
  );
  assert.throws(
    () => parseRepoConfigPlan(
      '{"operations":[{"action":"set","name":"AGENT_AUTO_UPDATE","value":"false"},{"action":"unset","name":"AGENT_AUTO_UPDATE"}]}',
    ),
    /multiple operations/,
  );
  assert.throws(
    () => parseRepoConfigPlan(
      '{"operations":[{"action":"unset","name":"AGENT_AUTO_UPDATE","value":"false"}]}',
    ),
    /must not include value/,
  );
});

test("parseRepoConfigPlan rejects invalid variable-specific values", () => {
  assert.throws(
    () => parseRepoConfigPlan('{"operations":[{"action":"set","name":"AGENT_RUNS_ON","value":"ubuntu-latest"}]}'),
    /JSON array of runner labels/,
  );
  assert.throws(
    () => parseRepoConfigPlan('{"operations":[{"action":"set","name":"AGENT_TASK_TIMEOUT_POLICY","value":"{\\"default_minutes\\":\\"30\\"}"}]}'),
    /default_minutes must be a positive integer/,
  );
  assert.throws(
    () => parseRepoConfigPlan('{"operations":[{"action":"set","name":"AGENT_AUTO_UPDATE","value":"banana"}]}'),
    /must be a boolean value/,
  );
  assert.throws(
    () => parseRepoConfigPlan('{"operations":[{"action":"set","name":"AGENT_DEFAULT_PROVIDER","value":"openai"}]}'),
    /must be one of auto, codex, claude/,
  );
  assert.throws(
    () => parseRepoConfigPlan('{"operations":[{"action":"set","name":"AGENT_MEMORY_REF","value":"bad ref"}]}'),
    /valid branch\/ref name/,
  );
});

test("formatRepoConfigSummary reports dry-run and applied statuses", () => {
  const plan = parseRepoConfigPlan(
    '{"operations":[{"action":"set","name":"AGENT_AUTO_UPDATE","value":"false","reason":"Disable updates"}]}',
  );
  const dryRun = formatRepoConfigSummary({ repo: "self-evolving/repo", apply: false, plan });
  assert.match(dryRun, /Mode: `dry run`/);
  assert.match(dryRun, /planned/);
  assert.match(dryRun, /Dry run only/);

  const applied = formatRepoConfigSummary({
    repo: "self-evolving/repo",
    apply: true,
    plan,
    results: [{ ...plan.operations[0], status: "updated" }],
  });
  assert.match(applied, /Mode: `applied`/);
  assert.match(applied, /updated/);
});
