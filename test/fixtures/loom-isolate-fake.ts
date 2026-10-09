/** The loom-isolate entrypoint over the fake VM backend. */
import { isolateCli } from "../../cli/src/isolate/cli.ts";
import { fakeDependencies } from "./loom-isolate-backend.ts";

Deno.exit(await isolateCli(Deno.args, fakeDependencies));
