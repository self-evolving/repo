import { test } from "node:test";
import { strict as assert } from "node:assert";

import { parseInstallForkPrCliArgs } from "../cli/install-fork-pr.js";

test("parseInstallForkPrCliArgs maps prepare flags and keeps token in env", () => {
  const input = parseInstallForkPrCliArgs([
    "prepare",
    "--target-repo",
    "lm4sci/lm4sci.github.io",
    "--branch",
    "agent/custom-install",
  ], {
    GH_TOKEN: "pat-token",
    INSTALL_TARGET_REPO: "env-owner/env-repo",
    INSTALL_BRANCH: "env-branch",
  });

  assert.equal(input.action, "prepare");
  assert.equal(input.common.targetRepo, "lm4sci/lm4sci.github.io");
  assert.equal(input.common.githubToken, "pat-token");
  assert.equal(input.common.branch, "agent/custom-install");
  assert.equal(input.common.workdir, undefined);
});

test("parseInstallForkPrCliArgs maps publish flags", () => {
  const input = parseInstallForkPrCliArgs([
    "publish",
    "--target-repo",
    "lm4sci/lm4sci.github.io",
    "--workdir",
    "/tmp/install-work",
    "--fork-repo",
    "sepo-install-bot/lm4sci.github.io",
    "--default-branch",
    "main",
    "--branch",
    "agent/install-agent-infra",
    "--pr-title",
    "Install Sepo agent infrastructure",
    "--pr-body-file",
    "/tmp/body.md",
  ], {
    GH_TOKEN: "pat-token",
  });

  assert.equal(input.action, "publish");
  assert.equal(input.publish.targetRepo, "lm4sci/lm4sci.github.io");
  assert.equal(input.publish.githubToken, "pat-token");
  assert.equal(input.publish.workdir, "/tmp/install-work");
  assert.equal(input.publish.forkRepo, "sepo-install-bot/lm4sci.github.io");
  assert.equal(input.publish.defaultBranch, "main");
  assert.equal(input.publish.branch, "agent/install-agent-infra");
  assert.equal(input.publish.title, "Install Sepo agent infrastructure");
  assert.equal(input.publish.bodyFile, "/tmp/body.md");
});

test("parseInstallForkPrCliArgs preserves environment fallbacks", () => {
  const input = parseInstallForkPrCliArgs([], {
    INSTALL_FORK_PR_ACTION: "publish",
    GITHUB_TOKEN: "fallback-token",
    INSTALL_TARGET_REPO: "env-owner/env-repo",
    INSTALL_WORKDIR: "/tmp/env-work",
    INSTALL_FORK_REPO: "env-bot/env-repo",
    INSTALL_DEFAULT_BRANCH: "trunk",
    INSTALL_BRANCH: "agent/env-install",
    INSTALL_PR_TITLE: "Env title",
    INSTALL_PR_BODY_FILE: "/tmp/env-body.md",
  });

  assert.equal(input.action, "publish");
  assert.equal(input.publish.targetRepo, "env-owner/env-repo");
  assert.equal(input.publish.githubToken, "fallback-token");
  assert.equal(input.publish.workdir, "/tmp/env-work");
  assert.equal(input.publish.forkRepo, "env-bot/env-repo");
  assert.equal(input.publish.defaultBranch, "trunk");
  assert.equal(input.publish.branch, "agent/env-install");
  assert.equal(input.publish.title, "Env title");
  assert.equal(input.publish.bodyFile, "/tmp/env-body.md");
});

test("parseInstallForkPrCliArgs rejects github token flags", () => {
  assert.throws(
    () => parseInstallForkPrCliArgs(["prepare", "--github-token", "pat-token"], {
      GH_TOKEN: "env-token",
    }),
    /Unknown option '--github-token'/,
  );
});
