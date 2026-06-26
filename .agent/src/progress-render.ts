import { compactSessionLog } from "./acpx-adapter.js";

export type ProgressStatus = "running" | "finalized" | "cancelled";
export type ProgressOutcome = "success" | "failure" | "finished";

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
  totalStepCount?: number;
  recentActivityLimit?: number;
  maxMessageChars?: number;
}

const DEFAULT_ACTIVITY_LIMIT = 6;
const DEFAULT_MESSAGE_CHARS = 240;
const TOOL_DETAIL_CHARS = 120;

interface ToolEvent {
  key: string;
  name?: string;
  title?: string;
  status?: string;
}

interface ToolMetadata {
  name?: string;
  title?: string;
  status?: string;
}

interface ToolKeyState {
  anonymousToolIndex: number;
  lastToolKey: string;
}

export interface ProgressStepCounterState {
  count: number;
  partialLine: string;
  messageOpen: boolean;
  anonymousToolIndex: number;
  lastToolKey: string;
  seenToolKeys: Set<string>;
}

export function createProgressStepCounter(): ProgressStepCounterState {
  return {
    count: 0,
    partialLine: "",
    messageOpen: false,
    anonymousToolIndex: 0,
    lastToolKey: "",
    seenToolKeys: new Set<string>(),
  };
}

export function buildProgressViewModel(
  ndjsonTail: string,
  options: ProgressViewModelOptions,
): ProgressViewModel {
  const recentActivityLimit = Math.max(0, options.recentActivityLimit ?? DEFAULT_ACTIVITY_LIMIT);
  const maxMessageChars = Math.max(20, options.maxMessageChars ?? DEFAULT_MESSAGE_CHARS);
  const allActivity: ProgressActivity[] = [];
  const toolEvents = toolEventsFromNdjson(ndjsonTail);
  const toolActivityIndexByKey = new Map<string, number>();
  const toolMetadataByKey = new Map<string, ToolMetadata>();
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
      const event = toolEvents[toolIndex];
      const key = event?.key ?? `compact:${toolIndex}`;
      const metadata = mergeToolMetadata(toolMetadataByKey.get(key), event, entry);
      toolMetadataByKey.set(key, metadata);
      const activity = toolActivity(metadata);
      const existingIndex = toolActivityIndexByKey.get(key);
      if (existingIndex === undefined) {
        stepCount += 1;
        toolActivityIndexByKey.set(key, allActivity.length);
        allActivity.push(activity);
      } else {
        allActivity[existingIndex] = activity;
      }
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
    stepCount: normalizeStepCount(options.totalStepCount, stepCount),
    recentActivity: allActivity.slice(-recentActivityLimit),
    lastMessage: lastMessage || undefined,
    stopReason: stopReason || undefined,
  };
}

export function countProgressSteps(ndjson: string): number {
  return appendProgressStepCount(createProgressStepCounter(), ndjson);
}

export function appendProgressStepCount(state: ProgressStepCounterState, ndjsonChunk: string): number {
  const text = state.partialLine + ndjsonChunk;
  const lines = text.split("\n");
  state.partialLine = text.endsWith("\n") ? "" : lines.pop() ?? "";

  for (const line of lines) {
    countProgressLine(state, line);
  }

  if (state.partialLine && countProgressLine(state, state.partialLine)) {
    state.partialLine = "";
  }

  return state.count;
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
  const title = finalTitle(outcome);
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

function finalTitle(outcome: ProgressOutcome): string {
  if (outcome === "success") return "✅ Sepo finished";
  if (outcome === "failure") return "❌ Sepo finished with errors";
  return "Sepo finished";
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

function toolEventsFromNdjson(ndjsonTail: string): ToolEvent[] {
  const events: ToolEvent[] = [];
  const keyState: ToolKeyState = { anonymousToolIndex: 0, lastToolKey: "" };

  for (const rawLine of ndjsonTail.split("\n")) {
    if (!rawLine.trim()) continue;
    try {
      const event = JSON.parse(rawLine) as Record<string, unknown>;
      const update = (event.params as Record<string, unknown> | undefined)
        ?.update as Record<string, unknown> | undefined;
      if (update?.sessionUpdate !== "tool_call" && update?.sessionUpdate !== "tool_call_update") {
        continue;
      }
      const name = cleanSingleLine(String(update.name ?? ""));
      const title = cleanSingleLine(String(update.title ?? ""));
      const status = cleanSingleLine(String(update.status ?? ""));
      const toolCallId = cleanSingleLine(String(update.toolCallId ?? ""));
      const key = progressToolKey(keyState, String(update.sessionUpdate), { name, title, toolCallId });
      events.push({
        key,
        name: name || undefined,
        title: title || undefined,
        status: status || undefined,
      });
    } catch {
      // Ignore malformed and partial lines; compactSessionLog handles them too.
    }
  }
  return events;
}

function countProgressLine(state: ProgressStepCounterState, rawLine: string): boolean {
  if (!rawLine.trim()) return true;

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawLine) as Record<string, unknown>;
  } catch {
    return false;
  }

  const update = (event.params as Record<string, unknown> | undefined)
    ?.update as Record<string, unknown> | undefined;
  if (!update?.sessionUpdate) return true;

  const updateType = update.sessionUpdate;
  if (updateType === "agent_message_chunk") {
    const content = update.content as Record<string, unknown> | undefined;
    if (content?.type === "text" && content.text && !state.messageOpen) {
      state.count += 1;
      state.messageOpen = true;
    }
    return true;
  }

  if (updateType === "tool_call" || updateType === "tool_call_update") {
    state.messageOpen = false;
    const key = progressToolKey(state, String(updateType), {
      name: cleanSingleLine(String(update.name ?? "")),
      title: cleanSingleLine(String(update.title ?? "")),
      toolCallId: cleanSingleLine(String(update.toolCallId ?? "")),
    });
    if (!state.seenToolKeys.has(key)) {
      state.count += 1;
      state.seenToolKeys.add(key);
    }
    return true;
  }

  if (updateType === "usage_update") {
    state.messageOpen = false;
  }
  return true;
}

function progressToolKey(
  state: ToolKeyState,
  updateType: string,
  fields: { name: string; title: string; toolCallId: string },
): string {
  let key = fields.toolCallId ? `id:${fields.toolCallId}` : "";

  if (!key) {
    if (updateType === "tool_call") {
      state.anonymousToolIndex += 1;
      key = `anonymous:${state.anonymousToolIndex}`;
    } else if (state.lastToolKey) {
      key = state.lastToolKey;
    } else if (fields.name) {
      key = `name:${fields.name}`;
    } else if (fields.title) {
      key = `title:${fields.title}`;
    } else {
      state.anonymousToolIndex += 1;
      key = `anonymous:${state.anonymousToolIndex}`;
    }
  }

  state.lastToolKey = key;
  return key;
}

function mergeToolMetadata(
  current: ToolMetadata | undefined,
  event: ToolEvent | undefined,
  entry: Record<string, unknown>,
): ToolMetadata {
  const next: ToolMetadata = { ...current };
  const fallbackName = cleanSingleLine(String(entry.name ?? ""));
  const candidateName = event?.name || (!event ? fallbackName : "");

  if (candidateName && shouldStoreToolName(candidateName, next.name)) {
    next.name = candidateName;
  }
  if (event?.title && shouldStoreToolTitle(event.title, next.title)) {
    next.title = event.title;
  }
  if (!next.name && fallbackName) {
    next.name = fallbackName;
  }
  if (event?.status) {
    next.status = event.status;
  } else {
    const fallbackStatus = cleanSingleLine(String(entry.status ?? ""));
    if (fallbackStatus) {
      next.status = fallbackStatus;
    }
  }
  return next;
}

function shouldStoreToolName(candidate: string, current?: string): boolean {
  if (!current) {
    return true;
  }
  return isGenericToolName(current) && !isGenericToolName(candidate);
}

function shouldStoreToolTitle(candidate: string, current?: string): boolean {
  if (!current) {
    return true;
  }
  return isGenericToolName(current) && !isGenericToolName(candidate);
}

function toolActivity(metadata: ToolMetadata): ProgressActivity {
  const toolName = metadata.name ?? "";
  const displayTitle = metadata.title || toolName;
  const label = toolLabel(toolName, displayTitle);
  const detail = toolDetail(displayTitle, label);
  return {
    kind: "tool",
    label,
    detail,
    status: metadata.status,
  };
}

function toolLabel(toolName: string, displayTitle = ""): string {
  const source = toolName && !isGenericToolName(toolName) ? toolName : displayTitle || toolName;
  const normalized = source.trim().toLowerCase();
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

function isGenericToolName(toolName: string): boolean {
  return /^tool(?:[_-]?\d+)?$/i.test(toolName.trim());
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

function normalizeStepCount(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

function cleanLogin(login: string): string {
  const normalized = cleanSingleLine(login).replace(/^@+/, "").replace(/[^A-Za-z0-9-]/g, "");
  return normalized || "unknown";
}
