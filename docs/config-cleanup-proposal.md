# Config cleanup: proposed further renames

Status: **two rounds done; the high-risk rows remain proposals.** Each
remaining row needs approval before it changes. Every rename follows one
compatibility pattern: the old key still parses, is read under its new
name, and Loom warns once per daemon (and lists it in `config.check` and
`loom doctor`). `backend/daemon/src/config/legacy-keys.ts` holds the table, so a
rename is one entry plus its schema, docs and tests.

Risk levels: **low**: a rename with a mechanical mapping; **medium**: changes
a default, a value shape or which layer a key belongs to; **high**: changes
behaviour, crosses a file or wire format, or removes something people use.

## Done (first round)

| Was                                                         | Now                                                                     |
| ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| `session.notify.webhook`                                    | removed; use a `hooks` entry with `on: "waiting"`                       |
| `session.titles.enabled`                                    | removed; titles are always generated                                    |
| `session.isolation.enabled`                                 | `session.defaults.isolation`: `"none"` \| `"vm"`                        |
| `session.worktree.enabled`, `isolation.checkout.mode`       | `session.defaults.workspace`: `"in-place"` \| `"worktree"` \| `"clone"` |
| `session.isolation.extra_allowed_hosts`                     | `session.isolation.network.allowed_hosts`                               |
| `session.isolation.network_presets`                         | `session.isolation.network.presets`                                     |
| `mcp_servers.*.grants.network` (host list)                  | `mcp_servers.*.grants.network.{allowed_hosts, presets}`                 |
| environment-config `access.network.hosts` (and in `grants`) | `access.network.allowedHosts`                                           |

`session.worktree.enabled` was not in the request but is the other half of
`session.defaults.workspace`: `"in-place"` is only reachable from it.

## Done (second round)

| Was                                                                                                                                                                        | Now                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.auto_rebase.{enabled, mode}`                                                                                                                                      | `session.auto_rebase`: `"off"` \| `"rebase"` \| `"merge"`                                                                                                                                               |
| `session.auto_resume.enabled`, `session.commit_reminder.enabled`                                                                                                           | `session.auto_resume`, `session.commit_reminder`: booleans                                                                                                                                              |
| `hooks[].timeout`                                                                                                                                                          | `hooks[].timeout_seconds`                                                                                                                                                                               |
| `daemon.idle_shutdown_minutes`, `session.isolation.idle_timeout_minutes`                                                                                                   | `daemon.idle_stop_minutes`, `session.isolation.idle_stop_minutes`                                                                                                                                       |
| `session.isolation.checkout.{visible_refs, max_push_bytes}`                                                                                                                | `session.clone.{visible_refs, max_push_bytes}`                                                                                                                                                          |
| `session.isolation.{claude, aisdk, codex}`                                                                                                                                 | `session.isolation.runtimes.{claude, aisdk, codex}`                                                                                                                                                     |
| `providers.claude.permission_default`                                                                                                                                      | `providers.claude.default_mode` (session modes, `"manual"` alias); it was never read and now seeds a new Claude session's mode until one is remembered; `"bypassPermissions"` is dropped with a warning |
| `prompt_cache_ttl` (`""` sentinel; Claude without `"off"`)                                                                                                                 | one enum for Claude and AI SDK: `"default"` \| `"5m"` \| `"1h"` \| `"off"`                                                                                                                              |
| `""` as unset (`worktree_dir`, `cli_path`, `api_key(_env)`, `base_url`, `model` (AI SDK), `title_model`, `config_dir`, `color`, `default_provider`, hook `name`/`project`) | optional keys; `""` still reads as absent                                                                                                                                                               |
| `session.provider_access.{only, disabled}`                                                                                                                                 | `session.provider_access.{allow, deny}`                                                                                                                                                                 |
| `agents.profiles.*.mcp`                                                                                                                                                    | `agents.profiles.*.mcp_servers`                                                                                                                                                                         |
| `mcp_servers.*.execution`                                                                                                                                                  | no longer read (a local `source.kind` always runs in a VM)                                                                                                                                              |
| `providers.echo.enabled`                                                                                                                                                   | `providers.echo: {}` (presence shows it)                                                                                                                                                                |
| `session.auto_nix`, `session.isolation.environment.*`                                                                                                                      | `session.environment.{auto_nix, command_prefix, timeout_seconds, cpus, memory_mib}`                                                                                                                     |
| `base_branch`, `worktree_dir` (top level)                                                                                                                                  | `session.defaults.base_branch`, `session.worktree_dir`                                                                                                                                                  |
| environment-config `lifecycle.execution: "local"`; wire `"local"`                                                                                                          | `"none"` (`"local"` still read); wire protocol v7                                                                                                                                                       |
| `providers.claude.worker_allowed_hosts` (replaces Claude's hosts)                                                                                                          | `providers.claude.network.allowed_hosts` (adds to them); the old key keeps its replacing meaning, with a warning                                                                                        |
| Lenient `.catch(default)` coercions                                                                                                                                        | a wrong type or range is an error naming the key; an unknown key in a section that used to drop it is ignored and reported                                                                              |

## Proposed

| Current key                                                                                       | Proposed                                                                                                        | Reason                                                                                                                                                                                                                                     | Risk                                                           |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `local_tools`, `vm_tools`, `remote_tools` (+ `session.local_tools` / `vm_tools` / `remote_tools`) | fold into `mcp_servers` with `source.kind: "command"` for host tools; one selection list, `session.mcp_servers` | Two catalogs for one concept: `mcp_servers` already covers VM (`nix`/`runtime`) and remote (`http`) tools, with auth and grants the old catalogs lack. `remote_tools.*.bearer_token_env` duplicates `mcp_servers.*.auth.bearer_token_env`. | high: four keys, selections merge, `tool-selection.ts` rewrite |
| `search.{backend, api_key, api_key_env, api_base, max_results}`                                   | remove; configure a search MCP under `mcp_servers` (as Kagi already is)                                         | Duplicated concept: a built-in Brave/Tavily client beside MCP search. Kagi was already moved out (`search.backend: "kagi"` is rejected with that advice). `max_results: 0` is silently coerced to 1.                                       | high: removes a feature some AISDK users rely on               |
| `hooks[].project` (glob)                                                                          | keep, but document `repos[].hooks` as the default way                                                           | Two ways to scope a hook to a repository; the glob one also covers groups of repos, so both stay.                                                                                                                                          | none (docs only)                                               |
| Loom `config.jsonc` snake_case vs environment-config camelCase                                    | document; do not change                                                                                         | Two files, two casings. The environment format is versioned and shared; converging would be a format version bump.                                                                                                                         | high, not proposed                                             |

## Top items

1. Fold `local_tools` / `vm_tools` / `remote_tools` into `mcp_servers`: the
   largest duplicated concept, and the source of most tool-selection errors.
2. Retire the built-in `search` backend in favour of a search MCP.
