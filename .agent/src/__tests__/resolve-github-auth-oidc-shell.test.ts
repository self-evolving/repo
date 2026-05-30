import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

const repoRoot = path.resolve(__dirname, "../../..");

function writeExecutable(filePath: string, lines: string[]): void {
  writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
  chmodSync(filePath, 0o755);
}

function writeFakeCurl(binDir: string): void {
  writeExecutable(join(binDir, "curl"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "is_exchange=false",
    "output_file=\"\"",
    "for ((i = 1; i <= $#; i++)); do",
    "  arg=\"${!i}\"",
    "  if [ \"$arg\" = \"--data-binary\" ]; then",
    "    is_exchange=true",
    "  fi",
    "  if [ \"$arg\" = \"-o\" ]; then",
    "    next=$((i + 1))",
    "    output_file=\"${!next}\"",
    "  fi",
    "done",
    "",
    "if [ \"$is_exchange\" != \"true\" ]; then",
    "  printf '{\"value\":\"oidc-token\"}'",
    "  exit 0",
    "fi",
    "",
    "count=\"$(cat \"$FAKE_CURL_COUNT\" 2>/dev/null || printf '0')\"",
    "IFS=',' read -ra statuses <<< \"$EXCHANGE_STATUSES\"",
    "last_index=$((${#statuses[@]} - 1))",
    "status=\"${statuses[$count]:-${statuses[$last_index]}}\"",
    "printf '%s' \"$((count + 1))\" > \"$FAKE_CURL_COUNT\"",
    "",
    "case \"$status\" in",
    "  200)",
    "    printf '{\"token\":\"app-token\"}' > \"$output_file\"",
    "    ;;",
    "  400)",
    "    printf '{\"error\":{\"message\":\"bad request\"}}' > \"$output_file\"",
    "    ;;",
    "  *)",
    "    printf '{\"error\":{\"message\":\"temporary broker failure\"}}' > \"$output_file\"",
    "    ;;",
    "esac",
    "",
    "printf '%s' \"$status\"",
  ]);
}

function writeFakeJq(binDir: string): void {
  writeExecutable(join(binDir, "jq"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "if [ \"${1:-}\" = \"-n\" ]; then",
    "  printf '{}\\n'",
    "  exit 0",
    "fi",
    "",
    "if [ \"${1:-}\" = \"-r\" ]; then",
    "  expression=\"$2\"",
    "  shift 2",
    "else",
    "  expression=\"$1\"",
    "  shift",
    "fi",
    "",
    "input=\"\"",
    "if [ \"$#\" -gt 0 ]; then",
    "  last=\"${@: -1}\"",
    "  if [ -f \"$last\" ]; then",
    "    input=\"$(cat \"$last\")\"",
    "  else",
    "    input=\"$(cat)\"",
    "  fi",
    "else",
    "  input=\"$(cat)\"",
    "fi",
    "",
    "node - \"$expression\" \"$input\" <<'NODE'",
    "const expression = process.argv[2] || \"\";",
    "const input = process.argv[3] || \"\";",
    "let data = {};",
    "try { data = JSON.parse(input || \"{}\"); } catch { data = {}; }",
    "",
    "let value = \"\";",
    "if (expression.includes(\".value\")) {",
    "  value = data.value || \"\";",
    "} else if (expression.includes(\".token\") || expression.includes(\".app_token\")) {",
    "  value = data.token || data.app_token || \"\";",
    "} else if (expression.includes(\".error.message\") || expression.includes(\".message\")) {",
    "  value = (data.error && data.error.message) || data.message || \"\";",
    "} else if (expression.includes(\"keys_unsorted\")) {",
    "  value = data && typeof data === \"object\" && !Array.isArray(data) ? Object.keys(data).join(\",\") : \"\";",
    "}",
    "",
    "if (value) process.stdout.write(String(value) + \"\\n\");",
    "NODE",
  ]);
}

function runOidcExchange(statuses: string[]) {
  const tempDir = mkdtempSync(join(tmpdir(), "resolve-github-auth-oidc-"));
  const binDir = join(tempDir, "bin");
  const outputFile = join(tempDir, "outputs.txt");
  const countFile = join(tempDir, "exchange-count.txt");
  mkdirSync(binDir);
  writeFakeCurl(binDir);
  writeFakeJq(binDir);
  writeExecutable(join(binDir, "sleep"), ["#!/usr/bin/env bash", "exit 0"]);

  const result = spawnSync("bash", [".github/actions/resolve-github-auth/exchange-oidc.sh"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.githubusercontent.test/oidc",
      EXCHANGE_STATUSES: statuses.join(","),
      FAKE_CURL_COUNT: countFile,
      GITHUB_OUTPUT: outputFile,
      GITHUB_REPOSITORY: "self-evolving/repo",
      GITHUB_RUN_ID: "12345",
      GITHUB_WORKFLOW_REF: "self-evolving/repo/.github/workflows/agent-implement.yml@refs/heads/main",
      OIDC_AUDIENCE: "sepo",
      OIDC_EXCHANGE_URL: "https://oidc.self-evolving.test/api/github/github-app-token-exchange",
      PATH: `${binDir}:${process.env.PATH || ""}`,
    },
    encoding: "utf8",
  });

  const outputText = result.status === 0 ? readFileSync(outputFile, "utf8") : "";
  const exchangeAttempts = Number(readFileSync(countFile, "utf8"));

  rmSync(tempDir, { recursive: true, force: true });
  return { result, outputText, exchangeAttempts };
}

test("hosted OIDC exchange retries transient broker HTTP responses", () => {
  const { result, outputText, exchangeAttempts } = runOidcExchange(["500", "429", "200"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(exchangeAttempts, 3);
  assert.match(result.stderr, /Hosted broker exchange returned HTTP 500; retrying\./);
  assert.match(result.stderr, /Hosted broker exchange returned HTTP 429; retrying\./);
  assert.match(outputText, /token=app-token/);
  assert.match(outputText, /auth_mode=oidc_broker/);
});

test("hosted OIDC exchange does not retry deterministic broker HTTP 400", () => {
  const { result, outputText, exchangeAttempts } = runOidcExchange(["400", "200"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(exchangeAttempts, 1);
  assert.match(result.stderr, /Hosted broker exchange returned HTTP 400: bad request/);
  assert.doesNotMatch(outputText, /token=app-token/);
  assert.doesNotMatch(outputText, /auth_mode=oidc_broker/);
});
