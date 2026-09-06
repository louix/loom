/**
 * Boundary decoders for the frames each end of the socket receives.
 *
 * Every predicate here answers one question — "is this shape safe to route?" —
 * and answers it about the envelope, the discriminants, and the fields a
 * consumer branches on or iterates. It is deliberately *not* a schema check of
 * every leaf: a permission request's `input` is whatever the vendor SDK put in
 * the tool call, and validating that would mean re-deriving somebody else's
 * protocol here, which the frames' own consumers do not need.
 *
 * A frame that fails one of these is not a value with a field missing. It is
 * evidence the peer is not speaking this protocol, so both readers drop the
 * connection on one rather than skip it — a stream we cannot parse has already
 * lost frames we would never learn about.
 */
import type {
  DaemonSnapshot,
  HelloResult,
  PushFrame,
  RequestFrame,
  ResponseFrame,
  StatePush,
} from "./wire.ts";

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** A wire id must survive a JSON round trip and index a map — no floats, no NaN. */
const isId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const isArrOf = (v: unknown, each: (x: unknown) => boolean): boolean =>
  Array.isArray(v) && v.every(each);

const STATE_KINDS = new Set([
  "starting",
  "running",
  "awaiting_input",
  "interrupted",
  "idle",
  "working_background",
  "error",
  "done",
]);
const AWAIT_REASONS = new Set(["permission", "question", "plan_review", "user_question"]);
const INTERACTION_KINDS = new Set(["permission", "user_question", "question", "plan_review"]);

/** The closed union a client folds over — a `kind` outside it has no branch. */
const isSessionState = (v: unknown): boolean => {
  if (!isRec(v) || !isStr(v["kind"]) || !STATE_KINDS.has(v["kind"])) return false;
  if (v["kind"] === "awaiting_input") return isStr(v["on"]) && AWAIT_REASONS.has(v["on"]);
  if (v["kind"] === "interrupted") return v["by"] === "user" || v["by"] === "stream_ended";
  if (v["kind"] === "error") return isStr(v["message"]);
  return true;
};

/** A blocking request must be answerable straight off the snapshot: it needs an
 *  id to resolve against and the payload its own kind renders from. */
const isInteraction = (v: unknown): boolean => {
  if (!isRec(v) || !isStr(v["kind"]) || !INTERACTION_KINDS.has(v["kind"])) return false;
  if (!isStr(v["id"]) || !isNum(v["at"])) return false;
  if (v["kind"] === "permission" || v["kind"] === "user_question") return isStr(v["tool"]);
  if (v["kind"] === "question") return isStr(v["question"]);
  return isStr(v["plan"]);
};

const isDaemonInfo = (v: unknown): boolean =>
  isRec(v) &&
  isNum(v["pid"]) &&
  isStr(v["version"]) &&
  isNum(v["startedAt"]) &&
  isStr(v["repoRoot"]) &&
  isStr(v["epoch"]);

const isProviderInfo = (v: unknown): boolean =>
  isRec(v) && isStr(v["id"]) && isArrOf(v["models"], isStr);

const isSessionSnapshot = (v: unknown): boolean =>
  isRec(v) &&
  isStr(v["id"]) &&
  isStr(v["provider"]) &&
  isStr(v["mode"]) &&
  isSessionState(v["status"]) &&
  isArrOf(v["requests"], isInteraction) &&
  Array.isArray(v["subagents"]) &&
  Array.isArray(v["backgroundTasks"]) &&
  isRec(v["rateLimits"]) &&
  isRec(v["usage"]) &&
  isRec(v["cache"]);

export const isDaemonSnapshot = (v: unknown): v is DaemonSnapshot =>
  isRec(v) &&
  isDaemonInfo(v["daemon"]) &&
  isArrOf(v["providers"], isProviderInfo) &&
  isArrOf(v["sessions"], isSessionSnapshot);

/** Client -> daemon. An unroutable envelope has no id to answer on. */
export const isRequestFrame = (v: unknown): v is RequestFrame =>
  isRec(v) && v["kind"] === "req" && isId(v["id"]) && isStr(v["method"]);

/**
 * Daemon -> client. `ok` decides which half of the union the caller reads, so
 * a response that says neither cannot be settled either way.
 */
export const isResponseFrame = (v: unknown): v is ResponseFrame => {
  if (!isRec(v) || v["kind"] !== "res" || !isId(v["id"])) return false;
  if (v["ok"] === true) return "result" in v;
  if (v["ok"] !== false) return false;
  const e = v["error"];
  return isRec(e) && isStr(e["code"]) && isStr(e["message"]);
};

/** The whole-fleet replacement snapshot. Outside the `seq` space by design. */
export const isStatePush = (v: unknown): v is StatePush =>
  isRec(v) && v["kind"] === "push" && v["type"] === "state" && isDaemonSnapshot(v["state"]);

/** The `seq`-stamped stream. `event` payloads stay unvalidated past their
 *  `sessionId` / `type` — they are the adapter's vocabulary, not the wire's. */
export const isPushFrame = (v: unknown): v is PushFrame => {
  if (!isRec(v) || v["kind"] !== "push" || !isNum(v["seq"])) return false;
  switch (v["type"]) {
    case "event": {
      const ev = v["event"];
      return isRec(ev) && isStr(ev["type"]) && isStr(ev["sessionId"]);
    }
    case "resync":
      return isStr(v["reason"]);
    case "notice":
      return isStr(v["text"]) && (v["tone"] === "info" || v["tone"] === "warn");
    default:
      return false;
  }
};

/**
 * The handshake result. `protocolVersion` is checked by the caller, not here —
 * a *well-formed* hello reporting an incompatible version is a mismatch to
 * report, not a malformed frame to drop the socket over.
 */
export const isHelloResult = (v: unknown): v is HelloResult =>
  isRec(v) &&
  isNum(v["protocolVersion"]) &&
  isDaemonInfo(v["daemon"]) &&
  isNum(v["seq"]) &&
  typeof v["replaying"] === "boolean";
