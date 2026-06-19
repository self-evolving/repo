import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  ROUTES,
  normalizeDispatch,
  applyDispatchPolicy,
  extractRequestedRoute,
  extractRequestedRouteDecision,
  buildRequestedRouteDecision,
  normalizeImplementIssueMetadata,
  resolveRequestedLabel,
} from "../triage.js";
import {
  getAllowedAssociationsForRoute,
  isAssociationAllowedForRoute,
  parseAccessPolicy,
} from "../access-policy.js";

const repoRoot = resolve(__dirname, "../../..");

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

// --- normalizeDispatch ---

test("dispatch prompt enumerates every supported dispatch route", () => {
  const prompt = readRepoFile(".github/prompts/agent-dispatch.md");
  const supportedRoutes = [...ROUTES].sort();

  const bulletRoutes = Array.from(
    prompt.matchAll(/^- `([^`]+)`: /gm),
    ([, route]) => route,
  ).sort();
  assert.deepEqual(bulletRoutes, supportedRoutes);

  const unionMatch = prompt.match(/"route": "([^"]+)"/);
  assert.ok(unionMatch, "dispatch prompt should document the route JSON union");
  const unionRoutes = unionMatch[1]
    .split("|")
    .map((route) => route.trim())
    .sort();
  assert.deepEqual(unionRoutes, supportedRoutes);
  assert.match(prompt, /Use `orchestrate` when/);
});

test("normalizeDispatch reads raw JSON", () => {
  const d = normalizeDispatch(
    '{"route":"answer","needs_approval":false,"summary":"Will answer.","confidence":"high","issue_title":"","issue_body":""}',
  );
  assert.equal(d.route, "answer");
  assert.equal(d.needsApproval, false);
  assert.equal(d.summary, "Will answer.");
});

test("normalizeDispatch reads fenced JSON", () => {
  const d = normalizeDispatch(
    '```json\n{"route":"implement","needs_approval":true,"summary":"Will implement.","confidence":"high","issue_title":"feat: add X","issue_body":"body"}\n```',
  );
  assert.equal(d.route, "implement");
  assert.equal(d.issueTitle, "feat: add X");
});

test("normalizeDispatch lowercases mixed-case routes", () => {
  const d = normalizeDispatch('{"route":"Review","summary":"rev"}');
  assert.equal(d.route, "review");
});

test("normalizeDispatch rejects empty input", () => {
  assert.throws(() => normalizeDispatch(""), /empty/i);
});

test("normalizeDispatch rejects malformed JSON", () => {
  assert.throws(() => normalizeDispatch("not json"), /JSON object/i);
});

test("normalizeDispatch rejects unsupported routes", () => {
  assert.throws(
    () => normalizeDispatch('{"route":"deploy"}'),
    /Unsupported dispatch route/,
  );
});

test("parseAccessPolicy accepts future route override keys and GitHub associations", () => {
  const policy = parseAccessPolicy(
    JSON.stringify({
      route_overrides: {
        "future-route": ["MANNEQUIN"],
      },
    }),
  );

  assert.deepEqual(getAllowedAssociationsForRoute(policy, "future-route", false), ["MANNEQUIN"]);
  assert.equal(isAssociationAllowedForRoute(policy, "future-route", "mannequin", false), true);
});

test("parseAccessPolicy rejects malformed policy values", () => {
  assert.throws(() => parseAccessPolicy("{"), SyntaxError);
  assert.throws(() => parseAccessPolicy("[1,2,3]"), /JSON object/);
  assert.throws(
    () => parseAccessPolicy(JSON.stringify({ allowed_associations: [] })),
    /at least one author association/,
  );
  assert.throws(
    () => parseAccessPolicy(JSON.stringify({ allowed_associations: ["SUPERUSER"] })),
    /unsupported author associations/,
  );
  assert.throws(
    () => parseAccessPolicy(JSON.stringify({ route_overrides: [] })),
    /route_overrides must be an object/,
  );
  assert.throws(
    () => parseAccessPolicy(JSON.stringify({ route_overrides: { "--invalid": ["OWNER"] } })),
    /Invalid route override key/,
  );
  assert.throws(
    () => parseAccessPolicy(JSON.stringify({ route_overrides: { answer: [] } })),
    /route_overrides\.answer must contain at least one author association/,
  );
});

test("extractRequestedRoute detects explicit slash routes after the agent mention", () => {
  assert.equal(
    extractRequestedRoute("@sepo-agent /review this PR again", "@sepo-agent"),
    "review",
  );
  assert.equal(
    extractRequestedRoute("Please check this.\n\n@sepo-agent /fix-pr handle the latest comments", "@sepo-agent"),
    "fix-pr",
  );
  assert.equal(
    extractRequestedRoute("@sepo-agent /orchestrate continue intelligently", "@sepo-agent"),
    "orchestrate",
  );
  assert.equal(
    extractRequestedRoute("@sepo-agent /create-action monitor flaky tests", "@sepo-agent"),
    "create-action",
  );
  assert.equal(
    extractRequestedRoute("@sepo-agent /add-rubrics capture this preference", "@sepo-agent"),
    "add-rubrics",
  );
});

test("extractRequestedRouteDecision detects mention-based skill requests", () => {
  assert.deepEqual(
    extractRequestedRouteDecision(
      "@sepo-agent /skill Release-Notes summarize the changelog",
      "@sepo-agent",
    ),
    { route: "skill", skill: "release-notes" },
  );
});

test("extractRequestedRouteDecision maps install requests to install route", () => {
  assert.deepEqual(
    extractRequestedRouteDecision(
      "@sepo-agent /install self-evolving/example-repo",
      "@sepo-agent",
    ),
    {
      route: "install",
      skill: "",
    },
  );
  assert.deepEqual(
    extractRequestedRouteDecision(
      "Please install it.\n\n@sepo-agent /install https://github.com/self-evolving/example-repo.",
      "@sepo-agent",
    ),
    {
      route: "install",
      skill: "",
    },
  );
  assert.deepEqual(
    extractRequestedRouteDecision(
      "@sepo-agent /install: can you install Sepo into foo/bar?",
      "@sepo-agent",
    ),
    {
      route: "install",
      skill: "",
    },
  );
  assert.deepEqual(
    extractRequestedRouteDecision("@sepo-agent /install", "@sepo-agent"),
    { route: "install", skill: "" },
  );
  assert.deepEqual(
    extractRequestedRouteDecision("@sepo-agent /install not-a-slug", "@sepo-agent"),
    { route: "install", skill: "" },
  );
  assert.doesNotMatch(
    buildRequestedRouteDecision("unsupported", "@sepo-agent /deploy").summary,
    /\/install owner\/repo/,
  );
});

test("extractRequestedRoute ignores non-route slash commands and commands without the mention", () => {
  assert.equal(
    extractRequestedRoute("@sepo-agent /approve req-a1b2c3", "@sepo-agent"),
    "",
  );
  assert.equal(
    extractRequestedRoute("/review this PR again", "@sepo-agent"),
    "",
  );
  assert.deepEqual(
    extractRequestedRouteDecision("@sepo-agent /skill ../../oops", "@sepo-agent"),
    { route: "", skill: "" },
  );
});

test("buildRequestedRouteDecision builds deterministic implement metadata without approval gate", () => {
  const d = buildRequestedRouteDecision(
    "implement",
    "@sepo-agent /implement add a regression test for approval routing",
  );
  assert.equal(d.route, "implement");
  // Explicit /implement is self-approval; the approval gate only applies to
  // triaged implement decisions.
  assert.equal(d.needsApproval, false);
  assert.equal(d.issueTitle, "Implement requested change");
  assert.match(d.issueBody, /Original request/);
});

test("buildRequestedRouteDecision falls back to generic implement title without generated metadata", () => {
  const d = buildRequestedRouteDecision("implement", "@sepo-agent /implement");
  assert.equal(d.issueTitle, "Implement requested change");
});

test("buildRequestedRouteDecision uses generated implement issue metadata", () => {
  const d = buildRequestedRouteDecision(
    "implement",
    "Earlier prose mentions /implement add the wrong title.\n\n@sepo-agent /implement",
    {
      issueTitle: "Fix webhook dispatch retry handling",
      issueBody: "## Goal\nFix webhook dispatch retry handling.\n\n## Acceptance criteria\n- Add regression coverage.",
      basePr: "268",
    },
  );
  assert.equal(d.issueTitle, "Fix webhook dispatch retry handling");
  assert.doesNotMatch(d.issueTitle, /wrong title/);
  assert.match(d.issueBody, /webhook dispatch retry/);
  assert.equal(d.basePr, "268");
});

test("normalizeImplementIssueMetadata reads generated JSON metadata", () => {
  const metadata = normalizeImplementIssueMetadata(
    '```json\n{"issue_title":"Fix PR tracking issue titles","issue_body":"## Goal\\nGenerate title from context.","base_pr":"268"}\n```',
  );
  assert.equal(metadata.issueTitle, "Fix PR tracking issue titles");
  assert.match(metadata.issueBody, /Generate title from context/);
  assert.equal(metadata.basePr, "268");
});

test("normalizeImplementIssueMetadata rejects malformed generated metadata", () => {
  assert.throws(
    () => normalizeImplementIssueMetadata('{"issue_title":"Missing body"}'),
    /missing issue_body/,
  );
  assert.throws(
    () => normalizeImplementIssueMetadata('{"issue_title":"Bad base","issue_body":"body","base_pr":"#268"}'),
    /base_pr must be a positive integer/,
  );
  assert.throws(
    () => normalizeImplementIssueMetadata('{"issue_title":"Bad base","issue_body":"body","base_pr":"0"}'),
    /base_pr must be a positive integer/,
  );
});

test("buildRequestedRouteDecision builds deterministic review metadata", () => {
  const d = buildRequestedRouteDecision("review", "@sepo-agent /review");
  assert.equal(d.route, "review");
  assert.equal(d.needsApproval, false);
  assert.equal(d.issueTitle, "");
  assert.equal(d.issueBody, "");
});

test("buildRequestedRouteDecision builds deterministic orchestrate metadata", () => {
  const d = buildRequestedRouteDecision("orchestrate", "@sepo-agent /orchestrate");
  assert.equal(d.route, "orchestrate");
  assert.equal(d.needsApproval, false);
  assert.equal(d.issueTitle, "");
  assert.equal(d.issueBody, "");
});

test("buildRequestedRouteDecision builds deterministic create-action metadata", () => {
  const d = buildRequestedRouteDecision(
    "create-action",
    "@sepo-agent /create-action monitor flaky tests",
  );
  assert.equal(d.route, "create-action");
  assert.equal(d.needsApproval, false);
  assert.equal(d.issueTitle, "Create scheduled agent workflow");
  assert.match(d.issueBody, /scheduled GitHub Actions workflow/);
});

test("buildRequestedRouteDecision builds deterministic add-rubrics metadata", () => {
  const d = buildRequestedRouteDecision(
    "add-rubrics",
    "@sepo-agent /add-rubrics prefer small PRs for workflow changes",
  );
  assert.equal(d.route, "add-rubrics");
  assert.equal(d.needsApproval, false);
  assert.equal(d.issueTitle, "Propose rubric updates");
  assert.match(d.issueBody, /Review existing rubrics/);
  assert.match(d.summary, /rubric updates/);
});

test("buildRequestedRouteDecision supports skill routes", () => {
  const d = buildRequestedRouteDecision("skill", "agent/s/release-notes");
  assert.equal(d.route, "skill");
  assert.equal(d.needsApproval, false);
});

test("buildRequestedRouteDecision supports install routes", () => {
  const d = buildRequestedRouteDecision("install", "@sepo-agent /install owner/repo");
  assert.equal(d.route, "install");
  assert.equal(d.needsApproval, false);
  assert.match(d.summary, /install route/);
});

test("resolveRequestedLabel maps built-in and skill labels", () => {
  assert.deepEqual(resolveRequestedLabel("agent/review"), { route: "review", skill: "" });
  assert.deepEqual(resolveRequestedLabel("agent/orchestrate"), { route: "orchestrate", skill: "" });
  assert.deepEqual(resolveRequestedLabel("agent/create-action"), {
    route: "create-action",
    skill: "",
  });
  assert.equal(resolveRequestedLabel("agent/add-rubrics"), null);
  assert.deepEqual(resolveRequestedLabel("agent/s/release-notes"), {
    route: "skill",
    skill: "release-notes",
  });
});

test("resolveRequestedLabel normalizes skill name to lowercase", () => {
  assert.deepEqual(resolveRequestedLabel("agent/s/Release-Notes"), {
    route: "skill",
    skill: "release-notes",
  });
});

test("resolveRequestedLabel rejects unsupported or malformed labels", () => {
  assert.equal(resolveRequestedLabel("bug"), null);
  assert.equal(resolveRequestedLabel("agent/deploy"), null);
  assert.equal(resolveRequestedLabel("agent/s/../../oops"), null);
});

// --- applyDispatchPolicy ---

test("applyDispatchPolicy requires approval for triaged implement decisions", () => {
  const d = applyDispatchPolicy(
    normalizeDispatch('{"route":"implement","needs_approval":false,"summary":"s","issue_title":"t","issue_body":"b"}'),
    "issue",
  );
  assert.equal(d.needsApproval, true);
});

test("applyDispatchPolicy skips approval gate for explicit implement requests", () => {
  const d = applyDispatchPolicy(
    buildRequestedRouteDecision("implement", "@sepo-agent /implement add foo"),
    "issue",
    "MEMBER",
    undefined,
    false,
    true,
  );
  assert.equal(d.route, "implement");
  assert.equal(d.needsApproval, false);
});

test("applyDispatchPolicy requires approval for triaged create-action decisions", () => {
  const d = applyDispatchPolicy(
    normalizeDispatch(
      '{"route":"create-action","needs_approval":false,"summary":"s","issue_title":"t","issue_body":"b"}',
    ),
    "issue",
  );
  assert.equal(d.route, "create-action");
  assert.equal(d.needsApproval, true);
});

test("applyDispatchPolicy requires approval for triaged add-rubrics decisions", () => {
  const d = applyDispatchPolicy(
    normalizeDispatch(
      '{"route":"add-rubrics","needs_approval":false,"summary":"s","issue_title":"t","issue_body":"b"}',
    ),
    "issue",
  );
  assert.equal(d.route, "add-rubrics");
  assert.equal(d.needsApproval, true);
});

test("applyDispatchPolicy skips approval gate for explicit add-rubrics requests", () => {
  const d = applyDispatchPolicy(
    buildRequestedRouteDecision("add-rubrics", "@sepo-agent /add-rubrics capture this"),
    "issue",
    "MEMBER",
    undefined,
    false,
    true,
  );
  assert.equal(d.route, "add-rubrics");
  assert.equal(d.needsApproval, false);
});

test("applyDispatchPolicy skips approval gate for explicit create-action requests", () => {
  const d = applyDispatchPolicy(
    buildRequestedRouteDecision("create-action", "@sepo-agent /create-action monitor"),
    "issue",
    "MEMBER",
    undefined,
    false,
    true,
  );
  assert.equal(d.route, "create-action");
  assert.equal(d.needsApproval, false);
});

test("applyDispatchPolicy denies explicit implement when access policy restricts the route", () => {
  // Explicit /implement bypasses the approval gate but must still honor the
  // access policy — isExplicit=true does not mean access-unrestricted.
  const d = applyDispatchPolicy(
    buildRequestedRouteDecision("implement", "@sepo-agent /implement add foo"),
    "issue",
    "CONTRIBUTOR",
    parseAccessPolicy(
      JSON.stringify({
        route_overrides: {
          implement: ["OWNER", "MEMBER"],
        },
      }),
    ),
    false,
    true,
  );
  assert.equal(d.route, "unsupported");
  assert.equal(d.needsApproval, false);
});

test("applyDispatchPolicy dispatches fix-pr on PR without approval", () => {
  const d = applyDispatchPolicy(
    normalizeDispatch('{"route":"fix-pr","needs_approval":true,"summary":"fix"}'),
    "pull_request",
    "MEMBER",
  );
  assert.equal(d.route, "fix-pr");
  assert.equal(d.needsApproval, false);
});

test("applyDispatchPolicy overrides model approval for fix-pr on PR", () => {
  const d = applyDispatchPolicy(
    normalizeDispatch('{"route":"fix-pr","needs_approval":true,"summary":"fix it"}'),
    "pull_request",
    "OWNER",
  );
  assert.equal(d.needsApproval, false);
});

test("applyDispatchPolicy uses default private repo access for fix-pr", () => {
  const d = applyDispatchPolicy(
    normalizeDispatch('{"route":"fix-pr","summary":"fix"}'),
    "pull_request",
    "CONTRIBUTOR",
  );
  assert.equal(d.route, "fix-pr");
  assert.equal(d.needsApproval, false);
});

test("applyDispatchPolicy dispatches review on PR without approval", () => {
  const d = applyDispatchPolicy(
    normalizeDispatch('{"route":"review","summary":"review it"}'),
    "pull_request",
    "MEMBER",
  );
  assert.equal(d.route, "review");
  assert.equal(d.needsApproval, false);
});

test("applyDispatchPolicy dispatches orchestrate on issue without approval", () => {
  const d = applyDispatchPolicy(
    normalizeDispatch('{"route":"orchestrate","summary":"orchestrate"}'),
    "issue",
    "MEMBER",
  );
  assert.equal(d.route, "orchestrate");
  assert.equal(d.needsApproval, false);
});

test("applyDispatchPolicy rejects orchestrate requests outside issues and pull requests", () => {
  const d = applyDispatchPolicy(
    normalizeDispatch('{"route":"orchestrate","summary":"orchestrate"}'),
    "discussion",
  );
  assert.equal(d.route, "unsupported");
});

test("applyDispatchPolicy rejects review requests outside pull requests", () => {
  const d = applyDispatchPolicy(
    normalizeDispatch('{"route":"review","summary":"review it"}'),
    "issue",
  );
  assert.equal(d.route, "unsupported");
});

test("applyDispatchPolicy rejects fix-pr requests outside pull requests", () => {
  const d = applyDispatchPolicy(
    normalizeDispatch('{"route":"fix-pr","summary":"fix"}'),
    "issue",
  );
  assert.equal(d.route, "unsupported");
});

test("applyDispatchPolicy keeps skill requests as immediate inline runs", () => {
  const d = applyDispatchPolicy(
    buildRequestedRouteDecision("skill", "agent/s/release-notes"),
    "issue",
  );
  assert.equal(d.route, "skill");
  assert.equal(d.needsApproval, false);
});

test("applyDispatchPolicy evaluates install independently from skill overrides", () => {
  const policy = parseAccessPolicy(
    JSON.stringify({
      allowed_associations: ["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR"],
      route_overrides: {
        install: ["OWNER", "MEMBER"],
        skill: ["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR"],
      },
    }),
  );

  const deniedInstall = applyDispatchPolicy(
    buildRequestedRouteDecision("install", "@sepo-agent /install owner/repo"),
    "discussion",
    "CONTRIBUTOR",
    policy,
    true,
    true,
  );
  assert.equal(deniedInstall.route, "unsupported");
  assert.match(deniedInstall.summary, /install requests currently require OWNER, MEMBER access/);

  const allowedSkill = applyDispatchPolicy(
    buildRequestedRouteDecision("skill", "@sepo-agent /skill release-notes"),
    "discussion",
    "CONTRIBUTOR",
    policy,
    true,
    true,
  );
  assert.equal(allowedSkill.route, "skill");

  const allowedInstall = applyDispatchPolicy(
    buildRequestedRouteDecision("install", "@sepo-agent /install owner/repo"),
    "discussion",
    "MEMBER",
    policy,
    true,
    true,
  );
  assert.equal(allowedInstall.route, "install");
  assert.equal(allowedInstall.needsApproval, false);
});

test("applyDispatchPolicy rejects routes disallowed by configured access policy", () => {
  const d = applyDispatchPolicy(
    normalizeDispatch('{"route":"review","summary":"review it"}'),
    "pull_request",
    "CONTRIBUTOR",
    parseAccessPolicy(
      JSON.stringify({
        route_overrides: {
          review: ["OWNER", "MEMBER", "COLLABORATOR"],
        },
      }),
    ),
  );
  assert.equal(d.route, "unsupported");
  assert.match(d.summary, /OWNER, MEMBER, COLLABORATOR/);
});

test("applyDispatchPolicy allows contributors by default for public repos", () => {
  const d = applyDispatchPolicy(
    normalizeDispatch('{"route":"answer","summary":"answer it"}'),
    "issue",
    "CONTRIBUTOR",
    parseAccessPolicy(""),
    true,
  );
  assert.equal(d.route, "answer");
  assert.equal(d.needsApproval, false);
});

test("applyDispatchPolicy allows route overrides to widen public repo access", () => {
  const d = applyDispatchPolicy(
    normalizeDispatch('{"route":"fix-pr","summary":"fix it"}'),
    "pull_request",
    "CONTRIBUTOR",
    parseAccessPolicy(
      JSON.stringify({
        route_overrides: {
          "fix-pr": ["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR"],
        },
      }),
    ),
    true,
  );
  assert.equal(d.route, "fix-pr");
  assert.equal(d.needsApproval, false);
});
