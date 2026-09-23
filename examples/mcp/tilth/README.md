# Tilth MCP package

This standalone flake pins Tilth and includes its Git dependency and Git-error
patch. It exports an ordinary Linux Nix package, independently of Loom's package.

Copy this directory to a durable location, for example
`~/.config/loom/mcp/tilth`. Configure its absolute path:

```jsonc
{
  "mcp_servers": {
    "tilth": {
      "source": {
        "kind": "nix",
        "ref": "path:/home/you/.config/loom/mcp/tilth#default",
        "executable": "tilth",
        "args": ["--mcp", "--edit"],
      },
      "execution": "vm",
      "grants": { "workspace": "read-write", "network": [] },
      "default_for": ["read", "write", "edit", "find", "grep"],
    },
  },
  "session": { "mcp_servers": ["tilth"] },
}
```

Run `loom mcp prepare tilth`, then `loom mcp status tilth`.
Restart the daemon and start/resume sessions to apply changed configuration.
Keep the copied lock file: preparation does not advance upstream revisions.
After deliberately changing the package, run `loom mcp update tilth`.
macOS preparation requires a configured Linux builder.
