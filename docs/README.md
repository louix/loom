# Documentation

Start with the guide for the task at hand:

| Task                                                     | Guide                                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Use the terminal UI                                      | [Keybindings](keybindings.md)                                                               |
| Share reports and scripts across sessions                | [Project files](project-files.md)                                                           |
| Configure MCP servers and authentication                 | [Tools](tools.md)                                                                           |
| Choose local or VM execution                             | [Isolation](isolation.md)                                                                   |
| Understand worktrees, private clones and Git             | [Repository access](repository-mounts.md)                                                   |
| Set up project dependencies, prepare VMs or open a shell | [Session environments](session-environments.md)                                             |
| Install or update runtime artifacts                      | [Packaged runtimes](packaged-runtimes.md)                                                   |
| Diagnose a provider VM                                   | [Claude](claude-session-vm.md), [Codex](codex-session-vm.md), [AI SDK](aisdk-session-vm.md) |
| Run one command in a VM without Loom                     | [loom-isolate](loom-isolate.md)                                                             |
| Configure loom-isolate, or convert Loom config for it    | [Environment configuration](environment-config.md)                                          |

For contributors:

- [Agent supervision](loom-agents.md)
- [Message queue](message-queue.md)
- [Connector contract and cost accounting](connectors.md)
- [HTTP MCP OAuth internals](mcp-oauth.md)
- [TUI state, ordering and rendering](tui-state.md)
- [Remaining work](roadmap.md)

Document usage, contracts, design rationale, accepted trade-offs and unresolved
issues. Keep each fact in one place. Omit implementation narration, completed
plans and verification diaries; Git history and tests retain that evidence.
Comments should explain constraints or why code exists, not restate it.
