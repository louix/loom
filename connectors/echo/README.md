# Echo connector

A minimal Loom provider plugin. Enable it in `config.jsonc`:

```jsonc
{ "providers": { "echo": {} } }
```

Restart the daemon, then choose **Echo** in the TUI. Every message receives
`Echo: <your message>`, with zero tokens and cost. It runs in a local worker
without credentials, network access, or a model download.

`src/index.ts` demonstrates the connector contract:

- Export `createProvider(ctx)` and advertise supported capabilities.
- Create a session and process its opening prompt.
- Queue normalized text, usage, and result events for each turn.
- Handle follow-up messages, stateless resume, one-shot calls, and stream closure.
- Return independent snapshots and reject unsupported operations.

Echo has no tools, inference, compaction, rewind, or provider-side history.
Loom stores the displayed transcript. Mock and fake remain separate scripted
test providers.

To build another connector, see [Writing a connector](../../docs/connectors.md#writing-a-connector).
Workspace registration, the CLI manifest, worker loader/protocol, and daemon
provider routing must also recognize its package; plugins are not auto-discovered.
