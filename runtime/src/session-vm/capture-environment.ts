// Invoked by the configured environment command. No repo config or imports are loaded.
await Deno.writeTextFile(Deno.args[0]!, JSON.stringify(Deno.env.toObject()), { mode: 0o600 });
