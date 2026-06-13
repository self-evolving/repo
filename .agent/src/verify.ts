// Post-agent verification helper.
//
// Runs lightweight checks on agent-generated changes. Delegates to the
// shared post-agent verification script while providing a typed interface
// for workflow use.

import { execFileSync } from "node:child_process";
import { join } from "node:path";

const VERIFY_SCRIPT = ".agent/scripts/post-agent-verify.sh";

export interface VerifyResult {
  exitCode: number;
  output: string;
}

export interface VerifyOptions {
  /** Optional base commit used to verify clean history-only HEAD updates. */
  baseSha?: string;
}

export function shouldRunVerification(hasWorktreeChanges: boolean, hasBranchUpdate: boolean): boolean {
  return hasWorktreeChanges || hasBranchUpdate;
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
    return { exitCode: 0, output };
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
