#!/usr/bin/env node
import { parseArgs } from "node:util";
import { findRepoRoot } from "../util/paths.ts";
import { setLogLevel } from "@loom/core/logger";
import { Daemon } from "../daemon/daemon.ts";
import { DaemonAlreadyRunning } from "../daemon/lifecycle.ts";
import { LOOM_VERSION } from "@loom/core/version";
import { CONNECTORS } from "./connectors.ts";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      repo: { type: "string" },
      "log-level": { type: "string", default: "info" },
      version: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.version) {
    process.stdout.write(`loomd ${LOOM_VERSION}\n`);
    return;
  }
  if (values.help) {
    process.stdout.write(
      "usage: loomd [--repo <path>] [--log-level debug|info|warn|error]\n\n" +
        "Starts the Loom daemon in the foreground. Normally launched automatically\n" +
        "by the `loom` client; run directly for development or under a supervisor.\n",
    );
    return;
  }

  setLogLevel((values["log-level"] as "debug" | "info" | "warn" | "error") ?? "info");
  const repoRoot = values.repo ? values.repo : findRepoRoot();

  let daemon: Daemon;
  try {
    daemon = await Daemon.start({ repoRoot, connectors: CONNECTORS });
  } catch (err) {
    if (err instanceof DaemonAlreadyRunning) {
      process.stderr.write(`${err.message}\n`);
      process.exit(3);
    }
    throw err;
  }

  await daemon.whenClosed();
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`loomd: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
