// `deno test` with live output, inside a throwaway HOME/XDG root
// (scripts/lib/test-run.ts). Exit code mirrors the child runs.
//
// Usage: deno task test [deno test flags...] [files or dirs; default test/]

import { runTests } from "./lib/test-run.ts";

const { code } = await runTests(Deno.args, "live");
Deno.exit(code);
