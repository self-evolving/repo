import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  hasGithubRepositoryCollaborator,
  normalizeGithubActorLogin,
  resolveGithubActorAssociation,
} from "../actor-association.js";

function withFakeGh<T>(script: string, fn: () => T): T {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-actor-association-"));
  const originalPath = process.env.PATH;

  try {
    writeFileSync(join(tempDir, "gh"), script, {
      encoding: "utf8",
      mode: 0o755,
    });
    process.env.PATH = `${tempDir}:${originalPath || ""}`;
    return fn();
  } finally {
    process.env.PATH = originalPath;
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test("normalizes GitHub actor login decorations", () => {
  assert.equal(normalizeGithubActorLogin(" app/sepo-agent-app[bot] "), "sepo-agent-app");
});

test("resolves personal repository owner without GitHub lookups", () => {
  withFakeGh([
    "#!/usr/bin/env bash",
    "printf 'gh should not be called for owner match\\n' >&2",
    "exit 1",
    "",
  ].join("\n"), () => {
    assert.equal(
      resolveGithubActorAssociation({
        repo: "alice/repo",
        actorLogin: "Alice",
        ownerLogin: "alice",
        ownerType: "User",
      }),
      "OWNER",
    );
  });
});

test("resolves organization member association before repository permission by default", () => {
  withFakeGh([
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "if [[ \"${1:-}\" == \"api\" && \"${2:-}\" == \"orgs/self-evolving/memberships/alice\" ]]; then",
    "  printf 'active\\n'",
    "  exit 0",
    "fi",
    "printf 'unexpected gh args: %s\\n' \"$*\" >&2",
    "exit 1",
    "",
  ].join("\n"), () => {
    assert.equal(
      resolveGithubActorAssociation({
        repo: "self-evolving/repo",
        actorLogin: "alice",
        ownerLogin: "self-evolving",
        ownerType: "Organization",
      }),
      "MEMBER",
    );
  });
});

test("resolves repository permission as collaborator after membership misses", () => {
  withFakeGh([
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "if [[ \"${1:-}\" == \"api\" && \"${2:-}\" == \"orgs/self-evolving/memberships/alice\" ]]; then",
    "  exit 1",
    "fi",
    "if [[ \"${1:-}\" == \"api\" && \"${2:-}\" == \"orgs/self-evolving/members/alice\" ]]; then",
    "  exit 1",
    "fi",
    "if [[ \"${1:-}\" == \"api\" && \"${2:-}\" == \"repos/self-evolving/repo/collaborators/alice/permission\" ]]; then",
    "  printf 'write\\n'",
    "  exit 0",
    "fi",
    "printf 'unexpected gh args: %s\\n' \"$*\" >&2",
    "exit 1",
    "",
  ].join("\n"), () => {
    assert.equal(
      resolveGithubActorAssociation({
        repo: "self-evolving/repo",
        actorLogin: "alice",
        ownerLogin: "self-evolving",
        ownerType: "Organization",
      }),
      "COLLABORATOR",
    );
  });
});

test("repository-first lookup preserves cancel authorization association order", () => {
  withFakeGh([
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "if [[ \"${1:-}\" == \"api\" && \"${2:-}\" == \"repos/self-evolving/repo/collaborators/alice/permission\" ]]; then",
    "  printf 'write\\n'",
    "  exit 0",
    "fi",
    "printf 'unexpected gh args: %s\\n' \"$*\" >&2",
    "exit 1",
    "",
  ].join("\n"), () => {
    assert.equal(
      resolveGithubActorAssociation({
        repo: "self-evolving/repo",
        actorLogin: "alice",
        lookupOrder: "repository-first",
      }),
      "COLLABORATOR",
    );
  });
});

test("lookup failures do not authorize trust", () => {
  withFakeGh([
    "#!/usr/bin/env bash",
    "exit 1",
    "",
  ].join("\n"), () => {
    assert.equal(
      resolveGithubActorAssociation({
        repo: "self-evolving/repo",
        actorLogin: "alice",
        ownerLogin: "self-evolving",
        ownerType: "Organization",
      }),
      "NONE",
    );
    assert.equal(hasGithubRepositoryCollaborator("self-evolving/repo", "alice"), false);
  });
});
