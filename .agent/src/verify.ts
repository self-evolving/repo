// Post-agent verification helper.
//
// Runs lightweight checks on agent-generated changes. Delegates to the
// shared post-agent verification script while providing a typed interface
// for workflow use.

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { loadRubrics } from "./rubrics.js";

const VERIFY_SCRIPT = ".agent/scripts/post-agent-verify.sh";

export interface VerifyResult {
  exitCode: number;
  output: string;
}

export interface VerifyOptions {
  /** Optional base commit used to verify clean history-only HEAD updates. */
  baseSha?: string;
  /** Route being verified; add-rubrics runs require rubric schema validation. */
  route?: string;
}

export function shouldRunVerification(hasWorktreeChanges: boolean, hasBranchUpdate: boolean): boolean {
  return hasWorktreeChanges || hasBranchUpdate;
}

function validateRubricsWorktree(cwd: string): VerifyResult {
  const { rubrics, errors } = loadRubrics(cwd);
  if (errors.length > 0) {
    return {
      exitCode: 1,
      output: errors.map((error) => `${error.path}: ${error.message}`).join("\n"),
    };
  }
  return {
    exitCode: 0,
    output: `validated ${rubrics.length} rubric${rubrics.length === 1 ? "" : "s"} in ${cwd}`,
  };
}

function combineOutput(...parts: string[]): string {
  return parts.map((part) => part.trim()).filter(Boolean).join("\n");
}

/**
 * Runs the verification script. Returns exit code 0 if verification passed.
 */
export function runVerification(cwd: string, options: VerifyOptions = {}): VerifyResult {
  try {
    const env = { ...process.env };
    if (options.baseSha) {
      env.VERIFY_BASE_SHA = options.baseSha;
    }
    const verifyScript = process.env.AGENT_RUNTIME_DIR
      ? join(process.env.AGENT_RUNTIME_DIR, VERIFY_SCRIPT)
      : VERIFY_SCRIPT;

    const output = execFileSync("bash", [verifyScript], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120_000,
    }).toString("utf8");
    if (String(options.route || process.env.ROUTE || "").trim().toLowerCase() !== "add-rubrics") {
      return { exitCode: 0, output };
    }

    const rubricsValidation = validateRubricsWorktree(cwd);
    return {
      exitCode: rubricsValidation.exitCode,
      output: combineOutput(output, rubricsValidation.output),
    };
  } catch (err: unknown) {
    const error = err as { status?: number; stdout?: Buffer; stderr?: Buffer };
    const stdout = error.stdout?.toString("utf8") ?? "";
    const stderr = error.stderr?.toString("utf8") ?? "";
    return {
      exitCode: error.status ?? 1,
      output: stdout + stderr,
    };
  }
}
