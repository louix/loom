/// <reference lib="deno.worker" />
// A Worker that spawns short-lived subprocesses back to back until terminated,
// saying so after the first: each holds a copy of every descriptor the process
// has open until its exec.
const spawn = () =>
  new Deno.Command("true", { stdin: "null", stdout: "null", stderr: "null" }).output();
await spawn();
self.postMessage("spawning");
for (;;) await spawn();
