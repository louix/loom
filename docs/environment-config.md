# Environment configuration

A versioned configuration for isolated environments, separate from Loom's own
`config.jsonc`. [loom-isolate](loom-isolate.md) is its only reader. Loom's
daemon and TUI keep reading `config.jsonc` and nothing else; nothing here
changes how Loom sessions run.

| File                                                   | Trust          | Format              | Says                                       |
| ------------------------------------------------------ | -------------- | ------------------- | ------------------------------------------ |
| `loom.json` at the checkout root                       | repository     | strict JSON         | what the project **requests**              |
| `${XDG_CONFIG_HOME:-~/.config}/loom/environment.jsonc` | you (the host) | JSONC, `version: 1` | runtime, defaults, profiles and **grants** |

Both files need `"version": 1` and reject unknown fields. The user file sits
beside Loom's `config.jsonc` under a different name on purpose: main-new used
`config.jsonc` for this schema, which rejects every Loom setting. Neither file
is ever read in place of the other; pointing `--user-config` at Loom's file
fails with a pointer to [`loom config convert`](#converting-loom-config).
`loom.json` keeps main-new's name and schema, so its project files still parse.

Editor schemas: [project](../environment-config/project.schema.json) and
[user](../environment-config/user.schema.json); regenerate both with
`deno task config:schema`.

## Project file

```json
{
  "version": 1,
  "environment": {
    "nix": { "auto": true },
    "resources": { "cpus": 2, "memoryMiB": 4096 },
    "prepare": [{ "run": "npm ci", "timeoutSeconds": 600 }],
    "start": [{ "name": "services", "run": "just services" }]
  },
  "access": { "network": { "presets": ["javascript"], "allowedHosts": ["api.example.com"] } }
}
```

`environment` fields: `nix.auto` (activate devenv, flake, shell.nix or
default.nix), `commandPrefix` (literal argv wrapping activation; not with
`nix.auto`), `timeoutSeconds` (activation, default 900), `resources` (default 1
CPU, 2048 MiB), and `prepare`/`start` hooks (`run`, optional `name`,
`timeoutSeconds` 1–3600, default 900). `access.network` lists exact HTTPS names
as `hosts` and/or `presets` (`nix`, `javascript`, `python`, `rust`).

`access.mcp` and `skills` parse for main-new compatibility, but nothing attaches
them yet: they are reported as unsupported and ignored, which grants nothing.

A project file can only request. It cannot name a runtime, profiles, limits,
lifecycle defaults, repositories or grants.

## User file

```jsonc
{
  "version": 1,
  "backend": { "artifact": "/nix/store/…-session-runtime", "executable": "smolvm" },
  "environment": { "timeoutSeconds": 1200 },
  "access": { "network": { "presets": ["nix"] } },
  "profiles": {
    "tests": { "entrypoint": ["just", "test"], "environment": { "resources": { "cpus": 4 } } },
  },
  "limits": { "cpus": 8, "memoryMiB": 16384 },
  "lifecycle": { "workspace": "worktree", "execution": "local" },
  "repos": [
    {
      "path": "/home/me/src/project",
      "environment": { "resources": { "memoryMiB": 8192 } },
      "access": { "network": { "allowedHosts": ["internal.example.com"] } },
      "grants": {
        "setup": true,
        "network": { "presets": ["javascript"], "allowedHosts": ["api.example.com"] },
      },
    },
  ],
}
```

- `backend`: the session runtime and smolvm. `executable` may be a name on PATH.
- `environment`: host defaults, same fields as the project's.
- `access.network`: hosts the host allows directly, with no project request.
- `profiles`: [launch profiles](#launch-profiles).
- `limits`: ceilings; a larger request fails rather than being clamped.
- `lifecycle`: default workspace placement (`in-place`, `worktree`, `clone`),
  execution (`vm`, `local`) and `idleTimeoutMinutes` for applications that
  create workspaces. Absent fields keep each application's own default; Loom's
  is local + worktree, main-new's was worktree + VM. loom-isolate always runs in
  place in a VM and only displays these.
- `repos[]`: per-repository host overrides (`environment`, `access`,
  `lifecycle`) and `grants`. A path names its repository: a linked worktree or
  subdirectory resolves to the repository's entry; an ordinary directory is its
  own repository. Duplicate entries are errors.

## Intent and grants

The project's requests are checked against the matching `repos[].grants`:

| Project requests                                                        | Needs                                                                   |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `nix.auto: true`, `commandPrefix`, non-empty `prepare` or `start` hooks | `grants.setup: true`                                                    |
| each network host (presets expand to hosts)                             | the host in `grants.network`, or already allowed by the host's `access` |
| `resources`                                                             | nothing beyond `limits`                                                 |

The check applies to what the project asked for, even when a host layer later
overrides that field. Without a matching `repos[]` entry nothing is granted.
Host layers (user defaults, profiles, `repos[]` overrides) need no grants: the
host is the authority. Explicit `--allow-host` flags add hosts the same way.

## Precedence

Environment fields resolve in four layers, later winning:

1. user `environment` (defaults)
2. the selected profile's `environment`
3. the project's `environment`
4. the matching `repos[].environment` (final host overrides)

Each field replaces the earlier value. `resources.cpus` and `resources.memoryMiB`
merge individually. **Hook arrays replace earlier arrays whole**, including an
empty array; they never append. Host `access.network.allowedHosts` and
`.presets` in `repos[]` each replace the user-level field; granted project
hosts are then added. `hosts`, the old name of `allowedHosts`, still parses
wherever `allowedHosts` does; `loom-isolate` reports it once per run, and
`allowedHosts` wins when both are set. `loom-isolate config inspect` shows the layer behind each value.

This differs from Loom's `config.jsonc`, where a matching `repos[]` entry's
`hooks` **append** to the global `hooks` and other arrays replace. That rule is
unchanged for Loom.

## Hooks

`prepare` and `start` are environment hooks: shell commands in the guest
workspace, run in order. A failure or timeout fails the operation. They are
distinct from Loom's session hooks (`file_write`, `turn_end`, notifications),
which stay in `config.jsonc` and have no equivalent here.

In loom-isolate, `start` hooks run on every boot before the command;
`loom-isolate prepare` runs `prepare` hooks and then `start` hooks. There are no
prepared bases: preparation changes the mounted workspace itself. Hooks receive
`LOOM_HOOK` and `LOOM_HOOK_EVENT` (`workspace_prepare` or `workspace_start`).

## Launch profiles

A profile is a literal entrypoint argv with an optional runtime `artifact` and
`environment` defaults. `loom-isolate run tests -- --filter x` runs
`just test --filter x`. The entrypoint must exist in the runtime or the
activated project environment. Profiles have no integrations (native Claude or
Codex logins, MCP, skills); those remain main-new features not ported.

## Converting Loom config

```sh
loom config convert                  # print, from ~/.config/loom/config.jsonc
loom config convert FILE --json      # machine-readable report
loom config convert --out ~/.config/loom/environment.jsonc
```

The command reads the old file and validates it as Loom would; it never writes
to it, and Loom keeps using it. `--out` writes the new file and refuses any path
that exists. The report lists every setting under one of:

- **converted**: `session.auto_nix` → `environment.nix.auto`;
  `session.isolation.environment` → `commandPrefix`, `timeoutSeconds`,
  `resources`; `session.isolation.network.allowed_hosts`/`presets` →
  `access.network.allowedHosts`/`presets`; `session.defaults.isolation` and
  `session.defaults.workspace` → `lifecycle.execution`/`workspace` (deprecated
  names such as `session.isolation.enabled` convert as their replacements, with
  a note);
  `idle_timeout_minutes` → `lifecycle.idleTimeoutMinutes`; `workspace_prepare`
  and `workspace_start` hooks → `environment.prepare`/`start`.
- **stays in Loom config**: providers, models and modes, TUI, daemon, tools and
  MCP servers, search, Git identity, worktree/branch/database settings,
  auto-resume and other session policy, clone publication
  policy, per-provider runtimes, and every non-workspace hook event.
- **not converted**: settings the new format cannot express, such as `async`
  start hooks, project-scoped (`project` glob) workspace hooks, `auto_nix` that
  Loom ignores under a `command_prefix`, clearing an inherited command prefix,
  removed settings (`session.titles`, `session.notify`, the VM launcher, `db`),
  and keys Loom itself ignores.

Old settings are trusted host configuration, so they convert into host layers
and need no grants. `lifecycle` is always written explicitly, preserving Loom's
local default. Repository overrides become `repos[]` entries holding only what
differs from the defaults; because old repository hooks appended while new
arrays replace, such an entry lists the inherited and repository hooks
together. Converted start hooks fail startup on error, whereas Loom reports a
failing `workspace_start` hook to the agent; the report notes this. Old
providers map to no launch profile: their semantics (Loom workers, credentials,
models) do not match a plain entrypoint.
