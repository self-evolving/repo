// Shared GitHub Actions output helper.
//
// Uses HEREDOC delimiters for all values, which is safe for multiline
// content. Replaces the per-file setOutput implementations that were
// inconsistent (some used bare key=value, breaking on newlines).

import { appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

/**
 * Writes a key-value pair to the GITHUB_OUTPUT file.
 * Uses HEREDOC delimiters so multiline values are handled correctly.
 */
export function setOutput(name: string, value: string): void {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) return;
  const delim = `DELIM_${randomBytes(8).toString("hex")}`;
  appendFileSync(outputFile, `${name}<<${delim}\n${value}\n${delim}\n`);
}
