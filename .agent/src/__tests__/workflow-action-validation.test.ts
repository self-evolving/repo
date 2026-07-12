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

test("setup-agent-runtime caching preserves the save-before-branch-switch trust boundary", () => {
  const action = readYaml(".github/actions/setup-agent-runtime/action.yml");
  assert.ok(isRecord(action) && isRecord(action.runs), "action should define runs");
  const steps = (action.runs as Record<string, unknown>).steps;
  assert.ok(Array.isArray(steps), "action should define steps");
  const stepList = steps as Array<Record<string, unknown>>;

  const indexOf = (name: string): number => {
    const index = stepList.findIndex((step) => step.name === name);
    assert.ok(index >= 0, `step "${name}" should exist`);
    return index;
  };

  // Restore/save split only: the combined actions/cache action saves in a
  // post step at job end, after write-capable callers have switched the
  // workspace to a mutable branch.
  for (const step of stepList) {
    if (typeof step.uses === "string" && step.uses.includes("actions/cache")) {
      assert.match(
        step.uses,
        /^actions\/cache\/(restore|save)@[0-9a-f]{40}/,
        `cache step must use SHA-pinned restore or save, got: ${step.uses}`,
      );
    }
  }

  // Saves run immediately after the step that produces their artifact,
  // inside the composite, before control returns to the caller.
  const restoreModules = indexOf("Restore runtime dependency cache");
  const install = indexOf("Install runtime dependencies");
  const saveModules = indexOf("Save runtime dependency cache");
  const restoreDist = indexOf("Restore built runtime cache");
  const build = indexOf("Build runtime");
  const saveDist = indexOf("Save built runtime cache");
  assert.ok(restoreModules < install, "modules restore precedes npm ci");
  assert.equal(saveModules, install + 1, "modules save immediately follows npm ci");
  assert.ok(restoreDist < build, "dist restore precedes the build");
  assert.equal(saveDist, build + 1, "dist save immediately follows the build");

  for (const name of ["Save runtime dependency cache", "Save built runtime cache"]) {
    const step = stepList[indexOf(name)];
    assert.equal(step["continue-on-error"], true, `${name} stays best-effort`);
    assert.match(String(step.if), /cache-hit != 'true'/, `${name} saves only on a miss`);
  }

  // Caller-supplied inputs must not be interpolated into run: text, and the
  // modules key must carry the Node version through env indirection.
  const keysStep = stepList[stepList.findIndex((step) => step.id === "keys")];
  assert.ok(isRecord(keysStep), "keys step should exist");
  const keysRun = String(keysStep.run);
  assert.doesNotMatch(keysRun, /\$\{\{\s*inputs\./, "no inputs interpolated into the keys script");
  assert.match(keysRun, /node\$\{NODE_VERSION_INPUT\}/, "modules key embeds the Node version via env");
  assert.ok(isRecord(keysStep.env), "keys step should pass inputs via env");
  assert.equal(
    String((keysStep.env as Record<string, unknown>).NODE_VERSION_INPUT),
    "${{ inputs.node_version }}",
  );
});
