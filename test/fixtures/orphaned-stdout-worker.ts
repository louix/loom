/** A worker that writes one frame, leaves a grandchild owning its stdout, and exits. */
new Deno.Command(Deno.execPath(), {
  args: ["eval", "await new Promise((resolve) => setTimeout(resolve, 60_000))"],
  stdin: "null",
  stdout: "inherit",
  stderr: "null",
}).spawn();
await Deno.stdout.write(new TextEncoder().encode('{"kind":"started"}\n'));
Deno.exit(0);
