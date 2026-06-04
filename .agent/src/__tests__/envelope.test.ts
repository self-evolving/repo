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
import { buildAnswerReviewContext } from "../answer-review-context.js";
import { resolveInstallTargetFromText } from "../install-target.js";

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

function readMarkdownIssueTemplate(relativePath: string): {
  frontMatter: Record<string, unknown>;
  body: string;
} {
  const template = readRepoFile(relativePath);
  const match = template.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  assert.ok(match, `${relativePath} should define YAML front matter`);
  const frontMatter = parseYaml(match[1]) as unknown;
  assert.ok(isRecord(frontMatter), `${relativePath} front matter should parse as a YAML object`);
  return { frontMatter, body: match[2] };
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
  assert.match(base, /likely transient server, rate-limit, timeout, or connection error/);
  assert.match(base, /Do not repeatedly retry deterministic failures/);
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

  assert.match(answerPrompt, /\$\{ANSWER_REVIEW_CONTEXT\}/);
  assert.doesNotMatch(answerPrompt, /\$\{REQUEST_SOURCE_KIND\}/);
  assert.doesNotMatch(answerPrompt, /\$\{REQUEST_COMMENT_ID\}/);
  assert.doesNotMatch(answerPrompt, /\$\{REQUEST_COMMENT_URL\}/);
  assert.doesNotMatch(answerPrompt, /Trigger metadata:/);
  assert.match(answerPrompt, /Except for targeted inline replies allowed by a review-triggered exception above/);
  assert.match(answerPrompt, /do not post comments directly via `gh`/i);
  assert.match(answerPrompt, /workflow will post it on the original surface/i);
});

test("answer review context renders only for pull request review triggers", () => {
  assert.equal(
    buildAnswerReviewContext({
      repoSlug: "self-evolving/repo",
      targetNumber: "1",
      sourceKind: "issue_comment",
      commentId: "123",
      commentUrl: "https://github.com/self-evolving/repo/issues/1#issuecomment-123",
    }),
    "",
  );

  const reviewContext = buildAnswerReviewContext({
    repoSlug: "self-evolving/repo",
    targetNumber: "1",
    sourceKind: "pull_request_review",
    commentId: "456",
    commentUrl: "https://github.com/self-evolving/repo/pull/1#pullrequestreview-456",
  });

  assert.match(reviewContext, /Review-triggered answer context/);
  assert.match(reviewContext, /Request source kind: `pull_request_review`/);
  assert.match(reviewContext, /Request review ID: `456`/);
  assert.match(reviewContext, /related inline comments/);
  assert.match(reviewContext, /non-empty final answer body/);
  assert.match(reviewContext, /duplicate an existing Sepo-authored inline reply/);
  assert.match(reviewContext, /gh api repos\/self-evolving\/repo\/pulls\/1\/reviews\/456/);
  assert.match(reviewContext, /gh api --method POST repos\/self-evolving\/repo\/pulls\/1\/comments -f body='<reply>' -F in_reply_to=<comment_id>/);
});

test("answer route passes trigger metadata into prompt variables", () => {
  const routerWorkflow = parseYaml(readRepoFile(".github/workflows/agent-router.yml")) as unknown;
  const runAgentTaskAction = parseYaml(readRepoFile(".github/actions/run-agent-task/action.yml")) as unknown;
  const runSource = readRepoFile(".agent/src/run.ts");
  const supplementalPromptVarNames = readSupplementalPromptVarNames(runSource);

  assert.ok(isRecord(routerWorkflow), "agent-router workflow should parse");
  assert.ok(isRecord(routerWorkflow.jobs), "agent-router workflow should define jobs");
  const answerJob = routerWorkflow.jobs.answer;
  assert.ok(isRecord(answerJob), "agent-router workflow should define answer job");
  assert.ok(Array.isArray(answerJob.steps), "answer job should define steps");
  const runAnswerStep = answerJob.steps.find(
    (step): step is Record<string, unknown> =>
      isRecord(step) && step.name === "Run answer agent",
  );
  assert.ok(runAnswerStep, "answer job should run the answer agent");
  assert.ok(isRecord(runAnswerStep.with), "answer agent step should define inputs");
  assert.equal(runAnswerStep.with.request_source_kind, "${{ needs.portal.outputs.source_kind }}");
  assert.equal(runAnswerStep.with.request_comment_id, "${{ needs.portal.outputs.source_comment_id }}");
  assert.equal(runAnswerStep.with.request_comment_url, "${{ needs.portal.outputs.source_comment_url }}");

  assert.ok(isRecord(runAgentTaskAction), "run-agent-task action should parse");
  assert.ok(isRecord(runAgentTaskAction.inputs), "run-agent-task action should define inputs");
  assert.ok(isRecord(runAgentTaskAction.inputs.request_source_kind));
  assert.ok(isRecord(runAgentTaskAction.inputs.request_comment_id));
  assert.ok(isRecord(runAgentTaskAction.inputs.request_comment_url));
  assert.ok(isRecord(runAgentTaskAction.runs), "run-agent-task action should define runs");
  assert.ok(Array.isArray(runAgentTaskAction.runs.steps), "run-agent-task action should define steps");
  const runStep = runAgentTaskAction.runs.steps.find(
    (step): step is Record<string, unknown> => isRecord(step) && step.id === "run",
  );
  assert.ok(runStep, "run-agent-task action should include the Run agent task step");
  assert.ok(isRecord(runStep.env), "run-agent-task run step should define env");
  assert.equal(runStep.env.REQUEST_SOURCE_KIND, "${{ inputs.request_source_kind || inputs.source_kind }}");
  assert.equal(runStep.env.REQUEST_COMMENT_ID, "${{ inputs.request_comment_id }}");
  assert.equal(runStep.env.REQUEST_COMMENT_URL, "${{ inputs.request_comment_url }}");

  assert.ok(supplementalPromptVarNames.has("REQUEST_SOURCE_KIND"));
  assert.ok(supplementalPromptVarNames.has("REQUEST_COMMENT_ID"));
  assert.ok(supplementalPromptVarNames.has("REQUEST_COMMENT_URL"));
  assert.match(runSource, /buildAnswerReviewContext/);
  assert.match(runSource, /envelope\.route === "answer"/);
  assert.match(runSource, /ANSWER_REVIEW_CONTEXT/);
});

test("answer action docs mention review-triggered inline replies", () => {
  const docs = readRepoFile(".agent/docs/usage/agent-actions.md");

  assert.match(docs, /pull_request_review/);
  assert.match(docs, /targeted inline replies/);
  assert.match(docs, /non-empty answer body/);
});

test("fix-pr route passes trigger metadata through run-agent-task inputs", () => {
  const fixPrWorkflow = parseYaml(readRepoFile(".github/workflows/agent-fix-pr.yml")) as unknown;

  assert.ok(isRecord(fixPrWorkflow), "agent-fix-pr workflow should parse");
  assert.ok(isRecord(fixPrWorkflow.jobs), "agent-fix-pr workflow should define jobs");
  const fixPrJob = fixPrWorkflow.jobs["fix-pr"];
  assert.ok(isRecord(fixPrJob), "agent-fix-pr workflow should define fix_pr job");
  assert.ok(Array.isArray(fixPrJob.steps), "fix_pr job should define steps");
  const runAgentStep = fixPrJob.steps.find(
    (step): step is Record<string, unknown> => isRecord(step) && step.name === "Run agent",
  );
  assert.ok(runAgentStep, "fix-pr job should run the agent");
  assert.ok(isRecord(runAgentStep.with), "fix-pr run-agent-task step should define inputs");
  assert.equal(runAgentStep.with.request_comment_id, "${{ inputs.request_comment_id }}");
  assert.equal(runAgentStep.with.request_comment_url, "${{ inputs.request_comment_url }}");
  assert.equal(runAgentStep.with.request_source_kind, "${{ inputs.request_source_kind || 'workflow_dispatch' }}");
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
  const selfApprovalWorkflow = readRepoFile(".github/workflows/agent-self-approve.yml");

  for (const workflow of [implementWorkflow, reviewWorkflow, fixPrWorkflow, selfApprovalWorkflow]) {
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
  const updateWorkflow = readRepoFile(".github/workflows/agent-update.yml");
  const reviewWorkflow = readRepoFile(".github/workflows/agent-review.yml");
  const selfApprovalWorkflow = readRepoFile(".github/workflows/agent-self-approve.yml");
  const autonomousWorkflows = [
    updateWorkflow,
    readRepoFile(".github/workflows/agent-daily-summary.yml"),
    readRepoFile(".github/workflows/agent-memory-bootstrap.yml"),
    readRepoFile(".github/workflows/agent-memory-pr-closed.yml"),
    readRepoFile(".github/workflows/agent-memory-scan.yml"),
    readRepoFile(".github/workflows/agent-rubrics-initialization.yml"),
    readRepoFile(".github/workflows/agent-rubrics-review.yml"),
    readRepoFile(".github/workflows/agent-rubrics-update.yml"),
  ];
  const resolverAction = readRepoFile(".github/actions/resolve-agent-provider/action.yml");
  const resolverImplementation = readRepoFile(".github/actions/resolve-agent-provider/resolve-provider.js");
  const configurationList = readRepoFile(".agent/docs/customization/configuration-list.md");

  assert.match(resolverAction, /node "\$\{GITHUB_ACTION_PATH\}\/resolve-provider\.js"/);
  assert.doesNotMatch(resolverAction, /resolve-provider\.sh/);
  assert.match(resolverAction, /model_policy:/);
  assert.doesNotMatch(resolverAction, /display_model:/);
  assert.match(resolverImplementation, /DEFAULT_PROVIDER/);
  assert.match(resolverImplementation, /AGENT_MODEL_POLICY/);
  assert.match(resolverImplementation, /\.agent\/model-defaults\.json/);
  assert.match(resolverImplementation, /OPENAI_API_KEY/);
  assert.match(resolverImplementation, /CLAUDE_CODE_OAUTH_TOKEN/);
  assert.match(resolverImplementation, /ANTHROPIC_API_KEY/);
  assert.match(resolverImplementation, /provider = "codex"/);
  assert.match(resolverImplementation, /provider = "claude"/);

  assert.match(routerWorkflow, /default:\s*auto/);
  assert.doesNotMatch(routerWorkflow, /vars\.AGENT_PROVIDER_(DISPATCH|ANSWER|SKILL)/);
  assert.match(routerWorkflow, /required:\s*"false"/);
  assert.match(routerWorkflow, /id:\s*dispatch_provider/);
  assert.match(routerWorkflow, /id:\s*skill_provider/);
  assert.match(routerWorkflow, /agent:\s*\$\{\{\s*steps\.dispatch_provider\.outputs\.provider\s*\}\}/);
  assert.match(routerWorkflow, /agent:\s*\$\{\{\s*steps\.skill_provider\.outputs\.provider\s*\}\}/);
  assert.match(routerWorkflow, /agent:\s*\$\{\{\s*steps\.provider\.outputs\.provider\s*\}\}/);
  assert.match(routerWorkflow, /display_model:\s*\$\{\{\s*vars\.AGENT_DISPLAY_MODEL \|\| ''\s*\}\}/);
  assert.doesNotMatch(routerWorkflow, /outputs\.display_model/);

  for (const workflow of [implementWorkflow, fixPrWorkflow, selfApprovalWorkflow, ...autonomousWorkflows]) {
    assert.match(workflow, /uses: \.\/\.github\/actions\/resolve-agent-provider/);
    assert.match(workflow, /default_provider:\s*\$\{\{\s*vars\.AGENT_DEFAULT_PROVIDER \|\|/);
    assert.match(workflow, /model_policy:\s*\$\{\{\s*vars\.AGENT_MODEL_POLICY \|\| ''\s*\}\}/);
    assert.match(workflow, /install_codex:\s*\$\{\{\s*steps\.provider\.outputs\.install_codex\s*\}\}/);
    assert.match(workflow, /install_claude:\s*\$\{\{\s*steps\.provider\.outputs\.install_claude\s*\}\}/);
    assert.match(workflow, /agent:\s*\$\{\{\s*steps\.provider\.outputs\.provider\s*\}\}/);
    assert.match(workflow, /model:\s*\$\{\{\s*steps\.provider\.outputs\.model\s*\}\}/);
    assert.match(workflow, /display_model:\s*\$\{\{\s*vars\.AGENT_DISPLAY_MODEL \|\| ''\s*\}\}/);
    assert.doesNotMatch(workflow, /outputs\.display_model/);
    assert.match(workflow, /claude_oauth_token:\s*\$\{\{\s*secrets\.CLAUDE_CODE_OAUTH_TOKEN\s*\}\}/);
    assert.match(workflow, /anthropic_api_key:\s*\$\{\{\s*secrets\.ANTHROPIC_API_KEY\s*\}\}/);
  }

  assert.match(fixPrWorkflow, /lane:\s*fix-pr-\$\{\{\s*steps\.provider\.outputs\.provider\s*\}\}/);
  assert.match(reviewWorkflow, /name:\s*Resolve synthesis provider/);
  assert.match(reviewWorkflow, /id:\s*synthesis_provider/);
  assert.match(reviewWorkflow, /route:\s*review-synthesize/);
  assert.match(reviewWorkflow, /default_provider:\s*\$\{\{\s*vars\.AGENT_DEFAULT_PROVIDER \|\| 'auto'\s*\}\}/);
  assert.match(reviewWorkflow, /model_policy:\s*\$\{\{\s*vars\.AGENT_MODEL_POLICY \|\| ''\s*\}\}/);
  assert.match(reviewWorkflow, /install_codex:\s*\$\{\{\s*steps\.synthesis_provider\.outputs\.install_codex\s*\}\}/);
  assert.match(reviewWorkflow, /install_claude:\s*\$\{\{\s*steps\.synthesis_provider\.outputs\.install_claude\s*\}\}/);
  assert.match(reviewWorkflow, /agent:\s*\$\{\{\s*steps\.synthesis_provider\.outputs\.provider\s*\}\}/);
  assert.match(reviewWorkflow, /model:\s*\$\{\{\s*steps\.synthesis_provider\.outputs\.model\s*\}\}/);
  assert.match(reviewWorkflow, /display_model:\s*\$\{\{\s*vars\.AGENT_DISPLAY_MODEL \|\| ''\s*\}\}/);
  assert.doesNotMatch(reviewWorkflow, /outputs\.display_model/);
  assert.match(reviewWorkflow, /reasoning_effort:\s*\$\{\{\s*steps\.synthesis_provider\.outputs\.reasoning_effort \|\| \(steps\.synthesis_provider\.outputs\.provider == 'claude' && 'max' \|\| 'xhigh'\)\s*\}\}/);
  assert.match(reviewWorkflow, /openai_api_key:\s*\$\{\{\s*secrets\.OPENAI_API_KEY\s*\}\}/);
  assert.match(reviewWorkflow, /anthropic_api_key:\s*\$\{\{\s*secrets\.ANTHROPIC_API_KEY\s*\}\}/);
  assert.match(configurationList, /AGENT_DISPLAY_MODEL[\s\S]*Defaults to `true`; set to `false` to hide the footer\./);
  assert.match(reviewWorkflow, /name:\s*Resolve reviewer provider/);
  assert.match(reviewWorkflow, /id:\s*reviewer_provider/);
  assert.match(reviewWorkflow, /route:\s*review/);
  assert.match(reviewWorkflow, /route_provider:\s*\$\{\{\s*matrix\.agent\s*\}\}/);
  assert.match(reviewWorkflow, /install_codex:\s*\$\{\{\s*steps\.reviewer_provider\.outputs\.install_codex\s*\}\}/);
  assert.match(reviewWorkflow, /install_claude:\s*\$\{\{\s*steps\.reviewer_provider\.outputs\.install_claude\s*\}\}/);
  const reviewerRunBlock = reviewWorkflow.match(
    /- name: Run \$\{\{ matrix\.agent \}\} review[\s\S]*?(?=\n      - name: Persist review artifacts)/,
  )?.[0] || "";
  assert.doesNotMatch(reviewerRunBlock, /model_policy:/);
  assert.match(reviewerRunBlock, /agent:\s*\$\{\{\s*steps\.reviewer_provider\.outputs\.provider\s*\}\}/);
  assert.match(reviewerRunBlock, /model:\s*\$\{\{\s*steps\.reviewer_provider\.outputs\.model\s*\}\}/);
  assert.match(reviewerRunBlock, /reasoning_effort:\s*\$\{\{\s*steps\.reviewer_provider\.outputs\.reasoning_effort \|\| matrix\.reasoning_effort\s*\}\}/);
  assert.doesNotMatch(implementWorkflow, /vars\.AGENT_PROVIDER_IMPLEMENT/);
  assert.doesNotMatch(fixPrWorkflow, /vars\.AGENT_PROVIDER_FIX_PR/);

  assert.match(configurationList, /AGENT_DEFAULT_PROVIDER/);
  assert.match(configurationList, /AGENT_MODEL_POLICY/);
  assert.doesNotMatch(configurationList, /AGENT_PROVIDER_IMPLEMENT/);
});

test("packaged Sepo workflows have a global AGENT_ENABLED job guard", () => {
  const workflowFiles = readdirSync(path.join(repoRoot, ".github/workflows"))
    .filter((file) => file.startsWith("agent-") && file.endsWith(".yml"))
    .sort();
  const guardPattern = /vars\.AGENT_ENABLED\s*!=\s*'false'/;

  assert.ok(workflowFiles.length > 0, "expected packaged agent workflows");
  assert.ok(!workflowFiles.includes("test-scripts.yml"));

  for (const file of workflowFiles) {
    const workflowPath = `.github/workflows/${file}`;
    const workflow = parseYaml(readRepoFile(workflowPath)) as unknown;
    assert.ok(isRecord(workflow), `${workflowPath} should parse as a YAML object`);
    assert.ok(isRecord(workflow.jobs), `${workflowPath} should define jobs`);

    for (const [jobId, job] of Object.entries(workflow.jobs)) {
      assert.ok(isRecord(job), `${workflowPath} job ${jobId} should be an object`);
      const jobIf = job.if;
      if (typeof jobIf !== "string") {
        assert.fail(`${workflowPath} job ${jobId} should define a job-level pause guard`);
      }
      assert.match(
        jobIf,
        guardPattern,
        `${workflowPath} job ${jobId} should check AGENT_ENABLED before running`,
      );
    }
  }

  const actionTemplate = parseYaml(
    readRepoFile(".agent/action-templates/agent-action-template.yml"),
  ) as unknown;
  assert.ok(isRecord(actionTemplate), "agent action template should parse as a YAML object");
  assert.ok(isRecord(actionTemplate.jobs), "agent action template should define jobs");
  const runJob = actionTemplate.jobs.run;
  assert.ok(isRecord(runJob), "agent action template should define the run job");
  const runJobIf = runJob.if;
  if (typeof runJobIf !== "string") {
    assert.fail("agent action template run job should define a job-level pause guard");
  }
  assert.match(runJobIf, guardPattern);

  const configurationList = readRepoFile(".agent/docs/customization/configuration-list.md");
  const supportedWorkflows = readRepoFile(".agent/docs/usage/supported-workflows.md");
  const agentActions = readRepoFile(".agent/docs/usage/agent-actions.md");
  const memoryDocs = readRepoFile(".agent/docs/architecture/memory.md");
  const docsIndex = readRepoFile(".agent/docs/index.md");

  assert.match(configurationList, /`AGENT_ENABLED`[\s\S]*Global Sepo pause switch/);
  assert.match(supportedWorkflows, /All packaged `agent-\*\.yml` workflow jobs honor `AGENT_ENABLED=false`/);
  assert.match(agentActions, /template includes the same `AGENT_ENABLED=false` job/);
  assert.match(memoryDocs, /pause all Sepo workflow entry points[\s\S]*`AGENT_ENABLED`/);
  assert.match(docsIndex, /AGENT_ENABLED=false/);
});

test("scheduled workflows evaluate skip gates before provider-dependent jobs", () => {
  const dailySummaryWorkflow = readRepoFile(".github/workflows/agent-daily-summary.yml");
  const memoryScanWorkflow = readRepoFile(".github/workflows/agent-memory-scan.yml");
  const memorySyncWorkflow = readRepoFile(".github/workflows/agent-memory-sync.yml");
  const updateWorkflow = readRepoFile(".github/workflows/agent-update.yml");
  const updatePrompt = readRepoFile(".github/prompts/agent-update.md");
  const gateAction = readRepoFile(".github/actions/scheduled-activity-gate/action.yml");

  assert.match(gateAction, /\.agent\/scripts\/resolve-scheduled-activity-gate\.sh/);
  assert.doesNotMatch(gateAction, /resolve-gate\.js/);
  assert.doesNotMatch(gateAction, /\.agent\/dist\/cli\/resolve-scheduled-activity-gate\.js/);

  assert.match(memoryScanWorkflow, /gate:\n[\s\S]*Resolve scheduled activity gate/);
  assert.match(memoryScanWorkflow, /scan:\n\s+needs: gate\n\s+if: vars\.AGENT_ENABLED != 'false' && needs\.gate\.outputs\.skip != 'true'/);
  assert.match(memoryScanWorkflow, /Resolve memory scan provider[\s\S]*Setup agent runtime/);
  assert.doesNotMatch(memoryScanWorkflow, /if: steps\.gate\.outputs\.skip != 'true'/);

  assert.match(memorySyncWorkflow, /gate:\n[\s\S]*Resolve scheduled activity gate/);
  assert.match(memorySyncWorkflow, /sync:\n\s+needs: gate\n\s+if: vars\.AGENT_ENABLED != 'false' && needs\.gate\.outputs\.skip != 'true'/);
  assert.doesNotMatch(memorySyncWorkflow, /if: steps\.gate\.outputs\.skip != 'true'/);

  assert.match(updateWorkflow, /gate:\n[\s\S]*Resolve scheduled activity gate/);
  assert.match(updateWorkflow, /vars\.AGENT_AUTO_UPDATE == 'false'/);
  assert.match(updateWorkflow, /"workflow_overrides":\{"agent-update\.yml":"disabled"\}/);
  assert.doesNotMatch(updateWorkflow, /Resolve canonical source guard/);
  assert.match(updateWorkflow, /Check pending update PR[\s\S]*if: steps\.schedule\.outputs\.skip != 'true'[\s\S]*resolve-pending-update-pr\.sh/);
  assert.match(updateWorkflow, /IGNORE_EXISTING_UPDATE_PR:\s*\$\{\{ inputs\.force && 'true' \|\| 'false' \}\}/);
  assert.match(updateWorkflow, /update:\n\s+needs: gate\n\s+if: vars\.AGENT_ENABLED != 'false' && needs\.gate\.outputs\.skip != 'true'/);
  assert.match(updateWorkflow, /existing_pr_branch: \$\{\{ steps\.pending\.outputs\.branch \}\}/);
  assert.match(updateWorkflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.doesNotMatch(updateWorkflow, /ref: \$\{\{ needs\.gate\.outputs\.existing_pr_branch/);
  assert.match(updateWorkflow, /Resolve update target checkout[\s\S]*git worktree add -B "\$\{EXISTING_PR_BRANCH\}"/);
  assert.match(updateWorkflow, /Resolve update provider[\s\S]*Setup agent runtime/);
  assert.match(updateWorkflow, /source_ref:[\s\S]*default:\s*""/);
  assert.match(updateWorkflow, /UPDATE_SOURCE_REF:\s*\$\{\{\s*inputs\.source_ref \|\| ''\s*\}\}/);
  assert.match(updateWorkflow, /Resolve update source[\s\S]*resolve-update-source\.sh/);
  assert.match(updateWorkflow, /Write update source summary[\s\S]*Sepo update source:/);
  assert.doesNotMatch(updateWorkflow, /Render update request/);
  assert.match(updateWorkflow, /runtime checkout path: \$\{\{ github\.workspace \}\}/);
  assert.match(updateWorkflow, /update target path: \$\{\{ steps\.update_target\.outputs\.path \}\}/);
  assert.match(updateWorkflow, /update target mode: \$\{\{ steps\.update_target\.outputs\.mode \}\}/);
  assert.match(updateWorkflow, /source agent repo\/ref: \$\{\{ steps\.update_source\.outputs\.source_repo \}\}@\$\{\{ steps\.update_source\.outputs\.source_ref \}\}/);
  assert.match(updateWorkflow, /source agent SHA: \$\{\{ steps\.update_source\.outputs\.source_sha \}\}/);
  assert.match(updateWorkflow, /existing update PR number: \$\{\{ needs\.gate\.outputs\.existing_pr_number \|\| 'none' \}\}/);
  assert.match(updateWorkflow, /existing update PR branch: \$\{\{ needs\.gate\.outputs\.existing_pr_branch \|\| 'none' \}\}/);
  assert.match(updateWorkflow, /Runtime actions and scripts are loaded from the default-branch checkout/);
  assert.match(updateWorkflow, /update that branch and PR in the update target path/);
  assert.match(updateWorkflow, /do not check out the existing PR branch in[\s\S]*the runtime checkout path/);
  assert.match(updateWorkflow, /Update Sepo from <installed version\/ref> to \$\{\{ steps\.update_source\.outputs\.source_ref \}\}\/\$\{\{ steps\.update_source\.outputs\.source_sha \}\}/);
  assert.match(updateWorkflow, /Resolve task timeout[\s\S]*ROUTE: update-agent[\s\S]*resolve-task-timeout\.js/);
  assert.match(
    updateWorkflow,
    /Run update agent\n\s+id: agent\n\s+timeout-minutes: \$\{\{ fromJson\(steps\.task_timeout\.outputs\.minutes \|\| '30'\) \}\}/,
  );
  assert.match(updateWorkflow, /prompt:\s*agent-update/);
  assert.match(updateWorkflow, /route:\s*update-agent/);
  assert.match(updateWorkflow, /rubrics_mode_override:\s*disabled/);
  assert.doesNotMatch(updateWorkflow, /skill:\s*update-agent/);
  assert.match(updatePrompt, /first-class internal `update-agent` route/);
  assert.match(updatePrompt, /must not depend on `\.skills\/update-agent\/SKILL\.md`/);
  assert.doesNotMatch(updateWorkflow, /if: steps\.gate\.outputs\.skip != 'true'/);

  assert.match(dailySummaryWorkflow, /pre_gate:\n[\s\S]*Resolve scheduled disabled gate/);
  assert.match(dailySummaryWorkflow, /signals:\n\s+needs: pre_gate\n\s+if: vars\.AGENT_ENABLED != 'false' && needs\.pre_gate\.outputs\.skip != 'true'/);
  assert.match(
    dailySummaryWorkflow,
    /daily-summary:\n\s+needs: signals\n\s+if: >-\n\s+vars\.AGENT_ENABLED != 'false' &&\n\s+needs\.signals\.result == 'success' &&\n\s+needs\.signals\.outputs\.skip != 'true'/,
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

test("project manager defaults label application on behind dry-run", () => {
  const projectManagerWorkflow = readRepoFile(".github/workflows/agent-project-manager.yml");
  const applyLabelsCli = readRepoFile(".agent/src/cli/apply-project-management-labels.ts");
  const configurationList = readRepoFile(".agent/docs/customization/configuration-list.md");
  const supportedWorkflows = readRepoFile(".agent/docs/usage/supported-workflows.md");

  assert.match(projectManagerWorkflow, /apply_labels:[\s\S]*default:\s*"true"/);
  assert.match(
    projectManagerWorkflow,
    /RAW_APPLY_LABELS:\s*\$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.apply_labels \|\| vars\.AGENT_PROJECT_MANAGEMENT_APPLY_LABELS \|\| 'true' \}\}/,
  );
  assert.match(projectManagerWorkflow, /apply_labels="\$\(normalize_bool "\$RAW_APPLY_LABELS" true\)"/);
  assert.match(applyLabelsCli, /boolEnv\("AGENT_PROJECT_MANAGEMENT_APPLY_LABELS", true\)/);
  assert.match(configurationList, /AGENT_PROJECT_MANAGEMENT_APPLY_LABELS[\s\S]*Defaults to `true`/);
  assert.match(supportedWorkflows, /Label application defaults enabled[\s\S]*dry-run mode defaults enabled/);
});

test("review workflow forwards requested_by to review, rubrics, and synthesis runs", () => {
  const reviewWorkflow = readRepoFile(".github/workflows/agent-review.yml");
  const forwardedValue = /requested_by:\s*\$\{\{\s*inputs\.requested_by \|\| github\.actor\s*\}\}/g;
  const matches = reviewWorkflow.match(forwardedValue) || [];

  assert.equal(matches.length, 3);
});

test("review workflow captures reviewed head as best-effort prepare output", () => {
  const workflow = parseYaml(readRepoFile(".github/workflows/agent-review.yml")) as unknown;
  assert.ok(isRecord(workflow), "review workflow should parse as a YAML object");
  assert.ok(isRecord(workflow.jobs), "review workflow should define jobs");

  const prepareJob = workflow.jobs.prepare;
  assert.ok(isRecord(prepareJob), "review workflow should define prepare job");
  assert.ok(isRecord(prepareJob.outputs), "prepare job should define outputs");
  assert.equal(prepareJob.outputs.reviewed_head_sha, "${{ steps.capture.outputs.head_sha }}");
  assert.ok(Array.isArray(prepareJob.steps), "prepare job should define steps");

  const captureStep = prepareJob.steps.find(
    (step): step is Record<string, unknown> => isRecord(step) && step.id === "capture",
  );
  assert.ok(captureStep, "prepare job should capture the reviewed head");
  assert.equal(captureStep["continue-on-error"], true);
  assert.equal(captureStep.run, "node .agent/dist/cli/capture-pr-head.js");
  assert.ok(isRecord(captureStep.env), "capture step should define env");
  assert.equal(captureStep.env.TARGET_NUMBER, "${{ inputs.pr_number }}");

  const reviewJob = workflow.jobs.review;
  assert.ok(isRecord(reviewJob), "review workflow should define review job");
  assert.deepEqual(reviewJob.needs, ["prepare"]);
  assert.equal(reviewJob.if, "${{ vars.AGENT_ENABLED != 'false' && !cancelled() }}");

  const rubricsReviewJob = workflow.jobs["rubrics-review"];
  assert.ok(isRecord(rubricsReviewJob), "review workflow should define rubrics-review job");
  assert.equal(rubricsReviewJob.needs, undefined);

  const synthesizeJob = workflow.jobs.synthesize;
  assert.ok(isRecord(synthesizeJob), "review workflow should define synthesize job");
  assert.deepEqual(synthesizeJob.needs, ["prepare", "review"]);
  assert.ok(Array.isArray(synthesizeJob.steps), "synthesize job should define steps");

  const postCommentStep = synthesizeJob.steps.find(
    (step): step is Record<string, unknown> => isRecord(step) && step.name === "Post review comment",
  );
  assert.ok(postCommentStep, "synthesize job should post the review comment");
  assert.ok(isRecord(postCommentStep.env), "post review comment step should define env");
  assert.equal(
    postCommentStep.env.REVIEWED_HEAD_SHA,
    "${{ needs.prepare.outputs.reviewed_head_sha }}",
  );
});

test("self-approval workflow stays opt-in and read-only until deterministic resolution", () => {
  const workflowText = readRepoFile(".github/workflows/agent-self-approve.yml");
  const workflow = parseYaml(workflowText) as unknown;
  assert.ok(isRecord(workflow), "self-approval workflow should parse as a YAML object");
  assert.ok(isRecord(workflow.jobs), "self-approval workflow should define jobs");
  const job = workflow.jobs["self-approve"];
  assert.ok(isRecord(job), "self-approval workflow should define self-approve job");
  assert.ok(Array.isArray(job.steps), "self-approval job should define steps");
  assert.match(workflowText, /permissions:\s*\n\s+actions:\s*read/);

  const runStep = job.steps.find(
    (step): step is Record<string, unknown> =>
      isRecord(step) && step.name === "Run self-approval agent",
  );
  assert.ok(runStep, "self-approval workflow should run the agent");
  assert.ok(isRecord(runStep.with), "self-approval run step should define inputs");
  assert.equal(runStep.with.permission_mode, "approve-all");
  assert.equal(runStep.with.route, "agent-self-approve");
  assert.equal(runStep.with.github_token, "${{ github.token }}");
  assert.match(workflowText, /AGENT_ALLOW_SELF_APPROVE:\s*\$\{\{\s*vars\.AGENT_ALLOW_SELF_APPROVE \|\| 'false'\s*\}\}/);
  assert.match(workflowText, /AGENT_ALLOW_SELF_MERGE:\s*\$\{\{\s*vars\.AGENT_ALLOW_SELF_MERGE \|\| 'false'\s*\}\}/);
  assert.match(workflowText, /node \.agent\/dist\/cli\/prepare-self-approve\.js/);
  assert.match(workflowText, /node \.agent\/dist\/cli\/resolve-self-approve\.js/);
  assert.match(workflowText, /Post self-approval stop[\s\S]*always\(\)[\s\S]*steps\.prepare\.outcome == 'success'[\s\S]*steps\.prepare\.outputs\.should_run != 'true'[\s\S]*steps\.prepare\.outputs\.body_file != ''/);
  assert.match(workflowText, /Resolve self-approval result[\s\S]*always\(\)/);
  assert.match(workflowText, /Post self-approval status[\s\S]*always\(\)[\s\S]*steps\.result\.outcome == 'failure'[\s\S]*steps\.result\.outputs\.status_post == 'true'/);
  assert.match(workflowText, /actions\/upload-artifact@v4/);
  assert.match(workflowText, /agent-self-approve-result-\$\{\{ inputs\.pr_number \}\}/);
  assert.match(workflowText, /if-no-files-found:\s*ignore/);
  assert.doesNotMatch(workflowText, /steps\.result\.outputs\.conclusion == 'request_changes'/);
  assert.match(workflowText, /steps\.result\.outcome == 'success' &&\s+inputs\.orchestration_enabled == 'true'/);
  assert.match(workflowText, /node \.agent\/dist\/cli\/dispatch-agent-orchestrator\.js/);
});

test("self-merge workflow stays opt-in and deterministic", () => {
  const workflowText = readRepoFile(".github/workflows/agent-self-merge.yml");
  const workflow = parseYaml(workflowText) as unknown;
  assert.ok(isRecord(workflow), "self-merge workflow should parse as a YAML object");
  assert.ok(isRecord(workflow.jobs), "self-merge workflow should define jobs");
  const job = workflow.jobs["self-merge"];
  assert.ok(isRecord(job), "self-merge workflow should define self-merge job");
  assert.ok(Array.isArray(job.steps), "self-merge job should define steps");
  assert.match(workflowText, /permissions:\s*\n\s+actions:\s*read[\s\S]*contents:\s*write[\s\S]*pull-requests:\s*write/);
  assert.match(workflowText, /ref:\s*\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}/);
  assert.match(workflowText, /AGENT_ALLOW_SELF_MERGE:\s*\$\{\{\s*vars\.AGENT_ALLOW_SELF_MERGE \|\| 'false'\s*\}\}/);
  assert.match(workflowText, /node \.agent\/dist\/cli\/resolve-self-merge\.js/);
  assert.doesNotMatch(workflowText, /uses: \.\/\.github\/actions\/run-agent-task/);
  assert.match(workflowText, /Post self-merge status[\s\S]*steps\.result\.outputs\.status_post == 'true'/);
  assert.match(workflowText, /agent-self-merge-result-\$\{\{ inputs\.pr_number \}\}/);
  assert.match(workflowText, /SOURCE_ACTION:\s*agent-self-merge/);
});

test("review synthesis uses a shared reviews directory contract", () => {
  const reviewWorkflow = readRepoFile(".github/workflows/agent-review.yml");
  const reviewPrompt = readRepoFile(".github/prompts/review.md");
  const synthesisPrompt = readRepoFile(".github/prompts/review-synthesize.md");
  const runSource = readRepoFile(".agent/src/run.ts");
  const configurationList = readRepoFile(".agent/docs/customization/configuration-list.md");
  const supportedWorkflows = readRepoFile(".agent/docs/usage/supported-workflows.md");

  assert.match(reviewWorkflow, /review:\n\s*# Ordering-only:[\s\S]*?needs:\s*\[prepare\]\n\s*if:\s*\$\{\{\s*vars\.AGENT_ENABLED != 'false' && !cancelled\(\)\s*\}\}\n\s*# Reviewer lanes are best-effort[\s\S]*?continue-on-error:\s*true/);
  assert.match(reviewWorkflow, /synthesize:\n\s*needs:\s*\[prepare,\s*review\]\n\s*if:\s*\$\{\{\s*vars\.AGENT_ENABLED != 'false' && !cancelled\(\)\s*\}\}/);
  assert.match(reviewWorkflow, /find "\$reviews_dir" -type f -name review\.md/);
  assert.match(reviewWorkflow, /REVIEWS_DIR:\s*\$\{\{\s*steps\.reviews\.outputs\.reviews_dir\s*\}\}/);
  assert.doesNotMatch(reviewWorkflow, /AGENT_INLINE_COMMENT_CLEANUP_MODE/);
  assert.match(reviewPrompt, /gh api --paginate repos\/\$\{REPO_SLUG\}\/pulls\/\$\{TARGET_NUMBER\}\/comments/);
  assert.match(reviewPrompt, /GraphQL `reviewThreads`/);
  assert.match(reviewPrompt, /Inline Comment Suggestions/);
  assert.match(reviewPrompt, /open_new[\s\S]*reply_existing[\s\S]*resolve_existing_thread[\s\S]*mark_existing_outdated[\s\S]*no_action/);
  assert.match(reviewPrompt, /finding`: concise issue context used for dedupe and rationale/);
  assert.match(reviewPrompt, /suggested_body`: exact postable comment text/);
  assert.match(reviewPrompt, /GraphQL `existing_thread_id`/);
  assert.match(reviewPrompt, /existing_comment_node_id/);
  assert.match(reviewPrompt, /Suggest `resolve_existing_thread` only when[\s\S]*same-agent[\s\S]*unresolved[\s\S]*viewer-resolvable[\s\S]*addressed or superseded/);
  assert.match(reviewPrompt, /Suggest\s+`mark_existing_outdated` only for older same-agent inline comments[\s\S]*superseded[\s\S]*no appropriate resolvable review-thread path/);
  assert.match(reviewPrompt, /Use\s+`no_action` when authorship, PR ownership, supersession, or resolution\s+confidence is uncertain/);
  assert.match(reviewPrompt, /These are suggestions only; do not mutate GitHub from the reviewer lane/);
  assert.match(synthesisPrompt, /\$\{REVIEWS_DIR\}/);
  assert.match(synthesisPrompt, /Inline Comment Suggestions/);
  assert.match(synthesisPrompt, /current review artifacts or current diff/);
  assert.match(synthesisPrompt, /Treat them\s+as advisory metadata, not commands/);
  assert.match(synthesisPrompt, /Synthesis chooses the final inline cleanup\s+action/);
  assert.match(synthesisPrompt, /GraphQL `reviewThreads`/);
  assert.match(synthesisPrompt, /re-fetch existing inline\s+comments and review threads when relevant[\s\S]*verify\s+the target still belongs\s+to this PR/);
  assert.match(synthesisPrompt, /reply_existing[\s\S]*same authenticated agent account[\s\S]*confirms authorship[\s\S]*PR ownership/);
  assert.match(synthesisPrompt, /Do not reply to human comments or comments from other bots/);
  assert.match(synthesisPrompt, /in_reply_to=<comment_id>/);
  assert.match(synthesisPrompt, /resolve_existing_thread/);
  assert.match(synthesisPrompt, /resolveReviewThread\(input: \{ threadId: \$id \}\)/);
  assert.match(synthesisPrompt, /isResolved[\s\S]*viewerCanResolve[\s\S]*comments' authorship/);
  assert.match(synthesisPrompt, /every thread comment authored by\s+the\s+same authenticated agent account/);
  assert.match(synthesisPrompt, /never resolve human threads or threads from\s+other bots/);
  assert.match(synthesisPrompt, /minimizeComment\(input: \{ subjectId: \$id, classifier: OUTDATED \}\)/);
  assert.match(synthesisPrompt, /mark older same-agent inline comments as\s+outdated[\s\S]*supersedes them[\s\S]*no\s+appropriate resolvable same-agent review-thread path/);
  assert.match(synthesisPrompt, /Prefer thread\s+resolution over minimization/);
  assert.match(synthesisPrompt, /Only minimize comments\s+authored by the same authenticated\s+agent account/);
  assert.match(synthesisPrompt, /never minimize\s+human comments or comments from other\s+bots/);
  assert.match(synthesisPrompt, /do not delete inline comments/);
  assert.match(synthesisPrompt, /do not reply to, resolve, or minimize anything when authorship, PR ownership,\s+supersession, or resolution confidence is uncertain/);
  assert.match(synthesisPrompt, /Progress` section/);
  assert.match(runSource, /"REVIEWS_DIR"/);
  assert.match(runSource, /"MEMORY_DIR"/);
  assert.doesNotMatch(runSource, /"AGENT_INLINE_COMMENT_CLEANUP_MODE"/);
  assert.doesNotMatch(configurationList, /AGENT_INLINE_COMMENT_CLEANUP_MODE/);
  assert.doesNotMatch(supportedWorkflows, /AGENT_INLINE_COMMENT_CLEANUP_MODE/);
  assert.doesNotMatch(reviewPrompt, /AGENT_INLINE_COMMENT_CLEANUP_MODE|inline cleanup mode/);
  assert.doesNotMatch(synthesisPrompt, /AGENT_INLINE_COMMENT_CLEANUP_MODE|inline cleanup mode/);
  assert.doesNotMatch(runSource, /PROMPT_VAR_MEMORY_/);
});

test("agent router bypasses dispatch triage for explicit mention slash routes", () => {
  const runnerWorkflow = readRepoFile(".github/workflows/agent-router.yml");
  const extractContext = readRepoFile(".agent/src/cli/extract-context.ts");
  const resolveDispatch = readRepoFile(".agent/src/cli/resolve-dispatch.ts");
  const implementMetadataPrompt = readRepoFile(".github/prompts/agent-implement-metadata.md");

  assert.match(extractContext, /setOutput\("requested_route", requestedRoute\)/);
  assert.match(
    runnerWorkflow,
    /steps\.context\.outputs\.should_respond == 'true'[\s\S]*steps\.context\.outputs\.requested_route == ''/,
  );
  assert.match(
    runnerWorkflow,
    /- name: Resolve explicit route authorization[\s\S]*steps\.context\.outputs\.requested_route == 'implement'[\s\S]*steps\.context\.outputs\.target_kind != 'issue'[\s\S]*id:\s*explicit_dispatch[\s\S]*node \.agent\/dist\/cli\/resolve-dispatch\.js/,
  );
  assert.match(
    runnerWorkflow,
    /- name: Generate implement issue metadata[\s\S]*steps\.explicit_dispatch\.outputs\.route == 'implement'[\s\S]*steps\.context\.outputs\.target_kind != 'issue'[\s\S]*continue-on-error:\s*true[\s\S]*permission_mode:\s*approve-all[\s\S]*prompt:\s*agent-implement-metadata/,
  );
  assert.match(
    runnerWorkflow,
    /RESPONSE_FILE:\s*\$\{\{\s*steps\.followup_intent\.outputs\.response_file \|\| steps\.triage\.outputs\.response_file \|\| steps\.implement_metadata\.outputs\.response_file\s*\}\}/,
  );
  assert.match(runnerWorkflow, /REQUESTED_ROUTE:\s*\$\{\{\s*steps\.context\.outputs\.requested_route\s*\}\}/);
  assert.match(runnerWorkflow, /base_pr:\s*\$\{\{\s*steps\.dispatch\.outputs\.base_pr\s*\}\}/);
  assert.match(resolveDispatch, /buildRequestedRouteDecision/);
  assert.match(resolveDispatch, /normalizeImplementIssueMetadata/);
  assert.match(implementMetadataPrompt, /Do not derive the title by copying the literal text after `\/implement`/);
  assert.match(implementMetadataPrompt, /Ignore earlier prose mentions of `\/implement`/);
  assert.match(implementMetadataPrompt, /Omit `base_pr` unless `TARGET_KIND` is `pull_request`/);
  assert.match(implementMetadataPrompt, /If the current target pull request is closed or merged, omit `base_pr`/);
  assert.match(implementMetadataPrompt, /digits only, with no `#` prefix/);
  assert.doesNotMatch(extractContext, /requested_install_target_repo/);
  assert.doesNotMatch(runnerWorkflow, /requested_install_target_repo:/);
});

test("agent router preauthorizes implicit follow-up answer gates", () => {
  const entrypointWorkflow = readRepoFile(".github/workflows/agent-entrypoint.yml");
  const runnerWorkflow = readRepoFile(".github/workflows/agent-router.yml");

  assert.match(
    entrypointWorkflow,
    /github\.event_name == 'issue_comment' &&[\s\S]*github\.event\.action == 'created' &&[\s\S]*contains\(github\.event\.issue\.labels\.\*\.name, 'agent'\)/,
  );
  assert.match(
    entrypointWorkflow,
    /github\.event_name == 'pull_request_review_comment' &&[\s\S]*github\.event\.action == 'created' &&[\s\S]*contains\(github\.event\.pull_request\.labels\.\*\.name, 'agent'\)/,
  );
  assert.match(
    entrypointWorkflow,
    /github\.event_name == 'pull_request_review' &&[\s\S]*github\.event\.action == 'submitted' &&[\s\S]*contains\(github\.event\.pull_request\.labels\.\*\.name, 'agent'\)/,
  );

  const answerProviderIndex = runnerWorkflow.indexOf("- name: Resolve answer provider");
  const setupIndex = runnerWorkflow.indexOf("- name: Setup agent runtime");
  assert.ok(answerProviderIndex > 0, "portal should resolve the answer provider before setup");
  assert.ok(setupIndex > answerProviderIndex, "runtime setup should see answer provider install flags");
  assert.match(
    runnerWorkflow,
    /install_codex:\s*\$\{\{\s*\(steps\.provider\.outputs\.install_codex == 'true' \|\| steps\.answer_provider\.outputs\.install_codex == 'true'\) && 'true' \|\| 'false'\s*\}\}/,
  );
  assert.match(
    runnerWorkflow,
    /install_claude:\s*\$\{\{\s*\(steps\.provider\.outputs\.install_claude == 'true' \|\| steps\.answer_provider\.outputs\.install_claude == 'true'\) && 'true' \|\| 'false'\s*\}\}/,
  );

  const authIndex = runnerWorkflow.indexOf("- name: Authorize implicit follow-up answer");
  const followupProviderIndex = runnerWorkflow.indexOf("- name: Require follow-up intent provider");
  const intentIndex = runnerWorkflow.indexOf("- name: Run follow-up intent gate");
  const resolveRouteIndex = runnerWorkflow.indexOf("- name: Resolve route");
  assert.ok(authIndex > setupIndex, "authorization should run after context extraction is available");
  assert.ok(authIndex < followupProviderIndex, "authorization must happen before follow-up provider resolution");
  assert.ok(followupProviderIndex < intentIndex, "provider must resolve before the intent gate");

  const authBlock = runnerWorkflow.slice(authIndex, followupProviderIndex);
  assert.match(authBlock, /REQUESTED_ROUTE:\s*answer/);
  assert.match(authBlock, /node \.agent\/dist\/cli\/resolve-dispatch\.js/);
  assert.match(
    runnerWorkflow.slice(followupProviderIndex, intentIndex),
    /steps\.followup_authorization\.outputs\.route == 'answer'/,
  );
  assert.match(
    runnerWorkflow.slice(intentIndex, resolveRouteIndex),
    /steps\.followup_authorization\.outputs\.route == 'answer'/,
  );
  assert.match(
    runnerWorkflow.slice(resolveRouteIndex, runnerWorkflow.indexOf("- name: React with eyes", resolveRouteIndex)),
    /steps\.context\.outputs\.implicit_followup != 'true'[\s\S]*steps\.followup_authorization\.outputs\.route == 'answer'/,
  );
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
  assert.match(runnerWorkflow, /needs\.portal\.outputs\.route == 'install'/);
  assert.match(runnerWorkflow, /workflow_call:[\s\S]*outputs:[\s\S]*should_respond:/);
  assert.doesNotMatch(runnerWorkflow, /clear-trigger-label:/);
  assert.match(runnerWorkflow, /vars\.AGENT_RUNS_ON/);
  assert.match(extractContext, /resolveRequestedLabel/);
  assert.match(labelWorkflow, /issues:\s+types: \[labeled\]/);
  assert.match(labelWorkflow, /pull_request_target:\s+types: \[labeled\]/);
  assert.match(labelWorkflow, /startsWith\(github\.event\.label\.name, 'agent\/'\)/);
  assert.match(labelWorkflow, /cleanup-label:/);
  assert.match(labelWorkflow, /needs\.agent\.result == 'success'/);
  assert.match(labelWorkflow, /needs\.agent\.outputs\.should_respond == 'true'/);
  assert.match(labelWorkflow, /AGENT_INSTALL_PAT:\s*\$\{\{\s*secrets\.AGENT_INSTALL_PAT\s*\}\}/);
  assert.match(entrypointWorkflow, /AGENT_INSTALL_PAT:\s*\$\{\{\s*secrets\.AGENT_INSTALL_PAT\s*\}\}/);
  assert.match(labelWorkflow, /AGENT_SECONDARY_GITHUB_TOKEN:\s*\$\{\{\s*secrets\.AGENT_SECONDARY_GITHUB_TOKEN\s*\}\}/);
  assert.match(entrypointWorkflow, /AGENT_SECONDARY_GITHUB_TOKEN:\s*\$\{\{\s*secrets\.AGENT_SECONDARY_GITHUB_TOKEN\s*\}\}/);
  assert.match(runnerWorkflow, /AGENT_SECONDARY_GITHUB_TOKEN:[\s\S]*Optional read-only secondary token/);
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
  const supportedWorkflows = readRepoFile(".agent/docs/usage/supported-workflows.md");

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
  assert.match(
    implementJob,
    /BASE_PR:\s*\$\{\{\s*needs\.portal\.outputs\.base_pr\s*\}\}/,
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
  const selfApprovalWorkflow = readRepoFile(".github/workflows/agent-self-approve.yml");

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
  assert.match(selfApprovalWorkflow, /session_bundle_mode:[\s\S]*default:\s*""/);
  assert.match(selfApprovalWorkflow, /vars\.AGENT_SESSION_BUNDLE_MODE/);
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
  assert.match(fixPrWorkflow, /AGENT_COLLAPSE_OLD_REVIEWS:\s*\$\{\{ vars\.AGENT_COLLAPSE_OLD_REVIEWS \}\}/);
  const unsupportedFixPrStatusStart = fixPrWorkflow.indexOf("- name: Post unsupported status");
  const orchestrateHandoffStart = fixPrWorkflow.indexOf("- name: Orchestrate automation handoff");
  assert.ok(unsupportedFixPrStatusStart >= 0);
  assert.ok(orchestrateHandoffStart > unsupportedFixPrStatusStart);
  const unsupportedFixPrStatusStep = fixPrWorkflow.slice(
    unsupportedFixPrStatusStart,
    orchestrateHandoffStart,
  );
  assert.match(unsupportedFixPrStatusStep, /run: node \.agent\/dist\/cli\/post-comment\.js/);
  assert.match(unsupportedFixPrStatusStep, /AGENT_COLLAPSE_OLD_REVIEWS:\s*\$\{\{ vars\.AGENT_COLLAPSE_OLD_REVIEWS \}\}/);
  assert.match(unsupportedFixPrStatusStep, /COMMENT_TARGET:\s*pr/);
  assert.match(unsupportedFixPrStatusStep, /ROUTE:\s*fix-pr/);
  assert.match(unsupportedFixPrStatusStep, /STATUS:\s*unsupported/);
  assert.doesNotMatch(unsupportedFixPrStatusStep, /gh pr comment/);
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
  assert.match(action, /skill_root:/);
  assert.match(action, /model:/);
  assert.match(action, /display_model:/);
  const displayModelBlock = action.match(/display_model:[\s\S]*?(?=^  [a-z_]+:|^outputs:)/m)?.[0] || "";
  assert.match(displayModelBlock, /default:\s*"true"/);
  assert.match(action, /anthropic_api_key:/);
  assert.match(action, /lane:/);
  assert.match(action, /session_policy:/);
  const sessionPolicyBlock = action.match(/session_policy:[\s\S]*?(?=^  [a-z_]+:|^outputs:)/m)?.[0] || "";
  assert.match(sessionPolicyBlock, /required:\s*true/);
  assert.doesNotMatch(sessionPolicyBlock, /default:/);
  assert.match(action, /PROMPT_NAME/);
  assert.match(action, /SKILL_NAME/);
  assert.match(action, /SKILL_ROOT/);
  assert.match(action, /MODEL_ID/);
  assert.match(action, /DISPLAY_MODEL:\s*\$\{\{\s*inputs\.display_model \|\| 'true'\s*\}\}/);
  assert.match(action, /ANTHROPIC_API_KEY/);
  assert.match(action, /LANE/);
  assert.match(action, /SESSION_POLICY/);
  assert.match(action, /\.agent\/dist\/run\.js/);
});

test("shared run-agent-task exposes an optional secondary GitHub token", () => {
  const action = readRepoFile(".github/actions/run-agent-task/action.yml");
  const runtimeEnvSource = readRepoFile(".agent/src/runtime-env.ts");
  const basePrompt = readRepoFile(".github/prompts/_base.md");
  const parsedAction = parseYaml(action) as unknown;

  assert.ok(isRecord(parsedAction), "run-agent-task action should parse");
  assert.ok(isRecord(parsedAction.inputs), "run-agent-task should define inputs");
  const secondaryInput = parsedAction.inputs.secondary_github_token;
  assert.ok(isRecord(secondaryInput), "run-agent-task should define secondary_github_token");
  assert.equal(secondaryInput.required, false);
  assert.equal(secondaryInput.default, "");

  assert.ok(isRecord(parsedAction.runs), "run-agent-task should define runs");
  assert.ok(Array.isArray(parsedAction.runs.steps), "run-agent-task should define steps");
  const runStep = parsedAction.runs.steps.find(
    (step): step is Record<string, unknown> => isRecord(step) && step.name === "Run agent task",
  );
  assert.ok(runStep, "run-agent-task action should include the Run agent task step");
  assert.ok(isRecord(runStep.env), "Run agent task step should define env");
  assert.equal(
    runStep.env.INPUT_SECONDARY_GITHUB_TOKEN,
    "${{ inputs.secondary_github_token }}",
  );
  assert.equal(runStep.env.INPUT_GITHUB_TOKEN, "${{ inputs.github_token }}");

  assert.match(runtimeEnvSource, /INPUT_SECONDARY_GITHUB_TOKEN/);
  assert.doesNotMatch(
    runtimeEnvSource,
    /env\.GH_TOKEN\s*=\s*inputEnv\.INPUT_SECONDARY_GITHUB_TOKEN/,
  );
  assert.match(basePrompt, /INPUT_SECONDARY_GITHUB_TOKEN/);
  assert.match(basePrompt, /Do not print token values/);
  assert.match(basePrompt, /read-only credential for external GitHub repositories/);
  assert.match(basePrompt, /Do not use the secondary token for external writes/);
});

test("run-agent-task maps reasoning effort for Claude env and Codex thought level", () => {
  const action = readRepoFile(".github/actions/run-agent-task/action.yml");
  const runSource = readRepoFile(".agent/src/run.ts");
  const runtimeEnvSource = readRepoFile(".agent/src/runtime-env.ts");
  const acpxSource = readRepoFile(".agent/src/acpx-adapter.ts");

  assert.match(action, /reasoning_effort:\n\s+description: "Model reasoning effort level"/);
  assert.match(action, /MODEL_REASONING_EFFORT:\s*\$\{\{\s*inputs\.reasoning_effort\s*\}\}/);
  assert.match(runtimeEnvSource, /env\.MODEL_REASONING_EFFORT = inputEnv\.MODEL_REASONING_EFFORT/);
  assert.match(runtimeEnvSource, /env\.CLAUDE_CODE_EFFORT_LEVEL = inputEnv\.MODEL_REASONING_EFFORT/);
  assert.match(runSource, /thoughtLevel:\s*process\.env\.MODEL_REASONING_EFFORT/);
  assert.match(runSource, /parseBooleanFlag\(process\.env\.DISPLAY_MODEL, true\)/);
  assert.match(runSource, /CODEX_REASONING_MODEL_SUFFIX/);
  assert.match(runSource, /displayReasoningEffort/);
  assert.match(acpxSource, /"thought_level", thoughtLevel/);
});

test("run-agent-task callers pass secondary token without replacing primary auth", () => {
  const workflowPaths = readdirSync(path.join(repoRoot, ".github/workflows"))
    .filter((file) => file.endsWith(".yml"))
    .map((file) => `.github/workflows/${file}`)
    .concat(".agent/action-templates/agent-action-template.yml");
  let runTaskCount = 0;

  for (const workflowPath of workflowPaths) {
    const workflow = parseYaml(readRepoFile(workflowPath)) as unknown;
    assert.ok(isRecord(workflow), `${workflowPath} should parse as a YAML object`);
    const jobs = workflow.jobs;
    if (!isRecord(jobs)) continue;

    for (const [jobId, job] of Object.entries(jobs)) {
      if (!isRecord(job) || !Array.isArray(job.steps)) continue;
      for (const step of job.steps) {
        if (!isRecord(step) || step.uses !== "./.github/actions/run-agent-task") continue;
        runTaskCount += 1;
        assert.ok(isRecord(step.with), `${workflowPath} job ${jobId} run-agent-task needs with`);
        assert.ok(step.with.github_token, `${workflowPath} job ${jobId} keeps primary token`);
        if (workflowPath === ".github/workflows/agent-router.yml" && jobId === "install") {
          assert.equal(
            step.with.github_token,
            "${{ secrets.AGENT_INSTALL_PAT }}",
            "install route keeps its dedicated primary token",
          );
          assert.equal(
            step.with.secondary_github_token,
            undefined,
            "install route must not receive the general secondary token",
          );
          continue;
        }
        assert.notEqual(
          step.with.github_token,
          "${{ secrets.AGENT_SECONDARY_GITHUB_TOKEN }}",
          `${workflowPath} job ${jobId} must not replace primary auth with secondary token`,
        );
        assert.equal(
          step.with.secondary_github_token,
          "${{ secrets.AGENT_SECONDARY_GITHUB_TOKEN }}",
          `${workflowPath} job ${jobId} should pass optional secondary token`,
        );
      }
    }
  }

  assert.ok(runTaskCount > 0);
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

test("skill route uses the composite setup action for path and setup checks", () => {
  const runnerWorkflow = readRepoFile(".github/workflows/agent-router.yml");
  const setupAction = readRepoFile(".github/actions/run-skill-setup/action.yml");
  const runAgentTaskAction = readRepoFile(".github/actions/run-agent-task/action.yml");
  const runSource = readRepoFile(".agent/src/run.ts");
  const supplementalVars = readSupplementalPromptVarNames(runSource);
  const skillJobStart = runnerWorkflow.indexOf("  skill:\n    needs: portal");
  const installJobStart = runnerWorkflow.indexOf("  install:\n    needs: portal", skillJobStart);
  const approvalJobStart = runnerWorkflow.indexOf("  approval:", installJobStart);
  assert.ok(skillJobStart >= 0);
  assert.ok(installJobStart > skillJobStart);
  assert.ok(approvalJobStart > skillJobStart);
  const skillWorkflow = runnerWorkflow.slice(skillJobStart, installJobStart);
  const installWorkflow = runnerWorkflow.slice(installJobStart, approvalJobStart);
  const optionalProviderStart = skillWorkflow.indexOf("- name: Resolve skill provider");
  const runtimeStart = skillWorkflow.indexOf("- name: Setup agent runtime");
  const checkStart = skillWorkflow.indexOf("- name: Check skill");
  const requireProviderStart = skillWorkflow.indexOf("- name: Require skill provider");
  const setupStart = skillWorkflow.indexOf("- name: Run skill setup");

  assert.match(skillWorkflow, /\.\/\.github\/actions\/run-skill-setup/);
  assert.doesNotMatch(skillWorkflow, /needs\.portal\.outputs\.route == 'install'/);
  assert.match(runnerWorkflow, /AGENT_INSTALL_PAT:[\s\S]*Install-route machine-user token/);
  assert.doesNotMatch(skillWorkflow, /AGENT_INSTALL_PAT_CONFIGURED/);
  assert.doesNotMatch(skillWorkflow, /Post install configuration blocked response/);
  assert.doesNotMatch(skillWorkflow, /AGENT_INSTALL_PAT/);
  assert.match(skillWorkflow, /route:\s*skill/);
  assert.match(skillWorkflow, /ROUTE:\s*skill/);
  assert.match(skillWorkflow, /trusted_ref:\s*\$\{\{ !startsWith\(github\.ref, 'refs\/pull\/'\) \}\}/);
  assert.match(skillWorkflow, /skill_root:\s*\$\{\{ inputs\.skill_root \}\}/);
  assert.doesNotMatch(skillWorkflow, /install_target_repo:/);
  assert.match(skillWorkflow, /github_token:\s*\$\{\{\s*steps\.auth\.outputs\.token\s*\}\}/);
  assert.match(installWorkflow, /needs\.portal\.outputs\.route == 'install'/);
  assert.match(installWorkflow, /persist-credentials:\s*false/);
  assert.match(installWorkflow, /AGENT_INSTALL_PAT_CONFIGURED:\s*\$\{\{\s*secrets\.AGENT_INSTALL_PAT != '' && 'true' \|\| 'false'\s*\}\}/);
  assert.match(installWorkflow, /Post install configuration blocked response/);
  assert.match(installWorkflow, /Install is not configured/);
  assert.match(installWorkflow, /prompt:\s*agent-install/);
  assert.match(installWorkflow, /route:\s*install/);
  assert.match(installWorkflow, /ROUTE:\s*install/);
  assert.match(installWorkflow, /github_token:\s*\$\{\{\s*secrets\.AGENT_INSTALL_PAT\s*\}\}/);
  assert.match(installWorkflow, /memory_mode_override:\s*disabled/);
  assert.match(installWorkflow, /rubrics_mode_override:\s*disabled/);
  assert.match(installWorkflow, /id:\s*post_install_response/);
  assert.match(installWorkflow, /steps\.install\.outputs\.install_status == 'published'/);
  assert.match(installWorkflow, /node \.agent\/dist\/cli\/complete-install-request\.js/);
  assert.match(installWorkflow, /continue-on-error:\s*true/);
  assert.doesNotMatch(installWorkflow, /memory_policy:\s*\$\{\{\s*vars\.AGENT_MEMORY_POLICY/);
  assert.doesNotMatch(installWorkflow, /github_token:[^\n]*steps\.auth\.outputs\.token/);
  assert.doesNotMatch(installWorkflow, /\.\/\.github\/actions\/run-skill-setup/);
  assert.ok(optionalProviderStart >= 0);
  assert.ok(runtimeStart > optionalProviderStart);
  assert.ok(checkStart > runtimeStart);
  assert.ok(requireProviderStart > checkStart);
  assert.ok(setupStart > requireProviderStart);
  assert.match(skillWorkflow, /required:\s*"false"/);
  assert.doesNotMatch(skillWorkflow, /resolve-skill\.js/);
  assert.match(skillWorkflow, /run_setup:\s*"false"/);
  assert.match(skillWorkflow, /run_setup:\s*"true"/);
  assert.match(skillWorkflow, /steps\.skill_setup\.outcome == 'success'/);
  assert.match(skillWorkflow, /steps\.skill_check\.outputs\.exists == 'false'/);
  assert.match(setupAction, /name: Run Skill Setup/);
  assert.match(setupAction, /run_setup:/);
  assert.doesNotMatch(setupAction, /node \.agent\/dist\/cli\/run-skill-setup\.js/);
  assert.match(setupAction, /if \[ ! -f "\$skill_file" \]/);
  assert.match(setupAction, /if \[ ! -f "\$setup_file" \]/);
  assert.match(setupAction, /Refusing to run .*untrusted PR checkout/);
  assert.match(setupAction, /bash "\$setup_file"/);
  assert.doesNotMatch(runAgentTaskAction, /install_target_repo:/);
  assert.equal(supplementalVars.has("INSTALL_TARGET_REPO"), false);
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
  assert.match(oidcScript, /run_exchange_with_retries\(\)/);
  assert.match(oidcScript, /429\|500\|502\|503\|504/);
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
  const runSource = readRepoFile(".agent/src/run.ts");

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

  const parsedAction = parseYaml(action) as unknown;
  assert.ok(isRecord(parsedAction), "run-agent-task action should parse as a YAML object");
  assert.ok(isRecord(parsedAction.runs), "run-agent-task action should define runs");
  assert.ok(Array.isArray(parsedAction.runs.steps), "run-agent-task action should define steps");
  const runStep = parsedAction.runs.steps.find(
    (step): step is Record<string, unknown> => isRecord(step) && step.name === "Run agent task",
  );
  assert.ok(runStep, "run-agent-task action should include the Run agent task step");
  assert.ok(isRecord(runStep.env), "Run agent task step should define env");
  assert.equal(runStep.env.SESSION_BUNDLE_MODE, "${{ inputs.session_bundle_mode }}");
  assert.match(runSource, /parseSessionBundleMode\(process\.env\.SESSION_BUNDLE_MODE\)/);
  assert.match(
    runSource,
    /preserveExecSession:\s*sessionPolicy === "track-only" &&\s*shouldBackupSessionBundles\(sessionBundleMode, sessionPolicy\)/,
  );
});

test("workflows declare explicit session policies", () => {
  const runnerWorkflow = readRepoFile(".github/workflows/agent-router.yml");
  const fixPrWorkflow = readRepoFile(".github/workflows/agent-fix-pr.yml");
  const implementWorkflow = readRepoFile(".github/workflows/agent-implement.yml");
  const reviewWorkflow = readRepoFile(".github/workflows/agent-review.yml");
  const selfApprovalWorkflow = readRepoFile(".github/workflows/agent-self-approve.yml");

  assert.match(runnerWorkflow, /prompt:\s*dispatch[\s\S]*session_policy:\s*none/);
  assert.match(runnerWorkflow, /prompt:\s*answer[\s\S]*session_policy:\s*resume-best-effort/);
  assert.match(fixPrWorkflow, /prompt:\s*fix-pr[\s\S]*session_policy:\s*resume-best-effort/);
  assert.match(implementWorkflow, /prompt:\s*\$\{\{ env\.IMPLEMENTATION_PROMPT \}\}[\s\S]*session_fork_from_thread_key:\s*\$\{\{ inputs\.session_fork_from_thread_key \}\}/);
  assert.match(implementWorkflow, /route:\s*\$\{\{ env\.IMPLEMENTATION_ROUTE \}\}[\s\S]*session_policy:\s*\$\{\{ inputs\.session_fork_from_thread_key != '' && 'resume-best-effort' \|\| 'track-only' \}\}/);
  assert.match(reviewWorkflow, /prompt:\s*review[\s\S]*session_policy:\s*track-only/);
  assert.match(reviewWorkflow, /agent-rubrics-review\.yml/);
  assert.match(reviewWorkflow, /prompt:\s*review-synthesize[\s\S]*session_policy:\s*track-only/);
  assert.match(selfApprovalWorkflow, /prompt:\s*agent-self-approve[\s\S]*session_policy:\s*track-only/);
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
  const supportedWorkflows = readRepoFile(".agent/docs/usage/supported-workflows.md");
  const requestLifecycle = readRepoFile(".agent/docs/architecture/request-lifecycle.md");
  const configurationList = readRepoFile(".agent/docs/customization/configuration-list.md");
  const skillsDocs = readRepoFile(".agent/docs/customization/skills.md");
  const existingRepoInstall = readRepoFile(".agent/docs/setup/install-existing-repository.md");
  const installIssueTemplate = readMarkdownIssueTemplate(".github/ISSUE_TEMPLATE/install-sepo.md");
  const askIssueTemplate = readMarkdownIssueTemplate(".github/ISSUE_TEMPLATE/ask-sepo.md");
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
  assert.doesNotMatch(configurationList, /AGENT_INSTALL_PAT/);
  assert.match(configurationList, /AGENT_SECONDARY_GITHUB_TOKEN/);
  assert.match(configurationList, /INPUT_SECONDARY_GITHUB_TOKEN/);
  assert.match(supportedWorkflows, /INPUT_SECONDARY_GITHUB_TOKEN/);
  assert.match(supportedWorkflows, /read-only external repository inspection/);
  assert.match(supportedWorkflows, /deterministic write authorization/);
  assert.match(supportedWorkflows, /does not replace the primary same-repository\s+token/);
  assert.match(developerNotes, /AGENT_INSTALL_PAT/);
  assert.doesNotMatch(existingRepoInstall, /AGENT_INSTALL_PAT/);
  assert.match(existingRepoInstall, /public `\/install` route uses a dedicated install credential/);
  assert.match(existingRepoInstall, /Normal routes keep[\s\S]*GitHub auth resolver order/);
  assert.match(existingRepoInstall, /Install Sepo into another repository/);
  assert.match(existingRepoInstall, /source request issue[\s\S]*comment linking the install PR/);
  assert.equal(installIssueTemplate.frontMatter.name, "Install Sepo into another repository");
  assert.equal(
    installIssueTemplate.frontMatter.about,
    "Ask Sepo to open an install PR for a public target repository",
  );
  assert.equal(installIssueTemplate.frontMatter.title, "Install Sepo into target repository");
  assert.equal(installIssueTemplate.frontMatter.labels, "agent");
  assert.match(installIssueTemplate.body, /^@sepo-agent \/install\n/);
  assert.match(installIssueTemplate.body, /## Target public repository URL/);
  assert.match(installIssueTemplate.body, /Paste the public GitHub repository URL here/);
  assert.match(installIssueTemplate.body, /## Notes/);
  assert.doesNotMatch(String(installIssueTemplate.frontMatter.title || ""), /owner\/repo|OWNER\/REPO|<owner\/repo>/);
  const defaultInstallTarget = resolveInstallTargetFromText(installIssueTemplate.body);
  assert.equal(defaultInstallTarget.status, "missing");
  assert.equal(defaultInstallTarget.targetRepo, "");
  assert.equal(askIssueTemplate.frontMatter.name, "Ask Sepo");
  assert.equal(askIssueTemplate.frontMatter.about, "Ask Sepo a question about this repository");
  assert.equal(askIssueTemplate.frontMatter.title, "Ask Sepo: ");
  assert.equal(askIssueTemplate.frontMatter.labels, "agent");
  assert.match(askIssueTemplate.body, /^@sepo-agent \/answer\n/);
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
  assert.match(configurationList, /AGENT_ENABLED/);
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
  assert.match(configurationList, /AGENT_AUTO_UPDATE/);
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
  assert.match(developerNotes, /hosted Sepo App path only works/);
  assert.match(developerNotes, /selected-repository installation/);
  assert.match(skillsDocs, /`skill_root`/);
  assert.match(skillsDocs, /\/skill/);
  assert.match(skillsDocs, /setup\.sh/);
  assert.match(skillsDocs, /agent-router\.yml/);
  assert.match(developerNotes, /lazy blockquote/);
  assert.match(developerNotes, /lightweight post-agent check/);
});

test("create-action prompt uses native workflows with shared expiration and runtime guardrails", () => {
  const prompt = readRepoFile(".github/prompts/agent-create-action.md");
  const docs = readRepoFile(".agent/docs/customization/creating-your-own-actions.md");
  const template = readRepoFile(".agent/action-templates/agent-action-template.yml");
  const internalActions = readRepoFile(".agent/docs/usage/internal-actions.md");
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
  const selfApprovalWorkflow = readRepoFile(".github/workflows/agent-self-approve.yml");
  const runSource = readRepoFile(".agent/src/run.ts");
  const handoffSource = readRepoFile(".agent/src/handoff.ts");
  const orchestrateHandoffCli = readRepoFile(".agent/src/cli/orchestrate-handoff.ts");
  const fixPrPrompt = readRepoFile(".github/prompts/agent-fix-pr.md");
  const orchestratorPrompt = readRepoFile(".github/prompts/agent-orchestrator.md");
  const orchestratorDoc = readRepoFile(".agent/docs/architecture/agent-orchestrator.md");

  assert.match(entrypointWorkflow, /automation_mode:\s*\$\{\{ vars\.AGENT_AUTOMATION_MODE \|\| 'agent' \}\}/);
  assert.match(labelWorkflow, /automation_mode:\s*\$\{\{ vars\.AGENT_AUTOMATION_MODE \|\| 'agent' \}\}/);
  assert.match(runnerWorkflow, /automation_mode:[\s\S]*default:\s*"agent"/);
  assert.match(approveWorkflow, /AUTOMATION_MODE:\s*\$\{\{ vars\.AGENT_AUTOMATION_MODE \|\| 'agent' \}\}/);
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

  for (const workflow of [implementWorkflow, fixPrWorkflow, reviewWorkflow, selfApprovalWorkflow]) {
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
  assert.match(orchestrateHandoffCli, /agent-self-approve\.yml/);
  assert.match(orchestrateHandoffCli, /agent-self-merge\.yml/);
  assert.match(handoffSource, /Task for fix-pr/);
  assert.match(orchestrateHandoffCli, /collapsePreviousHandoffComments/);
  assert.match(orchestrateHandoffCli, /manual orchestrate start on issue; dispatching implement/);
  assert.match(fixPrWorkflow, /orchestrator_context:/);
  assert.match(fixPrWorkflow, /ORCHESTRATOR_CONTEXT:\s*\$\{\{ inputs\.orchestrator_context \}\}/);
  assert.match(fixPrPrompt, /\$\{ORCHESTRATOR_CONTEXT\}/);
  assert.match(orchestratorPrompt, /"handoff_context"/);
  assert.match(orchestratorPrompt, /ORCHESTRATOR_SOURCE_HANDOFF_CONTEXT/);
  assert.match(orchestratorPrompt, /ORCHESTRATOR_SELF_APPROVE_ENABLED/);
  assert.match(orchestratorPrompt, /ORCHESTRATOR_SELF_MERGE_ENABLED/);
  assert.match(orchestratorPrompt, /"user_message"/);
  assert.match(orchestratorPrompt, /"clarification_request"/);
  assert.match(orchestratorPrompt, /prior child finished with an open, unmerged PR/);
  assert.match(runSource, /"ORCHESTRATOR_CONTEXT"/);
  assert.match(runSource, /"ORCHESTRATOR_SELF_APPROVE_ENABLED"/);
  assert.match(runSource, /"ORCHESTRATOR_SELF_MERGE_ENABLED"/);
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
  const setupGuide = readRepoFile(".agent/docs/setup/setup-guide.md");
  const internalActions = readRepoFile(".agent/docs/usage/internal-actions.md");
  const selfHostedRunner = readRepoFile(
    ".agent/docs/setup/self-hosted-github-action-runner.md",
  );

  assert.match(setupGuide, /Official Sepo-hosted app/);
  assert.match(setupGuide, /selected-repository Sepo GitHub App installation/);
  assert.match(setupGuide, /App installed on the selected repository/);
  assert.match(
    setupGuide,
    /do not need repo-local `AGENT_APP_ID` \/ `AGENT_APP_PRIVATE_KEY`\s+secrets/,
  );
  assert.doesNotMatch(setupGuide, /AGENT_OIDC_EXCHANGE_URL/);
  assert.doesNotMatch(setupGuide, /AGENT_OIDC_AUDIENCE/);
  assert.match(setupGuide, /Bring your own GitHub App/);
  assert.match(setupGuide, /`AGENT_PAT`/);
  assert.doesNotMatch(setupGuide, /AGENT_INSTALL_PAT/);
  assert.match(setupGuide, /`AGENT_SECONDARY_GITHUB_TOKEN`/);
  assert.match(setupGuide, /`INPUT_SECONDARY_GITHUB_TOKEN`/);
  assert.match(setupGuide, /does not replace the primary\s+`GH_TOKEN`/);
  assert.match(setupGuide, /read access only to the needed surfaces/);
  assert.match(setupGuide, /read-only external inspection/);
  assert.match(setupGuide, /External writes need a route-specific credential/);
  assert.match(setupGuide, /non-public external repository read access is still\s+sensitive/);
  assert.match(setupGuide, /only trusted requesters/);
  assert.match(setupGuide, /tighten\s+`AGENT_ACCESS_POLICY`/);
  assert.match(setupGuide, /avoid granting private repository\s+scopes/);
  assert.match(setupGuide, /Public install requests use a separate install credential/);
  assert.match(setupGuide, /Contents:\*\* read and write/);
  assert.match(setupGuide, /### Auth priority/);
  assert.match(
    setupGuide,
    /1\. direct GitHub App token[\s\S]*2\. official OIDC broker exchange[\s\S]*3\. `AGENT_PAT`[\s\S]*4\. fallback workflow token `github\.token`/,
  );
  assert.match(setupGuide, /fallback workflow token `github\.token`/i);
  assert.doesNotMatch(setupGuide, /"oidc_token"/);
  assert.match(internalActions, /hosted OIDC broker path retries/);
  assert.match(internalActions, /`429`, `500`, `502`, `503`, or `504`/);
  assert.match(internalActions, /generic broker `400` responses remain terminal/);
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

test("validateEnvelope accepts dispatch, action, self-approval, update, and rubrics routes", () => {
  for (const route of [
    "dispatch",
    "create-action",
    "agent-self-approve",
    "agent-self-merge",
    "update-agent",
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

test("agent-review permissions are scoped per-job: reviewers read-only, synthesize writes", () => {
  const reviewWorkflow = readRepoFile(".github/workflows/agent-review.yml");

  // Top-level workflow permissions keep contents read-only; actions write
  // allows the synthesize job to dispatch automation handoffs.
  assert.match(reviewWorkflow, /^permissions:\s*\n\s+actions: write\s*\n\s+contents: read/m);

  // Reviewer job keeps contents:read.
  assert.match(
    reviewWorkflow,
    /review:\s*\n\s+# Ordering-only:[\s\S]*?needs: \[prepare\]\s*\n\s+if: \$\{\{ vars\.AGENT_ENABLED != 'false' && !cancelled\(\) \}\}\s*\n\s+# Reviewer lanes are best-effort[\s\S]*?permissions:\s*\n\s+# Reviewer jobs stay read-only[\s\S]*?contents: read/,
  );

  // Synthesize job upgrades to contents:write for the memory commit.
  assert.match(
    reviewWorkflow,
    /synthesize:\s*\n\s+needs: \[prepare, review\]\s*\n\s+if: \$\{\{ vars\.AGENT_ENABLED != 'false' && !cancelled\(\) \}\}\s*\n\s+permissions:[\s\S]*?contents: write/,
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
