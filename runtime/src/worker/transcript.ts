import type { TranscriptMessage, TranscriptStore } from "../../../core/src/transcript.ts";

/** Private mirror of exactly one host-owned transcript. */
export class WorkerTranscript implements TranscriptStore {
  #messages: TranscriptMessage[] = [];
  readonly sessionId: string;
  readonly publish: (from: number, messages: readonly TranscriptMessage[]) => void;
  constructor(
    sessionId: string,
    publish: (from: number, messages: readonly TranscriptMessage[]) => void,
  ) {
    this.sessionId = sessionId;
    this.publish = publish;
  }
  #check(id: string) {
    if (id !== this.sessionId) throw new Error("transcript outside worker binding");
  }
  seed(messages: readonly TranscriptMessage[]) {
    this.#messages.push(...structuredClone(messages));
  }
  load(id: string) {
    this.#check(id);
    return structuredClone(this.#messages);
  }
  count(id: string) {
    this.#check(id);
    return this.#messages.length;
  }
  append(id: string, messages: readonly TranscriptMessage[]) {
    this.replaceFrom(id, this.count(id), messages);
  }
  replaceFrom(id: string, from: number, messages: readonly TranscriptMessage[]) {
    this.#check(id);
    if (!Number.isSafeInteger(from) || from < 0 || from > this.#messages.length)
      throw new Error("invalid transcript offset");
    const copy = structuredClone(messages);
    this.publish(from, copy);
    this.#messages.splice(from, this.#messages.length - from, ...copy);
  }
  clear(id: string) {
    this.replaceFrom(id, 0, []);
  }
  copyTo(_from: string, _to: string): never {
    throw new Error("forking transcripts belongs to the host");
  }
}
