import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSnapshot } from "@loom/core/wire";
import { mkComposer, release, enqueue, outboxOf, pending, cleared } from "@loom/tui/composer";

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
const fixture = () => {
  const session = { id: "a", status: { kind: "idle" }, turns: 1 } as SessionSnapshot;
  const sessions = [session];
  const calls: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  const notes: string[] = [];
  const recovered: string[] = [];
  const composer = mkComposer({
    recover: (text) => recovered.push(text),
    fleet: () => sessions,
    note: (text) => notes.push(text),
    send: () => new Promise<void>((resolve, reject) => calls.push({ resolve, reject })),
  });
  return { composer, calls, notes, session, sessions, recovered };
};

test("a rejected send stays held until explicit retry, including while reviewed", async () => {
  const f = fixture();
  f.composer.enqueue("a", "same");
  f.calls[0]!.reject(new Error("busy"));
  await flush();
  assert.equal(f.calls.length, 1);
  assert.equal(f.composer.get().a?.t, "held");
  f.composer.enqueue("a", "later");
  f.session.turns++;
  assert.equal(release(f.composer.get().a!)!.text, "same");
  f.composer.advance();
  assert.equal(f.calls.length, 1);
  void f.composer.retry("a", "edited");
  assert.equal(f.calls.length, 2);
  f.calls[1]!.resolve();
  await flush();
  assert.equal(f.composer.get().a?.t, "queued");
  assert.equal(f.calls.length, 2);
  f.composer.dispose();
});

test("clearing preserves an in-flight send and obsolete completions cannot consume a replacement", async () => {
  const f = fixture();
  f.composer.enqueue("a", "same");
  f.composer.clear("a");
  f.composer.enqueue("a", "same");
  f.composer.advance();
  assert.equal(f.calls.length, 1);
  f.calls[0]!.resolve();
  await flush();
  assert.deepEqual(
    pending(f.composer.get().a!),
    ["same"],
    "clearing did not consume the next message",
  );
  assert.equal(f.calls.length, 1, "the next message waits for a new turn");
  f.session.turns++;
  f.composer.advance();
  // Removal/replacement: even identical text is a different operation.
  f.sessions.length = 0;
  f.composer.advance();
  assert.deepEqual(f.recovered, ["same"], "the outgoing head remains recoverable after removal");
  f.sessions.push(f.session);
  f.composer.enqueue("a", "same");
  f.notes.length = 0;
  const second = f.composer.get().a;
  f.calls[1]!.resolve();
  await flush();
  assert.equal(f.composer.get().a, second);
  f.composer.dispose();
  f.calls[2]!.reject(new Error("late"));
  await flush();
  assert.equal(f.composer.get().a, second);
  assert.deepEqual(f.notes, []);
});

test("enqueue trims messages, keeps order, ignores blanks and clears queued text", () => {
  let box = outboxOf({}, "a");
  box = enqueue(box, "  first  ");
  box = enqueue(box, "second");
  box = enqueue(box, "   "); // blank is not a message
  assert.equal(box.t, "queued");
  assert.deepEqual(pending(box), ["first", "second"]);
  assert.deepEqual(pending(cleared(box)), []);
});
