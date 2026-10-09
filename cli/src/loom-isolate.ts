#!/usr/bin/env -S deno run -A --deny-net
/** Standalone isolation CLI. Packaged without Loom's client, daemon, TUI or agents. */
import { isolateCli } from "./isolate/cli.ts";

Deno.exit(await isolateCli(Deno.args));
