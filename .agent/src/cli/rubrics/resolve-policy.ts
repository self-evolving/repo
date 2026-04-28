#!/usr/bin/env node
// CLI: resolve effective rubric access mode for a route.
// Env: AGENT_RUBRICS_POLICY, RUBRICS_MODE_OVERRIDE, ROUTE
// Outputs: mode, read_enabled, write_enabled

import { setOutput } from "../../output.js";
import {
  getRubricsModeForRoute,
  isRubricsMode,
  isRubricsHardDisabledRoute,
  parseRubricsPolicy,
  rubricsModeAllowsRead,
  rubricsModeAllowsWrite,
  type RubricsMode,
} from "../../rubrics-policy.js";

export function resolveRubricsMode(env: NodeJS.ProcessEnv = process.env): RubricsMode {
  const route = String(env.ROUTE || "").trim().toLowerCase();
  if (isRubricsHardDisabledRoute(route)) {
    return "disabled";
  }

  const override = String(env.RUBRICS_MODE_OVERRIDE || "").trim().toLowerCase();
  if (override) {
    if (!isRubricsMode(override)) {
      throw new Error(`RUBRICS_MODE_OVERRIDE must be one of enabled, read-only, disabled (got ${override})`);
    }
    return override;
  }

  const policy = parseRubricsPolicy(env.AGENT_RUBRICS_POLICY || "");
  return getRubricsModeForRoute(policy, route);
}

export function runRubricsResolvePolicyCli(env: NodeJS.ProcessEnv = process.env): number {
  try {
    const mode = resolveRubricsMode(env);
    setOutput("mode", mode);
    setOutput("read_enabled", String(rubricsModeAllowsRead(mode)));
    setOutput("write_enabled", String(rubricsModeAllowsWrite(mode)));
    console.log(`rubrics mode: ${mode}`);
    return 0;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Invalid AGENT_RUBRICS_POLICY: ${msg}`);
    // Fail closed: malformed policy disables rubric access for this run, but the
    // workflow can continue without rubric steering.
    setOutput("mode", "disabled");
    setOutput("read_enabled", "false");
    setOutput("write_enabled", "false");
    return 0;
  }
}

if (require.main === module) {
  process.exitCode = runRubricsResolvePolicyCli();
}
