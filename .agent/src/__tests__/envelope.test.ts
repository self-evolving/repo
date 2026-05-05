import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parse as parseYaml } from "yaml";

import {
  buildEnvelope,
  buildEnvelopeFromEventContext,
  buildThreadKey,
  envelopeToPromptVars,
  SCHEMA_VERSION,
  validateEnvelope,
} from "../envelope.js";

const repoRoot = path.resolve(__dirname, "../../..");

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function readSupplementalPromptVarNames(runSource: string): Set<string> {
  const match = runSource.match(/const SUPPLEMENTAL_PROMPT_VAR_NAMES = \[([\s\S]*?)\] as const;/);
  assert.ok(match, "run.ts should define SUPPLEMENTAL_PROMPT_VAR_NAMES");
  return new Set(Array.from(match[1].matchAll(/"([^"]+)"/g), ([, name]) => name));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readBranchCleanupScript(): string {
  const workflow = parseYaml(readRepoFile(".github/workflows/agent-branch-cleanup.yml")) as unknown;
  assert.ok(isRecord(workflow), "branch cleanup workflow should parse as a YAML object");
  assert.ok(isRecord(workflow.jobs), "branch cleanup workflow should define jobs");
  const cleanupJob = workflow.jobs.cleanup;
  assert.ok(isRecord(cleanupJob), "branch cleanup workflow should define cleanup job");
  assert.ok(Array.isArray(cleanupJob.steps), "branch cleanup job should define steps");

  const githubScriptStep = cleanupJob.steps.find(
    (step): step is Record<string, unknown> =>
      isRecord(step) && step.uses === "actions/github-script@v7",
  );
  assert.ok(githubScriptStep, "branch cleanup workflow should use actions/github-script");
  assert.ok(isRecord(githubScriptStep.with), "github-script step should define inputs");
  const script = githubScriptStep.with.script;
  if (typeof script !== "string") {
    assert.fail("github-script step should define a script input");
  }

  return script;
}

async function runBranchCleanupScript(args: {
  github: unknown;
  context: unknown;
  core: unknown;
}): Promise<void> {
  const script = readBranchCleanupScript();
  const run = new Function(
    "github",
    "context",
    "core",
    `"use strict"; return (async () => {\n${script}\n})();`,
  ) as (github: unknown, context: unknown, core: unknown) => Promise<void>;

  await run(args.github, args.context, args.core);
}

const VALID_PARAMS = {
  repo_slug: "self-evolving/repo",
  route: "review",
  source_kind: "issue_comment",
  target_kind: "pull_request",
  target_number: 42,
  target_url: "https://github.com/self-evolving/repo/pull/42",
  request_text: "please review this",
  requested_by: "lolipopshock",
};

test("shared base prompt exists and contains the metadata contract", () => {
  const base = readRepoFile(".github/prompts/_base.md");

  assert.match(base, /Target: \$\{TARGET_KIND\} #\$\{TARGET_NUMBER\}/);
  assert.match(base, /Source: \$\{SOURCE_KIND\}/);
  assert.match(base, /URL: \$\{TARGET_URL\}/);
  assert.match(base, /\$\{REPO_SLUG\}/);
  assert.match(base, /\$\{REQUESTED_BY\}/);
  assert.match(base, /\$\{REQUEST_TEXT\}/);
  assert.match(base, /gh issue view/);
  assert.match(base, /gh pr view/);
});

test("route prompts do not duplicate the base metadata header", () => {
  const reviewPrompt = readRepoFile(".github/prompts/review.md");
  const implementPrompt = readRepoFile(".github/prompts/agent-implement.md");

  assert.doesNotMatch(reviewPrompt, /Target: \$\{TARGET_KIND\} #\$\{TARGET_NUMBER\}/);
  assert.doesNotMatch(implementPrompt, /Target: \$\{TARGET_KIND\} #\$\{TARGET_NUMBER\}/);
  assert.doesNotMatch(reviewPrompt, /Source: \$\{SOURCE_KIND\}/);
  assert.doesNotMatch(implementPrompt, /Source: \$\{SOURCE_KIND\}/);
});

test("review and implement prompts use self-serve context gathering", () => {
  const reviewPrompt = readRepoFile(".github/prompts/review.md");
  const implementPrompt = readRepoFile(".github/prompts/agent-implement.md");

  assert.match(reviewPrompt, /gh pr view \$\{TARGET_NUMBER\} --repo \$\{REPO_SLUG\}/);
  assert.match(reviewPrompt, /gh pr diff \$\{TARGET_NUMBER\} --repo \$\{REPO_SLUG\}/);
  assert.doesNotMatch(
    reviewPrompt,
    /\$\{PR_META_FILE\}|\$\{DIFF_FILE\}|\$\{RESOURCE_MANIFEST_FILE\}/,
  );

  assert.match(implementPrompt, /gh issue view \$\{TARGET_NUMBER\} --repo \$\{REPO_SLUG\}/);
  assert.match(implementPrompt, /"commit_message"/);
  assert.match(implementPrompt, /Closes #\$\{TARGET_NUMBER\}/);
  assert.doesNotMatch(
    implementPrompt,
    /\$\{PRIMARY_CONTEXT_FILE\}|\$\{RESOURCE_MANIFEST_FILE\}/,
  );
});

test("issue enhancement prompt uses self-serve context gathering", () => {
  const issueEnhancePrompt = readRepoFile(".github/prompts/agent-issue-enhance.md");

  assert.match(issueEnhancePrompt, /gh issue view \$\{TARGET_NUMBER\} --repo \$\{REPO_SLUG\}/);
  assert.doesNotMatch(issueEnhancePrompt, /\$\{PRIMARY_CONTEXT_FILE\}|\$\{RESOURCE_MANIFEST_FILE\}/);
});

test("answer prompt returns content for workflow posting instead of commenting directly", () => {
  const answerPrompt = readRepoFile(".github/prompts/agent-answer.md");

  assert.match(answerPrompt, /do not post comments directly via `gh`/i);
  assert.match(answerPrompt, /workflow will post it on the original surface/i);
});

test("setup routes are issue-only with plan/apply boundaries", () => {
  const setupPrompt = readRepoFile(".github/prompts/agent-setup.md");
  const routerWorkflow = readRepoFile(".github/workflows/agent-router.yml");
  const dispatchPrompt = readRepoFile(".github/prompts/agent-dispatch.md");
  const action = readRepoFile(".github/actions/run-agent-task/action.yml");
  const supportedWorkflows = readRepoFile(".agent/docs/architecture/supported-workflows.md");
  const agentActions = readRepoFile(".agent/docs/actions/agent-actions.md");
  const accessPolicy = readRepoFile(".agent/docs/access-policy.md");
  const setupApplyCli = readRepoFile(".agent/src/cli/setup-apply.ts");
  const setupApplyModule = readRepoFile(".agent/src/setup-apply.ts");
  const setupJobMatch = routerWorkflow.match(
    /\n  setup:\n[\s\S]*?(?=\n  [a-z][a-z0-9-]*:\n)/,
  );
  assert.ok(setupJobMatch, "setup job should exist in agent-router.yml");
  const setupJob = setupJobMatch[0];
  const setupApplyJobMatch = routerWorkflow.match(
    /\n  setup-apply:\n[\s\S]*?(?=\n  [a-z][a-z0-9-]*:\n)/,
  );
  assert.ok(setupApplyJobMatch, "setup-apply job should exist in agent-router.yml");
  const setupApplyJob = setupApplyJobMatch[0];

  assert.match(setupPrompt, /This route is plan-only/);
  assert.match(setupPrompt, /gh issue view \$\{TARGET_NUMBER\} --repo \$\{REPO_SLUG\}/);
  assert.match(setupPrompt, /gh variable list --repo \$\{REPO_SLUG\}/);
  assert.match(setupPrompt, /AGENT_HANDLE/);
  assert.match(setupPrompt, /Project `Status` values/);
  assert.match(setupPrompt, /Do not run write commands/);
  assert.match(setupPrompt, /gh variable set/);
  assert.match(setupPrompt, /gh project create/);
  assert.match(setupPrompt, /gh api --method POST/);
  assert.match(setupPrompt, /\/setup apply` is handled by a separate deterministic workflow path/);
  assert.match(setupPrompt, /workflow will post it/);

  assert.match(dispatchPrompt, /`setup`: produce a plan-only Sepo setup diff/);
  assert.match(dispatchPrompt, /`setup` is only valid for `issue` targets/);
  assert.match(dispatchPrompt, /only the exact explicit `\/setup apply` command may apply allowlisted repository variables/);
  assert.match(action, /create-action, setup, dispatch/);

  assert.match(
    setupJob,
    /setup:\n\s+needs: portal[\s\S]*needs\.portal\.outputs\.route == 'setup'[\s\S]*needs\.portal\.outputs\.target_kind == 'issue'/,
  );
  assert.match(setupJob, /Resolve setup provider[\s\S]*route:\s*setup/);
  assert.match(setupJob, /Run setup plan agent[\s\S]*permission_mode:\s*approve-reads/);
  assert.match(setupJob, /Run setup plan agent[\s\S]*prompt:\s*setup[\s\S]*route:\s*setup/);
  assert.match(setupJob, /Post setup plan[\s\S]*node \.agent\/dist\/cli\/post-response\.js/);
  assert.match(
    setupApplyJob,
    /setup-apply:\n\s+needs: portal[\s\S]*needs\.portal\.outputs\.route == 'setup-apply'[\s\S]*needs\.portal\.outputs\.target_kind == 'issue'/,
  );
  assert.match(setupApplyJob, /Setup agent runtime/);
  assert.match(setupApplyJob, /Apply setup variables[\s\S]*node \.agent\/dist\/cli\/setup-apply\.js/);
  assert.match(setupApplyJob, /Fail failed setup apply[\s\S]*steps\.setup_apply\.outcome == 'failure'/);
  assert.doesNotMatch(setupApplyJob, /run-agent-task/);
  assert.match(setupApplyCli, /SETUP_APPLY_DRY_RUN/);
  assert.match(setupApplyModule, /SETUP_VARIABLE_ALLOWLIST/);
  assert.match(setupApplyModule, /AGENT_PROJECT_MANAGEMENT_PROJECT_OWNER/);
  assert.match(setupApplyModule, /AGENT_PROJECT_MANAGEMENT_PROJECT_TITLE/);
  assert.match(setupApplyModule, /sepo-agent-setup-apply/);
  assert.match(setupApplyModule, /variable[\s\S]*set/);
  assert.doesNotMatch(setupApplyModule, /project create|field-create|item-add/);
  assert.match(
    routerWorkflow,
    /Label handled issue or PR[\s\S]*steps\.dispatch\.outputs\.route != 'setup'[\s\S]*steps\.dispatch\.outputs\.route != 'setup-apply'/,
  );
  assert.match(
    routerWorkflow,
    /Assign handled issue or PR[\s\S]*steps\.dispatch\.outputs\.route != 'setup'[\s\S]*steps\.dispatch\.outputs\.route != 'setup-apply'/,
  );
  assert.doesNotMatch(setupJob, /dispatch-agent-implement/);

  assert.match(supportedWorkflows, /@sepo-agent \/setup plan/);
  assert.match(supportedWorkflows, /@sepo-agent \/setup apply/);
  assert.match(supportedWorkflows, /allowlisted repository variables/);
  assert.match(supportedWorkflows, /route_overrides\.setup/);
  assert.match(agentActions, /Setup plan[\s\S]*`setup`[\s\S]*agent-setup\.md/);
  assert.match(agentActions, /Setup apply[\s\S]*`setup-apply`[\s\S]*setup-apply\.ts/);
  assert.match(accessPolicy, /`setup` and[\s\S]*`setup-apply` routes default to `OWNER`, `MEMBER`, and `COLLABORATOR`/);
});

test("fix-pr prompt uses self-serve context, not local snapshots", () => {
  const fixPrompt = readRepoFile(".github/prompts/agent-fix-pr.md");

  assert.doesNotMatch(fixPrompt, /\$\{PR_META_FILE\}/);
  assert.doesNotMatch(fixPrompt, /\$\{PR_DIFF_FILE\}/);
  assert.doesNotMatch(fixPrompt, /\$\{REVIEW_COMMENTS_FILE\}/);
  assert.doesNotMatch(fixPrompt, /\$\{REQUEST_COMMENT_FILE\}/);
  assert.doesNotMatch(fixPrompt, /\$\{RESOURCE_MANIFEST_FILE\}/);
  assert.match(fixPrompt, /gh pr view \$\{TARGET_NUMBER\}/);
  assert.match(fixPrompt, /\$\{REQUEST_COMMENT_ID\}/);
  assert.match(fixPrompt, /"commit_message"/);
});

test("agent-review and agent-implement workflows do not build linked context", () => {
  const reviewWorkflow = readRepoFile(".github/workflows/agent-review.yml");
  const implementWorkflow = readRepoFile(".github/workflows/agent-implement.yml");

  assert.doesNotMatch(reviewWorkflow, /build-linked-context\.cjs/);
  assert.doesNotMatch(implementWorkflow, /build-linked-context\.cjs/);
});

test("all execution workflows use the shared run-agent-task action", () => {
  const implementWorkflow = readRepoFile(".github/workflows/agent-implement.yml");
  const reviewWorkflow = readRepoFile(".github/workflows/agent-review.yml");
  const fixPrWorkflow = readRepoFile(".github/workflows/agent-fix-pr.yml");

  for (const workflow of [implementWorkflow, reviewWorkflow, fixPrWorkflow]) {
    assert.match(workflow, /uses: \.\/\.github\/actions\/run-agent-task/);
    assert.doesNotMatch(workflow, /\.github\/scripts\/lib\/agent\/run-codex\.sh/);
  }

  assert.doesNotMatch(fixPrWorkflow, /build-linked-context\.cjs/);
});

test("run-agent-task workflow steps are guarded by resolved task timeouts", () => {
  const workflowPaths = readdirSync(path.join(repoRoot, ".github/workflows"))
    .filter((file) => file.endsWith(".yml"))
    .map((file) => `.github/workflows/${file}`)
    .concat(".agent/action-templates/agent-action-template.yml");
  let guardedSteps = 0;

  for (const workflowPath of workflowPaths) {
    const workflow = parseYaml(readRepoFile(workflowPath)) as unknown;
    assert.ok(isRecord(workflow), `${workflowPath} should parse as a YAML object`);
    const jobs = workflow.jobs;
    if (!isRecord(jobs)) continue;

    for (const [jobId, job] of Object.entries(jobs)) {
      if (!isRecord(job) || !Array.isArray(job.steps)) continue;

      const resolverStepIds = new Set<string>();
      for (const step of job.steps) {
        if (!isRecord(step)) continue;
        if (String(step.run || "").includes("node .agent/dist/cli/resolve-task-timeout.js")) {
          const id = String(step.id || "");
          assert.ok(id, `${workflowPath} job ${jobId} timeout resolver needs an id`);
          assert.ok(isRecord(step.env), `${workflowPath} job ${jobId} timeout resolver needs env`);
          assert.equal(
            step.env.AGENT_TASK_TIMEOUT_POLICY,
            "${{ vars.AGENT_TASK_TIMEOUT_POLICY || '' }}",
            `${workflowPath} job ${jobId} timeout resolver should read AGENT_TASK_TIMEOUT_POLICY`,
          );
          assert.ok(step.env.ROUTE, `${workflowPath} job ${jobId} timeout resolver needs ROUTE`);
          resolverStepIds.add(id);
        }

        if (step.uses === "./.github/actions/run-agent-task") {
          const timeout = String(step["timeout-minutes"] || "");
          const match = timeout.match(/steps\.([a-zA-Z0-9_-]+)\.outputs\.minutes/);
          assert.ok(match, `${workflowPath} job ${jobId} run-agent-task step needs timeout-minutes from resolver output`);
          assert.ok(
            resolverStepIds.has(match[1]!),
            `${workflowPath} job ${jobId} timeout resolver must precede run-agent-task`,
          );
          assert.equal(
            timeout,
            "${{ fromJson(steps.task_timeout.outputs.minutes || '30') }}",
            `${workflowPath} job ${jobId} should coerce resolved timeout minutes`,
          );
          guardedSteps += 1;
        }
      }
    }
  }

  assert.ok(guardedSteps > 0);
});

test("single-agent workflows resolve provider before runtime setup", () => {
  const routerWorkflow = readRepoFile(".github/workflows/agent-router.yml");
  const implementWorkflow = readRepoFile(".github/workflows/agent-implement.yml");
  const fixPrWorkflow = readRepoFile(".github/workflows/agent-fix-pr.yml");
  const reviewWorkflow = readRepoFile(".github/workflows/agent-review.yml");
  const autonomousWorkflows = [
    readRepoFile(".github/workflows/agent-daily-summary.yml"),
    readRepoFile(".github/workflows/agent-memory-bootstrap.yml"),
    readRepoFile(".github/workflows/agent-memory-pr-closed.yml"),
    readRepoFile(".github/workflows/agent-memory-scan.yml"),
    readRepoFile(".github/workflows/agent-rubrics-initialization.yml"),
    readRepoFile(".github/workflows/agent-rubrics-review.yml"),
    readRepoFile(".github/workflows/agent-rubrics-update.yml"),
  ];
  const resolverAction = readRepoFile(".github/actions/resolve-agent-provider/action.yml");
  const resolverScript = readRepoFile(".github/actions/resolve-agent-provider/resolve-provider.sh");
  const configurationList = readRepoFile(".agent/docs/customization/configuration-list.md");

  assert.match(resolverAction, /resolve-provider\.sh/);
  assert.match(resolverScript, /DEFAULT_PROVIDER/);
  assert.match(resolverScript, /OPENAI_API_KEY/);
  assert.match(resolverScript, /CLAUDE_CODE_OAUTH_TOKEN/);
  assert.match(resolverScript, /provider=codex/);
  assert.match(resolverScript, /provider=claude/);

  assert.match(routerWorkflow, /default:\s*auto/);
  assert.doesNotMatch(routerWorkflow, /vars\.AGENT_PROVIDER_(DISPATCH|ANSWER|SKILL)/);
  assert.match(routerWorkflow, /required:\s*"false"/);
  assert.match(routerWorkflow, /id:\s*dispatch_provider/);
  assert.match(routerWorkflow, /id:\s*skill_provider/);
  assert.match(routerWorkflow, /agent:\s*\$\{\{\s*steps\.dispatch_provider\.outputs\.provider\s*\}\}/);
  assert.match(routerWorkflow, /agent:\s*\$\{\{\s*steps\.skill_provider\.outputs\.provider\s*\}\}/);
  assert.match(routerWorkflow, /agent:\s*\$\{\{\s*steps\.provider\.outputs\.provider\s*\}\}/);

  for (const workflow of [implementWorkflow, fixPrWorkflow, ...autonomousWorkflows]) {
    assert.match(workflow, /uses: \.\/\.github\/actions\/resolve-agent-provider/);
    assert.match(workflow, /default_provider:\s*\$\{\{\s*vars\.AGENT_DEFAULT_PROVIDER \|\|/);
    assert.match(workflow, /install_codex:\s*\$\{\{\s*steps\.provider\.outputs\.install_codex\s*\}\}/);
    assert.match(workflow, /install_claude:\s*\$\{\{\s*steps\.provider\.outputs\.install_claude\s*\}\}/);
    assert.match(workflow, /agent:\s*\$\{\{\s*steps\.provider\.outputs\.provider\s*\}\}/);
    assert.match(workflow, /claude_oauth_token:\s*\$\{\{\s*secrets\.CLAUDE_CODE_OAUTH_TOKEN\s*\}\}/);
  }

  assert.match(fixPrWorkflow, /lane:\s*fix-pr-\$\{\{\s*steps\.provider\.outputs\.provider\s*\}\}/);
  assert.match(reviewWorkflow, /name:\s*Resolve synthesis provider/);
  assert.match(reviewWorkflow, /id:\s*synthesis_provider/);
  assert.match(reviewWorkflow, /route:\s*review-synthesize/);
  assert.match(reviewWorkflow, /default_provider:\s*\$\{\{\s*vars\.AGENT_DEFAULT_PROVIDER \|\| 'auto'\s*\}\}/);
  assert.match(reviewWorkflow, /install_codex:\s*\$\{\{\s*steps\.synthesis_provider\.outputs\.install_codex\s*\}\}/);
  assert.match(reviewWorkflow, /install_claude:\s*\$\{\{\s*steps\.synthesis_provider\.outputs\.install_claude\s*\}\}/);
  assert.match(reviewWorkflow, /agent:\s*\$\{\{\s*steps\.synthesis_provider\.outputs\.provider\s*\}\}/);
  assert.match(reviewWorkflow, /openai_api_key:\s*\$\{\{\s*secrets\.OPENAI_API_KEY\s*\}\}/);
  assert.doesNotMatch(implementWorkflow, /vars\.AGENT_PROVIDER_IMPLEMENT/);
  assert.doesNotMatch(fixPrWorkflow, /vars\.AGENT_PROVIDER_FIX_PR/);

  assert.match(configurationList, /AGENT_DEFAULT_PROVIDER/);
  assert.doesNotMatch(configurationList, /AGENT_PROVIDER_IMPLEMENT/);
});

test("scheduled workflows evaluate skip gates before provider-dependent jobs", () => {
  const dailySummaryWorkflow = readRepoFile(".github/workflows/agent-daily-summary.yml");
  const memoryScanWorkflow = readRepoFile(".github/workflows/agent-memory-scan.yml");
  const memorySyncWorkflow = readRepoFile(".github/workflows/agent-memory-sync.yml");
  const gateAction = readRepoFile(".github/actions/scheduled-activity-gate/action.yml");

  assert.match(gateAction, /\.agent\/scripts\/resolve-scheduled-activity-gate\.sh/);
  assert.doesNotMatch(gateAction, /resolve-gate\.js/);
  assert.doesNotMatch(gateAction, /\.agent\/dist\/cli\/resolve-scheduled-activity-gate\.js/);

  assert.match(memoryScanWorkflow, /gate:\n[\s\S]*Resolve scheduled activity gate/);
  assert.match(memoryScanWorkflow, /scan:\n\s+needs: gate\n\s+if: needs\.gate\.outputs\.skip != 'true'/);
  assert.match(memoryScanWorkflow, /Resolve memory scan provider[\s\S]*Setup agent runtime/);
  assert.doesNotMatch(memoryScanWorkflow, /if: steps\.gate\.outputs\.skip != 'true'/);

  assert.match(memorySyncWorkflow, /gate:\n[\s\S]*Resolve scheduled activity gate/);
  assert.match(memorySyncWorkflow, /sync:\n\s+needs: gate\n\s+if: needs\.gate\.outputs\.skip != 'true'/);
  assert.doesNotMatch(memorySyncWorkflow, /if: steps\.gate\.outputs\.skip != 'true'/);

  assert.match(dailySummaryWorkflow, /pre_gate:\n[\s\S]*Resolve scheduled disabled gate/);
  assert.match(dailySummaryWorkflow, /signals:\n\s+needs: pre_gate\n\s+if: needs\.pre_gate\.outputs\.skip != 'true'/);
  assert.match(
    dailySummaryWorkflow,
    /daily-summary:\n\s+needs: signals\n\s+if: needs\.signals\.result == 'success' && needs\.signals\.outputs\.skip != 'true'/,
  );
  assert.match(dailySummaryWorkflow, /daily-summary-signals-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(dailySummaryWorkflow, /Upload summary signals[\s\S]*actions\/upload-artifact@v4/);
  assert.match(dailySummaryWorkflow, /Download summary signals[\s\S]*actions\/download-artifact@v4/);
  assert.doesNotMatch(dailySummaryWorkflow, /COMMIT_COUNT/);
  assert.match(dailySummaryWorkflow, /count=\$\(\(ISSUE_COUNT \+ PULL_COUNT \+ DISCUSSION_COUNT\)\)/);
  assert.match(
    dailySummaryWorkflow,
    /signals:[\s\S]*Resolve GitHub auth[\s\S]*Resolve summary discussion gate[\s\S]*discussion-post-gate[\s\S]*Setup agent runtime for activity signals/,
  );
  assert.match(dailySummaryWorkflow, /Setup agent runtime for activity signals\n\s+if: steps\.discussion_gate\.outputs\.skip != 'true'/);
  assert.match(dailySummaryWorkflow, /Gather repository signals\n\s+if: steps\.discussion_gate\.outputs\.skip != 'true'/);
  assert.match(dailySummaryWorkflow, /Upload summary signals\n\s+if: steps\.discussion_gate\.outputs\.skip != 'true' && steps\.gate\.outputs\.skip != 'true'/);
  assert.match(dailySummaryWorkflow, /skip: \$\{\{ steps\.discussion_gate\.outputs\.skip == 'true' && 'true' \|\| steps\.gate\.outputs\.skip \}\}/);
  assert.doesNotMatch(dailySummaryWorkflow, /daily-summary:[\s\S]*Resolve summary discussion gate/);
  assert.match(dailySummaryWorkflow, /Resolve daily summary provider[\s\S]*Setup selected provider/);
  assert.match(dailySummaryWorkflow, /discussion_category:[\s\S]*default:\s*""/);
  assert.match(
    dailySummaryWorkflow,
    /DISCUSSION_CATEGORY:\s*\$\{\{\s*inputs\.discussion_category \|\| vars\.AGENT_PROJECT_MANAGEMENT_DISCUSSION_CATEGORY \|\| 'General'\s*\}\}/,
  );
  assert.doesNotMatch(dailySummaryWorkflow, /if: steps\.pre_gate\.outputs\.skip != 'true' && steps\.gate\.outputs\.skip != 'true'/);
});

test("review workflow forwards requested_by to review, rubrics, and synthesis runs", () => {
  const reviewWorkflow = readRepoFile(".github/workflows/agent-review.yml");
  const forwardedValue = /requested_by:\s*\$\{\{\s*inputs\.requested_by \|\| github\.actor\s*\}\}/g;
  const matches = reviewWorkflow.match(forwardedValue) || [];

  assert.equal(matches.length, 3);
});

test("review synthesis uses a shared reviews directory contract", () => {
  const reviewWorkflow = readRepoFile(".github/workflows/agent-review.yml");
  const synthesisPrompt = readRepoFile(".github/prompts/review-synthesize.md");
  const runSource = readRepoFile(".agent/src/run.ts");

  assert.match(reviewWorkflow, /review:\n\s+# Reviewer lanes are best-effort[\s\S]*?continue-on-error:\s*true/);
  assert.match(reviewWorkflow, /synthesize:\n\s*needs:\s*\[review\]\n\s*if:\s*\$\{\{\s*!cancelled\(\)\s*\}\}/);
  assert.match(reviewWorkflow, /find "\$reviews_dir" -type f -name review\.md/);
  assert.match(reviewWorkflow, /REVIEWS_DIR:\s*\$\{\{\s*steps\.reviews\.outputs\.reviews_dir\s*\}\}/);
  assert.match(synthesisPrompt, /\$\{REVIEWS_DIR\}/);
  assert.match(runSource, /"REVIEWS_DIR"/);
  assert.match(runSource, /"MEMORY_DIR"/);
  assert.doesNotMatch(runSource, /PROMPT_VAR_MEMORY_/);
});

test("agent router bypasses dispatch triage for explicit mention slash routes", () => {
  const runnerWorkflow = readRepoFile(".github/workflows/agent-router.yml");
  const extractContext = readRepoFile(".agent/src/cli/extract-context.ts");
  const resolveDispatch = readRepoFile(".agent/src/cli/resolve-dispatch.ts");

  assert.match(extractContext, /setOutput\("requested_route", requestedRoute\)/);
  assert.match(
    runnerWorkflow,
    /steps\.context\.outputs\.should_respond == 'true'[\s\S]*steps\.context\.outputs\.requested_route == ''/,
  );
  assert.match(runnerWorkflow, /REQUESTED_ROUTE:\s*\$\{\{\s*steps\.context\.outputs\.requested_route\s*\}\}/);
  assert.match(resolveDispatch, /buildRequestedRouteDecision/);
});

test("agent router supports label-triggered route and skill overrides", () => {
  const runnerWorkflow = readRepoFile(".github/workflows/agent-router.yml");
  const extractContext = readRepoFile(".agent/src/cli/extract-context.ts");
  const labelWorkflow = readRepoFile(".github/workflows/agent-label.yml");
  const entrypointWorkflow = readRepoFile(".github/workflows/agent-entrypoint.yml");
  const approveWorkflow = readRepoFile(".github/workflows/agent-approve.yml");

  assert.match(runnerWorkflow, /trigger_kind:/);
  assert.match(runnerWorkflow, /label_name:/);
  assert.match(runnerWorkflow, /requested_skill:/);
  assert.match(runnerWorkflow, /needs\.portal\.outputs\.route == 'skill'/);
  assert.match(runnerWorkflow, /workflow_call:[\s\S]*outputs:[\s\S]*should_respond:/);
  assert.doesNotMatch(runnerWorkflow, /clear-trigger-label:/);
  assert.match(runnerWorkflow, /vars\.AGENT_RUNS_ON/);
  assert.match(extractContext, /resolveRequestedLabel/);
  assert.match(labelWorkflow, /issues:\s+types: \[labeled\]/);
  assert.match(labelWorkflow, /pull_request_target:\s+types: \[labeled\]/);
  assert.match(labelWorkflow, /cleanup-label:/);
  assert.match(labelWorkflow, /needs\.agent\.result == 'success'/);
  assert.match(labelWorkflow, /needs\.agent\.outputs\.should_respond == 'true'/);
  assert.doesNotMatch(labelWorkflow, /author_association:\s*COLLABORATOR/);
  assert.match(labelWorkflow, /\.\/\.github\/actions\/resolve-github-auth/);
  assert.match(labelWorkflow, /fallback_token:\s*\$\{\{\s*github\.token\s*\}\}/);
  assert.match(labelWorkflow, /actions\/github-script@v7/);
  assert.match(labelWorkflow, /github-token:\s*\$\{\{\s*steps\.auth\.outputs\.token\s*\}\}/);
  assert.match(labelWorkflow, /github\.rest\.issues\.removeLabel/);
  assert.match(labelWorkflow, /vars\.AGENT_RUNS_ON/);
  assert.match(entrypointWorkflow, /vars\.AGENT_RUNS_ON/);
  assert.match(approveWorkflow, /vars\.AGENT_RUNS_ON/);
});

test("agent status label is opt-in and fixed to the AGENT_STATUS_LABEL_ENABLED variable", () => {
  const runnerWorkflow = readRepoFile(".github/workflows/agent-router.yml");
  const implementWorkflow = readRepoFile(".github/workflows/agent-implement.yml");
  const fixPrWorkflow = readRepoFile(".github/workflows/agent-fix-pr.yml");
  const createPrCli = readRepoFile(".agent/src/cli/create-pr.ts");
  const addLabelCli = readRepoFile(".agent/src/cli/add-label.ts");
  const configurationList = readRepoFile(".agent/docs/customization/configuration-list.md");
  const supportedWorkflows = readRepoFile(".agent/docs/architecture/supported-workflows.md");

  assert.match(configurationList, /AGENT_STATUS_LABEL_ENABLED/);
  assert.match(supportedWorkflows, /fixed `agent` status label/);

  assert.match(addLabelCli, /const STATUS_LABEL = "agent"/);
  assert.match(addLabelCli, /AGENT_STATUS_LABEL_ENABLED/);
  assert.doesNotMatch(addLabelCli, /AGENT_STATUS_LABEL_NAME/);
  assert.doesNotMatch(addLabelCli, /AGENT_STATUS_LABEL_COLOR/);
  assert.doesNotMatch(addLabelCli, /AGENT_STATUS_LABEL_DESCRIPTION/);

  assert.match(
    runnerWorkflow,
    /- name: Resolve route[\s\S]*- name: Label handled issue or PR[\s\S]*- name: React with thumbs up/,
  );
  assert.match(runnerWorkflow, /vars\.AGENT_STATUS_LABEL_ENABLED == 'true'/);
  assert.match(runnerWorkflow, /steps\.dispatch\.outputs\.route != 'unsupported'/);
  assert.match(
    runnerWorkflow,
    /\(steps\.context\.outputs\.target_kind == 'issue' \|\| steps\.context\.outputs\.target_kind == 'pull_request'\)/,
  );
  assert.doesNotMatch(runnerWorkflow, /status_label_name:/);
  assert.doesNotMatch(runnerWorkflow, /AGENT_STATUS_LABEL_NAME/);
  assert.doesNotMatch(runnerWorkflow, /AGENT_STATUS_LABEL_COLOR/);
  assert.doesNotMatch(runnerWorkflow, /AGENT_STATUS_LABEL_DESCRIPTION/);

  assert.match(implementWorkflow, /- name: Label source issue[\s\S]*TARGET_KIND: issue/);
  assert.match(
    implementWorkflow,
    /- name: Label generated pull request[\s\S]*TARGET_KIND: pull_request[\s\S]*TARGET_NUMBER: \$\{\{ steps\.pr\.outputs\.pr_number \}\}/,
  );
  assert.match(
    fixPrWorkflow,
    /- name: Label target pull request[\s\S]*vars\.AGENT_STATUS_LABEL_ENABLED == 'true'[\s\S]*steps\.pr\.outputs\.cross_repo != 'true'[\s\S]*steps\.pr\.outputs\.pr_state == 'OPEN'[\s\S]*TARGET_KIND: pull_request/,
  );
  assert.match(createPrCli, /setOutput\("pr_number"/);
});

test("accepted issue and PR work is best-effort assigned from AGENT_HANDLE", () => {
  const labelWorkflow = readRepoFile(".github/workflows/agent-label.yml");
  const routerWorkflow = readRepoFile(".github/workflows/agent-router.yml");
  const implementWorkflow = readRepoFile(".github/workflows/agent-implement.yml");
  const fixPrWorkflow = readRepoFile(".github/workflows/agent-fix-pr.yml");
  const reviewWorkflow = readRepoFile(".github/workflows/agent-review.yml");
  const orchestratorWorkflow = readRepoFile(".github/workflows/agent-orchestrator.yml");
  const onboardingWorkflow = readRepoFile(".github/workflows/agent-onboarding.yml");
  const assignCli = readRepoFile(".agent/src/cli/assign-agent.ts");
  const assigneeModule = readRepoFile(".agent/src/agent-assignee.ts");
  const configurationList = readRepoFile(".agent/docs/customization/configuration-list.md");
  const supportedWorkflows = readRepoFile(".agent/docs/architecture/supported-workflows.md");

  assert.match(assignCli, /Non-fatal: exits 0 even if the handle is not assignable/);
  assert.match(assignCli, /AGENT_ASSIGNMENT_ENABLED/);
  assert.match(assigneeModule, /DEFAULT_AGENT_HANDLE = "@sepo-agent"/);
  assert.match(assigneeModule, /deriveAssigneeLogin/);
  assert.match(assigneeModule, /isRepoAssigneeAssignable/);
  assert.match(
    assigneeModule,
    /resolveAgentAssignee\(input:\s*\{\s*agentHandle\?: string;\s*repo: string;\s*\}\): AgentAssigneeResolution/,
  );
  assert.doesNotMatch(assigneeModule, /AGENT_ASSIGNEE/);

  assert.match(
    routerWorkflow,
    /Assign handled issue or PR[\s\S]*steps\.dispatch\.outputs\.needs_approval != 'true'[\s\S]*steps\.dispatch\.outputs\.route != 'unsupported'[\s\S]*AGENT_HANDLE:\s*\$\{\{ inputs\.agent_handle \|\| '@sepo-agent' \}\}[\s\S]*AGENT_ASSIGNMENT_ENABLED:\s*\$\{\{ vars\.AGENT_ASSIGNMENT_ENABLED \|\| 'true' \}\}[\s\S]*node \.agent\/dist\/cli\/assign-agent\.js/,
  );
  assert.match(
    labelWorkflow,
    /uses:\s*\.\/\.github\/workflows\/agent-router\.yml[\s\S]*agent_handle:\s*\$\{\{ vars\.AGENT_HANDLE \|\| '@sepo-agent' \}\}[\s\S]*trigger_kind:\s*label/,
  );
  assert.match(
    implementWorkflow,
    /Assign source issue[\s\S]*AGENT_HANDLE:\s*\$\{\{ vars\.AGENT_HANDLE \|\| '@sepo-agent' \}\}[\s\S]*AGENT_ASSIGNMENT_ENABLED:\s*\$\{\{ vars\.AGENT_ASSIGNMENT_ENABLED \|\| 'true' \}\}[\s\S]*TARGET_KIND: issue[\s\S]*node \.agent\/dist\/cli\/assign-agent\.js/,
  );
  assert.match(
    implementWorkflow,
    /Assign generated pull request[\s\S]*TARGET_KIND: pull_request[\s\S]*TARGET_NUMBER:\s*\$\{\{ steps\.pr\.outputs\.pr_number \}\}/,
  );
  assert.match(
    fixPrWorkflow,
    /Assign target pull request[\s\S]*steps\.pr\.outputs\.cross_repo != 'true'[\s\S]*AGENT_ASSIGNMENT_ENABLED:\s*\$\{\{ vars\.AGENT_ASSIGNMENT_ENABLED \|\| 'true' \}\}[\s\S]*TARGET_KIND: pull_request[\s\S]*node \.agent\/dist\/cli\/assign-agent\.js/,
  );
  assert.match(
    reviewWorkflow,
    /Assign target pull request[\s\S]*matrix\.agent == 'codex'[\s\S]*AGENT_ASSIGNMENT_ENABLED:\s*\$\{\{ vars\.AGENT_ASSIGNMENT_ENABLED \|\| 'true' \}\}[\s\S]*TARGET_KIND: pull_request[\s\S]*node \.agent\/dist\/cli\/assign-agent\.js/,
  );
  assert.match(
    orchestratorWorkflow,
    /Assign orchestrator target[\s\S]*AGENT_ASSIGNMENT_ENABLED:\s*\$\{\{ vars\.AGENT_ASSIGNMENT_ENABLED \|\| 'true' \}\}[\s\S]*TARGET_KIND:\s*\$\{\{ inputs\.target_kind \|\| \(inputs\.source_action == 'implement' && 'issue' \|\| 'pull_request'\) \}\}[\s\S]*node \.agent\/dist\/cli\/assign-agent\.js/,
  );
  assert.match(onboardingWorkflow, /AGENT_HANDLE:\s*\$\{\{ vars\.AGENT_HANDLE \|\| '@sepo-agent' \}\}/);
  assert.match(configurationList, /`AGENT_ASSIGNMENT_ENABLED`/);
  assert.match(configurationList, /best-effort assigned to the login derived from this handle/);
  assert.match(supportedWorkflows, /labels and mentions remain the automation signal layer/);
});

test("long-running routes use non-trigger activity labels", () => {
  const routerWorkflow = readRepoFile(".github/workflows/agent-router.yml");
  const implementWorkflow = readRepoFile(".github/workflows/agent-implement.yml");
  const fixPrWorkflow = readRepoFile(".github/workflows/agent-fix-pr.yml");
  const reviewWorkflow = readRepoFile(".github/workflows/agent-review.yml");
  const orchestratorWorkflow = readRepoFile(".github/workflows/agent-orchestrator.yml");
  const activityLabels = readRepoFile(".agent/src/activity-labels.ts");
  const activityLabelCli = readRepoFile(".agent/src/cli/activity-label.ts");
  const supportedWorkflows = readRepoFile(".agent/docs/architecture/supported-workflows.md");

  for (const label of [
    "agent-running/implement",
    "agent-running/create-action",
    "agent-running/review",
    "agent-running/fix-pr",
    "agent-running/orchestrate",
  ]) {
    assert.match(activityLabels, new RegExp(label.replace("/", "\\/")));
  }
  assert.match(activityLabelCli, /ACTIVITY_LABEL_ACTION/);
  assert.doesNotMatch(activityLabels, /name:\s*"agent\/running/);

  assert.match(implementWorkflow, /Mark implementation activity[\s\S]*ROUTE:\s*\$\{\{ env\.IMPLEMENTATION_ROUTE \}\}/);
  assert.match(implementWorkflow, /Clear implementation activity label[\s\S]*ACTIVITY_LABEL_ACTION: remove/);
  assert.match(implementWorkflow, /Orchestrate automation handoff\s*\n\s+id: orchestrator_dispatch/);
  assert.match(
    implementWorkflow,
    /Clear orchestration root activity label after dispatch failure[\s\S]*steps\.orchestrator_dispatch\.outcome != 'success'/,
  );
  assert.match(
    implementWorkflow,
    /Clear orchestration root activity label after dispatch failure[\s\S]*ROUTE: orchestrate[\s\S]*TARGET_KIND:\s*\$\{\{ inputs\.orchestration_root_kind \}\}[\s\S]*TARGET_NUMBER:\s*\$\{\{ inputs\.orchestration_root_number \}\}/,
  );
  assert.match(fixPrWorkflow, /Mark fix-pr activity[\s\S]*ROUTE: fix-pr/);
  assert.match(fixPrWorkflow, /Clear fix-pr activity label[\s\S]*ACTIVITY_LABEL_ACTION: remove/);
  assert.match(fixPrWorkflow, /Orchestrate automation handoff\s*\n\s+id: orchestrator_dispatch/);
  assert.match(
    fixPrWorkflow,
    /Clear orchestration root activity label after dispatch failure[\s\S]*steps\.orchestrator_dispatch\.outcome != 'success'/,
  );
  assert.match(
    fixPrWorkflow,
    /Clear orchestration root activity label after dispatch failure[\s\S]*ROUTE: orchestrate[\s\S]*TARGET_KIND:\s*\$\{\{ inputs\.orchestration_root_kind \}\}[\s\S]*TARGET_NUMBER:\s*\$\{\{ inputs\.orchestration_root_number \}\}/,
  );
  assert.match(reviewWorkflow, /Mark review activity[\s\S]*ROUTE: review/);
  assert.match(reviewWorkflow, /cleanup-activity-label:/);
  assert.match(reviewWorkflow, /Clear review activity label[\s\S]*ACTIVITY_LABEL_ACTION: remove/);
  assert.match(
    reviewWorkflow,
    /synthesize:\s*\n\s+needs: \[review\][\s\S]*?outputs:\s*\n\s+orchestration_handoff_outcome: \$\{\{ steps\.orchestrate_handoff\.outcome \|\| 'missing' \}\}/,
  );
  assert.match(reviewWorkflow, /Orchestrate automation handoff\s*\n\s+id: orchestrate_handoff/);
  assert.match(
    reviewWorkflow,
    /Clear orchestration root activity label after review failure[\s\S]*needs\.synthesize\.outputs\.orchestration_handoff_outcome != 'success'/,
  );
  assert.doesNotMatch(reviewWorkflow, /Clear orchestration root activity label after review failure[\s\S]*needs\.synthesize\.result != 'success'/);
  assert.match(
    reviewWorkflow,
    /Clear orchestration root activity label after review failure[\s\S]*ROUTE: orchestrate[\s\S]*TARGET_KIND:\s*\$\{\{ inputs\.orchestration_root_kind \}\}[\s\S]*TARGET_NUMBER:\s*\$\{\{ inputs\.orchestration_root_number \}\}/,
  );
  assert.match(orchestratorWorkflow, /Mark orchestrator activity[\s\S]*ROUTE: orchestrate/);
  assert.match(orchestratorWorkflow, /id: handoff/);
  assert.match(orchestratorWorkflow, /Clear orchestrator activity label[\s\S]*steps\.handoff\.outputs\.decision == 'stop'/);
  assert.doesNotMatch(orchestratorWorkflow, /steps\.handoff\.outputs\.decision == 'blocked'/);
  assert.match(orchestratorWorkflow, /steps\.handoff\.outcome == 'failure'/);
  assert.match(orchestratorWorkflow, /Clear orchestrator activity label[\s\S]*failure\(\) && steps\.handoff\.outcome != 'success'/);
  assert.match(routerWorkflow, /ORCHESTRATION_ROOT_KIND:\s*\$\{\{ needs\.portal\.outputs\.target_kind \}\}/);
  assert.match(implementWorkflow, /ORCHESTRATION_ROOT_KIND:\s*\$\{\{ inputs\.orchestration_root_kind \}\}/);
  assert.match(fixPrWorkflow, /ORCHESTRATION_ROOT_KIND:\s*\$\{\{ inputs\.orchestration_root_kind \}\}/);
  assert.match(reviewWorkflow, /ORCHESTRATION_ROOT_KIND:\s*\$\{\{ inputs\.orchestration_root_kind \}\}/);
  assert.match(supportedWorkflows, /`agent-running\/<route>`/);
  assert.match(supportedWorkflows, /not trigger `agent-label\.yml`/);
});

test("project management docs preserve the minimal Project planning model", () => {
  const docsIndex = readRepoFile(".agent/docs/README.md");
  const planningDoc = readRepoFile(".agent/docs/architecture/project-planning.md");
  const supportedWorkflows = readRepoFile(".agent/docs/architecture/supported-workflows.md");
  const configurationList = readRepoFile(".agent/docs/customization/configuration-list.md");
  const projectManagerPrompt = readRepoFile(".github/prompts/project-manager.md");
  const projectManagerWorkflow = readRepoFile(".github/workflows/agent-project-manager.yml");
  const projectManagerWorkflowYaml = parseYaml(projectManagerWorkflow) as unknown;
  assert.ok(isRecord(projectManagerWorkflowYaml), "project manager workflow should parse as YAML");
  const triggers = projectManagerWorkflowYaml.on;
  assert.ok(isRecord(triggers), "project manager workflow should define triggers");
  const workflowDispatch = triggers.workflow_dispatch;
  assert.ok(isRecord(workflowDispatch), "project manager workflow should support manual dispatch");
  const workflowInputs = workflowDispatch.inputs;
  assert.ok(isRecord(workflowInputs), "project manager workflow should define inputs");
  assert.ok(workflowInputs.project_id);
  assert.ok(workflowInputs.project_url);
  assert.ok(workflowInputs.project_owner);
  assert.ok(workflowInputs.project_title);

  for (const source of [planningDoc, supportedWorkflows, projectManagerPrompt]) {
    assert.match(source, /`Status`[\s\S]*`Inbox`[\s\S]*`In Progress`[\s\S]*`To Review`[\s\S]*`Done`/);
    assert.match(source, /`Priority`[\s\S]*`P0`[\s\S]*`P1`[\s\S]*`P2`[\s\S]*`P3`/);
    assert.match(source, /`Effort`[\s\S]*`Low`[\s\S]*`Medium`[\s\S]*`High`/);
    assert.match(source, /[Oo]ptional `Release`|`Release` \| No/);
  }

  assert.match(docsIndex, /Project planning model/);
  assert.match(planningDoc, /`agent\/\*`[\s\S]*one-shot trigger labels/);
  assert.match(planningDoc, /`agent-running\/\*`[\s\S]*temporary activity labels/);
  assert.match(planningDoc, /`priority\/\*` and `effort\/\*` labels are legacy\/fallback signals/);
  assert.match(planningDoc, /does not create GitHub\s+Projects,[\s\S]*update Project fields/);
  assert.match(planningDoc, /AGENT_PROJECT_MANAGEMENT_PROJECT_ID/);
  assert.match(planningDoc, /AGENT_PROJECT_MANAGEMENT_PROJECT_URL/);
  assert.match(planningDoc, /AGENT_PROJECT_MANAGEMENT_PROJECT_OWNER/);
  assert.match(planningDoc, /AGENT_PROJECT_MANAGEMENT_PROJECT_TITLE/);
  assert.match(planningDoc, /summary\/dry-run behavior/);
  assert.match(planningDoc, /best-effort assigned to the login derived from\s+`AGENT_HANDLE`/);
  assert.match(supportedWorkflows, /legacy\/fallback managed-label change plan/);
  assert.match(supportedWorkflows, /Project-backed project management is experimental/);
  assert.match(supportedWorkflows, /AGENT_PROJECT_MANAGEMENT_PROJECT_ID/);
  assert.match(supportedWorkflows, /AGENT_PROJECT_MANAGEMENT_PROJECT_URL/);
  assert.match(supportedWorkflows, /AGENT_PROJECT_MANAGEMENT_PROJECT_OWNER/);
  assert.match(supportedWorkflows, /AGENT_PROJECT_MANAGEMENT_PROJECT_TITLE/);
  assert.match(supportedWorkflows, /planning context\s+only/);
  assert.match(configurationList, /Project field sync is not implemented yet/);
  assert.match(configurationList, /`AGENT_PROJECT_MANAGEMENT_PROJECT_ID`/);
  assert.match(configurationList, /`AGENT_PROJECT_MANAGEMENT_PROJECT_URL`/);
  assert.match(configurationList, /`AGENT_PROJECT_MANAGEMENT_PROJECT_OWNER`/);
  assert.match(configurationList, /`AGENT_PROJECT_MANAGEMENT_PROJECT_TITLE`/);
  assert.match(configurationList, /legacy\/fallback `priority\/\*` and `effort\/\*` labels/);
  assert.match(projectManagerPrompt, /## Legacy\/Fallback Managed Labels/);
  assert.match(projectManagerPrompt, /Default repository labels stay operational: `agent`, one-shot `agent\/\*` trigger/);
  assert.match(projectManagerPrompt, /This prompt does not create or update GitHub Projects/);
  assert.match(projectManagerPrompt, /Project target: `not configured` or the configured Project ID\/URL\/owner\/title/);
  assert.match(projectManagerWorkflow, /RAW_PROJECT_ID:\s*\$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.project_id \|\| vars\.AGENT_PROJECT_MANAGEMENT_PROJECT_ID \|\| '' \}\}/);
  assert.match(projectManagerWorkflow, /RAW_PROJECT_URL:\s*\$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.project_url \|\| vars\.AGENT_PROJECT_MANAGEMENT_PROJECT_URL \|\| '' \}\}/);
  assert.match(projectManagerWorkflow, /RAW_PROJECT_OWNER:\s*\$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.project_owner \|\| vars\.AGENT_PROJECT_MANAGEMENT_PROJECT_OWNER \|\| '' \}\}/);
  assert.match(projectManagerWorkflow, /RAW_PROJECT_TITLE:\s*\$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.project_title \|\| vars\.AGENT_PROJECT_MANAGEMENT_PROJECT_TITLE \|\| '' \}\}/);
  assert.match(projectManagerWorkflow, /project_configured=false/);
  assert.match(projectManagerWorkflow, /AGENT_PROJECT_MANAGEMENT_PROJECT_URL must be a GitHub Project URL/);
  assert.match(projectManagerWorkflow, /AGENT_PROJECT_MANAGEMENT_PROJECT_OWNER must be a GitHub user or organization login/);
  assert.match(projectManagerWorkflow, /AGENT_PROJECT_MANAGEMENT_PROJECT_TITLE must be 100 characters or fewer/);
  assert.match(projectManagerWorkflow, /GitHub Project target:\s*\$\{\{ steps\.project_config\.outputs\.project_target \}\}/);
  assert.match(projectManagerWorkflow, /GitHub Project field sync: not implemented/);
  assert.match(projectManagerWorkflow, /Project-backed source of truth when configured: GitHub Project fields Status\/Priority\/Effort\/Release/);
});

test("agent router posts unsupported route summaries directly instead of running the answer agent", () => {
  const runnerWorkflow = readRepoFile(".github/workflows/agent-router.yml");

  assert.match(runnerWorkflow, /Prepare unsupported response/);
  assert.match(runnerWorkflow, /needs\.portal\.outputs\.route == 'unsupported'/);
  assert.match(
    runnerWorkflow,
    /- name: Setup agent runtime[\s\S]*needs\.portal\.outputs\.route == 'answer' \|\|[\s\S]*needs\.portal\.outputs\.route == 'unsupported'/,
  );
  assert.match(
    runnerWorkflow,
    /install_codex:\s*\$\{\{\s*needs\.portal\.outputs\.route == 'answer' && steps\.provider\.outputs\.install_codex \|\| 'false'\s*\}\}/,
  );
  assert.match(
    runnerWorkflow,
    /install_claude:\s*\$\{\{\s*needs\.portal\.outputs\.route == 'answer' && steps\.provider\.outputs\.install_claude \|\| 'false'\s*\}\}/,
  );
  assert.match(runnerWorkflow, /SUMMARY:\s*\$\{\{\s*needs\.portal\.outputs\.summary\s*\}\}/);
  assert.match(runnerWorkflow, /Post unsupported response/);
  assert.match(
    runnerWorkflow,
    /- name: Run answer agent[\s\S]*if:\s*needs\.portal\.outputs\.route == 'answer'/,
  );
});

test("agent router dispatches agent-implement directly for explicit implement requests", () => {
  const runnerWorkflow = readRepoFile(".github/workflows/agent-router.yml");
  const approveWorkflow = readRepoFile(".github/workflows/agent-approve.yml");

  const implementJobMatch = runnerWorkflow.match(
    /\n  implement:\n[\s\S]*?(?=\n  [a-z][a-z0-9-]*:\n)/,
  );
  assert.ok(implementJobMatch, "implement job should exist in agent-router.yml");
  const implementJob = implementJobMatch[0];

  // Mutual exclusion with the approval job: runs only when the dispatch
  // decision said an implementation-like route and no approval gate is needed.
  assert.match(implementJob, /needs\.portal\.outputs\.route == 'implement'/);
  assert.match(implementJob, /needs\.portal\.outputs\.route == 'create-action'/);
  assert.match(implementJob, /needs\.portal\.outputs\.needs_approval == 'false'/);

  // Runtime must be bootstrapped before any node .agent/dist/* calls.
  assert.match(implementJob, /uses:\s*\.\/\.github\/actions\/setup-agent-runtime/);

  // Tracking-issue creation + dispatch delegate to CLI helpers in the
  // TS backend rather than inline shell.
  assert.match(
    implementJob,
    /- name: Create implementation issue[\s\S]*if:\s*needs\.portal\.outputs\.target_kind != 'issue'[\s\S]*node \.agent\/dist\/cli\/create-issue\.js/,
  );
  assert.match(
    implementJob,
    /- name: Dispatch agent-implement[\s\S]*APPROVAL_COMMENT_URL: ""[\s\S]*node \.agent\/dist\/cli\/dispatch-agent-implement\.js/,
  );
  assert.match(
    implementJob,
    /SESSION_FORK_FROM_THREAD_KEY:\s*\$\{\{ github\.repository \}\}:\$\{\{ needs\.portal\.outputs\.target_kind \}\}:\$\{\{ needs\.portal\.outputs\.target_number \}\}:answer:default/,
  );

  // Link-back comment on the originating PR/discussion points at the
  // tracking issue that was just created.
  assert.match(
    implementJob,
    /- name: Post link-back to original surface[\s\S]*if:\s*needs\.portal\.outputs\.target_kind != 'issue'[\s\S]*node \.agent\/dist\/cli\/post-response\.js/,
  );

  // agent-approve.yml uses the same CLIs — no duplicate inline shell.
  assert.match(approveWorkflow, /node \.agent\/dist\/cli\/create-issue\.js/);
  assert.match(approveWorkflow, /node \.agent\/dist\/cli\/dispatch-agent-implement\.js/);
  assert.doesNotMatch(approveWorkflow, /actions\/workflows\/\$\{WORKFLOW\}\/dispatches/);
});

test("session bundle persistence is configurable through workflow inputs and AGENT_SESSION_BUNDLE_MODE", () => {
  const routerWorkflow = readRepoFile(".github/workflows/agent-router.yml");
  const implementWorkflow = readRepoFile(".github/workflows/agent-implement.yml");
  const fixPrWorkflow = readRepoFile(".github/workflows/agent-fix-pr.yml");
  const reviewWorkflow = readRepoFile(".github/workflows/agent-review.yml");

  assert.match(routerWorkflow, /session_bundle_mode:/);
  assert.match(routerWorkflow, /AGENT_SESSION_BUNDLE_MODE/);
  assert.match(
    routerWorkflow,
    /session_bundle_mode:\s*\$\{\{ inputs\.session_bundle_mode \|\| vars\.AGENT_SESSION_BUNDLE_MODE \|\| 'auto' \}\}/,
  );
  assert.match(implementWorkflow, /session_bundle_mode:[\s\S]*default:\s*""/);
  assert.match(implementWorkflow, /session_fork_from_thread_key:[\s\S]*default:\s*""/);
  assert.match(implementWorkflow, /vars\.AGENT_SESSION_BUNDLE_MODE/);
  assert.match(fixPrWorkflow, /session_bundle_mode:[\s\S]*default:\s*""/);
  assert.match(fixPrWorkflow, /vars\.AGENT_SESSION_BUNDLE_MODE/);
  assert.match(reviewWorkflow, /session_bundle_mode:[\s\S]*default:\s*""/);
  assert.match(reviewWorkflow, /vars\.AGENT_SESSION_BUNDLE_MODE/);
});

test("workflows use granular CLI helpers for post-processing", () => {
  const implementWorkflow = readRepoFile(".github/workflows/agent-implement.yml");
  const fixPrWorkflow = readRepoFile(".github/workflows/agent-fix-pr.yml");
  const reviewWorkflow = readRepoFile(".github/workflows/agent-review.yml");

  assert.match(implementWorkflow, /node \.agent\/dist\/cli\/add-label\.js/);
  assert.match(implementWorkflow, /node \.agent\/dist\/cli\/verify\.js/);
  assert.match(implementWorkflow, /node \.agent\/dist\/cli\/parse-response\.js/);
  assert.match(implementWorkflow, /steps\.response\.outputs\.commit_message/);
  assert.match(implementWorkflow, /node \.agent\/dist\/cli\/commit\.js/);
  assert.match(implementWorkflow, /node \.agent\/dist\/cli\/create-pr\.js/);
  assert.match(implementWorkflow, /node \.agent\/dist\/cli\/post-comment\.js/);
  assert.match(implementWorkflow, /base_branch:/);
  assert.match(implementWorkflow, /base_pr:/);
  assert.match(implementWorkflow, /node \.agent\/dist\/cli\/resolve-implementation-base\.js/);
  assert.match(implementWorkflow, /GH_TOKEN:\s*\$\{\{ steps\.auth\.outputs\.token \}\}/);
  assert.match(implementWorkflow, /http\.\$\{GITHUB_SERVER_URL\}\/\.extraheader=AUTHORIZATION: basic \$\{AUTH_HEADER\}/);
  assert.match(implementWorkflow, /fetch origin "refs\/heads\/\$\{BASE_BRANCH\}"/);
  assert.match(implementWorkflow, /BASE_BRANCH:\s*\$\{\{ env\.BASE_BRANCH \}\}/);

  assert.match(fixPrWorkflow, /node \.agent\/dist\/cli\/verify\.js/);
  assert.match(fixPrWorkflow, /node \.agent\/dist\/cli\/detect-head-change\.js/);
  assert.ok(
    fixPrWorkflow.indexOf("node .agent/dist/cli/detect-head-change.js")
      < fixPrWorkflow.indexOf("node .agent/dist/cli/verify.js"),
  );
  assert.match(fixPrWorkflow, /HEAD_CHANGED:\s*\$\{\{ steps\.head\.outputs\.head_changed \}\}/);
  assert.match(fixPrWorkflow, /VERIFY_BASE_SHA:\s*\$\{\{ steps\.pr\.outputs\.head_sha \}\}/);
  assert.match(fixPrWorkflow, /steps\.commit\.outcome == 'failure'/);
  assert.match(fixPrWorkflow, /steps\.push-head\.outcome == 'failure'/);
  assert.match(fixPrWorkflow, /steps\.response\.outputs\.commit_message/);
  assert.match(fixPrWorkflow, /node \.agent\/dist\/cli\/commit\.js/);
  assert.match(fixPrWorkflow, /node \.agent\/dist\/cli\/push-pr-head\.js/);
  assert.match(fixPrWorkflow, /node \.agent\/dist\/cli\/add-label\.js/);
  assert.match(fixPrWorkflow, /node \.agent\/dist\/cli\/post-comment\.js/);
  assert.match(
    fixPrWorkflow,
    /REQUESTED_BY:\s*\$\{\{\s*inputs\.orchestration_enabled == 'true' && \(vars\.AGENT_HANDLE \|\| '@sepo-agent'\) \|\| inputs\.requested_by \|\| github\.actor\s*\}\}/,
  );

  assert.match(reviewWorkflow, /node \.agent\/dist\/cli\/post-comment\.js/);
  assert.match(reviewWorkflow, /AGENT_COLLAPSE_OLD_REVIEWS:\s*\$\{\{ vars\.AGENT_COLLAPSE_OLD_REVIEWS \}\}/);
});

test("shared run-agent-task action exists and requires explicit prompt/skill/lane/session_policy inputs", () => {
  const action = readRepoFile(".github/actions/run-agent-task/action.yml");

  assert.match(action, /name: Run Agent Task/);
  assert.match(action, /prompt:/);
  assert.match(action, /skill:/);
  assert.match(action, /lane:/);
  assert.match(action, /session_policy:/);
  const sessionPolicyBlock = action.match(/session_policy:[\s\S]*?(?=^  [a-z_]+:|^outputs:)/m)?.[0] || "";
  assert.match(sessionPolicyBlock, /required:\s*true/);
  assert.doesNotMatch(sessionPolicyBlock, /default:/);
  assert.match(action, /PROMPT_NAME/);
  assert.match(action, /SKILL_NAME/);
  assert.match(action, /LANE/);
  assert.match(action, /SESSION_POLICY/);
  assert.match(action, /\.agent\/dist\/run\.js/);
});

test("shared setup-agent-runtime action exists and is referenced by reusable workflows", () => {
  const action = readRepoFile(".github/actions/setup-agent-runtime/action.yml");
  const runnerWorkflow = readRepoFile(".github/workflows/agent-router.yml");

  assert.match(action, /name: Setup Agent Runtime/);
  assert.match(action, /actions\/setup-node/);
  assert.match(action, /npm ci/);
  assert.match(action, /npm run build/);
  assert.match(runnerWorkflow, /\.\/\.github\/actions\/setup-agent-runtime/);
});

test("shared auth action supports the built-in hosted OIDC broker mode", () => {
  const action = readRepoFile(".github/actions/resolve-github-auth/action.yml");
  const oidcScript = readRepoFile(".github/actions/resolve-github-auth/exchange-oidc.sh");
  const runnerWorkflow = readRepoFile(".github/workflows/agent-router.yml");
  const approveWorkflow = readRepoFile(".github/workflows/agent-approve.yml");
  const implementWorkflow = readRepoFile(".github/workflows/agent-implement.yml");
  const fixPrWorkflow = readRepoFile(".github/workflows/agent-fix-pr.yml");
  const reviewWorkflow = readRepoFile(".github/workflows/agent-review.yml");
  const entrypointWorkflow = readRepoFile(".github/workflows/agent-entrypoint.yml");
  const labelWorkflow = readRepoFile(".github/workflows/agent-label.yml");
  const memoryBootstrapWorkflow = readRepoFile(".github/workflows/agent-memory-bootstrap.yml");

  assert.doesNotMatch(action, /oidc_exchange_url:/);
  assert.doesNotMatch(action, /oidc_audience:/);
  assert.match(action, /Validate direct GitHub App inputs/);
  assert.match(action, /app_id and app_private_key must be configured together/);
  assert.match(action, /bash "\$\{GITHUB_ACTION_PATH\}\/exchange-oidc\.sh"/);
  assert.match(action, /https:\/\/oidc\.self-evolving\.app/);
  assert.match(action, /OIDC_AUDIENCE:\s*sepo/);

  assert.match(oidcScript, /ACTIONS_ID_TOKEN_REQUEST_URL/);
  assert.match(oidcScript, /ACTIONS_ID_TOKEN_REQUEST_TOKEN/);
  assert.match(oidcScript, /oidc_request_url=\"\$\{ACTIONS_ID_TOKEN_REQUEST_URL\}&audience=\$\{OIDC_AUDIENCE\}\"/);
  assert.match(oidcScript, /for cmd in curl jq/);
  assert.match(oidcScript, /run_with_retries\(\)/);
  assert.match(oidcScript, /jq -r '\.value \/\/ empty' 2>\/dev\/null \|\| true/);
  assert.match(oidcScript, /jq -r '\.token \/\/ \.app_token \/\/ empty' .*2>\/dev\/null \|\| true/);
  assert.match(oidcScript, /--max-time 30/);
  assert.match(oidcScript, /auth_mode=oidc_broker/);

  for (const workflow of [
    runnerWorkflow,
    approveWorkflow,
    implementWorkflow,
    fixPrWorkflow,
    reviewWorkflow,
    entrypointWorkflow,
    labelWorkflow,
    memoryBootstrapWorkflow,
  ]) {
    assert.match(workflow, /id-token:\s*write/);
    assert.doesNotMatch(workflow, /AGENT_OIDC_EXCHANGE_URL/);
    assert.doesNotMatch(workflow, /AGENT_OIDC_AUDIENCE/);
  }
});

test("shared run-agent-task action wires session bundle restore and upload around the agent run", () => {
  const action = readRepoFile(".github/actions/run-agent-task/action.yml");

  assert.match(action, /session_bundle_mode:/);
  assert.match(action, /session_bundle_retention_days:/);
  assert.match(action, /session_fork_from_thread_key:/);
  assert.match(action, /Restore session bundle/);
  assert.match(action, /Restore session bundle[\s\S]*continue-on-error:\s*true/);
  assert.match(action, /node \.agent\/dist\/cli\/session-restore\.js/);
  assert.match(action, /Prepare session bundle/);
  assert.match(action, /node \.agent\/dist\/cli\/session-backup\.js/);
  assert.match(action, /Prepare session bundle[\s\S]*steps\.run\.outputs\.exit_code == '0'/);
  assert.match(action, /Upload session bundle artifact[\s\S]*steps\.run\.outputs\.exit_code == '0'/);
  assert.match(action, /actions\/upload-artifact@v4/);
  assert.match(action, /Register session bundle artifact[\s\S]*steps\.run\.outputs\.exit_code == '0'/);
  assert.match(action, /node \.agent\/dist\/cli\/session-register\.js/);
  assert.match(action, /resume_status:/);
  assert.match(action, /session_bundle_restore_status:/);
  assert.match(action, /session_fork_restore_status:/);
  assert.match(action, /SESSION_FORK_FROM_THREAD_KEY:\s*\$\{\{\s*inputs\.session_fork_from_thread_key\s*\}\}/);
  assert.match(action, /SESSION_FORK_ACPX_SESSION_ID:\s*\$\{\{\s*steps\.restore\.outputs\.fork_acpx_session_id\s*\}\}/);
});

test("workflows declare explicit session policies", () => {
  const runnerWorkflow = readRepoFile(".github/workflows/agent-router.yml");
  const fixPrWorkflow = readRepoFile(".github/workflows/agent-fix-pr.yml");
  const implementWorkflow = readRepoFile(".github/workflows/agent-implement.yml");
  const reviewWorkflow = readRepoFile(".github/workflows/agent-review.yml");

  assert.match(runnerWorkflow, /prompt:\s*dispatch[\s\S]*session_policy:\s*none/);
  assert.match(runnerWorkflow, /prompt:\s*answer[\s\S]*session_policy:\s*resume-best-effort/);
  assert.match(fixPrWorkflow, /prompt:\s*fix-pr[\s\S]*session_policy:\s*resume-best-effort/);
  assert.match(implementWorkflow, /prompt:\s*\$\{\{ env\.IMPLEMENTATION_PROMPT \}\}[\s\S]*session_fork_from_thread_key:\s*\$\{\{ inputs\.session_fork_from_thread_key \}\}/);
  assert.match(implementWorkflow, /route:\s*\$\{\{ env\.IMPLEMENTATION_ROUTE \}\}[\s\S]*session_policy:\s*\$\{\{ inputs\.session_fork_from_thread_key != '' && 'resume-best-effort' \|\| 'track-only' \}\}/);
  assert.match(reviewWorkflow, /prompt:\s*review[\s\S]*session_policy:\s*track-only/);
  assert.match(reviewWorkflow, /agent-rubrics-review\.yml/);
  assert.match(reviewWorkflow, /prompt:\s*review-synthesize[\s\S]*session_policy:\s*track-only/);
});

test("review workflow declares distinct lanes for reviewer jobs and synthesis", () => {
  const reviewWorkflow = readRepoFile(".github/workflows/agent-review.yml");

  assert.match(reviewWorkflow, /lane:\s*claude-review/);
  assert.match(reviewWorkflow, /lane:\s*codex-review/);
  assert.match(reviewWorkflow, /lane:\s*synthesize/);
});

test("workflow docs record the minimal metadata contract and developer notes", () => {
  const keyConcepts = readRepoFile(".agent/docs/technical-details/key-concepts.md");
  const memoryArchitecture = readRepoFile(".agent/docs/architecture/memory.md");
  const rubricsArchitecture = readRepoFile(".agent/docs/architecture/rubrics.md");
  const rubricsInitializationWorkflow = readRepoFile(".github/workflows/agent-rubrics-initialization.yml");
  const rubricsInitializationPrompt = readRepoFile(".github/prompts/rubrics-initialization.md");
  const supportedWorkflows = readRepoFile(".agent/docs/architecture/supported-workflows.md");
  const requestLifecycle = readRepoFile(".agent/docs/architecture/request-lifecycle.md");
  const configurationList = readRepoFile(".agent/docs/customization/configuration-list.md");
  const existingRepoInstall = readRepoFile(".agent/docs/deployment/install-existing-repository.md");
  const developerNotes = readRepoFile(".agent/docs/technical-details/developer-notes.md");

  assert.match(keyConcepts, /### RuntimeEnvelope/);
  assert.match(keyConcepts, /Envelope version, currently `1`/);
  assert.match(keyConcepts, /`thread_key`/);
  assert.match(keyConcepts, /repo:target_kind:target_number:route:lane/);
  assert.match(keyConcepts, /`issue`, `pull_request`, `discussion`, or `repository`/);
  assert.match(keyConcepts, /target_number=0/);

  assert.match(supportedWorkflows, /agent-label\.yml/);
  assert.match(supportedWorkflows, /agent-branch-cleanup\.yml/);
  assert.match(supportedWorkflows, /### Core workflows/i);
  assert.match(supportedWorkflows, /### Repository memory workflows/i);
  assert.match(supportedWorkflows, /Agent \/ Memory \/ Initialization/);
  assert.match(supportedWorkflows, /Agent \/ Memory \/ Sync GitHub Artifacts/);
  assert.match(supportedWorkflows, /Agent \/ Memory \/ Record PR Closure/);
  assert.match(supportedWorkflows, /Agent \/ Memory \/ Curate Recent Activity/);
  assert.match(supportedWorkflows, /Agent \/ Memory \/ Initialization[\s\S]*\|\s*Auto\s*\|/);
  assert.match(supportedWorkflows, /Agent \/ Rubrics \/ Review/);
  assert.match(supportedWorkflows, /Agent \/ Rubrics \/ Initialization/);
  assert.match(supportedWorkflows, /Agent \/ Rubrics \/ Update/);
  assert.doesNotMatch(
    supportedWorkflows.match(/### Core workflows[\s\S]*?### Repository memory workflows/)?.[0] || "",
    /agent-rubrics-/,
  );
  assert.match(supportedWorkflows, /agent\/s\/<skill>/);
  assert.match(supportedWorkflows, /removes[\s\S]*triggering `agent\/\*` label/i);
  assert.match(supportedWorkflows, /strips code blocks[\s\S]*quoted text/i);
  assert.match(supportedWorkflows, /OWNER[\s\S]*MEMBER[\s\S]*COLLABORATOR[\s\S]*CONTRIBUTOR/);
  assert.match(memoryArchitecture, /Agent \/ Memory \/ Initialization[\s\S]*\|\s*Auto\s*\|/);
  assert.match(rubricsArchitecture, /agent\/rubrics/);
  assert.match(rubricsArchitecture, /AGENT_RUBRICS_POLICY/);
  assert.match(rubricsArchitecture, /agent\/memory` stores agent\/project continuity/i);
  assert.match(rubricsArchitecture, /Agent \/ Rubrics \/ Initialization/);
  assert.match(rubricsInitializationWorkflow, /^name: Agent \/ Rubrics \/ Initialization$/m);
  assert.match(rubricsInitializationWorkflow, /Reject existing rubrics branch/);
  assert.match(rubricsInitializationWorkflow, /prompt:\s*rubrics-initialization/);
  assert.match(rubricsInitializationWorkflow, /route:\s*rubrics-initialization/);
  assert.match(rubricsInitializationWorkflow, /rubrics_mode_override:\s*'enabled'/);
  assert.match(rubricsInitializationWorkflow, /initialization_context:/);
  assert.match(rubricsInitializationWorkflow, /rubrics_ref:[\s\S]*default: agent\/rubrics/);
  assert.match(rubricsInitializationWorkflow, /inputs\.rubrics_ref \|\| vars\.AGENT_RUBRICS_REF \|\| 'agent\/rubrics'/);
  assert.doesNotMatch(rubricsInitializationWorkflow, /description: "GitHub login that requested the run"/);
  assert.doesNotMatch(rubricsInitializationWorkflow, /^      session_bundle_mode:/m);
  assert.match(rubricsInitializationWorkflow, /requested_by:\s*\$\{\{\s*github\.repository_owner\s*\}\}/);
  assert.match(rubricsInitializationWorkflow, /session_bundle_mode:\s*\$\{\{\s*vars\.AGENT_SESSION_BUNDLE_MODE \|\| 'auto'\s*\}\}/);
  assert.match(rubricsInitializationPrompt, /Initialization context:/);
  assert.match(rubricsInitializationPrompt, /OWNER[\s\S]*MEMBER[\s\S]*COLLABORATOR/);
  assert.match(rubricsArchitecture, /Only rubric initialization bootstraps a missing branch/);
  assert.match(rubricsArchitecture, /Dispatch triage is always rubric-disabled/);
  assert.match(rubricsArchitecture, /honor `AGENT_RUBRICS_POLICY`/);
  assert.match(existingRepoInstall, /cannot silently skip persistence/);

  assert.match(requestLifecycle, /route access follows the configured trigger access policy/);
  assert.match(requestLifecycle, /agent\/<route>-<target_kind>-<number>\/<agent>-<run_id>/);

  assert.match(configurationList, /AGENT_RUNS_ON/);
  assert.match(configurationList, /AGENT_TASK_TIMEOUT_POLICY/);
  assert.match(configurationList, /Values must be 1-360 minutes/);
  assert.match(configurationList, /AGENT_MEMORY_POLICY/);
  assert.match(configurationList, /AGENT_MEMORY_REF/);
  assert.match(configurationList, /AGENT_RUBRICS_POLICY/);
  assert.match(configurationList, /AGENT_RUBRICS_REF/);
  assert.match(configurationList, /AGENT_RUBRICS_LIMIT/);
  assert.match(configurationList, /AGENT_SESSION_BUNDLE_MODE/);
  assert.match(configurationList, /AGENT_AUTOMATION_MODE/);
  assert.match(configurationList, /AGENT_AUTOMATION_MAX_ROUNDS/);
  assert.match(configurationList, /AGENT_STATUS_LABEL_ENABLED/);

  assert.match(existingRepoInstall, /open a normal PR in the target repository/i);
  assert.match(existingRepoInstall, /`\.github\/`/);
  assert.match(existingRepoInstall, /workflows, composite actions, and prompt templates/i);
  assert.match(existingRepoInstall, /Agent \/ Memory \/ Initialization/);
  assert.match(existingRepoInstall, /Alternative: local memory bootstrap/);
  assert.match(existingRepoInstall, /first-run initializer/i);
  assert.match(existingRepoInstall, /does not require[\s\S]*agent\/memory[\s\S]*to exist yet/i);
  assert.match(existingRepoInstall, /rejects the run if[\s\S]*already exists/i);
  assert.match(existingRepoInstall, /initial GitHub artifact sync/i);
  assert.match(existingRepoInstall, /recent-activity curation inline/i);
  assert.match(existingRepoInstall, /Agent \/ Rubrics \/ Initialization/);
  assert.match(existingRepoInstall, /supplied context/i);

  assert.match(developerNotes, /## Testing/);
  assert.match(developerNotes, /cd \.agent[\s\S]*npm test/);
  assert.match(developerNotes, /## Known limitations/);
  assert.match(developerNotes, /`skill_root`/);
  assert.match(developerNotes, /\/skill/);
  assert.match(developerNotes, /lazy blockquote/);
  assert.match(developerNotes, /lightweight post-agent check/);
});

test("create-action prompt uses native workflows with shared expiration and runtime guardrails", () => {
  const prompt = readRepoFile(".github/prompts/agent-create-action.md");
  const docs = readRepoFile(".agent/docs/customization/creating-your-own-actions.md");
  const template = readRepoFile(".agent/action-templates/agent-action-template.yml");
  const internalActions = readRepoFile(".agent/docs/actions/internal-actions.md");
  const action = readRepoFile(".github/actions/check-agent-action-expiration/action.yml");
  const script = readRepoFile(".github/actions/check-agent-action-expiration/check-expiration.sh");

  for (const content of [prompt, docs]) {
    assert.match(content, /\.agent\/action-templates\/agent-action-template\.yml/);
    assert.match(content, /check-agent-action-expiration/);
    assert.match(content, /steps\.expiration\.outputs\.expired != 'true'/);
    assert.match(content, /issues: write/);
    assert.doesNotMatch(content, /date -u -d/);
  }

  assert.match(template, /uses: \.\/\.github\/actions\/check-agent-action-expiration/);
  assert.match(template, /uses: \.\/\.github\/actions\/resolve-github-auth/);
  assert.match(template, /uses: \.\/\.github\/actions\/resolve-agent-provider/);
  assert.match(template, /uses: \.\/\.github\/actions\/setup-agent-runtime/);
  assert.match(template, /uses: \.\/\.github\/actions\/run-agent-task/);
  assert.match(template, /steps\.expiration\.outputs\.expired != 'true'/);
  assert.match(template, /permission_mode:\s*approve-all/);
  assert.match(template, /memory_mode_override:\s*read-only/);
  assert.match(template, /session_policy:\s*track-only/);
  assert.match(template, /Post report to issue/);
  assert.match(template, /add issue write permission/i);
  assert.doesNotMatch(template, /^\s*issues:\s*write\s*$/m);
  assert.doesNotMatch(template, /date -u -d/);

  assert.match(internalActions, /check-agent-action-expiration/);
  assert.match(action, /expires_at:/);
  assert.match(action, /check-expiration\.sh/);
  assert.match(script, /date -u \+%Y-%m-%d/);
  assert.doesNotMatch(script, /date -u -d/);
});

test("agent implement prompt input falls back to implementation route", () => {
  const implementWorkflow = readRepoFile(".github/workflows/agent-implement.yml");
  const implementationPromptDefaults =
    implementWorkflow.match(/implementation_prompt:[\s\S]*?default:\s*""/g) || [];

  assert.equal(implementationPromptDefaults.length, 2);
  assert.match(
    implementWorkflow,
    /IMPLEMENTATION_PROMPT:\s*\$\{\{\s*inputs\.implementation_prompt \|\| inputs\.implementation_route \|\| 'implement'\s*\}\}/,
  );
});

test("execution workflows expose automation handoff inputs", () => {
  const entrypointWorkflow = readRepoFile(".github/workflows/agent-entrypoint.yml");
  const labelWorkflow = readRepoFile(".github/workflows/agent-label.yml");
  const runnerWorkflow = readRepoFile(".github/workflows/agent-router.yml");
  const approveWorkflow = readRepoFile(".github/workflows/agent-approve.yml");
  const orchestratorWorkflow = readRepoFile(".github/workflows/agent-orchestrator.yml");
  const implementWorkflow = readRepoFile(".github/workflows/agent-implement.yml");
  const fixPrWorkflow = readRepoFile(".github/workflows/agent-fix-pr.yml");
  const reviewWorkflow = readRepoFile(".github/workflows/agent-review.yml");
  const runSource = readRepoFile(".agent/src/run.ts");
  const handoffSource = readRepoFile(".agent/src/handoff.ts");
  const orchestrateHandoffCli = readRepoFile(".agent/src/cli/orchestrate-handoff.ts");
  const fixPrPrompt = readRepoFile(".github/prompts/agent-fix-pr.md");
  const orchestratorPrompt = readRepoFile(".github/prompts/agent-orchestrator.md");
  const orchestratorDoc = readRepoFile(".agent/docs/technical-details/agent-orchestrator.md");

  assert.match(entrypointWorkflow, /automation_mode:\s*\$\{\{ vars\.AGENT_AUTOMATION_MODE \|\| 'disabled' \}\}/);
  assert.match(labelWorkflow, /automation_mode:\s*\$\{\{ vars\.AGENT_AUTOMATION_MODE \|\| 'disabled' \}\}/);
  assert.match(runnerWorkflow, /automation_mode:/);
  assert.match(approveWorkflow, /AUTOMATION_MODE:\s*\$\{\{ vars\.AGENT_AUTOMATION_MODE \|\| 'disabled' \}\}/);
  assert.match(orchestratorWorkflow, /name: Agent \/ Orchestrator/);
  assert.match(orchestratorWorkflow, /source_run_id:/);
  assert.match(orchestratorWorkflow, /issues: write/);
  assert.match(orchestratorWorkflow, /uses: \.\/\.github\/actions\/resolve-agent-provider/);
  assert.match(orchestratorWorkflow, /route:\s*orchestrator/);
  assert.match(orchestratorWorkflow, /node \.agent\/dist\/cli\/orchestrator-preflight\.js/);
  assert.match(orchestratorWorkflow, /Check handoff preflight[\s\S]*AUTHOR_ASSOCIATION:/);
  assert.match(orchestratorWorkflow, /Check handoff preflight[\s\S]*ACCESS_POLICY:/);
  assert.match(
    orchestratorWorkflow,
    /Plan next action with agent[\s\S]*if:\s*\$\{\{\s*steps\.preflight\.outputs\.planner_enabled == 'true'\s*\}\}/,
  );
  assert.match(orchestratorWorkflow, /install_claude:\s*\$\{\{\s*steps\.provider\.outputs\.install_claude\s*\}\}/);
  assert.match(orchestratorWorkflow, /prompt:\s*orchestrator/);
  assert.match(orchestratorWorkflow, /permission_mode:\s*approve-all/);
  assert.match(orchestratorWorkflow, /session_policy:\s*resume-best-effort/);
  assert.match(orchestratorWorkflow, /continue-on-error:\s*true/);
  assert.match(orchestratorWorkflow, /rubrics_mode_override:\s*read-only/);
  assert.match(orchestratorWorkflow, /agent:\s*\$\{\{\s*steps\.provider\.outputs\.provider\s*\}\}/);
  assert.match(orchestratorWorkflow, /node \.agent\/dist\/cli\/orchestrate-handoff\.js/);

  for (const workflow of [implementWorkflow, fixPrWorkflow, reviewWorkflow]) {
    assert.match(workflow, /automation_mode:/);
    assert.match(workflow, /automation_current_round:/);
    assert.match(workflow, /automation_max_rounds:/);
    assert.match(workflow, /orchestration_enabled:/);
    assert.match(workflow, /inputs\.orchestration_enabled == 'true'/);
    assert.match(workflow, /node \.agent\/dist\/cli\/dispatch-agent-orchestrator\.js/);
  }

  assert.match(runnerWorkflow, /needs\.portal\.outputs\.route == 'orchestrate'/);
  assert.match(runnerWorkflow, /SOURCE_ACTION:\s*orchestrate/);
  assert.match(runnerWorkflow, /TARGET_KIND:\s*\$\{\{ needs\.portal\.outputs\.target_kind \}\}/);
  assert.match(runnerWorkflow, /node \.agent\/dist\/cli\/dispatch-agent-orchestrator\.js/);
  assert.match(reviewWorkflow, /id: post_comment/);
  assert.match(reviewWorkflow, /RESPONSE_FILE:\s*\$\{\{ steps\.synthesis\.outputs\.response_file \}\}/);
  assert.match(reviewWorkflow, /steps\.post_comment\.outcome == 'success'/);
  assert.match(orchestratorWorkflow, /PLANNER_RESPONSE_FILE:\s*\$\{\{ steps\.planner\.outputs\.response_file \}\}/);
  assert.match(orchestratorWorkflow, /base_branch:/);
  assert.match(orchestratorWorkflow, /base_pr:/);
  assert.match(orchestratorWorkflow, /source_handoff_context:/);
  assert.match(orchestratorWorkflow, /AGENT_COLLAPSE_OLD_REVIEWS:\s*\$\{\{ vars\.AGENT_COLLAPSE_OLD_REVIEWS \}\}/);
  assert.match(orchestratorWorkflow, /BASE_BRANCH:\s*\$\{\{ inputs\.base_branch \}\}/);
  assert.match(orchestratorWorkflow, /SOURCE_HANDOFF_CONTEXT:\s*\$\{\{ inputs\.source_handoff_context \}\}/);
  assert.match(orchestratorWorkflow, /ORCHESTRATOR_SOURCE_HANDOFF_CONTEXT:\s*\$\{\{ inputs\.source_handoff_context \}\}/);
  assert.match(orchestrateHandoffCli, /resolveEffectiveBaseInputs/);
  assert.match(orchestrateHandoffCli, /baseBranch:\s*decision\.baseBranch \|\| baseBranch/);
  assert.match(orchestrateHandoffCli, /basePr:\s*decision\.basePr \|\| basePr/);
  assert.match(orchestrateHandoffCli, /base_branch:\s*effectiveBaseBranch/);
  assert.match(orchestrateHandoffCli, /base_pr:\s*effectiveBasePr/);
  assert.match(orchestrateHandoffCli, /set only one of base_branch or base_pr for implementation/);
  assert.match(orchestrateHandoffCli, /sourceHandoffContext/);
  assert.match(orchestratorWorkflow, /target_kind:/);
  assert.match(orchestratorWorkflow, /TARGET_KIND:/);
  assert.match(orchestrateHandoffCli, /orchestration_enabled:\s*"true"/);
  assert.match(orchestrateHandoffCli, /automationMode === "disabled" \? "heuristics" : automationMode/);
  assert.match(orchestrateHandoffCli, /orchestrator_context:\s*decision\.handoffContext/);
  assert.match(handoffSource, /Task for fix-pr/);
  assert.match(orchestrateHandoffCli, /collapsePreviousHandoffComments/);
  assert.match(orchestrateHandoffCli, /manual orchestrate start on issue; dispatching implement/);
  assert.match(fixPrWorkflow, /orchestrator_context:/);
  assert.match(fixPrWorkflow, /ORCHESTRATOR_CONTEXT:\s*\$\{\{ inputs\.orchestrator_context \}\}/);
  assert.match(fixPrPrompt, /\$\{ORCHESTRATOR_CONTEXT\}/);
  assert.match(orchestratorPrompt, /"handoff_context"/);
  assert.match(orchestratorPrompt, /ORCHESTRATOR_SOURCE_HANDOFF_CONTEXT/);
  assert.match(orchestratorPrompt, /"user_message"/);
  assert.match(orchestratorPrompt, /"clarification_request"/);
  assert.match(orchestratorPrompt, /prior child finished with an open, unmerged PR/);
  assert.match(runSource, /"ORCHESTRATOR_CONTEXT"/);
  assert.match(orchestratorDoc, /Implement --> Review: success \+ PR created/);
  assert.match(orchestratorDoc, /continues sequential child implementation work/);
  assert.match(orchestratorDoc, /workflow_dispatch/);
  assert.match(orchestratorDoc, /handoff_context/);
  assert.match(orchestratorDoc, /source handoff context/);
  assert.match(orchestratorDoc, /Task for fix-pr/);
  assert.match(orchestratorDoc, /agent\s+handle/);
  assert.match(orchestratorDoc, /minimizes older visible handoff marker comments/);
});

test("orchestrator source handoff context is renderable in planner prompts", () => {
  const runSource = readRepoFile(".agent/src/run.ts");
  const orchestratorPrompt = readRepoFile(".github/prompts/agent-orchestrator.md");
  const sourceContextName = "ORCHESTRATOR_SOURCE_HANDOFF_CONTEXT";

  assert.match(orchestratorPrompt, /\$\{ORCHESTRATOR_SOURCE_HANDOFF_CONTEXT\}/);
  assert.ok(
    readSupplementalPromptVarNames(runSource).has(sourceContextName),
    `${sourceContextName} must be allowlisted for runtime prompt rendering`,
  );
});

test("workflow docs cover hosted auth and self-hosting paths", () => {
  const setupGuide = readRepoFile(".agent/docs/deployment/setup-guide.md");
  const selfHostedRunner = readRepoFile(
    ".agent/docs/deployment/self-hosted-github-action-runner.md",
  );

  assert.match(setupGuide, /Official Sepo-hosted app/);
  assert.match(setupGuide, /works without\s+extra repository configuration/);
  assert.doesNotMatch(setupGuide, /AGENT_OIDC_EXCHANGE_URL/);
  assert.doesNotMatch(setupGuide, /AGENT_OIDC_AUDIENCE/);
  assert.match(setupGuide, /Bring your own GitHub App/);
  assert.match(setupGuide, /`AGENT_PAT`/);
  assert.match(setupGuide, /Contents:\*\* read and write/);
  assert.match(setupGuide, /### Auth priority/);
  assert.match(
    setupGuide,
    /1\. direct GitHub App token[\s\S]*2\. official OIDC broker exchange[\s\S]*3\. `AGENT_PAT`[\s\S]*4\. fallback workflow token `github\.token`/,
  );
  assert.match(setupGuide, /fallback workflow token `github\.token`/i);
  assert.doesNotMatch(setupGuide, /"oidc_token"/);
  assert.match(selfHostedRunner, /infrastructure you operate/);
  assert.match(selfHostedRunner, /`git`, `gh`, `jq`, `curl`, `bash`, and network/);
});

test("buildEnvelope produces a valid envelope with all fields", () => {
  const envelope = buildEnvelope(VALID_PARAMS);

  assert.equal(envelope.schema_version, SCHEMA_VERSION);
  assert.equal(envelope.repo_slug, "self-evolving/repo");
  assert.equal(envelope.route, "review");
  assert.equal(envelope.source_kind, "issue_comment");
  assert.equal(envelope.target_kind, "pull_request");
  assert.equal(envelope.target_number, 42);
  assert.equal(envelope.target_url, "https://github.com/self-evolving/repo/pull/42");
  assert.equal(envelope.request_text, "please review this");
  assert.equal(envelope.requested_by, "lolipopshock");
  assert.equal(envelope.approval_comment_url, null);
  assert.equal(envelope.lane, "default");
  assert.equal(envelope.thread_key, "self-evolving/repo:pull_request:42:review:default");
});

test("buildEnvelope uses the default lane when lane is not provided", () => {
  const envelope = buildEnvelope(VALID_PARAMS);
  assert.equal(envelope.lane, "default");
});

test("buildEnvelope respects explicit lane", () => {
  const envelope = buildEnvelope({ ...VALID_PARAMS, lane: "portal" });
  assert.equal(envelope.lane, "portal");
  assert.equal(envelope.thread_key, "self-evolving/repo:pull_request:42:review:portal");
});

test("buildEnvelope sets workflow when provided", () => {
  const envelope = buildEnvelope({ ...VALID_PARAMS, workflow: "agent-review.yml" });
  assert.equal(envelope.workflow, "agent-review.yml");
});

test("buildEnvelope preserves approval_comment_url", () => {
  const url = "https://github.com/self-evolving/repo/issues/21#issuecomment-123";
  const envelope = buildEnvelope({ ...VALID_PARAMS, approval_comment_url: url });
  assert.equal(envelope.approval_comment_url, url);
});

test("validateEnvelope passes for a valid envelope", () => {
  const envelope = buildEnvelope(VALID_PARAMS);
  const errors = validateEnvelope(envelope);
  assert.deepEqual(errors, []);
});

test("validateEnvelope catches missing required fields", () => {
  const envelope = buildEnvelope({ ...VALID_PARAMS, repo_slug: "", target_number: 0 });
  const errors = validateEnvelope(envelope);
  assert.ok(errors.some((error) => error.includes("repo_slug")));
  assert.ok(errors.some((error) => error.includes("target_number")));
});

test("validateEnvelope catches invalid route", () => {
  const envelope = buildEnvelope({ ...VALID_PARAMS, route: "deploy" });
  const errors = validateEnvelope(envelope);
  assert.ok(errors.some((error) => error.includes("Invalid route")));
});

test("validateEnvelope accepts dispatch, action, and rubrics as first-class routes", () => {
  for (const route of [
    "dispatch",
    "create-action",
    "setup",
    "rubrics-review",
    "rubrics-initialization",
    "rubrics-update",
  ]) {
    const envelope = buildEnvelope({ ...VALID_PARAMS, route });
    const errors = validateEnvelope(envelope);
    assert.deepEqual(errors, []);
  }
});

test("validateEnvelope catches invalid source_kind", () => {
  const envelope = buildEnvelope({ ...VALID_PARAMS, source_kind: "webhook" });
  const errors = validateEnvelope(envelope);
  assert.ok(errors.some((error) => error.includes("Invalid source_kind")));
});

test("validateEnvelope catches invalid target_kind", () => {
  const envelope = buildEnvelope({ ...VALID_PARAMS, target_kind: "commit" });
  const errors = validateEnvelope(envelope);
  assert.ok(errors.some((error) => error.includes("Invalid target_kind")));
});

test("buildThreadKey is deterministic", () => {
  assert.equal(
    buildThreadKey({
      repo_slug: "self-evolving/repo",
      target_kind: "issue",
      target_number: 21,
      route: "implement",
    }),
    "self-evolving/repo:issue:21:implement:default",
  );
});

test("buildEnvelopeFromEventContext maps event context into an envelope", () => {
  const envelope = buildEnvelopeFromEventContext(
    {
      body: "please implement",
      sourceKind: "issue_comment",
      targetKind: "issue",
      targetNumber: "21",
      targetUrl: "https://github.com/self-evolving/repo/issues/21",
    },
    {
      repo_slug: "self-evolving/repo",
      route: "implement",
      requested_by: "alice",
      workflow: "agent-implement.yml",
      lane: "default",
    },
  );

  assert.equal(envelope.target_number, 21);
  assert.equal(envelope.request_text, "please implement");
  assert.equal(envelope.requested_by, "alice");
  assert.equal(envelope.workflow, "agent-implement.yml");
});

test("envelopeToPromptVars exposes the prompt contract", () => {
  const envelope = buildEnvelope(VALID_PARAMS);
  assert.deepEqual(envelopeToPromptVars(envelope), {
    REPO_SLUG: "self-evolving/repo",
    ROUTE: "review",
    SOURCE_KIND: "issue_comment",
    TARGET_KIND: "pull_request",
    TARGET_NUMBER: "42",
    TARGET_URL: "https://github.com/self-evolving/repo/pull/42",
    REQUEST_TEXT: "please review this",
    MENTION_BODY: "please review this",
    REQUESTED_BY: "lolipopshock",
    WORKFLOW: "",
    LANE: "default",
    THREAD_KEY: "self-evolving/repo:pull_request:42:review:default",
  });
});

test("repository target kind accepts target_number=0", () => {
  const envelope = buildEnvelope({
    ...VALID_PARAMS,
    source_kind: "workflow_dispatch",
    target_kind: "repository",
    target_number: 0,
    target_url: "https://github.com/self-evolving/repo",
  });
  assert.deepEqual(validateEnvelope(envelope), []);
});

test("non-repository target kinds still require target_number", () => {
  const envelope = buildEnvelope({
    ...VALID_PARAMS,
    target_number: 0,
  });
  const errors = validateEnvelope(envelope);
  assert.ok(errors.some((e) => /target_number/.test(e)));
});

test("run-agent-task resolves memory mode from policy and threads memory env to the agent", () => {
  const action = readRepoFile(".github/actions/run-agent-task/action.yml");
  const commitCli = readRepoFile(".agent/src/cli/commit.ts");
  assert.match(action, /memory_policy:/);
  assert.match(action, /memory_mode_override:/);
  assert.match(action, /memory_ref:/);
  assert.doesNotMatch(action, /memory_bootstrap_if_missing:/);
  assert.doesNotMatch(action, /memory_repository:/);
  assert.doesNotMatch(action, /memory_path:/);
  assert.doesNotMatch(action, /memory_commit_message:/);
  assert.match(action, /AGENT_MEMORY_POLICY:\s*\$\{\{\s*inputs\.memory_policy\s*\}\}/);
  assert.doesNotMatch(action, /vars\.AGENT_MEMORY_POLICY/);
  assert.match(action, /cli\/memory\/resolve-policy\.js/);
  assert.match(action, /steps\.memory_mode\.outputs\.read_enabled == 'true'/);
  assert.match(action, /steps\.memory_mode\.outputs\.write_enabled == 'true'/);
  // Commit must be gated on a clean agent exit, not just always().
  assert.match(action, /steps\.run\.outputs\.exit_code == '0'/);
  assert.match(action, /Set up agent memory/);
  assert.match(action, /MEMORY_AVAILABLE:\s*\$\{\{\s*steps\.memory\.outputs\.memory_available\s*\}\}/);
  assert.match(action, /MEMORY_DIR:\s*\$\{\{\s*steps\.memory\.outputs\.memory_dir\s*\}\}/);
  assert.match(action, /MEMORY_REF:\s*\$\{\{\s*steps\.memory\.outputs\.memory_ref\s*\}\}/);
  assert.doesNotMatch(action, /PROMPT_VAR_MEMORY_/);
  assert.match(action, /Commit memory edits/);
  assert.match(action, /COMMIT_CWD:\s*\$\{\{\s*steps\.memory\.outputs\.memory_dir\s*\}\}/);
  assert.doesNotMatch(action, /GITHUB_WORKSPACE:\s*\$\{\{\s*steps\.memory\.outputs\.memory_dir\s*\}\}/);
  assert.match(
    action,
    /bootstrap_if_missing:\s*\$\{\{\s*inputs\.memory_mode_override == 'enabled' && 'true' \|\| 'false'\s*\}\}/,
  );
  assert.match(action, /Report memory commit failure/);
  assert.match(action, /steps\.commit_memory\.outcome == 'failure'/);
  assert.match(action, /::warning title=Memory commit failed::/);
  assert.match(action, /\.\/\.github\/actions\/download-agent-memory/);
  assert.match(commitCli, /process\.env\.COMMIT_CWD \|\| process\.env\.GITHUB_WORKSPACE/);
});

test("run-agent-task only bootstraps missing rubrics for first-run initialization", () => {
  const action = readRepoFile(".github/actions/run-agent-task/action.yml");
  const rubricsPrompt = readRepoFile(".github/prompts/_rubrics.md");

  assert.match(
    action,
    /bootstrap_if_missing:\s*\$\{\{\s*inputs\.route == 'rubrics-initialization' && inputs\.rubrics_mode_override == 'enabled' && 'true' \|\| 'false'\s*\}\}/,
  );
  assert.match(action, /Require rubric initialization commit/);
  assert.match(action, /Rubrics initialization did not persist/);
  assert.match(action, /Report rubrics validation failure/);
  assert.match(action, /steps\.validate_rubrics\.outcome == 'failure'/);
  assert.match(action, /::warning title=Rubrics validation failed::/);
  assert.match(action, /RUBRICS_SELECT_ALL_ROUTES:\s*\$\{\{\s*inputs\.route == 'rubrics-review' && 'true' \|\| 'false'\s*\}\}/);
  assert.match(action, /RUBRICS_LIMIT:\s*\$\{\{\s*inputs\.route == 'rubrics-review' && 'all' \|\| inputs\.rubrics_limit\s*\}\}/);
  assert.match(action, /all_route_args\+=\(--all-routes\)/);
  assert.match(action, /"\$\{all_route_args\[@\]\}"/);
  assert.match(rubricsPrompt, /Agent \/ Rubrics \/ Initialization and Agent \/ Rubrics \/ Update/);
});

test("normal workflows honor rubrics policy instead of forcing read-only", () => {
  const implementWorkflow = readRepoFile(".github/workflows/agent-implement.yml");
  const fixPrWorkflow = readRepoFile(".github/workflows/agent-fix-pr.yml");
  const reviewWorkflow = readRepoFile(".github/workflows/agent-review.yml");
  const rubricsReviewWorkflow = readRepoFile(".github/workflows/agent-rubrics-review.yml");
  const rubricsInitializationWorkflow = readRepoFile(".github/workflows/agent-rubrics-initialization.yml");
  const rubricsInitializationPrompt = readRepoFile(".github/prompts/rubrics-initialization.md");
  const rubricsUpdateWorkflow = readRepoFile(".github/workflows/agent-rubrics-update.yml");
  const rubricsUpdatePrompt = readRepoFile(".github/prompts/rubrics-update.md");

  for (const workflow of [implementWorkflow, fixPrWorkflow, reviewWorkflow, rubricsReviewWorkflow]) {
    assert.doesNotMatch(workflow, /rubrics_mode_override:\s*'read-only'/);
    assert.match(workflow, /rubrics_policy:\s*\$\{\{\s*vars\.AGENT_RUBRICS_POLICY \|\| ''\s*\}\}/);
  }
  assert.match(rubricsInitializationWorkflow, /rubrics_mode_override:\s*'enabled'/);
  assert.match(rubricsUpdateWorkflow, /rubrics_mode_override:\s*'enabled'/);
  assert.match(rubricsInitializationPrompt, /gh repo view \$\{REPO_SLUG\} --json owner,nameWithOwner/);
  assert.match(rubricsInitializationPrompt, /permissions\.admin or \.permissions\.maintain/);
  assert.match(rubricsInitializationPrompt, /primary source of user\/team preference/);
  assert.match(rubricsUpdatePrompt, /author's login,[\s\S]*user type,[\s\S]*author_association/);
  assert.match(rubricsUpdatePrompt, /gh repo view \$\{REPO_SLUG\} --json owner,nameWithOwner/);
  assert.match(rubricsUpdatePrompt, /permissions\.admin or \.permissions\.maintain/);
  assert.match(rubricsUpdatePrompt, /non-primary maintainer comments as corroborating evidence/);
  assert.match(rubricsUpdatePrompt, /automatic merged-PR rubrics-update runs[\s\S]*closed\/merged/);
  assert.match(rubricsUpdatePrompt, /authored by `REQUESTED_BY`; it does not make other PR conversation[\s\S]*participants trusted/);
  assert.match(rubricsUpdateWorkflow, /issues:\s*write/);
  assert.match(rubricsUpdateWorkflow, /id:\s*rubrics_update/);
  assert.match(rubricsUpdateWorkflow, /Prepare rubrics update summary/);
  assert.match(rubricsUpdateWorkflow, /prepare-rubrics-update-summary\.js/);
  assert.match(rubricsUpdateWorkflow, /Post rubrics update summary/);
});

test("rubrics-review prompt chooses from full active rubric context", () => {
  const rubricsReviewPrompt = readRepoFile(".github/prompts/rubrics-review.md");

  assert.match(rubricsReviewPrompt, /full active rubric set/);
  assert.match(rubricsReviewPrompt, /do not score unrelated route\/process rubrics/);
});

test("memory workflows exist and point at the right CLIs / prompts", () => {
  const bootstrapWorkflow = readRepoFile(".github/workflows/agent-memory-bootstrap.yml");
  const syncWorkflow = readRepoFile(".github/workflows/agent-memory-sync.yml");
  const prClosedWorkflow = readRepoFile(".github/workflows/agent-memory-pr-closed.yml");
  const scanWorkflow = readRepoFile(".github/workflows/agent-memory-scan.yml");

  assert.match(bootstrapWorkflow, /^name: Agent \/ Memory \/ Initialization$/m);
  assert.match(syncWorkflow, /^name: Agent \/ Memory \/ Sync GitHub Artifacts$/m);
  assert.match(prClosedWorkflow, /^name: Agent \/ Memory \/ Record PR Closure$/m);
  assert.match(scanWorkflow, /^name: Agent \/ Memory \/ Curate Recent Activity$/m);
  assert.match(bootstrapWorkflow, /workflow_dispatch:/);
  assert.match(bootstrapWorkflow, /inputs:\s*[\s\S]*memory_ref:/);
  assert.match(bootstrapWorkflow, /git\/matching-refs\/heads\/\$\{MEMORY_REF\}/);
  assert.match(bootstrapWorkflow, /exact_ref="refs\/heads\/\$\{MEMORY_REF\}"/);
  assert.match(bootstrapWorkflow, /grep -Fxq "\$exact_ref"/);
  assert.match(bootstrapWorkflow, /already exists\. Bootstrap is first-run only\./);
  assert.match(bootstrapWorkflow, /uses: \.\/\.github\/actions\/download-agent-memory/);
  assert.match(bootstrapWorkflow, /bootstrap_if_missing: "true"/);
  assert.match(bootstrapWorkflow, /Resolve memory bootstrap provider/);
  assert.match(bootstrapWorkflow, /install_codex:\s*\$\{\{\s*steps\.provider\.outputs\.install_codex\s*\}\}/);
  assert.match(bootstrapWorkflow, /install_claude:\s*\$\{\{\s*steps\.provider\.outputs\.install_claude\s*\}\}/);
  assert.match(bootstrapWorkflow, /node \.agent\/dist\/cli\/memory\/read-sync-state\.js/);
  assert.match(bootstrapWorkflow, /node \.agent\/dist\/cli\/memory\/sync-github-artifacts\.js/);
  assert.match(bootstrapWorkflow, /node \.agent\/dist\/cli\/memory\/write-sync-state\.js/);
  assert.match(bootstrapWorkflow, /PREVIOUS_LAST_SYNC: ""/);
  assert.doesNotMatch(bootstrapWorkflow, /steps\.commit\.outputs\.committed == 'true'/);
  assert.match(bootstrapWorkflow, /steps\.memory\.outputs\.memory_available == 'true'/);
  assert.match(bootstrapWorkflow, /node \$\{\{ github\.workspace \}\}\/\.agent\/dist\/cli\/commit\.js/);
  assert.match(bootstrapWorkflow, /COMMIT_CWD:\s*\$\{\{\s*runner\.temp\s*\}\}\/agent-memory/);
  assert.doesNotMatch(bootstrapWorkflow, /GITHUB_WORKSPACE:\s*\$\{\{\s*runner\.temp\s*\}\}\/agent-memory/);
  assert.match(bootstrapWorkflow, /COMMIT_MESSAGE: "chore\(memory\): initialize memory branch"/);
  assert.match(bootstrapWorkflow, /COMMIT_MESSAGE: "chore\(memory\): sync github artifacts"/);
  assert.match(bootstrapWorkflow, /permission_mode: approve-all/);
  assert.match(bootstrapWorkflow, /prompt: memory-scan/);
  assert.match(bootstrapWorkflow, /memory_mode_override: 'enabled'/);
  assert.match(bootstrapWorkflow, /memory_policy:\s*\$\{\{\s*vars\.AGENT_MEMORY_POLICY \|\| ''\s*\}\}/);
  assert.match(bootstrapWorkflow, /workflow: agent-memory-bootstrap\.yml/);
  assert.match(bootstrapWorkflow, /inputs\.memory_ref \|\| vars\.AGENT_MEMORY_REF \|\| 'agent\/memory'/);
  assert.doesNotMatch(bootstrapWorkflow, /dispatch-workflow\.js/);
  assert.match(syncWorkflow, /cron: "17 \*\/6 \* \* \*"/);
  assert.match(syncWorkflow, /node \.agent\/dist\/cli\/memory\/read-sync-state\.js/);
  assert.match(syncWorkflow, /node \.agent\/dist\/cli\/memory\/sync-github-artifacts\.js/);
  assert.match(syncWorkflow, /node \.agent\/dist\/cli\/memory\/write-sync-state\.js/);
  assert.match(syncWorkflow, /inputs\.memory_ref \|\| vars\.AGENT_MEMORY_REF \|\| 'agent\/memory'/);
  assert.match(syncWorkflow, /GH_TOKEN:\s*\$\{\{\s*steps\.auth\.outputs\.token\s*\}\}/);
  assert.match(syncWorkflow, /GITHUB_TOKEN:\s*\$\{\{\s*steps\.auth\.outputs\.token\s*\}\}/);
  assert.match(syncWorkflow, /MEMORY_SYNC_LOOKBACK_DAYS:\s*\$\{\{\s*inputs\.lookback_days \|\| '30'\s*\}\}/);
  assert.match(syncWorkflow, /bootstrap_if_missing: "true"/);
  assert.match(syncWorkflow, /COMMIT_CWD:\s*\$\{\{\s*runner\.temp\s*\}\}\/agent-memory/);
  assert.doesNotMatch(syncWorkflow, /GITHUB_WORKSPACE:\s*\$\{\{\s*runner\.temp\s*\}\}\/agent-memory/);
  assert.doesNotMatch(syncWorkflow, /dispatch_scan_on_success:/);
  assert.doesNotMatch(syncWorkflow, /dispatch-workflow\.js/);
  assert.doesNotMatch(syncWorkflow, /Bootstrap memory checkout/);
  assert.doesNotMatch(syncWorkflow, /date -u -d/);

  // The dedicated memory scaffolds bypass the memory policy so they always run.
  assert.match(prClosedWorkflow, /pull_request_target:\s*[\s\S]*types: \[closed\]/);
  assert.match(prClosedWorkflow, /permission_mode: approve-all/);
  assert.match(prClosedWorkflow, /prompt: memory-pr-closed/);
  assert.match(prClosedWorkflow, /memory_mode_override: 'enabled'/);
  assert.match(prClosedWorkflow, /memory_policy:\s*\$\{\{\s*vars\.AGENT_MEMORY_POLICY \|\| ''\s*\}\}/);
  assert.doesNotMatch(prClosedWorkflow, /memory_bootstrap_if_missing:/);
  assert.match(prClosedWorkflow, /inputs\.memory_ref \|\| vars\.AGENT_MEMORY_REF \|\| 'agent\/memory'/);
  assert.doesNotMatch(prClosedWorkflow, /continue-on-error:\s*true/);
  // Fork safety: either same repo, workflow_dispatch, or merged fork PR.
  assert.match(prClosedWorkflow, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(prClosedWorkflow, /github\.event\.pull_request\.merged == true/);

  assert.match(scanWorkflow, /cron: '0 \*\/6 \* \* \*'/);
  assert.match(scanWorkflow, /permission_mode: approve-all/);
  assert.match(scanWorkflow, /prompt: memory-scan/);
  assert.match(scanWorkflow, /memory_mode_override: 'enabled'/);
  assert.match(scanWorkflow, /memory_policy:\s*\$\{\{\s*vars\.AGENT_MEMORY_POLICY \|\| ''\s*\}\}/);
  assert.doesNotMatch(scanWorkflow, /memory_bootstrap_if_missing:/);
  assert.match(scanWorkflow, /inputs\.memory_ref \|\| vars\.AGENT_MEMORY_REF \|\| 'agent\/memory'/);
  assert.match(scanWorkflow, /target_kind: repository/);
  assert.doesNotMatch(scanWorkflow, /continue-on-error:\s*true/);
});

test("download-agent-memory only suppresses missing-branch failures", () => {
  const action = readRepoFile(".github/actions/download-agent-memory/action.yml");

  assert.match(action, /bootstrap_if_missing:/);
  assert.match(action, /git clone --depth=1 --branch "\$ref" --single-branch "\$auth_url" "\$dest"/);
  assert.match(
    action,
    /if git ls-remote --exit-code --heads "\$auth_url" "\$ref"[\s\S]*else[\s\S]*lsremote_status=\$\?[\s\S]*fi/,
  );
  assert.match(action, /if \[ "\$lsremote_status" -eq 2 \]/);
  assert.match(action, /if \[ "\$INPUT_BOOTSTRAP_IF_MISSING" = "true" \]/);
  assert.match(action, /memory\/init\.js/);
  assert.match(action, /Failed to clone memory branch/);
});

test("main execution workflows rely on the default memory policy (no explicit override)", () => {
  const routerWorkflow = readRepoFile(".github/workflows/agent-router.yml");
  const implementWorkflow = readRepoFile(".github/workflows/agent-implement.yml");
  const fixPrWorkflow = readRepoFile(".github/workflows/agent-fix-pr.yml");
  const reviewWorkflow = readRepoFile(".github/workflows/agent-review.yml");

  // No explicit memory_enabled flag — memory is on by default via policy.
  assert.doesNotMatch(routerWorkflow, /memory_enabled:/);
  assert.doesNotMatch(implementWorkflow, /memory_enabled:/);
  assert.doesNotMatch(fixPrWorkflow, /memory_enabled:/);
  assert.match(routerWorkflow, /memory_ref:\s*\$\{\{\s*vars\.AGENT_MEMORY_REF \|\| 'agent\/memory'\s*\}\}/);
  assert.match(implementWorkflow, /memory_ref:\s*\$\{\{\s*vars\.AGENT_MEMORY_REF \|\| 'agent\/memory'\s*\}\}/);
  assert.match(fixPrWorkflow, /memory_ref:\s*\$\{\{\s*vars\.AGENT_MEMORY_REF \|\| 'agent\/memory'\s*\}\}/);
  assert.match(routerWorkflow, /memory_policy:\s*\$\{\{\s*vars\.AGENT_MEMORY_POLICY \|\| ''\s*\}\}/);
  assert.match(implementWorkflow, /memory_policy:\s*\$\{\{\s*vars\.AGENT_MEMORY_POLICY \|\| ''\s*\}\}/);
  assert.match(fixPrWorkflow, /memory_policy:\s*\$\{\{\s*vars\.AGENT_MEMORY_POLICY \|\| ''\s*\}\}/);

  // Review matrix is explicitly read-only so the parallel claude+codex jobs
  // don't race to push to agent/memory; synthesize (no override) inherits
  // the default mode and writes.
  assert.match(reviewWorkflow, /memory_mode_override: 'read-only'/);
  assert.match(reviewWorkflow, /memory_ref:\s*\$\{\{\s*vars\.AGENT_MEMORY_REF \|\| 'agent\/memory'\s*\}\}/);
  assert.match(reviewWorkflow, /memory_policy:\s*\$\{\{\s*vars\.AGENT_MEMORY_POLICY \|\| ''\s*\}\}/);
});

test("agent-review permissions keep reviewer contents read-only and synthesize writable", () => {
  const reviewWorkflow = readRepoFile(".github/workflows/agent-review.yml");

  // Top-level workflow permissions keep contents read-only; actions write
  // allows the synthesize job to dispatch automation handoffs.
  assert.match(reviewWorkflow, /^permissions:\s*\n\s+actions: write\s*\n\s+contents: read/m);

  // Reviewer job keeps contents:read while allowing issue writes for labels.
  assert.match(
    reviewWorkflow,
    /review:\s*\n\s+# Reviewer lanes are best-effort[\s\S]*?permissions:\s*\n\s+# Reviewer jobs keep contents read-only[\s\S]*?contents: read[\s\S]*?issues: write/,
  );

  // Synthesize job upgrades to contents:write for the memory commit.
  assert.match(
    reviewWorkflow,
    /synthesize:\s*\n\s+needs: \[review\]\s*\n\s+if: \$\{\{ !cancelled\(\) \}\}[\s\S]*?permissions:[\s\S]*?contents: write/,
  );

  // Cleanup removes labels from PRs, including best-effort failure cleanup.
  assert.match(
    reviewWorkflow,
    /cleanup-activity-label:\s*\n\s+needs: \[review, rubrics-review, synthesize\]\s*\n\s+if: \$\{\{ always\(\) \}\}\s*\n\s+permissions:\s*\n\s+contents: read\s*\n\s+issues: write\s*\n\s+pull-requests: write\s*\n\s+id-token: write/,
  );
});

test("agent-orchestrator permissions cover root activity label mutation", () => {
  const orchestratorWorkflow = readRepoFile(".github/workflows/agent-orchestrator.yml");

  assert.match(
    orchestratorWorkflow,
    /^permissions:\s*\n\s+actions: write\s*\n\s+contents: read\s*\n\s+issues: write\s*\n\s+pull-requests: write\s*\n\s+id-token: write/m,
  );
});

test("branch cleanup preserves shared agent branches", () => {
  const cleanup = readRepoFile(".github/workflows/agent-branch-cleanup.yml");
  assert.match(cleanup, /head\.ref != \(vars\.AGENT_MEMORY_REF \|\| 'agent\/memory'\)/);
  assert.match(cleanup, /head\.ref != \(vars\.AGENT_RUBRICS_REF \|\| 'agent\/rubrics'\)/);
});

test("branch cleanup retargets stacked PRs before deleting merged branches", () => {
  const cleanup = readRepoFile(".github/workflows/agent-branch-cleanup.yml");
  assert.match(cleanup, /^permissions:\s*\n\s+contents: write\s*\n\s+pull-requests: write/m);
  assert.match(cleanup, /const retargetBase = context\.payload\.pull_request\?\.base\?\.ref/);
  assert.match(cleanup, /github\.paginate\(github\.rest\.pulls\.list[\s\S]*base: branch/);
  assert.match(cleanup, /github\.rest\.pulls\.update[\s\S]*base: retargetBase/);

  const retargetIndex = cleanup.indexOf("github.rest.pulls.update");
  const deleteIndex = cleanup.indexOf("github.rest.git.deleteRef");
  assert.notEqual(retargetIndex, -1);
  assert.notEqual(deleteIndex, -1);
  assert.ok(retargetIndex < deleteIndex);
});

test("branch cleanup preserves merged branch when dependent PR retarget fails", async () => {
  const calls: string[] = [];
  const retargetError = new Error("retarget failed");

  const pullsList = async (): Promise<never[]> => [];
  const github = {
    paginate: async (endpoint: unknown, options: Record<string, unknown>) => {
      calls.push("pulls.list");
      assert.equal(endpoint, pullsList);
      assert.deepEqual(options, {
        owner: "self-evolving",
        repo: "repo",
        state: "open",
        base: "agent/implement-issue-122/codex-25293354687",
        per_page: 100,
      });
      return [{ number: 116 }];
    },
    rest: {
      pulls: {
        list: pullsList,
        update: async (options: Record<string, unknown>) => {
          calls.push(`pulls.update:${String(options.pull_number)}`);
          assert.deepEqual(options, {
            owner: "self-evolving",
            repo: "repo",
            pull_number: 116,
            base: "main",
          });
          throw retargetError;
        },
      },
      git: {
        deleteRef: async () => {
          calls.push("git.deleteRef");
        },
      },
    },
  };
  const context = {
    repo: { owner: "self-evolving", repo: "repo" },
    payload: {
      pull_request: {
        head: { ref: "agent/implement-issue-122/codex-25293354687" },
        base: { ref: "main" },
      },
    },
  };
  const core = {
    info: () => {},
    setFailed: (message: string) => {
      calls.push(`core.setFailed:${message}`);
    },
  };

  await assert.rejects(runBranchCleanupScript({ github, context, core }), retargetError);
  assert.deepEqual(calls, ["pulls.list", "pulls.update:116"]);
});

test("memory and rubric guidance live in dedicated conditional prompt fragments", () => {
  const base = readRepoFile(".github/prompts/_base.md");
  const memory = readRepoFile(".github/prompts/_memory.md");
  const rubrics = readRepoFile(".github/prompts/_rubrics.md");
  const runSource = readRepoFile(".agent/src/run.ts");

  assert.doesNotMatch(base, /Repository memory/);
  assert.doesNotMatch(base, /memory\/search\.js/);
  assert.doesNotMatch(base, /memory\/update\.js/);
  assert.doesNotMatch(base, /MEMORY_AVAILABLE/);
  assert.match(memory, /Repository memory/);
  assert.match(memory, /memory\/search\.js/);
  assert.match(memory, /memory\/update\.js/);
  assert.match(memory, /\$\{MEMORY_DIR\}/);
  assert.match(runSource, /MEMORY_PROMPT_PATH = "\.github\/prompts\/_memory\.md"/);
  assert.match(runSource, /vars\.MEMORY_AVAILABLE === "true"/);
  assert.match(rubrics, /User\/team rubrics/);
  assert.match(rubrics, /\$\{RUBRICS_CONTEXT\}/);
  assert.match(runSource, /RUBRICS_PROMPT_PATH = "\.github\/prompts\/_rubrics\.md"/);
  assert.match(runSource, /vars\.RUBRICS_AVAILABLE === "true"/);
  assert.match(runSource, /base \+ memory \+ rubrics \+ template/);
});
