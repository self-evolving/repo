import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  blockedSetupVariableResults,
  buildSetupVariablePlan,
  formatSetupApplyAudit,
  parseRepoVariableList,
  parseSetupIssueIntent,
  SETUP_APPLY_COMMENT_MARKER,
} from "../setup-apply.js";

const setupIssueBody = `### Agent handle

@octo-agent

### Assign accepted work to the agent

No, skip automatic assignment

### Project management mode

project-backed

### GitHub Project

Create a new GitHub Project

### Project owner

self-evolving

### Project title

Sepo Planning & Roadmap

### Project Status values

Inbox
In Progress
To Review
Done

### Priority field

Create Priority field with P0, P1, P2, P3

### Effort field

Create Effort field with Low, Medium, High

### Release field

Skip Release for now

### Release values

_No response_

### Additional setup notes

Existing Project URL: https://github.com/orgs/self-evolving/projects/7
Project ID: PVT_kwDOExample

### Setup confirmation

- [x] I will request \`@sepo-agent /setup plan\` first and review the proposed changes before applying them.
- [x] I understand \`@sepo-agent /setup apply\` requires a later explicit confirmation before Sepo changes repository variables or GitHub Projects.
`;

test("setup apply parses setup issue intent and allowlisted variable plan", () => {
  const intent = parseSetupIssueIntent(setupIssueBody);
  assert.equal(intent.agentHandle, "@octo-agent");
  assert.equal(intent.assignToAgent, false);
  assert.equal(intent.projectManagementMode, "project-backed");
  assert.equal(intent.githubProjectChoice, "create");
  assert.equal(intent.projectUrl, "https://github.com/orgs/self-evolving/projects/7");
  assert.equal(intent.projectId, "PVT_kwDOExample");
  assert.deepEqual(intent.projectStatuses, ["Inbox", "In Progress", "To Review", "Done"]);
  assert.equal(intent.confirmationChecked, true);

  const current = parseRepoVariableList(JSON.stringify([
    { name: "AGENT_HANDLE", value: "@sepo-agent" },
    { name: "AGENT_PROJECT_MANAGEMENT_ENABLED", value: "true" },
  ]));
  const plan = buildSetupVariablePlan(intent, current);

  assert.deepEqual(plan.errors, []);
  assert.ok(plan.warnings.some((warning) => /Project creation was requested/.test(warning)));
  assert.deepEqual(
    plan.changes.map((change) => [change.name, change.nextValue, change.action]),
    [
      ["AGENT_HANDLE", "@octo-agent", "update"],
      ["AGENT_ASSIGNMENT_ENABLED", "false", "create"],
      ["AGENT_PROJECT_MANAGEMENT_ENABLED", "true", "unchanged"],
      ["AGENT_PROJECT_MANAGEMENT_DRY_RUN", "true", "create"],
      ["AGENT_PROJECT_MANAGEMENT_APPLY_LABELS", "false", "create"],
      ["AGENT_PROJECT_MANAGEMENT_PROJECT_OWNER", "self-evolving", "create"],
      ["AGENT_PROJECT_MANAGEMENT_PROJECT_TITLE", "Sepo Planning & Roadmap", "create"],
      ["AGENT_PROJECT_MANAGEMENT_PROJECT_URL", "https://github.com/orgs/self-evolving/projects/7", "create"],
      ["AGENT_PROJECT_MANAGEMENT_PROJECT_ID", "PVT_kwDOExample", "create"],
    ],
  );
});

test("setup apply blocks missing confirmation before variable writes", () => {
  const intent = parseSetupIssueIntent(setupIssueBody.replace(/- \[x\]/g, "- [ ]"));
  const plan = buildSetupVariablePlan(intent, new Map());

  assert.match(plan.errors.join("\n"), /confirmation checkboxes/);
  const audit = formatSetupApplyAudit({
    changes: plan.changes,
    dryRun: false,
    errors: plan.errors,
    warnings: plan.warnings,
  });
  assert.match(audit, new RegExp(SETUP_APPLY_COMMENT_MARKER));
  assert.match(audit, /Status: \*\*Blocked\*\*/);
  assert.match(audit, /No repository variables were changed/);
  assert.match(audit, /\| `AGENT_HANDLE` \| _unset_ \| `@octo-agent` \| blocked \|/);
  assert.doesNotMatch(audit, /\| created \||\| updated \|/);
});

test("setup apply blocks missing or unknown required setup choices", () => {
  const malformedBody = setupIssueBody
    .replace(/### Assign accepted work to the agent[\s\S]*?### Project management mode/, "### Project management mode")
    .replace("project-backed", "surprise me")
    .replace("Create a new GitHub Project", "Maybe later")
    .replace("Create Priority field with P0, P1, P2, P3", "Priority-ish");
  const intent = parseSetupIssueIntent(malformedBody);
  const plan = buildSetupVariablePlan(intent, new Map());

  assert.match(plan.errors.join("\n"), /Assign accepted work to the agent is required/);
  assert.match(plan.errors.join("\n"), /Project management mode has an unsupported value: surprise me/);
  assert.match(plan.errors.join("\n"), /GitHub Project has an unsupported value: Maybe later/);
  assert.match(plan.errors.join("\n"), /Priority field has an unsupported value: Priority-ish/);

  const audit = formatSetupApplyAudit({
    results: blockedSetupVariableResults(plan.changes),
    dryRun: false,
    errors: plan.errors,
    warnings: plan.warnings,
  });
  assert.match(audit, /Status: \*\*Blocked\*\*/);
  assert.match(audit, /\| blocked \|/);
  assert.doesNotMatch(audit, /\| created \||\| updated \|/);
});
