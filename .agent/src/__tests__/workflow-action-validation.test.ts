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
  assert.ok(isRecord(action.inputs), "action should define inputs");
  const cacheMode = (action.inputs as Record<string, unknown>).cache_mode;
  assert.ok(isRecord(cacheMode), "cache_mode input should exist");
  assert.equal(String(cacheMode.default), "full", "caching is on by default with off as the escape hatch");
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

  // Restores must also be best-effort: a failed restore leaves cache-hit
  // unset so the miss guards fall through to npm ci / build, rather than
  // failing setup before the uncached fallback can run.
  for (const name of ["Restore runtime dependency cache", "Restore built runtime cache"]) {
    const step = stepList[indexOf(name)];
    assert.equal(step["continue-on-error"], true, `${name} must not fail setup`);
  }

  // Caller-supplied inputs must not be interpolated into run: text, and the
  // modules key must carry the Node version through env indirection.
  const keysStep = stepList[stepList.findIndex((step) => step.id === "keys")];
  assert.ok(isRecord(keysStep), "keys step should exist");
  const keysRun = String(keysStep.run);
  assert.doesNotMatch(keysRun, /\$\{\{\s*inputs\./, "no inputs interpolated into the keys script");
  assert.match(keysRun, /process\.versions\.modules/, "modules key uses the resolved Node ABI");
  assert.match(keysRun, /nodeabi\$\{resolved_node_abi\}/, "modules key embeds the resolved Node ABI");
  // hashFiles aggregates content digests without paths, so a
  // content-preserving rename would keep the key while tsc emits different
  // output paths. The dist source fingerprint must be the path-sensitive
  // git tree ID instead.
  assert.match(keysRun, /git rev-parse HEAD:\.agent\/src/, "dist key fingerprints src via git tree ID");
  assert.match(keysRun, /src\$\{src_tree\}/, "dist key embeds the src tree ID");
  assert.doesNotMatch(keysRun, /\.agent\/src\/\*\*/, "dist key must not rely on path-blind hashFiles for src");

  const validate = stepList[indexOf("Validate cache mode")];
  assert.match(String(validate.if), /!= 'off'.*!= 'modules'.*!= 'full'/s, "validation rejects unknown modes");
  assert.ok(isRecord(validate.env), "validation reads the input via env");
  assert.match(String(validate.run), /exit 1/, "validation fails setup on unknown modes");
  const producerHash = /hashFiles\([^)]*\.github\/actions\/setup-agent-runtime\/action\.yml/;
  assert.match(keysRun, producerHash, "keys fingerprint the producing action");
  assert.equal(
    (keysRun.match(/\.github\/actions\/setup-agent-runtime\/action\.yml/g) || []).length,
    2,
    "both keys fingerprint the producing action",
  );
});

test("cache seed workflow only executes the trusted default branch", () => {
  const workflow = readYaml(".github/workflows/agent-cache-seed.yml");
  assert.ok(isRecord(workflow), "seed workflow should parse");
  const on = (workflow as Record<string, unknown>).on;
  assert.ok(isRecord(on) && isRecord(on.push), "seed workflow should trigger on push");
  assert.equal(
    (on.push as Record<string, unknown>).branches,
    undefined,
    "no static branch filter; the job gate enforces the default branch",
  );
  const jobs = (workflow as Record<string, unknown>).jobs;
  assert.ok(isRecord(jobs) && isRecord(jobs.seed), "seed job should exist");
  const seed = jobs.seed as Record<string, unknown>;
  assert.match(
    String(seed.if),
    /github\.ref_name == github\.event\.repository\.default_branch/,
    "seed job gates on the repository default branch",
  );
  const concurrency = (workflow as Record<string, unknown>).concurrency;
  assert.ok(isRecord(concurrency), "seed workflow should define concurrency");
  assert.match(
    String(concurrency.group),
    /github\.ref/,
    "seed concurrency is ref-scoped so branch pushes cannot cancel a default-branch warm",
  );
  const steps = seed.steps as Array<Record<string, unknown>>;
  const checkout = steps.find((step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout"));
  assert.ok(checkout && isRecord(checkout.with), "seed checkout should pin its ref");
  const withBlock = checkout.with as Record<string, unknown>;
  assert.equal(String(withBlock.ref), "${{ github.event.repository.default_branch }}");
  assert.equal(withBlock["persist-credentials"], false);
});

test("CLI binaries get the same cache discipline as the runtime", () => {
  const action = readYaml(".github/actions/setup-agent-runtime/action.yml");
  assert.ok(isRecord(action) && isRecord(action.runs), "action should define runs");
  const steps = (action.runs as Record<string, unknown>).steps as Array<Record<string, unknown>>;
  const indexOf = (name: string): number => {
    const index = steps.findIndex((step) => step.name === name);
    assert.ok(index >= 0, `step "${name}" should exist`);
    return index;
  };

  // Key computation: env-indirected inputs, weekly bucket for unpinned
  // versions so a stale "latest" cannot outlive its week.
  const keys = steps[indexOf("Resolve CLI cache keys")];
  const keysRun = String(keys.run);
  assert.doesNotMatch(keysRun, /\$\{\{\s*inputs\./, "no inputs interpolated into the CLI keys script");
  assert.match(keysRun, /%G-%V/, "unpinned CLI keys rotate on an ISO-week bucket");
  assert.match(keysRun, /latest-\$\{week\}/, "unpinned CLI keys carry the week bucket");
  assert.ok(isRecord(keys.env), "CLI keys step reads inputs via env");

  // Restores are best-effort and skipped entirely when the CLI is already
  // present (self-hosted runners with preinstalled CLIs).
  for (const name of ["Restore Codex CLI cache", "Restore Claude CLI cache"]) {
    const step = steps[indexOf(name)];
    assert.equal(step["continue-on-error"], true, `${name} must not fail setup`);
    assert.match(String(step.if), /need_(codex|claude) == 'true'/, `${name} is gated on the CLI being missing`);
  }

  // Saves are miss-gated, best-effort, and immediate: each save directly
  // follows its install step so nothing is archived at job end.
  for (const [saveName, installName] of [
    ["Save Codex CLI cache", "Install Codex CLI"],
    ["Save Claude CLI cache", "Install Claude CLI"],
  ] as const) {
    const saveIndex = indexOf(saveName);
    assert.equal(saveIndex, indexOf(installName) + 1, `${saveName} immediately follows ${installName}`);
    const step = steps[saveIndex];
    assert.equal(step["continue-on-error"], true, `${saveName} stays best-effort`);
    assert.match(String(step.if), /cache-hit != 'true'/, `${saveName} saves only on a miss`);
  }
});
