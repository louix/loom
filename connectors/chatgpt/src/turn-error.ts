/**
 * Why Codex ended a turn early, in Loom's words. A `turn/completed` turn
 * carries `error` (`TurnError`) when it failed — and, since Codex 0.160, when
 * Codex interrupted it itself — with a machine code (`codexErrorInfo`) beside
 * the human `message`.
 */

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** `CodexErrorInfo`'s plain codes (Codex 0.160). `other` says nothing. */
const CODE_LABELS: Record<string, string | null> = {
  contextWindowExceeded: "context window exceeded",
  sessionBudgetExceeded: "session budget exceeded",
  usageLimitExceeded: "usage limit reached",
  rateLimitExceeded: "rate limited",
  flexUnavailable: "flex processing unavailable",
  serverOverloaded: "server overloaded",
  cyberPolicy: "cyber policy",
  misalignmentPolicyViolation: "misalignment policy",
  tooManyDenials: "too many denials",
  internalServerError: "internal server error",
  unauthorized: "unauthorized",
  badRequest: "bad request",
  threadRollbackFailed: "thread rollback failed",
  sandboxError: "sandbox error",
  other: null,
};

/** `CodexErrorInfo`'s object variants, each `{ <code>: { …details } }`. */
const DETAIL_LABELS: Record<string, string> = {
  httpConnectionFailed: "connection failed",
  responseStreamConnectionFailed: "stream connection failed",
  responseStreamDisconnected: "stream disconnected",
  responseTooManyFailedAttempts: "too many failed attempts",
  activeTurnNotSteerable: "turn not steerable",
};

/** `fooBarBaz` → `foo bar baz`: a code this table doesn't know yet still reads. */
const words = (code: string): string =>
  code
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .trim();

/** A short label for a `CodexErrorInfo`, or undefined when it names nothing. */
export const codexErrorLabel = (info: unknown): string | undefined => {
  if (typeof info === "string") {
    const known = CODE_LABELS[info];
    return known === undefined ? words(info) || undefined : (known ?? undefined);
  }
  const variant = record(info);
  const code = variant && Object.keys(variant)[0];
  if (!code) return undefined;
  const label = DETAIL_LABELS[code] ?? words(code);
  const status = record(variant[code])?.["httpStatusCode"];
  return typeof status === "number" ? `${label} (HTTP ${status})` : label;
};

/** Why a turn ended early: the code's label, else Codex's message; `message`
 *  is the message when it says more than `reason`. */
export const turnErrorReason = (error: unknown): { reason?: string; message?: string } => {
  const e = record(error);
  const raw = e?.["message"];
  const message = typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
  const reason = codexErrorLabel(e?.["codexErrorInfo"]) ?? message?.replace(/\s+/g, " ");
  return {
    ...(reason ? { reason } : {}),
    ...(message && message !== reason ? { message } : {}),
  };
};
