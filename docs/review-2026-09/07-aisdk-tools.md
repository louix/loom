# Review — aisdk first-party tools (bash, edit, grep, web_search)

Scope: `aisdk/src/tools/{bash,edit,grep,search,builtins}.ts`. READ-ONLY review.

Findings ranked most severe first.

---

### Unbounded output buffer — OOM / `RangeError` crash while waiting for the sentinel

- **File:** aisdk/src/tools/bash.ts:42-47 (`onData`), 128-161 (`run` loop)
- **Severity:** high
- **Issue:** `onData` does `this.#buf += d` with **no cap**. `clamp()` (120 KB) is only
  applied at the moment `run()` returns. A command that streams output faster than it
  finishes — `yes`, `cat /dev/zero | base64`, `find /`, a chatty build — grows `#buf`
  without bound for the whole timeout window (default 120 s). Two concrete failure modes:
  1. `#buf` crosses V8's max string length (~536 MB) → `"Invalid string length"` RangeError
     thrown **inside a `'data'` event handler** → uncaught exception → the daemon process
     dies (takes every other session with it).
  2. Below that limit, a few hundred MB of retained string on a constrained host is a
     straight OOM.
     The `MAX_OUTPUT_BYTES` / `clamp` design shows the intent was to bound output; the
     accumulation path defeats it.
- **Fix:** Bound `#buf` as it grows. Keep a head slice up to ~`HEAD_BYTES` plus a rolling
  tail window (a few KB — must exceed `marker + " " + digits + "\n"` so marker detection
  still works), drop the middle, set a `truncated` flag, and stop unbounded concatenation.
  Continue scanning only the tail for the sentinel. Surface `[output truncated - stream
exceeded N bytes]` on return.

---

### Timeout / reset kills only the bash process, not its process group — orphaned servers and background jobs

- **File:** aisdk/src/tools/bash.ts:35-39 (`spawn`, no `detached`), 181-185 (`#kill`), 151-159 (timeout path)
- **Severity:** high
- **Issue:** `spawn("bash", …)` is started without `detached: true`, so no dedicated
  process group is created. `#kill()` / the timeout path do `this.#child?.kill("SIGKILL")`,
  which signals **only the bash process**. Any descendants the command started —
  `npm run dev`, `python -m http.server`, `./server &`, `sleep 999 &`, a hung `git` over
  SSH — are reparented to init and keep running. For a coding agent this is a common path
  ("start the dev server, then curl it"): after a timeout the "reset" shell can no longer
  bind the port the orphan still holds, and the leak accumulates across the daemon's
  lifetime. Explicit `&` background jobs are lost silently the same way on every shell
  reset (shell death path at 140-150 too).
- **Fix:** `spawn(..., { detached: true })` and on kill send the signal to the group:
  `try { process.kill(-child.pid, "SIGKILL") } catch {}` (guard `child.pid`), falling back
  to `child.kill`. Optionally SIGTERM-then-SIGKILL with a short grace period.

---

### Trailing backslash / trailing pipe / `&&` wedges the persistent shell for the full timeout

- **File:** aisdk/src/tools/bash.ts:125 (command wrapper), 71-104 (`#unclosedConstruct`)
- **Severity:** medium
- **Issue:** The command is wrapped as `{\n${command}\n} </dev/null\nprintf …`. If
  `command` ends with a backslash, the `\`+newline is a line continuation that swallows the
  closing `}` line (`foo\` + `\n}` → logical line `foo} </dev/null`, and `}` is no longer a
  group terminator). Non-interactive bash reads the whole compound command before
  executing, never finds the matching `}`, hits EOF only when the shell is killed — so the
  sentinel `printf` never runs and `run()` spins until the deadline, then `#kill()`s and
  resets. Same wedge for a command ending in `|`, `&&`, `||`. `#unclosedConstruct` only
  looks at odd quote counts and `<<`, so it does not catch this, and `bash -n -c 'foo\'`
  exits 0 (the wrapped form is what breaks), so even adding it to the `-n` check wouldn't
  help. Net: a stray trailing `\` (easy in a pasted multi-line command) costs a silent
  120 s stall and loses the command.
- **Fix:** Detect a dangling continuation/operator before running: reject or trim when
  `command` (after collapsing `\\`) matches `/\\$/`, or ends with an unquoted
  `|`, `&&`, `||`. Alternatively terminate the group defensively, e.g.
  `{ ${command}\n:\n} </dev/null` — no, still breaks on trailing `\`; simplest is the
  explicit reject.

---

### `set -x` makes the sentinel `printf` trace line satisfy the marker regex

- **File:** aisdk/src/tools/bash.ts:118-133
- **Severity:** medium
- **Issue:** `set -x` persists in the long-lived shell. With xtrace on, bash prints the
  expanded sentinel line to stderr (merged into stdout by `exec 2>&1`):
  `+ printf '\n%s %d\n' __LOOM_<hex>__ 0`. The read regex is
  `/\n?__LOOM_<hex>__ (-?\d+)\n/`; `\n?` is optional, so it matches the substring
  `__LOOM_<hex>__ 0\n` inside that trace line — **before** the real sentinel. `run()`
  returns early: `output` ends with a garbled `+ printf '\n%s %d\n' ` fragment, and the
  exit code is parsed from xtrace's expansion of `$?` rather than the real sentinel. The
  real sentinel line then lands in `#buf` and is cleared by the next call's
  `this.#buf = ""` — a latent desync if timing shifts. Impact is mostly a corrupted output
  tail plus a correctness dependency on xtrace `$?` expansion, on every command until the
  model runs `set +x` or the shell resets.
- **Fix:** Suppress xtrace around the sentinel emission:
  `{ __ec=$?; set +x; } 2>/dev/null; printf '\n%s %d\n' '<marker>' "$__ec"`. Also tighten
  the regex to require the marker at true line start (anchor with `^` in multiline mode or
  require a preceding `\n`), and/or emit the marker with a leading control byte the command
  stream can't contain.

---

### No timeout on the ripgrep child

- **File:** aisdk/src/tools/grep.ts:24-72
- **Severity:** medium
- **Issue:** `bash` and `web_search` both bound their work (120 s / 15 s). `runRipgrep`
  spawns `rg` with no timer at all. `OUT_CAP` (4 MB) bounds memory, but a slow scan —
  `path: "/"`, a large monorepo, an NFS/`sshfs` mount, `--glob` that matches huge binaries
  under `--max-columns` handling — can run for minutes and stall the whole model turn with
  no recovery.
- **Fix:** Add a wall-clock timeout (e.g. 30-60 s), `child.kill("SIGKILL")` on expiry
  (with process-group semantics as for bash), and resolve with a "search timed out, narrow
  the pattern/path" message.

---

### `edit` writes are non-atomic — crash or ENOSPC mid-write corrupts the source file

- **File:** aisdk/src/tools/edit.ts:63, 85 (`writeFileSync(path, updated)`)
- **Severity:** medium
- **Issue:** `writeFileSync` opens with `O_TRUNC` and streams the new content in place.
  A process crash, `kill`, or a disk-full error partway through leaves the file truncated
  or half-written, with **no backup** — the tool has already discarded the original from
  memory. For an agent editing its own worktree source this is unrecoverable data loss.
- **Fix:** Write to a sibling temp file, `fsync`, then `renameSync` over the target
  (atomic on POSIX). Preserve the original mode (`fstatSync` before, `chmodSync`/`fchmodSync`
  after) since `writeFileSync` on a new path defaults to 0644.

---

### Failed `bash` spawn can crash the daemon via an unhandled stdin stream error

- **File:** aisdk/src/tools/bash.ts:50-58
- **Issue:** When `spawn("bash", …)` fails (bash missing, ENOMEM, seccomp sandbox), the
  code has a `child.on("error")` handler on the ChildProcess — good — but line 58 then
  does `child.stdin?.write("exec 2>&1\n")` synchronously. On a process that never started,
  Node destroys the stdio streams; a buffered/late write to that Writable emits an
  `'error'` (`EPIPE` / `ERR_STREAM_DESTROYED`) on **`child.stdin`**, which has no listener.
  An unhandled stream `'error'` is rethrown → uncaught exception → the daemon exits. This
  is exactly the "bash missing / sandbox" scenario `#spawnError` was built to handle
  gracefully, and it can still take the process down.
- **Severity:** medium
- **Fix:** `child.stdin?.on("error", () => {})` (and same for stdout/stderr) right after
  spawn; only write the `exec 2>&1` primer once `child.pid` is set / on `'spawn'`.

---

### Concurrent `bash` tool calls throw an opaque "busy" error instead of serializing

- **File:** aisdk/src/tools/bash.ts:110
- **Severity:** low-medium
- **Issue:** The AI SDK executes tool calls from one assistant step concurrently
  (`Promise.all` over `execute`). If the model emits two `bash` calls, the first sets
  `#busy` synchronously and the second immediately `throw new Error("the bash shell is
busy with another command")`. No corruption, but the model gets a confusing hard failure
  for behaviour it can't predict.
- **Fix:** Queue commands on the shell (chain on a `#tail: Promise`) so concurrent calls
  run sequentially, or return a structured "retry" result rather than throwing.

---

### `edit` follows symlinks and accepts unrestricted absolute / `../` paths

- **File:** aisdk/src/tools/edit.ts:41, 63, 85, 174-176
- **Severity:** low-medium
- **Issue:** `abs` is `path` verbatim if it starts with `/`, else `cwd + "/" + path` with
  no normalization — `edit("../../etc/thing", …)` or an absolute path escapes the worktree.
  `readFileSync`/`writeFileSync` also follow symlinks, so editing a symlinked path rewrites
  the link target (and, with in-place write, through the link rather than replacing it).
  `grep` has the same lack of `path` confinement (grep.ts:28).
- **Fix:** Resolve and verify the realpath is inside the worktree root before read/write
  (allow an opt-out if cross-tree edits are intentional); `lstat` and refuse or warn on
  symlinks.

---

### `edit` on a non-UTF8 / binary file silently corrupts it

- **File:** aisdk/src/tools/edit.ts:41
- **Severity:** low
- **Issue:** `readFileSync(path, "utf8")` replaces invalid byte sequences with U+FFFD
  instead of throwing. If an exact match then succeeds on an ASCII region, `writeFileSync`
  persists the U+FFFD-mangled _entire_ file — binary content destroyed.
- **Fix:** Read as a Buffer, reject (or require an explicit flag) when the content isn't
  valid UTF-8 (`Buffer.compare(Buffer.from(text,"utf8"), raw) !== 0` or a decoder with
  `fatal: true`).

---

### `edit` fuzzy tiers rewrite CRLF line endings in the matched span

- **File:** aisdk/src/tools/edit.ts:78-79, 122-123, 139
- **Severity:** low
- **Issue:** Tiers 2/3 split file and needle on `"\n"` only, so file lines keep a trailing
  `\r`. `normalize = l => l.replace(/\s+$/, "")` strips the `\r` for comparison, so a
  `\n`-only `old_string` matches a CRLF file. The replacement span
  (`window.join("\n").length`) consumes the `\r` bytes and inserts `new_string` (LF-only),
  converting that region to LF and leaving the file with mixed endings.
- **Fix:** Detect the file's dominant EOL, normalize the needle to it before matching, and
  re-apply it to `new_string` on write; or exclude `\r` from the trailing-whitespace
  normalization and handle it explicitly.

---

### Minor: error/success messages embed the resolved absolute path

- **File:** aisdk/src/tools/edit.ts:45, 56, 64, 86, 99, 177
- **Severity:** low
- **Issue:** `cannot read /abs/path: …`, `edited /abs/path`, etc. are thrown/returned. Fed
  back to the model this is fine, but if tool errors are logged or shown to end users it
  discloses the worktree layout. (grep passes `rg` stderr through at grep.ts:68, which can
  likewise contain absolute paths.)
- **Fix:** Report worktree-relative paths where possible.

---

### Minor: `web_search` — `NaN` result count when `cfg.maxResults` is unset

- **File:** aisdk/src/tools/search.ts:27
- **Severity:** low
- **Issue:** `Math.min(20, Math.max(1, maxResults ?? cfg.maxResults))` — if
  `cfg.maxResults` is `undefined`/`NaN` and the caller omits `max_results`, `n` is `NaN`
  and flows into `&count=NaN` (brave) / `max_results: NaN` (tavily), which the backend
  rejects or ignores.
- **Fix:** `const want = maxResults ?? cfg.maxResults ?? 5; const n = Number.isFinite(want)
? Math.min(20, Math.max(1, want)) : 5;`

---

### Minor: `web_search` — empty API key isn't distinguished from an auth failure

- **File:** aisdk/src/tools/search.ts:22-48; builtins.ts:25
- **Severity:** low
- **Issue:** The tool is only registered when a `search` config object exists, but nothing
  checks `cfg.apiKey` is non-empty. A misconfigured key sends the request anyway and the
  model sees a raw `brave search 401 Unauthorized` rather than "web search isn't
  configured".
- **Fix:** Early-return a clear "search backend has no API key configured" when
  `!cfg.apiKey`.

---

## Clean / low-concern sub-areas

- **grep argument injection:** `args.push("--", pattern, path)` correctly terminates option
  parsing, so a pattern/path starting with `-` can't inject flags. ripgrep's Rust regex
  engine is linear-time, so no ReDoS. `--` guard is solid.
- **grep exit codes:** exit 1 (no matches) is correctly treated as success `"(no matches)"`;
  only exit ≥2 is an error. ENOENT for a missing `rg` returns a helpful fallback message
  instead of throwing. Output is capped (`OUT_CAP` + `maxResults` slice with a "N more"
  tail).
- **edit match precedence:** exact tier requires `replace_all` for >1 hit; fuzzy tiers 2/3
  require a **unique** span or they error with a "add surrounding context" message — they
  never silently pick one of several matches. Empty `old_string` and `old===new` are
  rejected up front. `replace_all` with `new_string` containing `old_string` is safe
  (`split`/`join`, no rescan).
- **web_search:** 15 s `AbortSignal.timeout` on both backends; API key travels only in a
  header (brave) or JSON body (tavily), never in a URL or an error string; response parsing
  is drift-tolerant (`str()` coercion + optional chaining + `?? []`); `oneLine` bounds
  snippet length; all network/JSON errors are funneled through one try/catch. No secret
  leakage observed.
- **bash `#unclosedConstruct`:** sensible guard against heredoc/odd-quote wedges, only
  forks `bash -n` for the rare suspicious command, `-n` never executes command
  substitutions, and the 5 s watchdog is `unref`'d.
- **bash spawn-failure handling:** `child.on("error")` prevents a missing-bash `'error'`
  event from crashing the daemon and surfaces via `#spawnError` (but see the stdin-stream
  finding above for the remaining gap).
