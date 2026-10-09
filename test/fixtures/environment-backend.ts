/** Fake smolvm for supervisor tests. No virtualization and no provider traffic. */
import { dirname, join } from "node:path";
const state = dirname(Deno.env.get("HOME")!);
switch (Deno.args[1]) {
  case "ls":
    console.log("[]");
    break;
  case "data-dir":
    console.log(join(state, "machine"));
    break;
  case "exec": {
    if ((await Deno.readTextFile(join(state, "private/environment-only"))) !== "1")
      throw new Error("Not an environment-only launch");
    await Deno.writeTextFile(join(state, "entered"), "");
    for (;;) {
      try {
        await Deno.stat(join(state, "release"));
        break;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const mode = await Deno.readTextFile(join(state, "mode"));
    if (mode === "failure") Deno.exit(17);
    if (mode === "diagnostic") {
      // guest.ts reports a classified preparation failure, then exits.
      console.error(JSON.stringify({ loomStartupFailure: "sessionCheckoutFailed" }));
      Deno.exit(1);
    }
    if (mode === "invalid") console.log("unexpected worker output");
    else {
      await Deno.stdout.write(new TextEncoder().encode('{"loomEnvironment'));
      await Deno.stdout.write(new TextEncoder().encode('Ready":1}\n'));
    }
    for await (const chunk of Deno.stdin.readable) {
      if (chunk.length) throw new Error("Unexpected worker initialization");
    }
    break;
  }
}
