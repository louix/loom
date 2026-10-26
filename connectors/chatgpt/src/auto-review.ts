/** Codex 0.160's review notification -> native denied-action retry event. */
export interface DeniedReview {
  id: string;
  turnId: string;
  event: Record<string, unknown>;
  input: Record<string, unknown>;
}

const snake = (s: string): string => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

export const deniedReview = (p: Record<string, unknown>): DeniedReview | null => {
  const review = p["review"] as Record<string, unknown> | undefined;
  const action = p["action"] as Record<string, unknown> | undefined;
  if (
    review?.["status"] !== "denied" ||
    typeof p["reviewId"] !== "string" ||
    !p["reviewId"] ||
    typeof p["turnId"] !== "string" ||
    !p["turnId"] ||
    !action ||
    typeof action["type"] !== "string" ||
    ![
      "command",
      "execve",
      "writeStdin",
      "applyPatch",
      "networkAccess",
      "mcpToolCall",
      "requestPermissions",
    ].includes(action["type"])
  )
    return null;

  // Only the action's own keys and enum values change casing. Nested permission
  // profiles already use their protocol representation and must stay intact.
  const nativeAction = Object.fromEntries(
    Object.entries(action).map(([key, value]) => [
      snake(key),
      (key === "type" || key === "source") && typeof value === "string" ? snake(value) : value,
    ]),
  );
  const reason =
    typeof review["rationale"] === "string" && review["rationale"].trim()
      ? review["rationale"]
      : "No reason was provided.";
  return {
    id: p["reviewId"],
    turnId: p["turnId"],
    input: {
      action,
      reason: `Automatic approval review denied this action: ${reason}\nApprove one retry?`,
      riskLevel: review["riskLevel"],
      userAuthorization: review["userAuthorization"],
    },
    event: {
      id: p["reviewId"],
      target_item_id: p["targetItemId"],
      turn_id: p["turnId"],
      started_at_ms: p["startedAtMs"],
      completed_at_ms: p["completedAtMs"],
      status: "denied",
      risk_level: review["riskLevel"],
      user_authorization: review["userAuthorization"],
      rationale: review["rationale"],
      decision_source: p["decisionSource"],
      action: nativeAction,
    },
  };
};
