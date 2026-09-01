# TODO 0 — Settings

## Context

`docs/todo.md` item 0 asks for a user-editable **Settings** surface, persisted
outside the session, covering five defaults that are currently hard-coded, dead,
or only remembered implicitly:

1. **Default verbosity** — the event-log filter (`v` key). Today TUI-only, in
   memory, reseeded to `everything` every launch (`frontend/tui/src/model.ts:371`).
2. **Default mode** — `manual|plan|acceptEdits|auto`. Today derived from an
   implicit "last mode used" row in the `meta` table, rewritten on every session
   create and every `⇧⇥`. The config knob meant for this, `providers.claude.
permissionDefault`, is fully parsed but **read nowhere** — dead since inception.
3. **Git working behavior** — worktree+branch / branch-only / in-place. Today only
   two of the three exist (`worktree.enabled` boolean); "branch, no worktree" is
   not implementable without new `WorktreeManager` code.
4. **Delete-branch-on-session-delete default** — TUI pre-checks it **on**
   (`fleet-handle.ts:1146`), CLI `--delete-branch` defaults **off**
   (`cli/src/loom.ts:119`). Divergent.
5. **Enable/disable connector plugins** — no mechanism exists; connectors are
   per-provider config carrying secrets.

**Decisions taken with the user:**

- **Deliver in three phases**, all eventually required: **Phase 1** = the settings
  framework + verbosity + default mode + delete-branch. **Phase 2** = git working
  behavior. **Phase 3** = connectors. This plan details Phase 1 and sketches 2–3.
- **Semantics: "pin, stop remembering."** An explicit setting _is_ the default;
  deliberate mid-session switches no longer rewrite it. Applies to `defaultMode`
  in Phase 1 (model/provider/effort "remember" logic is TODO 5, left untouched).
- **Storage: a new daemon-owned `~/.config/loom/settings.toml`** — machine-managed
  (not the comment-rich `config.toml`), read _and_ written by the daemon. Phase-1
  settings are all user-global; Phase 2's git behavior stays per-repo in
  `.loom/config.toml`. Must survive: missing file, unparseable file (→ defaults,
  never crash — unlike `config.toml` which rethrows), file deleted under a running
  daemon (in-memory copy is authoritative), unknown keys, out-of-enum values.
- No dedicated keybind — reached via the `Space` command palette.
- No DB migration.

## Phase 1 — framework + verbosity + default mode + delete-branch

### Data model — `core/src/wire.ts`

`wire.ts` already hosts the runtime const `PROTOCOL_VERSION`, is imported by both
sides, and must reference the settings type from a new push-frame variant — so the
canonical shape lives here, not in the daemon.

- `export type Verbosity = "chat" | "chat_and_tools" | "everything"` +
  `export const VERBOSITY_VALUES`.
- `export interface SettingsValues { verbosity: Verbosity; defaultMode: SessionMode;
deleteBranchOnRemove: boolean }` (reuse `SessionMode` / `SESSION_MODES` from
  `core/src/types.ts`, and `isSessionMode`).
- `export const DEFAULT_SETTINGS: SettingsValues = { verbosity: "everything",
defaultMode: "default", deleteBranchOnRemove: false }`.
  `deleteBranchOnRemove` defaults **false**: matches `session.remove`'s own
  doc-comment and `session.gc`, matches the CLI, keeps
  `test/worktree-session.test.ts:83` green, and destructive-by-default is wrong.
  This is a visible change for TUI users — call it out; the per-delete `b` toggle
  (now seeded from the setting) still lets them opt in.
- `export const SETTINGS_KEYS` + `export const coerceSettings(raw: unknown):
SettingsValues` — flat `{ ...DEFAULT_SETTINGS, ...validated }`, each field
  enum/boolean-guarded, out-of-range → default. No `deepMerge` (three scalars).
- Add `SettingsUpdatedPush { kind: "push"; seq: number; type: "settings_updated";
settings: SettingsValues }` to the `PushFrame` union.

### Daemon file I/O — `backend/daemon/src/config/settings.ts` (new)

Only I/O; the type + coercion come from `wire.ts`.

- `loadSettings(path, log): SettingsValues` — `readFileSync` + `smol-toml` `parse`
  - `coerceSettings`. `ENOENT` → `DEFAULT_SETTINGS` silently; any other read/parse
    error → `DEFAULT_SETTINGS` + `log.warn` (explicitly unlike `readTomlIfPresent`
    in `config.ts:437`).
- `writeSettings(path, values)` — `mkdirSync(dirname, { recursive: true })`,
  `writeFileSync(path + ".tmp", …)`, `renameSync(tmp, path)` (same dir → atomic).
  Prepend `# managed by loomd — manual edits are overwritten`.
- `applySet(current, key, value): SettingsValues | { error: string }` — key ∈
  `SETTINGS_KEYS`, value ∈ that key's enum/type; else `{ error }`.

### Daemon wiring — `backend/daemon/src/daemon/daemon.ts`

- `DaemonStartOptions` += `settingsPath?: string`. Ctor:
  `this.#settingsPath = opts.settingsPath ?? (this.#standalone ? null : userSettingsPath())`,
  `this.#settings = this.#settingsPath ? loadSettings(this.#settingsPath, this.#log) : { ...DEFAULT_SETTINGS }`.
  (`userSettingsPath()` added next to `userConfigPath()` in `scaffold.ts`.)
- `#emitSettingsUpdated()` — mirror `#emitNotice` (`daemon.ts:426`) exactly:
  `this.#server.broadcast(this.#events.append({ kind: "push", type: "settings_updated", settings: this.#settings }))`.
  Do **not** route through `emitEvent` (that also writes `#sessionEvents`).
- `#defaultMode()` (`daemon.ts:601`) → `return this.#settings.defaultMode`.
- Delete `this.#providerDefaults.rememberMode(mode)` at `daemon.ts:1087`
  (session.create) and `daemon.ts:1427` (session.setMode); fix adjacent comments.
- `session.remove` (`daemon.ts:1499`) →
  `const alsoBranch = typeof p["deleteBranch"] === "boolean" ? p["deleteBranch"] : this.#settings.deleteBranchOnRemove`
  (explicit param still wins).
- Register near `daemon.ts:970`:
  - `settings.get` → `() => this.#settings`.
  - `settings.set` (`{ key, value }`) → `applySet`; `{ error }` →
    `throw new RpcError("bad_request", error)`; else update memory, then
    `try { if (this.#settingsPath) writeSettings(this.#settingsPath, next) } catch { log.warn + #emitNotice("couldn't save settings to disk", "warn") }`,
    `#emitSettingsUpdated()`, return `this.#settings`. A disk-write failure is
    **not** an RPC error — memory changed and heals on next write.
- **Config watcher:** leave the `name.toString() === "config.toml"` filter
  (`daemon.ts:818`) exact — the sibling `settings.toml` rename must not trigger a
  config reload. No settings watcher in Phase 1 (daemon is sole writer).

### Daemon — remove the dead knob and the dead store method

- `backend/daemon/src/config/config.ts` — remove `permissionDefault` from
  `LoomConfig` (`:103`), `DEFAULT_CONFIG` (`:163`), `normalizeConfig`
  (`:362-371`, `:400`). Zero readers; its enum doesn't even map to `SessionMode`.
- `backend/daemon/config.example.toml` — drop the `permission_default` line.
- `backend/daemon/src/store/sessions.ts` — delete `ProviderDefaultStore.mode()`
  and `rememberMode()` (`:491-499`). Leave the orphan `last_mode` row (a one-row
  cleanup isn't worth an append-only migration). `provider()` / `remember*` for
  model/effort/provider stay (TODO 5).
- `backend/daemon/src/daemon/event-log.ts` — add the `settings_updated`
  `Omit<…,"seq">` variant to the `UnsequencedPush` union or `#events.append`
  won't typecheck.

### Harness isolation — `harness/src/harness.ts`

`harness.ts:24` sets one process-wide `XDG_CONFIG_HOME` for the whole test run;
if `settingsPath()` derived from it, every standalone daemon would share one file
and leak state. Pass `settingsPath: join(repoRoot, ".loom", "settings.toml")`
(per-repo, survives `harness.restart()`) to **both** `Daemon.start` calls
(initial + `restart()`).

### TUI — `frontend/tui/src/model.ts`

- Import `DEFAULT_SETTINGS` / `SettingsValues` / `Verbosity`; make `LogFilter` an
  alias of `Verbosity` (keep `cycleLogFilter` / `logFilterLabel` here).
- `UiMode` (`:25`) += `"settings"`.
- `TuiState` += `settings: SettingsValues` and `settingsCursor: number`;
  `initialState()` seeds both (keep `logFilter: "everything"`).
- `Action` += `{ t: "settingsLoaded"; values }`, `{ t: "settingsOpen" }`,
  `{ t: "settingsClose" }`, `{ t: "settingsMove"; delta }`.
- `reduce` cases: `settingsLoaded` / `settings_updated` also seed `logFilter` from
  `values.verbosity`; `settingsOpen`/`Close` set `mode` + clear other overlays
  (mirror `case "openConfirm"` / `case "help"`); `settingsMove` clamps
  `settingsCursor` to the 3 rows.
- `applyPush` (`:645`) += `case "settings_updated"` (or `default: absurd(frame)`
  throws).
- `footerHints` (`:1519`) += `case "settings"` (or `absurd(s.mode)` throws).
- `defaultModeOf` (`:1169`) → `return s.settings.defaultMode` (was
  `s.providers[0]?.defaultMode`). `ProviderInfo.defaultMode` keeps being shipped
  by `#providerList` wired to the new `#defaultMode()` — drop it in a later
  cleanup, not now.
- `ActName` (`:1345`) += `"settings"`; `commandsFor` `extra` (`:1493`) += a
  `["settings", "settings", ""]` row.

### TUI — `frontend/tui/src/fleet-handle.ts`, `components.tsx`, `app.tsx`

- `fleet-handle.ts`:
  - `BodyKind` (`:151`) += `"settings"`; `deriveView` (`:224`) branch.
  - `handleKey`: a `state.mode === "settings"` block before browse — `↑/↓` →
    `settingsMove`; `←/→` / `Enter` → next enum value for the focused row,
    dispatch `settingsLoaded` optimistically **and**
    `client.request("settings.set", { key, value })`, revert (re-dispatch prior
    values) on reject; `Esc` / `q` → `settingsClose`.
  - `runAct` (`:1196`) += `case "settings"` → `dispatch({ t: "settingsOpen" })`.
  - `refetch()` (`:1622`) `Promise.all` += `client.request<SettingsValues>
("settings.get").then(v => dispatch({ t: "settingsLoaded", values: v }))` —
    this is the whole delivery path; it already re-runs on boot + every
    reconnect/resync. **Do not** add `HelloResult.settings` or touch `LoomClient`.
  - `confirmForDelete` (`:1146`) seeds `deleteBranch: state.settings.
deleteBranchOnRemove`; its body text branches both ways (currently hard-codes
    "…and branch go too. Press b to keep").
- `components.tsx`: new `Settings` component — three rows
  (`Verbosity` / `Default mode` (render via `modeLabel`) / `Delete branch on
session delete`), highlight `settingsCursor`, show current value + how to
  cycle. Model on `Help` (`:1170`) + `Picker` (`:1096`).
- `app.tsx`: `case "settings":` in the `view.body` switch (`:72`) → `<Settings>`
  (or `absurd(view.body)` throws).

### CLI — `cli/src/loom.ts` (no functional change needed)

`rm` already spreads `deleteBranch` only when the flag is set, so an absent flag
falls through to the daemon's setting. Optional: add `--keep-branch` to force
`false` against a `true` setting; update the `rm` help line.

### Tests

- `test/store.test.ts:213` — split into provider-only; drop the `mode()` lines.
- `test/daemon.test.ts:459` — keep provider-remember assertions; invert the mode
  ones (`defaultMode` stays `"default"` after a create/`setMode`); add
  `settings.set { key: "defaultMode" }` → `providers.list[0].defaultMode` and next
  `session.create` reflect it; assert a `settings_updated` push.
- `test/tui-model.test.ts:1579` — rewrite the `defaultModeOf` test to set
  `state.settings`; add a `confirmForDelete` case asserting the `deleteBranch`
  seed from `state.settings`.
- `test/worktree-session.test.ts:83` — passes unchanged **iff** the default is
  `false` (it is).
- `test/config.test.ts` — update any full-normalized-config `deepEqual`.
- `test/settings.test.ts` (new) — `loadSettings` (missing→defaults,
  garbage→defaults+warn, unknown keys ignored, out-of-enum→coerced),
  `writeSettings` (atomic + mkdir), `applySet` (bad key / bad value → error).
- `test/tui-render.test.ts` — open/close/edit render test for the overlay; check
  no full-frame snapshot asserts on the palette/footer.

## Phase 2 — git working behavior (per-repo, follow-up)

- `core`: `WorktreeMode = "worktree" | "branch-only" | "in-place"`.
- `config.ts`: `worktree.enabled: boolean` → `worktree.mode: WorktreeMode`;
  `normalizeConfig` back-compat (`true`→`"worktree"`, `false`→`"in-place"`).
  Stays in `.loom/config.toml`. Surface in the Settings screen as a repo-scoped,
  read-only section, or a narrow `config.setWorktreeMode` RPC (a general
  `config.set` is a much larger surface — that file has user comments to preserve).
- `worktrees.ts`: new `createBranchOnly(prompt, id)` — `git branch <name> <base>`
  with no `git worktree add`; session runs in repo root on that branch. Guard hard
  against concurrent branch-only sessions in one working dir.
- `daemon.ts` `session.create` (`:1051`): `p["worktree"]` widens boolean → enum
  (keep boolean aliases); 3-way branch. Revisit `session.fork`'s in-place refusal
  for branch-only.
- DB: migration 13 — `worktree_mode TEXT` (or derive from
  `worktree IS NULL AND branch IS NOT NULL`).
- TUI `new` prompt: per-session worktree-mode picker row alongside
  provider/model/effort/mode.
- CLI: `--worktree` boolean → `--worktree=worktree|branch-only|in-place` (+
  `--worktree` / `--no-worktree` aliases).

## Phase 3 — connectors (deferred; needs its own design)

Connector config is per-provider-package and consists of **secrets** (API keys,
base URLs) that already live in `config.toml` with env-var indirection and a
first-run scaffold. An enable/disable-in-settings surface would need: secrets in a
second file with different trust properties; a schema that's dynamic per connector
package (so not a fixed `SettingsValues` — needs an RPC to describe itself);
precedence resolution against the config layer's live-reload / restart-nudge
machinery; and a secret-storage design (OS keychain?). Out of scope until that's
designed.

## Verification

- `pnpm typecheck` — the `absurd(...)` guards in `applyPush`, `footerHints`, and
  `app.tsx`'s body switch make every missed extension point a compile error.
- `pnpm test` — the suites above; new `test/settings.test.ts` +
  `test/tui-render.test.ts` overlay case.
- Manual (`pnpm loom` against a scratch repo):
  1. `Space` → "settings" opens the overlay; `↑/↓` + `←/→` cycle each row; the
     footer shows the overlay's keys; `Esc` closes.
  2. Set verbosity to `chat`, quit, relaunch → log opens filtered to `chat`
     (was always `everything` before). Confirm `~/.config/loom/settings.toml`
     exists with the three keys and the managed-file header.
  3. Set default mode to `plan`; `n` → the new-session prompt shows `plan`;
     `⇧⇥` mid-session to `auto`, start another `n` → still `plan` (pin, not
     remembered).
  4. Default delete-branch off → `X` on a branch-backed session shows "press b to
     also drop the branch" and leaves the branch; flip the setting on → `X`
     pre-checks branch deletion.
  5. Open a second `loom` client, change a setting in one → the other updates
     live (`settings_updated` push).
  6. `printf 'garbage{' > ~/.config/loom/settings.toml`, restart the daemon (`R`)
     → no crash, a warning is logged, settings read as defaults; changing a
     setting rewrites the file valid.
  7. `rm ~/.config/loom/settings.toml` while the daemon runs → next `settings.set`
     recreates it; in-memory values were unaffected.
