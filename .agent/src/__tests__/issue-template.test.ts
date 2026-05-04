import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parse as parseYaml } from "yaml";

const repoRoot = path.resolve(__dirname, "../../..");

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function loadSepoSetupTemplate(): Record<string, unknown> {
  const template = parseYaml(readRepoFile(".github/ISSUE_TEMPLATE/sepo-setup.yml")) as unknown;
  assert.ok(isRecord(template), "Sepo setup issue template should parse as a YAML object");
  return template;
}

function bodyItems(template: Record<string, unknown>): Record<string, unknown>[] {
  assert.ok(Array.isArray(template.body), "Sepo setup issue template should define body items");
  return template.body.filter(isRecord);
}

function itemById(
  items: Record<string, unknown>[],
  id: string,
): Record<string, unknown> {
  const item = items.find((entry) => entry.id === id);
  assert.ok(item, `Sepo setup issue template should define ${id}`);
  return item;
}

function attributes(item: Record<string, unknown>): Record<string, unknown> {
  assert.ok(isRecord(item.attributes), "issue template item should define attributes");
  return item.attributes;
}

test("Sepo setup issue template captures the setup planning contract", () => {
  const template = loadSepoSetupTemplate();

  assert.equal(template.name, "Sepo setup");
  const items = bodyItems(template);
  const ids = new Set(items.map((item) => item.id).filter(Boolean));

  for (const id of [
    "agent-handle",
    "assign-to-agent",
    "project-management-mode",
    "github-project",
    "project-owner",
    "project-title",
    "project-statuses",
    "priority-field",
    "effort-field",
    "release-field",
    "setup-confirmation",
  ]) {
    assert.ok(ids.has(id), `Sepo setup issue template should include ${id}`);
  }

  assert.equal(attributes(itemById(items, "agent-handle")).value, "@sepo-agent");
  assert.deepEqual(attributes(itemById(items, "project-management-mode")).options, [
    "off",
    "dry-run",
    "project-backed",
  ]);
  assert.deepEqual(attributes(itemById(items, "github-project")).options, [
    "Do not configure a Project yet",
    "Create a new GitHub Project",
    "Link an existing GitHub Project",
  ]);
  assert.equal(
    attributes(itemById(items, "project-statuses")).value,
    "Inbox\nIn Progress\nTo Review\nDone\n",
  );
  assert.deepEqual(attributes(itemById(items, "priority-field")).options, [
    "Create Priority field with P0, P1, P2, P3",
    "Use an existing Priority field",
    "Do not configure Priority",
  ]);
  assert.deepEqual(attributes(itemById(items, "effort-field")).options, [
    "Create Effort field with Low, Medium, High",
    "Use an existing Effort field",
    "Do not configure Effort",
  ]);
  assert.deepEqual(attributes(itemById(items, "release-field")).options, [
    "Skip Release for now",
    "Create optional Release field",
    "Use an existing Release field",
  ]);
});

test("Sepo setup issue template requires plan-first confirmation", () => {
  const template = loadSepoSetupTemplate();
  const items = bodyItems(template);
  const visibleText = JSON.stringify(template);
  const confirmation = attributes(itemById(items, "setup-confirmation"));

  assert.match(visibleText, /@sepo-agent \/setup plan/);
  assert.match(visibleText, /@sepo-agent \/setup apply/);
  assert.match(visibleText, /explicit confirmation/);
  assert.ok(Array.isArray(confirmation.options), "setup confirmation should define options");

  for (const option of confirmation.options) {
    assert.ok(isRecord(option), "setup confirmation option should be an object");
    assert.equal(option.required, true);
  }
});
