#!/usr/bin/env node
// CLI: report a failed agent run to the configured GitHub Discussion intake.
// Env is supplied by the shared run-agent-task action.

import {
  buildAgentFailureReportInput,
  postAgentFailureReport,
} from "../failure-report.js";
import { setOutput } from "../output.js";

export function runReportAgentFailureCli(
  env: NodeJS.ProcessEnv = process.env,
): number {
  try {
    const input = buildAgentFailureReportInput(env);
    const result = postAgentFailureReport(input);

    setOutput("report_status", result.status);
    setOutput("report_reason", result.reason);
    setOutput("fingerprint", result.fingerprint);
    setOutput("discussion_url", result.discussionUrl);
    setOutput("comment_url", result.commentUrl);

    const url = result.commentUrl || result.discussionUrl;
    if (url) {
      console.log(`Agent failure report ${result.status}: ${url}`);
    } else {
      console.log(`Agent failure report ${result.status}: ${result.reason}`);
    }
    return 0;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Agent failure reporting failed: ${message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = runReportAgentFailureCli();
}
