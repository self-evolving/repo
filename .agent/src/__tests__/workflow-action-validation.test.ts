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

test("standalone CLI caching follows the runtime cache discipline", () => {
  const action = readYaml(".github/actions/setup-agent-runtime/action.yml");
  assert.ok(isRecord(action) && isRecord(action.runs), "action should define runs");
  const steps = (action.runs as Record<string, unknown>).steps as Array<Record<string, unknown>>;
  const indexOf = (name: string): number => {
    const index = steps.findIndex((step) => step.name === name);
    assert.ok(index >= 0, `step "${name}" should exist`);
    return index;
  };

  // Codex is already supplied by codex-acp inside the cached runtime
  // dependencies, so it must not get an unreachable duplicate global cache.
  const packageLock = JSON.parse(readFileSync(path.join(repoRoot, ".agent/package-lock.json"), "utf8")) as unknown;
  assert.ok(isRecord(packageLock) && isRecord(packageLock.packages), "package lock should list packages");
  const codexAcp = packageLock.packages["node_modules/@agentclientprotocol/codex-acp"];
  assert.ok(isRecord(codexAcp) && isRecord(codexAcp.dependencies), "codex-acp dependencies should be locked");
  assert.ok(Object.hasOwn(codexAcp.dependencies, "@openai/codex"), "codex-acp should supply the Codex CLI");
  const runtimeBins = steps[indexOf("Add runtime tool bins to PATH")];
  assert.match(String(runtimeBins.run), /\.agent\/node_modules\/\.bin/, "the bundled Codex CLI is added to PATH");
  assert.ok(
    indexOf("Save runtime dependency cache") < indexOf("Install Codex CLI"),
    "the cached bundled Codex CLI is available before the fallback installer",
  );
  assert.equal(
    steps.some((step) => step.name === "Restore Codex CLI cache" || step.name === "Save Codex CLI cache"),
    false,
    "Codex must not have a duplicate global cache",
  );

  // Key computation uses env-indirected inputs and a weekly bucket for an
  // unpinned Claude install. The producing action, adapter lock state, and
  // model defaults all rotate the compatibility fingerprint.
  const keys = steps[indexOf("Resolve Claude CLI cache key")];
  assert.match(
    String(keys.if),
    /runner\.environment != 'self-hosted'/,
    "the hosted-only scope contract is enforced, not just documented",
  );
  const keysRun = String(keys.run);
  assert.doesNotMatch(keysRun, /\$\{\{\s*inputs\./, "no inputs interpolated into the CLI keys script");
  assert.match(keysRun, /%G-%V/, "unpinned CLI keys rotate on an ISO-week bucket");
  // Mutable channels (empty, latest, stable) all weekly-bucket; anything
  // else is treated as an exact pin.
  assert.match(keysRun, /""\|latest\|stable\)/, "empty, latest, and stable share the mutable-channel case");
  assert.match(keysRun, /latest\}-\$\{week\}/, "mutable channels carry the week bucket");
  // runner.os/arch is exact within the hosted scope contract; finer
  // platform detection (musl, Rosetta) is out of scope by declared
  // contract and covered by the execution probe's fresh-install fallback.
  assert.match(keysRun, /sepo-cli-claude-\$\{\{ runner\.os \}\}-\$\{\{ runner\.arch \}\}-\$\{channel\}/, "key composes runner platform and channel");
  assert.match(
    keysRun,
    /DISABLE_AUTOUPDATER=1/,
    "action-managed installs disable the CLI auto-updater",
  );
  assert.ok(
    keysRun.includes('if [ "${need_claude}" = "true" ] && [ -z "${DISABLE_AUTOUPDATER:-}" ]'),
    "the opt-out is need-gated and preserves any pre-set operator policy",
  );
  assert.match(keysRun, /FORCE_AUTOUPDATE_PLUGINS/, "the plugin-update escape hatch is documented in place");
  assert.ok(isRecord(keys.env), "CLI keys step reads inputs via env");

  const installProbe = steps[indexOf("Install Claude CLI")];
  assert.match(
    String(installProbe.run),
    /--version >\/dev\/null/,
    "restored binaries are probed by execution, not just executability",
  );
  // The compatibility fingerprint covers everything that sets a floor the
  // cached CLI must satisfy; rotation is absorbed by the seed's push and
  // weekly-schedule triggers rather than user-facing runs.
  for (const compatibilityInput of [
    ".github/actions/setup-agent-runtime/action.yml",
    ".agent/package-lock.json",
    ".agent/model-defaults.json",
  ]) {
    assert.ok(keysRun.includes(`'${compatibilityInput}'`), `CLI key fingerprints ${compatibilityInput}`);
  }

  // Every redirected output write is a complete NAME=VALUE line. This
  // rejects shell concatenation that expands a value across physical lines,
  // which GitHub's output-file parser treats as an invalid bare second line.
  const echoLines = keysRun
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("echo "));
  assert.ok(echoLines.length > 0, "CLI key step should emit outputs");
  for (const echoLine of echoLines) {
    if (echoLine.includes('$GITHUB_ENV')) {
      // Persisted-env writes are self-contained single lines.
      assert.match(echoLine, /^echo "[A-Z][A-Z0-9_]*=[^"]*" >> "\$GITHUB_ENV"$/, `unsupported GitHub env write: ${echoLine}`);
      continue;
    }
    assert.match(echoLine, /^echo "[a-z][a-z0-9_]*=[^"]*"$/, `unsupported GitHub output write: ${echoLine}`);
  }

  // Restore is best-effort and skipped when Claude is already present on a
  // self-hosted runner.
  const restore = steps[indexOf("Restore Claude CLI cache")];
  assert.equal(restore["continue-on-error"], true, "Claude restore must not fail setup");
  assert.match(String(restore.if), /need_claude == 'true'/, "Claude restore is gated on the CLI being missing");

  // Save is miss-gated, best-effort, and immediate so nothing is archived at
  // job end after a caller can switch branches. Paths are HOME-scoped by
  // declared scope contract: the cache targets the uniform hosted-runner
  // layout, self-hosted pools preinstall the CLI, and the execution probe
  // makes any layout mismatch degrade to the uncached status quo.
  const saveIndex = indexOf("Save Claude CLI cache");
  assert.equal(saveIndex, indexOf("Install Claude CLI") + 1, "Claude save immediately follows installation");
  const save = steps[saveIndex];
  assert.equal(save["continue-on-error"], true, "Claude save stays best-effort");
  assert.match(String(save.if), /cache-hit != 'true'/, "Claude save runs only on a miss");
  const actionText = readFileSync(path.join(repoRoot, ".github/actions/setup-agent-runtime/action.yml"), "utf8");
  assert.match(actionText, /Scope contract/, "the hosted-layout scope decision is stated in place");
});

test("cache seed warms the Claude CLI cache", () => {
  const workflow = readYaml(".github/workflows/agent-cache-seed.yml");
  assert.ok(isRecord(workflow) && isRecord(workflow.jobs), "seed workflow should define jobs");

  // Trigger/bucket alignment: the CLI key rotates on ISO weeks (Monday
  // 00:00 UTC), and low-trust triggers cannot save default-branch caches,
  // so the seed must fire on a matching weekly schedule.
  const on = (workflow as Record<string, unknown>).on as Record<string, unknown>;
  assert.ok(Array.isArray(on.schedule), "seed should have a schedule trigger");
  const crons = (on.schedule as Array<Record<string, unknown>>).map((entry) => String(entry.cron));
  assert.ok(
    crons.some((cron) => /^\S+ \S+ \* \* (1|MON)$/i.test(cron)),
    "seed schedule fires weekly on Monday, aligned with the %G-%V bucket rollover",
  );
  const seed = (workflow.jobs as Record<string, unknown>).seed as Record<string, unknown>;
  const steps = seed.steps as Array<Record<string, unknown>>;
  const setup = steps.find((step) => typeof step.uses === "string" && step.uses.includes("setup-agent-runtime"));
  assert.ok(setup && isRecord(setup.with), "seed should call setup-agent-runtime");
  assert.equal(
    String((setup.with as Record<string, unknown>).install_claude),
    "true",
    "seed absorbs CLI cache misses so user-facing runs do not pay them",
  );

  // The weekly cron is scheduled activity and honors AGENT_SCHEDULE_POLICY;
  // push and manual dispatch warm unconditionally.
  const gate = steps.find((step) => typeof step.uses === "string" && step.uses.includes("scheduled-activity-gate"));
  assert.ok(gate && isRecord(gate.with), "seed should resolve the schedule policy gate");
  assert.equal(String((gate.with as Record<string, unknown>).workflow), "agent-cache-seed.yml");
  assert.match(String(gate.if), /github\.event_name == 'schedule'/, "gate applies only to cron runs");
  assert.match(
    String(setup.if),
    /github\.event_name != 'schedule' \|\| steps\.schedule_gate\.outputs\.skip != 'true'/,
    "warming skips only when schedule policy disables the cron run",
  );
});
