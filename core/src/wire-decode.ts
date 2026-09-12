/** Shared schemas validate socket envelopes and their Loom-owned payloads. */
import {
  daemonSnapshotSchema,
  requestFrameSchema,
  responseFrameSchema,
  statePushSchema,
  pushFrameSchema,
  helloResultSchema,
  type DaemonSnapshot,
  type RequestFrame,
  type ResponseFrame,
  type StatePush,
  type PushFrame,
  type HelloResult,
} from "./wire.ts";

export const isDaemonSnapshot = (v: unknown): v is DaemonSnapshot =>
  daemonSnapshotSchema.safeParse(v).success;
export const isRequestFrame = (v: unknown): v is RequestFrame =>
  requestFrameSchema.safeParse(v).success;
export const isResponseFrame = (v: unknown): v is ResponseFrame =>
  responseFrameSchema.safeParse(v).success;
export const isStatePush = (v: unknown): v is StatePush => statePushSchema.safeParse(v).success;
export const isPushFrame = (v: unknown): v is PushFrame => pushFrameSchema.safeParse(v).success;
export const isHelloResult = (v: unknown): v is HelloResult =>
  helloResultSchema.safeParse(v).success;
