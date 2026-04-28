// Session continuity policy.
//
// Separates three concerns:
// 1. whether a route tracks durable thread state
// 2. whether it attempts to resume prior ACP sessions across runs
// 3. whether continuity failures are fatal or best-effort
//
// Policy is explicit in workflow YAML. We intentionally do not provide
// route-based defaults or backward-compatibility fallbacks.

export type SessionPolicy =
  | "none"
  | "track-only"
  | "resume-best-effort"
  | "resume-required";

export type SessionMode = "exec" | "persistent";

export function parseSessionPolicy(value: string | undefined): SessionPolicy | null {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "none" ||
    normalized === "track-only" ||
    normalized === "resume-best-effort" ||
    normalized === "resume-required"
  ) {
    return normalized;
  }
  return null;
}

export function sessionModeForPolicy(policy: SessionPolicy): SessionMode {
  return policy === "none" ? "exec" : "persistent";
}

export function tracksThreadState(policy: SessionPolicy): boolean {
  return policy !== "none";
}

export function attemptsResume(policy: SessionPolicy): boolean {
  return policy === "resume-best-effort" || policy === "resume-required";
}

export function requiresResumeContinuity(policy: SessionPolicy): boolean {
  return policy === "resume-required";
}
