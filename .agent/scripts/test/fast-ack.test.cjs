"use strict";

// Executes the portal fast-acknowledgement step script extracted from
// agent-router.yml against fixture payloads, with a stubbed curl. This is the
// executable counterpart to the envelope test that pins the step's shape.

const { strict: assert } = require("node:assert");
const { spawnSync } = require("node:child_process");
const {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { test } = require("node:test");
const { parse: parseYaml } = require("yaml");

const ROUTER_PATH = resolve(__dirname, "../../../.github/workflows/agent-router.yml");
const MENTION = "@sepo-agent";

function extractFastAckScript() {
  const workflow = parseYaml(readFileSync(ROUTER_PATH, "utf8"));
  const steps = workflow.jobs.portal.steps;
  const step = steps.find((candidate) => candidate && candidate.id === "fast_ack");
  assert.ok(step && typeof step.run === "string", "portal should define the fast_ack script");
  return step.run;
}

function runFastAck({ eventName, payload, curlStatus = 0 }) {
  const tempDir = mkdtempSync(join(tmpdir(), "fast-ack-"));
  const scriptPath = join(tempDir, "fast-ack.sh");
  const eventPath = join(tempDir, "event.json");
  const outputPath = join(tempDir, "output.txt");
  const capturePath = join(tempDir, "curl-args.txt");
  const curlPath = join(tempDir, "curl");

  writeFileSync(scriptPath, extractFastAckScript());
  writeFileSync(eventPath, JSON.stringify(payload));
  writeFileSync(outputPath, "");
  writeFileSync(
    curlPath,
    [
      "#!/usr/bin/env bash",
      "printf '%s\\n' \"$@\" >> \"${CURL_CAPTURE}\"",
      "if [ \"${CURL_STUB_STATUS:-0}\" != \"0\" ]; then",
      "  echo 'stub curl failure' >&2",
      "  exit \"${CURL_STUB_STATUS}\"",
      "fi",
      "echo '{}'",
    ].join("\n") + "\n",
  );
  chmodSync(curlPath, 0o755);

  const result = spawnSync("bash", [scriptPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_HANDLE: MENTION,
      CURL_CAPTURE: capturePath,
      CURL_STUB_STATUS: String(curlStatus),
      GH_TOKEN: "workflow-token",
      GITHUB_API_URL: "https://api.example.test",
      GITHUB_EVENT_NAME: eventName,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: outputPath,
      GITHUB_REPOSITORY: "self-evolving/repo",
      PATH: `${tempDir}:${process.env.PATH || ""}`,
    },
  });

  let curlArgs = "";
  try {
    curlArgs = readFileSync(capturePath, "utf8");
  } catch {
    curlArgs = "";
  }
  const outputs = Object.fromEntries(
    readFileSync(outputPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );

  rmSync(tempDir, { recursive: true, force: true });
  return { curlArgs, outputs, result };
}

test("fast ack reacts to live mentions with the correct REST endpoint", () => {
  const cases = [
    {
      name: "issue comment",
      eventName: "issue_comment",
      payload: { action: "created", comment: { id: 101, body: `${MENTION} please help` } },
      endpoint: "https://api.example.test/repos/self-evolving/repo/issues/comments/101/reactions",
    },
    {
      name: "issue title",
      eventName: "issues",
      payload: { action: "opened", issue: { number: 9, title: `${MENTION} do X`, body: "" } },
      endpoint: "https://api.example.test/repos/self-evolving/repo/issues/9/reactions",
    },
    {
      name: "pull request body",
      eventName: "pull_request",
      payload: { action: "opened", pull_request: { number: 12, title: "T", body: `${MENTION} review` } },
      endpoint: "https://api.example.test/repos/self-evolving/repo/issues/12/reactions",
    },
    {
      name: "review comment",
      eventName: "pull_request_review_comment",
      payload: { action: "created", comment: { id: 103, body: `${MENTION} fix this` } },
      endpoint: "https://api.example.test/repos/self-evolving/repo/pulls/comments/103/reactions",
    },
    {
      name: "parenthesized mention",
      eventName: "issue_comment",
      payload: { action: "created", comment: { id: 105, body: `see (${MENTION}) here` } },
      endpoint: "https://api.example.test/repos/self-evolving/repo/issues/comments/105/reactions",
    },
  ];

  for (const testCase of cases) {
    const { curlArgs, outputs, result } = runFastAck(testCase);
    assert.equal(result.status, 0, `${testCase.name} should exit cleanly`);
    assert.equal(outputs.reacted, "true", `${testCase.name} should react`);
    assert.ok(curlArgs.includes(testCase.endpoint), `${testCase.name} should call ${testCase.endpoint}`);
    assert.ok(curlArgs.includes('{"content":"eyes"}'), `${testCase.name} should post an eyes reaction`);
  }
});

test("fast ack skips non-live and unsupported mentions without calling the API", () => {
  const cases = [
    {
      name: "boundary overmatch",
      eventName: "issue_comment",
      payload: { action: "created", comment: { id: 201, body: `${MENTION}ic is not this agent` } },
    },
    {
      name: "fenced code",
      eventName: "issue_comment",
      payload: { action: "created", comment: { id: 202, body: `\`\`\`\n${MENTION} in code\n\`\`\`\nno live mention` } },
    },
    {
      name: "inline code",
      eventName: "issue_comment",
      payload: { action: "created", comment: { id: 203, body: `see \`${MENTION}\` inline` } },
    },
    {
      name: "quoted line",
      eventName: "issue_comment",
      payload: { action: "created", comment: { id: 204, body: `> ${MENTION} quoted\nplain follow-up` } },
    },
    {
      name: "list-nested backtick fence",
      eventName: "issue_comment",
      payload: { action: "created", comment: { id: 205, body: `- \`\`\`\n${MENTION} in nested fence\n  \`\`\`\nno live mention` } },
    },
    {
      name: "list-nested tilde fence",
      eventName: "issue_comment",
      payload: { action: "created", comment: { id: 206, body: `- ~~~\n${MENTION} in nested fence\n  ~~~\nno live mention` } },
    },
    {
      name: "mid-line fence opener",
      eventName: "issue_comment",
      payload: { action: "created", comment: { id: 207, body: `example: \`\`\`\n${MENTION} inside\n\`\`\`` } },
    },
    {
      name: "discussion surface",
      eventName: "discussion",
      payload: { action: "created", discussion: { number: 3, body: `${MENTION} hi` } },
    },
    {
      name: "missing id",
      eventName: "issue_comment",
      payload: { action: "created", comment: { body: `${MENTION} no id` } },
    },
  ];

  for (const testCase of cases) {
    const { curlArgs, outputs, result } = runFastAck(testCase);
    assert.equal(result.status, 0, `${testCase.name} should exit cleanly`);
    assert.equal(outputs.reacted, "false", `${testCase.name} should not react`);
    assert.equal(curlArgs, "", `${testCase.name} should not call the API`);
  }
});

test("fast ack reports reacted=false with a diagnostic when the API call fails", () => {
  const { outputs, result } = runFastAck({
    eventName: "issue_comment",
    payload: { action: "created", comment: { id: 301, body: `${MENTION} please help` } },
    curlStatus: 22,
  });
  assert.equal(result.status, 0, "API failure should not fail the step script");
  assert.equal(outputs.reacted, "false");
  assert.match(result.stdout, /Fast acknowledgement request failed/);
});
