import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parse as parseYaml } from "yaml";

const repoRoot = path.resolve(__dirname, "../../..");

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function listFiles(dir: string, predicate: (name: string) => boolean): string[] {
  return readdirSync(path.join(repoRoot, dir))
    .filter(predicate)
    .map((name) => path.join(dir, name))
    .sort();
}

function listWorkflowAndActionYamlFiles(): string[] {
  return [
    ...listFiles(".github/workflows", (name) => name.endsWith(".yml")),
    ...readdirSync(path.join(repoRoot, ".github/actions"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(".github/actions", entry.name, "action.yml")),
    ...listFiles(".agent/action-templates", (name) => name.endsWith(".yml")),
  ].sort();
}

function readYaml(relativePath: string): unknown {
  return parseYaml(readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

test("workflow and action YAML files parse as objects", () => {
  for (const relativePath of listWorkflowAndActionYamlFiles()) {
    const parsed = readYaml(relativePath);
    assert.ok(isRecord(parsed), `${relativePath} should parse as a YAML object`);
  }
});

test("workflow steps that allow gh commands define GH_TOKEN", () => {
  const failures: string[] = [];

  for (const workflowPath of listFiles(".github/workflows", (name) => name.endsWith(".yml"))) {
    const workflow = readYaml(workflowPath);
    assert.ok(isRecord(workflow), `${workflowPath} should parse as a YAML object`);
    const jobs = workflow.jobs;
    assert.ok(isRecord(jobs), `${workflowPath} should define jobs`);

    for (const [jobId, job] of Object.entries(jobs)) {
      if (!isRecord(job)) continue;
      const steps = job.steps;
      if (!Array.isArray(steps)) continue;

      for (const step of steps) {
        if (!isRecord(step) || !isRecord(step.with)) continue;
        const allowedTools = String(step.with.allowed_tools ?? "");
        if (!allowedTools.includes("Bash(gh *)")) continue;

        const env = step.env;
        if (isRecord(env) && Object.hasOwn(env, "GH_TOKEN")) continue;

        const stepName = typeof step.name === "string" ? step.name : "(unnamed step)";
        failures.push(`${workflowPath}: ${jobId}: ${stepName} allows gh without GH_TOKEN`);
      }
    }
  }

  assert.deepEqual(failures, []);
});
