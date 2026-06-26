import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  findAuthorizedCancelReaction,
  hasAuthorizedCancelReaction,
  listCommentReactions,
} from "../reactions.js";

function withFakeGh<T>(script: string, fn: () => T): T {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-reactions-"));
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

test("listCommentReactions returns normalized comment reactions", () => {
  withFakeGh([
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "if [[ \"${1:-}\" == \"api\" && \"${2:-}\" == \"--paginate\" && \"${3:-}\" == \"--slurp\" && \"${4:-}\" == \"repos/self-evolving/repo/issues/comments/99/reactions\" ]]; then",
    "  printf '%s\\n' '[[{\"content\":\"-1\",\"user\":{\"login\":\"alice\"}},{\"content\":\"+1\",\"user\":{\"login\":\"bob\"}},{\"content\":\"eyes\",\"user\":{\"login\":\"carol\"}}]]'",
    "  exit 0",
    "fi",
    "printf 'unexpected gh args: %s\\n' \"$*\" >&2",
    "exit 1",
    "",
  ].join("\n"), () => {
    assert.deepEqual(listCommentReactions("self-evolving/repo", 99), [
      { content: "THUMBS_DOWN", user: "alice" },
      { content: "THUMBS_UP", user: "bob" },
      { content: "EYES", user: "carol" },
    ]);
  });
});

test("no reactions do not authorize cancellation", () => {
  withFakeGh([
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "if [[ \"${1:-}\" == \"api\" && \"${4:-}\" == \"repos/self-evolving/repo/issues/comments/100/reactions\" ]]; then",
    "  printf '%s\\n' '[[]]'",
    "  exit 0",
    "fi",
    "printf 'unexpected gh args: %s\\n' \"$*\" >&2",
    "exit 1",
    "",
  ].join("\n"), () => {
    const reactions = listCommentReactions("self-evolving/repo", 100);
    assert.deepEqual(reactions, []);
    assert.equal(hasAuthorizedCancelReaction("self-evolving/repo", reactions, "alice"), false);
  });
});

test("requester thumbs-down authorizes cancellation without trust lookup", () => {
  withFakeGh([
    "#!/usr/bin/env bash",
    "printf 'gh should not be called for requester authorization\\n' >&2",
    "exit 1",
    "",
  ].join("\n"), () => {
    assert.deepEqual(
      findAuthorizedCancelReaction(
        "self-evolving/repo",
        [{ content: "THUMBS_DOWN", user: "Alice" }],
        "alice",
      ),
      { content: "THUMBS_DOWN", user: "Alice", authorization: "REQUESTER" },
    );
  });
});

test("trusted collaborator thumbs-down authorizes cancellation", () => {
  withFakeGh([
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "if [[ \"${1:-}\" == \"api\" && \"${2:-}\" == \"repos/self-evolving/repo/collaborators/bob/permission\" ]]; then",
    "  printf 'write\\n'",
    "  exit 0",
    "fi",
    "printf 'unexpected gh args: %s\\n' \"$*\" >&2",
    "exit 1",
    "",
  ].join("\n"), () => {
    assert.deepEqual(
      findAuthorizedCancelReaction(
        "self-evolving/repo",
        [{ content: "-1", user: "bob" }],
        "alice",
      ),
      { content: "THUMBS_DOWN", user: "bob", authorization: "COLLABORATOR" },
    );
  });
});

test("unauthorized thumbs-down does not authorize cancellation", () => {
  withFakeGh([
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "if [[ \"${1:-}\" == \"api\" && \"${2:-}\" == \"repos/self-evolving/repo/collaborators/bob/permission\" ]]; then",
    "  printf 'none\\n'",
    "  exit 0",
    "fi",
    "if [[ \"${1:-}\" == \"api\" && \"${2:-}\" == \"orgs/self-evolving/memberships/bob\" ]]; then",
    "  exit 1",
    "fi",
    "if [[ \"${1:-}\" == \"api\" && \"${2:-}\" == \"orgs/self-evolving/members/bob\" ]]; then",
    "  exit 1",
    "fi",
    "printf 'unexpected gh args: %s\\n' \"$*\" >&2",
    "exit 1",
    "",
  ].join("\n"), () => {
    assert.equal(
      findAuthorizedCancelReaction(
        "self-evolving/repo",
        [{ content: "THUMBS_DOWN", user: "bob" }],
        "alice",
      ),
      null,
    );
  });
});

test("other reactions do not authorize cancellation", () => {
  withFakeGh([
    "#!/usr/bin/env bash",
    "printf 'gh should not be called without a thumbs-down\\n' >&2",
    "exit 1",
    "",
  ].join("\n"), () => {
    assert.equal(
      findAuthorizedCancelReaction(
        "self-evolving/repo",
        [{ content: "THUMBS_UP", user: "alice" }],
        "alice",
      ),
      null,
    );
  });
});

test("gh reaction and trust lookup errors are non-fatal", () => {
  withFakeGh([
    "#!/usr/bin/env bash",
    "printf 'simulated gh failure\\n' >&2",
    "exit 1",
    "",
  ].join("\n"), () => {
    assert.deepEqual(listCommentReactions("self-evolving/repo", 99), []);
    assert.equal(
      findAuthorizedCancelReaction(
        "self-evolving/repo",
        [{ content: "THUMBS_DOWN", user: "bob" }],
        "alice",
      ),
      null,
    );
  });
});
