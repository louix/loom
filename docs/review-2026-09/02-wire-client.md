# Review 02 — Wire protocol, event log, gap replay/resync, thin client + reconnect

Area: `core/src/wire.ts`, `core/src/channel.ts`, `core/src/events.ts`,
`backend/daemon/src/daemon/event-log.ts`, `backend/daemon/src/daemon/rpc.ts`,
`client/src/client.ts` (plus adjacent `daemon/connection.ts`, `daemon/server.ts`,
`daemon.ts#hHello` for context).

Findings ranked most severe first.

---

### No write-side backpressure — one stuck client grows daemon memory unbounded
- **File:** backend/daemon/src/daemon/connection.ts:73-89 (`#write` / `push`); backend/daemon/src/daemon/server.ts:93-95 (`broadcast`)
- **Severity:** high
- **Issue:** `Connection.#write` calls `this.socket.write(...)` and ignores the
  return value; `push()` never checks `socket.writableLength` / `writableNeedDrain`.
  `broadcast()` fans every push frame to every connection unconditionally. If one
  client stops reading its socket (suspended laptop, SIGSTOP'd TUI, a frontend
  stuck in a render loop) the kernel send buffer fills, `write()` starts returning
  `false`, and Node queues the frames in the `Writable`'s in-memory buffer with no
  cap. A busy session emits assistant-text / usage / tool events continuously, so
  the daemon's heap grows without bound until OOM — the ring buffer in
  `event-log.ts` is bounded but the per-socket write queue is not.
- **Fix:** Track `socket.writableLength` (or accumulate a per-connection pending
  byte count); once it crosses a ceiling, either drop that connection (it can
  reconnect and gap-replay — that machinery already exists) or pause pushes to it
  and send a `resync` when it drains. Log the slow client.

---

### `#resync` moves `#lastSeq` backwards → duplicate event replay on a later reconnect
- **File:** client/src/client.ts:358-380 (`#resync`), esp. line 371 `this.#lastSeq = result.seq;`
- **Severity:** medium
- **Issue:** `#resync` is fire-and-forget (`void this.#resync(...)` at line 273)
  and `await`s a fresh `hello`. While it is awaiting, live push frames keep
  arriving through `#deliverPush`, each advancing `#lastSeq` (line 271). When the
  awaited `hello` resolves, `#resync` unconditionally assigns
  `this.#lastSeq = result.seq`, which can be *lower* than the value the concurrent
  live frames already set. On the next disconnect, `#handshake(this.#lastSeq)`
  asks the daemon to replay from the regressed seq, so frames the client already
  processed are replayed again — re-appended to `#eventLog` and re-dispatched to
  every push listener. There is no seq de-dupe in `#deliverPush`, so the TUI
  double-applies those events.
- **Fix:** Guard the assignment: `if (result.seq > this.#lastSeq) this.#lastSeq = result.seq;`
  (monotonic, same as `#deliverPush`). Also consider that `#resync` issues a
  *second* `hello` on a connection `#handshake` already handshook — the rolled
  branch of `#handshake` has already re-baselined `sessions`/`#lastSeq`, so
  `#resync` only needs to fire the `"resync"` listener event, not re-`hello`.

---

### In-flight requests are rejected on any socket blip and never retried
- **File:** client/src/client.ts:320-330 (`#onSocketClose`), 103-133 (`request`)
- **Severity:** medium
- **Issue:** The client advertises "automatic reconnect", but `#onSocketClose`
  rejects every entry in `#pending` with `connection closed` and clears the map.
  A `session.create` / `session.fork` (120 s ceiling) or `session.compact` (15 min)
  that was in flight when the socket dropped is rejected even though the daemon
  may run it to completion. The caller sees a hard failure for an operation that
  actually succeeded; daemon state later converges via replayed
  `session_updated`/events, but the UI has already surfaced an error.
  Additionally, `request()` throws synchronously (`not connected`) for the entire
  reconnect window because `#sock` is null — callers get no queueing.
- **Fix:** Distinguish "request outcome unknown" from "request failed" so callers
  can choose to poll/reconcile; optionally hold safe/idempotent requests and
  resend after the reconnect handshake, or at minimum expose the reconnect state
  so callers can await it before retrying.

---

### Failed handshake leaves `#helloDone=false` and never clears `#preHelloQueue`
- **File:** client/src/client.ts:291-318 (`#handshake`), 243-254 (`#onFrame`)
- **Severity:** medium
- **Issue:** `#handshake` sets `#helloDone = false` then `await this.request("hello")`.
  If that rejects (timeout, or the just-attached socket drops again), the error
  propagates to `#reconnectLoop`'s catch and it retries — but `#helloDone` stays
  `false` and `#preHelloQueue` is never emptied. Any push frames that arrived on
  the dead/half-open socket sit in `#preHelloQueue` unbounded (no cap), and the
  *next* successful `#handshake` drains that stale queue, mixing frames from a
  prior connection into the new session. With no seq de-dupe those become
  duplicate deliveries (or, if their seq ≤ the new `result.seq` and the daemon
  did not restart, silently mis-ordered).
- **Fix:** In `#handshake` (or `#attach`) reset `#preHelloQueue = []` at the start
  of every handshake attempt, and cap its length defensively; keep `#helloDone`
  handling in a `try/finally` so a partial handshake can't leave the flag wedged.

---

### AsyncChannel has no backpressure and an unbounded queue
- **File:** core/src/channel.ts:27-32 (`push`), 9 (`#queue`)
- **Severity:** medium
- **Issue:** `push()` is synchronous, never blocks, and appends to `#queue` with
  no high-water mark when no consumer waiter is parked. It sits on the hot path of
  every adapter (merging the provider SDK message iterator with out-of-band
  callbacks). If the SDK streams faster than the daemon consumer drains (slow
  persistence, a stalled downstream), `#queue` grows without bound → per-session
  memory growth. `drain()` and `pending` exist for observability but nothing
  enforces a limit.
- **Fix:** Add a configurable capacity; on overflow either apply backpressure by
  making `push` return a promise that resolves on drain, or drop-oldest with a
  counter the adapter can surface. At minimum document the assumption and assert
  on `pending` crossing a threshold.

---

### Client socket read buffer is unbounded (asymmetric with the daemon)
- **File:** client/src/client.ts:226-241 (`#ingest`), 51 (`#buf`)
- **Severity:** low-medium
- **Issue:** `#ingest` does `this.#buf += chunk` and only splits on `"\n"`. Unlike
  `Connection.#ingest` (daemon side), which enforces `MAX_FRAME_BYTES` and drops
  the connection, the client has no guard. A daemon bug (or a corrupted stream)
  that emits a very long line with no newline grows client heap without bound.
- **Fix:** Mirror the daemon's `MAX_FRAME_BYTES` check in `#ingest`; on breach,
  destroy the socket and let the reconnect path re-baseline.

---

### Silent frame drop on JSON parse failure → undetected seq divergence
- **File:** client/src/client.ts:234-238 (`#ingest`), backend/daemon/src/daemon/connection.ts:59-64
- **Severity:** low-medium
- **Issue:** Both ingest paths `continue` (drop the line) on `JSON.parse` failure.
  On the client, a dropped *push* frame is never recovered: the next frame's
  `seq` advances `#lastSeq` past the hole, so no future `sinceSeq` will ever ask
  for it and no `resync` is triggered — the client is permanently missing an
  event with no signal. A dropped *response* frame hangs that request until its
  timeout.
- **Fix:** On the client, track expected-next-seq contiguity in `#deliverPush`;
  if a frame arrives with `seq > lastSeq + 1` (gap), trigger `#resync`. Log
  unparseable frames on the client as the daemon already does.

---

### `replayHistory` (`sinceSeq: 0`) never yields the documented `resync` fallback
- **File:** client/src/client.ts:26-35 (option doc), backend/daemon/src/daemon/event-log.ts:82
- **Severity:** low
- **Issue:** `since()` computes `rolled = from > 0 && from < this.oldest - 1`. When
  a client attaches with `replayHistory: true` it sends `sinceSeq: 0`, so `from > 0`
  is false and `rolled` is *always* false even when the ring buffer has genuinely
  evicted the oldest frames. The daemon returns `replaying: true` with only the
  frames it still holds; the client (TUI) believes it has full history and gets no
  `resync`, contradicting the option's doc comment ("falls back to a `resync` if
  the buffer rolled").
- **Fix:** Either treat `from === 0` with a non-empty buffer whose `oldest > 1`
  as `rolled` (so the client learns history is partial), or reword the option doc
  to state that `replayHistory` replays only what is still buffered, silently.

---

### Reconnect backoff has no jitter; multi-client daemon-respawn storm
- **File:** client/src/client.ts:332-356 (`#reconnectLoop`), 194-202 (`#spawnDaemon`)
- **Severity:** low
- **Issue:** `#reconnectLoop` backs off `100 → *2 → 4000` ms with no random
  jitter. If a daemon dies while several clients (TUI + `loom tail` + CLI) are
  attached, they retry in lockstep and — on the iterations where nothing is
  listening — each calls `#spawnDaemon()` unconditionally, forking N `loomd`
  processes. `SocketServer.listen()`'s `isSocketLive` probe + `EADDRINUSE` guard
  means only one wins and the losers exit, but it is wasteful and noisy, and
  there is a TOCTOU window in `listen()` (between `isSocketLive` returning false,
  `unlinkSync`, and `server.listen`) where two daemons can both proceed and the
  second unlinks/rebinds over the first.
- **Fix:** Add full jitter to the backoff. Before `#spawnDaemon` in the loop,
  re-probe once more (or add a short randomized delay) so only one client is
  likely to spawn. Harden `listen()` to bind first and treat `EADDRINUSE` as
  "someone beat me, connect instead" rather than unlink-then-bind.

---

### Client does not validate `result.protocolVersion`
- **File:** client/src/client.ts:291-318 (`#handshake`); daemon side does check at backend/daemon/src/daemon/daemon.ts:1894
- **Severity:** low
- **Issue:** The daemon rejects a client whose `protocolVersion` mismatches (and
  skips the check entirely if the client omits it). The client never inspects
  `result.protocolVersion` from `HelloResult`, so a newer daemon that still
  accepts `PROTOCOL_VERSION` 1 requests but speaks a changed frame shape would be
  used blindly. Version negotiation is one-directional.
- **Fix:** In `#handshake`, compare `result.protocolVersion` to `PROTOCOL_VERSION`
  and fail fast (or downgrade behavior) on mismatch.

---

### Minor / robustness
- **client/src/client.ts:243-254** — a daemon `req` frame with a non-numeric `id`,
  or a `res` with an `id` that matches no pending entry, is silently ignored;
  the corresponding client `request()` (if any) hangs to its timeout. Low.
- **core/src/channel.ts:41-52** — `[Symbol.asyncIterator]` can be obtained twice;
  two generators both `push` waiters and the stream is split between them with no
  guard, despite the "single-consumer" contract. Early `break` from `for await`
  leaves `#queue` items un-drained and the channel open (leak until GC). Low.
- **backend/daemon/src/daemon/rpc.ts** — clean. `handle` always resolves (RpcError
  and generic throws both mapped to `errFrame`), duplicate-registration guarded,
  `result ?? null` avoids `undefined` on the wire.
- **client/src/client.ts:164-168** `close()` is `async` but awaits nothing — a
  caller `await`ing it is not actually waiting for the socket `close` event /
  `#fire("close")`. Cosmetic. Low.

---

## Clean sub-areas (checked, no issue found)

- **`EventLog.since()` seq math** (event-log.ts:76-85) — the `rolled` boundary
  `from < oldest - 1` is correct: buffered seqs are always contiguous
  `[oldest..head]` (every `append` does `++seq` then `push`, eviction only
  `shift`s the front), so `(from, head]` is fully recoverable iff
  `from >= oldest - 1`. The `from > #seq` early return correctly catches a
  daemon-restart client holding a stale high-water mark; `from === #seq` correctly
  returns "nothing to replay, not rolled".
- **hello snapshot vs. live subscription race** (daemon.ts:1892-1942) —
  `#server.subscribe(ctx.conn)` runs synchronously *before* `head` is read and
  before replay frames are pushed; `#hHello` never `await`s, so no frame can be
  appended mid-handshake. Replay frames are written before the `hello` response
  (the response is a `.then` microtask in `server.ts#onFrame`), and the client
  buffers all pushes in `#preHelloQueue` until `#helloDone`. Ordering is preserved
  end to end.
- **daemon-restart handling** (client.ts:299-318) — `epoch` change detection plus
  the `if (restarted && f.seq <= result.seq) continue;` skip when draining
  `#preHelloQueue` correctly discards replay frames the restarted daemon
  mis-attributed against the client's stale `sinceSeq`, then fires an explicit
  `"resync"`. `#eventLog` is cleared on restart.
- **`EventLog.append` fan-out** (event-log.ts:57-69) — a throwing listener is
  isolated per-listener and does not stall the loop.
- **`Connection.#ingest`** (connection.ts:46-71) — `MAX_FRAME_BYTES` bounds the
  read buffer, unparseable frames are logged and skipped, handler throws are
  caught per-frame.
- **`AsyncChannel` close semantics** (channel.ts:35-52) — `close()` wakes all
  parked waiters with `{done:true}`; the iterator drains `#queue` before checking
  `#closed`, so buffered items are not lost on close. Synchronous push→waiter
  handoff preserves order when multiple values are pushed before the consumer
  resumes.

---

tl;dr: One high — the daemon has no write-side backpressure, so a single stuck
client can OOM it. Several medium client-side reconnect bugs: `#resync` can
regress `#lastSeq` and re-deliver events, in-flight requests are dropped (not
retried) on a blip even though the op may have completed, a failed handshake
leaves `#preHelloQueue` uncleared, and `AsyncChannel` has no queue bound. The
`EventLog` seq/rolled math and the hello snapshot-vs-subscribe race are correct.
