import type { HarnessEvent } from "@loom/core/events";

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Account reads contain all buckets; rolling notifications contain one sparse bucket. */
export const rateLimitEvents = (
  payload: unknown,
  sessionId: string,
  ts: number,
): HarnessEvent[] => {
  const response = record(payload);
  const buckets = record(response?.["rateLimitsByLimitId"]);
  const entries =
    buckets && Object.keys(buckets).length
      ? Object.entries(buckets)
      : [["codex", response?.["rateLimits"]] as const];
  const events: HarnessEvent[] = [];
  for (const [key, value] of entries) {
    const snapshot = record(value);
    if (!snapshot) continue;
    const id = typeof snapshot["limitId"] === "string" ? snapshot["limitId"] : key;
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
      events.push({
        type: "rate_limit",
        sessionId,
        ts,
        window: `${id} ${duration}`,
        utilization: used,
        status,
        ...(typeof reset === "number" && Number.isFinite(reset) && reset > 0
          ? { resetsAt: reset * 1000 }
          : {}),
      });
    }
  }
  return events;
};
