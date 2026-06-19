#!/usr/bin/env node
// CLI: download GitHub user-attachments referenced by the current target
// before the model runs, then expose a local manifest path.

import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectAttachmentReferences,
  collectAttachmentTextSources,
  downloadGitHubAttachments,
  writeAttachmentManifest,
} from "../attachments.js";
import { setOutput } from "../output.js";

function parseTargetNumber(value: string | undefined): number {
  const number = Number(value || "");
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function resolveAttachmentsDir(env: NodeJS.ProcessEnv): string {
  if (env.ATTACHMENTS_DIR) return env.ATTACHMENTS_DIR;
  return join(env.RUNNER_TEMP || tmpdir(), "agent-attachments");
}

function resolveRepo(env: NodeJS.ProcessEnv): string {
  return String(env.REPO_SLUG || env.GITHUB_REPOSITORY || "").trim();
}

function resolveToken(env: NodeJS.ProcessEnv): string {
  return String(env.INPUT_GITHUB_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN || "");
}

export async function runDownloadAttachmentsCli(
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const repo = resolveRepo(env);
  const targetKind = String(env.TARGET_KIND || "").trim();
  const targetNumber = parseTargetNumber(env.TARGET_NUMBER);
  const outputDir = resolveAttachmentsDir(env);
  const manifestFile = join(outputDir, "manifest.json");

  const collected = collectAttachmentTextSources({
    repo,
    targetKind,
    targetNumber,
    requestText: env.REQUEST_TEXT || "",
  });
  const references = collectAttachmentReferences(collected.sources);
  const manifest = await downloadGitHubAttachments({
    references,
    outputDir,
    repo,
    targetKind,
    targetNumber,
    token: resolveToken(env),
  });
  manifest.errors.unshift(...collected.errors);
  writeAttachmentManifest(manifestFile, manifest);

  const downloadedCount = manifest.attachments.filter(
    (attachment) => attachment.status === "downloaded",
  ).length;
  const attachmentErrorCount = manifest.attachments.length - downloadedCount;
  const errorCount = attachmentErrorCount + manifest.errors.length;

  setOutput("manifest_file", manifestFile);
  setOutput("attachment_count", String(manifest.attachments.length));
  setOutput("downloaded_count", String(downloadedCount));
  setOutput("error_count", String(errorCount));

  console.log(
    `attachment manifest: ${manifest.attachments.length} attachment(s), ${downloadedCount} downloaded, ${errorCount} error(s)`,
  );
  console.log(`attachment manifest file: ${manifestFile}`);

  return 0;
}

if (require.main === module) {
  runDownloadAttachmentsCli().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`download-attachments failed: ${message}`);
      process.exitCode = 1;
    },
  );
}

