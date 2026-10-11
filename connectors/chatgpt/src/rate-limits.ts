import type { HarnessEvent, PlanWindow } from "@loom/core/events";

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * Where a payload came from: an `account/rateLimits/read` answer (`read`)
 * holds every bucket, and an on-demand refresh can repeat it, so its windows
 * are `polled`; an `account/rateLimits/updated` notification (`update`) holds
 * one sparse bucket.
 */
export type RateLimitSource = "read" | "update";

/** Account reads contain all buckets; rolling notifications contain one sparse bucket. */
export const rateLimitWindows = (
  payload: unknown,
  ts: number,
  source: RateLimitSource,
): PlanWindow[] => {
  const response = record(payload);
  const buckets = record(response?.["rateLimitsByLimitId"]);
  const entries =
    buckets && Object.keys(buckets).length
      ? Object.entries(buckets)
      : [["codex", response?.["rateLimits"]] as const];
  const windows: PlanWindow[] = [];
  for (const [key, value] of entries) {
    const snapshot = record(value);
    if (!snapshot) continue;
    const id = typeof snapshot["limitId"] === "string" ? snapshot["limitId"] : key;
    // The usage endpoint reports Spark under its internal bucket name.
    const label = id === "codex_bengalfox" ? "codex_5.3-spark" : id;
    for (const slot of ["primary", "secondary"] as const) {
      const window = record(snapshot[slot]);
      const used = window?.["usedPercent"];
      if (typeof used !== "number" || !Number.isFinite(used) || used < 0) continue;
      const minutes = window?.["windowDurationMins"];
      let duration: string = slot;
      if (typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0) {
        if (minutes % 1440 === 0) duration = `${minutes / 1440}d`;
        else if (minutes % 60 === 0) duration = `${minutes / 60}h`;
        else duration = `${minutes}m`;
      }
      let status: "allowed" | "allowed_warning" | "rejected" = "allowed";
      if (used >= 100) status = "rejected";
      else if (used >= 80) status = "allowed_warning";
      const reset = window?.["resetsAt"];
      windows.push({
        ts,
        window: `${label} ${duration}`,
        utilization: used,
        status,
        ...(typeof reset === "number" && Number.isFinite(reset) && reset > 0
          ? { resetsAt: reset * 1000 }
          : {}),
        ...(source === "read" ? { polled: true as const } : {}),
      });
    }
  }
  return windows;
};

/** {@link rateLimitWindows} as a session's `rate_limit` events. */
export const rateLimitEvents = (
  payload: unknown,
  sessionId: string,
  ts: number,
  source: RateLimitSource,
): HarnessEvent[] =>
  rateLimitWindows(payload, ts, source).map((w) => ({ type: "rate_limit", sessionId, ...w }));
