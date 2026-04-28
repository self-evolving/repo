#!/usr/bin/env node
// CLI: resolve the memory mode for the current run-agent-task invocation.
//
// Env:
//   ROUTE                  current route (e.g., answer, review)
//   AGENT_MEMORY_POLICY    raw JSON policy string (optional, falls back to default-enabled)
//   MEMORY_MODE_OVERRIDE   explicit mode ("enabled" | "read-only" | "disabled"),
//                          bypasses the policy entirely (used by dedicated memory
//                          workflows so they always have memory on)
//
// Outputs:
//   mode                   resolved mode string
//   read_enabled           "true" | "false"
//   write_enabled          "true" | "false"

import { setOutput } from "../../output.js";
import {
  DEFAULT_MEMORY_MODE,
  type MemoryMode,
  getMemoryModeForRoute,
  isMemoryMode,
  memoryModeAllowsRead,
  memoryModeAllowsWrite,
  parseMemoryPolicy,
} from "../../memory-policy.js";

export function resolveMode(): MemoryMode {
  const override = String(process.env.MEMORY_MODE_OVERRIDE || "").trim().toLowerCase();
  if (override) {
    if (!isMemoryMode(override)) {
      console.error(
        `Invalid MEMORY_MODE_OVERRIDE: ${override}. Expected enabled, read-only, or disabled.`,
      );
      process.exitCode = 2;
      return DEFAULT_MEMORY_MODE;
    }
    return override;
  }

  const route = String(process.env.ROUTE || "").trim().toLowerCase();

  try {
    const policy = parseMemoryPolicy(process.env.AGENT_MEMORY_POLICY || "");
    return getMemoryModeForRoute(policy, route);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Invalid AGENT_MEMORY_POLICY: ${msg}. Falling back to disabled.`);
    // Fall closed on a bad policy: disable memory for this run so a typo in
    // the repo variable does not take down user-triggered routes.
    return "disabled";
  }
}

if (require.main === module) {
  const mode = resolveMode();
  setOutput("mode", mode);
  setOutput("read_enabled", memoryModeAllowsRead(mode) ? "true" : "false");
  setOutput("write_enabled", memoryModeAllowsWrite(mode) ? "true" : "false");
  process.stdout.write(`memory mode: ${mode}\n`);
}
