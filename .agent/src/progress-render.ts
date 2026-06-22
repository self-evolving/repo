import { compactSessionLog } from "./acpx-adapter.js";

export type ProgressStatus = "running" | "finalized" | "cancelled";
export type ProgressOutcome = "success" | "failure";

export interface ProgressActivity {
  kind: "tool" | "message";
  label: string;
  detail?: string;
  status?: string;
}

export interface ProgressViewModel {
  status: ProgressStatus;
  runId: string;
  route?: string;
  elapsedMs: number;
  stepCount: number;
  recentActivity: ProgressActivity[];
  lastMessage?: string;
  stopReason?: string;
}

export interface ProgressViewModelOptions {
  runId: string;
  route?: string;
  status?: ProgressStatus;
  elapsedMs?: number;
  recentActivityLimit?: number;
  maxMessageChars?: number;
}

const DEFAULT_ACTIVITY_LIMIT = 6;
const DEFAULT_MESSAGE_CHARS = 240;
const TOOL_DETAIL_CHARS = 120;

export function buildProgressViewModel(
  ndjsonTail: string,
  options: ProgressViewModelOptions,
): ProgressViewModel {
  const recentActivityLimit = Math.max(0, options.recentActivityLimit ?? DEFAULT_ACTIVITY_LIMIT);
  const maxMessageChars = Math.max(20, options.maxMessageChars ?? DEFAULT_MESSAGE_CHARS);
  const allActivity: ProgressActivity[] = [];
  const toolNames = toolDisplayNamesFromNdjson(ndjsonTail);
  let toolIndex = 0;
  let stepCount = 0;
  let lastMessage = "";
  let stopReason = "";

  for (const rawLine of compactSessionLog(ndjsonTail).split("\n")) {
    if (!rawLine.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(rawLine) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (entry.type === "tool_call" || entry.type === "tool_call_update") {
      stepCount += 1;
      allActivity.push(toolActivity(entry, toolNames[toolIndex]));
      toolIndex += 1;
      continue;
    }

    if (entry.type === "message") {
      const message = truncate(cleanSingleLine(String(entry.text ?? "")), maxMessageChars);
      if (message) {
        stepCount += 1;
        lastMessage = message;
        allActivity.push({ kind: "message", label: "💬 Message", detail: message });
      }
      continue;
    }

    if (entry.type === "done") {
      stopReason = cleanSingleLine(String(entry.stopReason ?? ""));
    }
  }

  return {
    status: options.status ?? "running",
    runId: normalizeRunId(options.runId),
    route: cleanSingleLine(options.route ?? ""),
    elapsedMs: Math.max(0, Math.floor(options.elapsedMs ?? 0)),
    stepCount,
    recentActivity: allActivity.slice(-recentActivityLimit),
    lastMessage: lastMessage || undefined,
    stopReason: stopReason || undefined,
  };
}

export function renderRunning(model: ProgressViewModel): string {
  const lines = [
    `### 🤖 Sepo is working${renderMeta(model)}`,
    "",
  ];

  if (model.recentActivity.length === 0) {
    lines.push("Starting…");
  } else {
    lines.push("Recent activity");
    lines.push(...renderActivityList(model.recentActivity));
  }

  if (model.lastMessage) {
    lines.push("", "Last message", `> ${model.lastMessage}`);
  }

  lines.push("", progressMarker(model.runId));
  return lines.join("\n");
}

export function renderFinal(model: ProgressViewModel, outcome: ProgressOutcome): string {
  const title = outcome === "success" ? "✅ Sepo finished" : "❌ Sepo finished with errors";
  const lines = [
    `### ${title}${renderMeta(model)}`,
    "",
  ];

  if (model.lastMessage) {
    lines.push("Last message", `> ${model.lastMessage}`, "");
  }

  lines.push(...renderCollapsedActivity(model.recentActivity), "", progressMarker(model.runId));
  return lines.join("\n");
}

export function renderCancelled(model: ProgressViewModel, byLogin: string): string {
  const login = cleanLogin(byLogin);
  const lines = [
    `### ⏹️ Sepo cancelled${renderMeta(model)}`,
    "",
    `Cancelled by @${login}.`,
    "",
    ...renderCollapsedActivity(model.recentActivity),
    "",
    progressMarker(model.runId),
  ];
  return lines.join("\n");
}

export function progressMarker(runId: string): string {
  return `<!-- sepo-progress:run-${normalizeRunId(runId)} -->`;
}

function toolDisplayNamesFromNdjson(ndjsonTail: string): string[] {
  const names: string[] = [];
  for (const rawLine of ndjsonTail.split("\n")) {
    if (!rawLine.trim()) continue;
    try {
      const event = JSON.parse(rawLine) as Record<string, unknown>;
      const update = (event.params as Record<string, unknown> | undefined)
        ?.update as Record<string, unknown> | undefined;
      if (update?.sessionUpdate !== "tool_call" && update?.sessionUpdate !== "tool_call_update") {
        continue;
      }
      names.push(cleanSingleLine(String(update.title ?? update.name ?? "")));
    } catch {
      // Ignore malformed and partial lines; compactSessionLog handles them too.
    }
  }
  return names;
}

function toolActivity(entry: Record<string, unknown>, preferredName?: string): ProgressActivity {
  const rawName = cleanSingleLine(preferredName || String(entry.name ?? ""));
  const status = cleanSingleLine(String(entry.status ?? ""));
  const label = toolLabel(rawName);
  const detail = toolDetail(rawName, label);
  return {
    kind: "tool",
    label,
    detail,
    status: status || undefined,
  };
}

function toolLabel(toolName: string): string {
  const normalized = toolName.trim().toLowerCase();
  if (!normalized) {
    return "🔧 Used tool";
  }
  if (/(^|[^a-z])read([^a-z]|$)|view|open/.test(normalized)) {
    return "📖 Read";
  }
  if (/edit|write|patch|update|create/.test(normalized)) {
    return "✏️ Edited";
  }
  if (/bash|shell|exec|command|terminal/.test(normalized)) {
    return "💻 Ran";
  }
  if (/grep|glob|search|find|rg/.test(normalized)) {
    return "🔍 Searched";
  }
  return "🔧 Used tool";
}

function toolDetail(toolName: string, label: string): string | undefined {
  const cleanName = truncate(toolName, TOOL_DETAIL_CHARS);
  if (!cleanName || cleanName.toLowerCase() === label.replace(/^[^\w]+/u, "").trim().toLowerCase()) {
    return undefined;
  }
  return cleanName;
}

function renderMeta(model: Pick<ProgressViewModel, "route" | "elapsedMs" | "stepCount">): string {
  const parts = [
    model.route?.trim() || undefined,
    formatElapsed(model.elapsedMs),
    `${model.stepCount} ${model.stepCount === 1 ? "step" : "steps"}`,
  ].filter(Boolean);
  return parts.length ? ` — ${parts.join(" · ")}` : "";
}

function renderCollapsedActivity(activity: ProgressActivity[]): string[] {
  if (activity.length === 0) {
    return ["<details>", "<summary>Activity</summary>", "", "No activity captured yet.", "</details>"];
  }
  return [
    "<details>",
    "<summary>Activity</summary>",
    "",
    ...renderActivityList(activity),
    "</details>",
  ];
}

function renderActivityList(activity: ProgressActivity[]): string[] {
  return activity.map((item) => {
    const chunks = [item.label];
    if (item.detail) {
      chunks.push(item.kind === "message" ? `"${item.detail}"` : markdownCode(item.detail));
    }
    if (item.status) {
      chunks.push(`(${item.status})`);
    }
    return `- ${chunks.join(" ")}`;
  });
}

function markdownCode(value: string): string {
  return `\`${value.replace(/`/g, "'")}\``;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h${String(minutes).padStart(2, "0")}m${String(seconds).padStart(2, "0")}s`;
  }
  if (minutes > 0) {
    return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

function cleanSingleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function normalizeRunId(runId: string): string {
  const normalized = cleanSingleLine(runId).replace(/[^A-Za-z0-9._-]/g, "-");
  return normalized || "unknown";
}

function cleanLogin(login: string): string {
  const normalized = cleanSingleLine(login).replace(/^@+/, "").replace(/[^A-Za-z0-9-]/g, "");
  return normalized || "unknown";
}
