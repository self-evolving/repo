import test from "node:test";
import assert from "node:assert/strict";

import { resolveInstallTargetFromText } from "../install-target.js";

test("resolveInstallTargetFromText accepts owner repo slugs", () => {
  assert.deepEqual(
    resolveInstallTargetFromText("@sepo-agent /install self-evolving/example-repo.").targetRepo,
    "self-evolving/example-repo",
  );
});

test("resolveInstallTargetFromText accepts GitHub URLs", () => {
  const result = resolveInstallTargetFromText(
    "@sepo-agent /install can you install Sepo into https://github.com/foo/bar.git?",
  );

  assert.equal(result.status, "clear");
  assert.equal(result.targetRepo, "foo/bar");
});

test("resolveInstallTargetFromText does not scan slugs inside GitHub URL paths", () => {
  const issueUrl = resolveInstallTargetFromText(
    "@sepo-agent /install https://github.com/foo/bar/issues/123",
  );
  assert.equal(issueUrl.status, "clear");
  assert.equal(issueUrl.targetRepo, "foo/bar");
  assert.deepEqual(issueUrl.candidates, ["foo/bar"]);

  const treeUrl = resolveInstallTargetFromText(
    "Install into https://github.com/foo/bar/tree/main and mention foo/bar once.",
  );
  assert.equal(treeUrl.status, "clear");
  assert.deepEqual(treeUrl.candidates, ["foo/bar"]);
});

test("resolveInstallTargetFromText blocks missing and ambiguous targets", () => {
  assert.equal(resolveInstallTargetFromText("@sepo-agent /install please").status, "missing");

  const ambiguous = resolveInstallTargetFromText("Install into foo/bar or baz/qux");
  assert.equal(ambiguous.status, "ambiguous");
  assert.deepEqual(ambiguous.candidates, ["foo/bar", "baz/qux"]);
});
