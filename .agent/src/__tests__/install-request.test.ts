import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  completeInstallRequest,
  type InstallRequestRunner,
} from "../install-request.js";

class FakeInstallRequestRunner implements InstallRequestRunner {
  readonly calls: string[][] = [];
  issueState = "OPEN";
  failView = false;
  failClose = false;

  gh(args: string[]): string {
    this.calls.push([...args]);
    if (args[0] === "issue" && args[1] === "view") {
      if (this.failView) throw new Error("view failed");
      return `${this.issueState}\n`;
    }
    if (args[0] === "issue" && args[1] === "close") {
      if (this.failClose) throw new Error("close failed");
      return "";
    }
    throw new Error(`unexpected gh args: ${args.join(" ")}`);
  }

  called(pattern: RegExp): boolean {
    return this.calls.some((args) => pattern.test(args.join(" ")));
  }
}

test("completeInstallRequest closes published issue-backed install request", () => {
  const runner = new FakeInstallRequestRunner();

  const result = completeInstallRequest({
    sourceRepo: "self-evolving/repo",
    targetKind: "issue",
    targetNumber: 303,
    installStatus: "published",
    prUrl: "https://github.com/example/target/pull/77?notification=1",
    runner,
  });

  assert.equal(result.status, "closed");
  assert.equal(result.prUrl, "https://github.com/example/target/pull/77");
  assert.equal(result.comment, "Installation PR is ready: https://github.com/example/target/pull/77");
  assert.ok(runner.called(/issue view 303 --repo self-evolving\/repo --json state --jq \.state/));
  assert.ok(runner.called(/issue close 303 --repo self-evolving\/repo --comment Installation PR is ready: https:\/\/github\.com\/example\/target\/pull\/77/));
});

test("completeInstallRequest skips non-issue and non-published installs", () => {
  const runner = new FakeInstallRequestRunner();

  assert.equal(completeInstallRequest({
    sourceRepo: "self-evolving/repo",
    targetKind: "pull_request",
    targetNumber: 10,
    installStatus: "published",
    prUrl: "https://github.com/example/target/pull/77",
    runner,
  }).reason, "not_issue_backed");

  assert.equal(completeInstallRequest({
    sourceRepo: "self-evolving/repo",
    targetKind: "issue",
    targetNumber: 303,
    installStatus: "blocked",
    prUrl: "https://github.com/example/target/pull/77",
    runner,
  }).reason, "install_not_published");
});

test("completeInstallRequest skips already closed source issue", () => {
  const runner = new FakeInstallRequestRunner();
  runner.issueState = "CLOSED";

  const result = completeInstallRequest({
    sourceRepo: "self-evolving/repo",
    targetKind: "issue",
    targetNumber: 303,
    installStatus: "published",
    prUrl: "https://github.com/example/target/pull/77",
    runner,
  });

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "already_closed");
  assert.equal(runner.called(/issue close/), false);
});

test("completeInstallRequest reports source issue state lookup failures", () => {
  const runner = new FakeInstallRequestRunner();
  runner.failView = true;

  const result = completeInstallRequest({
    sourceRepo: "self-evolving/repo",
    targetKind: "issue",
    targetNumber: 303,
    installStatus: "published",
    prUrl: "https://github.com/example/target/pull/77",
    runner,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.reason, "issue_state_unavailable");
  assert.equal(runner.called(/issue close/), false);
});

test("completeInstallRequest reports close failures without throwing", () => {
  const runner = new FakeInstallRequestRunner();
  runner.failClose = true;

  const result = completeInstallRequest({
    sourceRepo: "self-evolving/repo",
    targetKind: "issue",
    targetNumber: 303,
    installStatus: "published",
    prUrl: "https://github.com/example/target/pull/77",
    runner,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.reason, "close_failed");
});
