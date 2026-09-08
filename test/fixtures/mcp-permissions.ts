const denied: boolean[] = [];
for (const operation of [
  () => Deno.readTextFile("/etc/passwd"),
  () => Deno.writeTextFile("/tmp/loom-mcp-must-not-write", "x"),
  () => Deno.env.get("HOME"),
  () => new Deno.Command("/bin/sh", { args: ["-c", "true"] }).output(),
  () => fetch("http://127.0.0.1:23456/"),
]) {
  try {
    await operation();
    denied.push(false);
  } catch (error) {
    denied.push(error instanceof Deno.errors.NotCapable);
  }
}
console.log(JSON.stringify(denied));
