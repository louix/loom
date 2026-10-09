// `deno test` with live output, inside a throwaway HOME/XDG root
// (scripts/lib/test-home.ts). Exit code mirrors the child run.
//
// Usage: deno task test [deno test flags...] [files or dirs; default test/]

import { runIsolatedTests } from "./lib/test-home.ts";

const { code } = await runIsolatedTests(Deno.args, { stdout: "inherit", stderr: "inherit" });
Deno.exit(code);
