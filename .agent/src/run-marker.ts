export function normalizeRunMarkerId(value: string): string {
  const normalized = String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, "-");
  return normalized || "unknown";
}
