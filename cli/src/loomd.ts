#!/usr/bin/env -S deno run -A --deny-net
import { relaunchForIpc } from "@loom/core/network-permissions";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { findRepoRoot, loomPaths } from "@loom/core/paths";
import { setLogLevel } from "@loom/core/logger";
import { Daemon } from "@loom/daemon/daemon/daemon";
import { DaemonAlreadyRunning } from "@loom/daemon/daemon/lifecycle";
import { LOOM_VERSION } from "@loom/core/version";
import { CONNECTORS } from "./connectors.ts";

const encoder = new TextEncoder();
const writeOut = (s: string): void => void Deno.stdout.writeSync(encoder.encode(s));
const writeErr = (s: string): void => void Deno.stderr.writeSync(encoder.encode(s));

const main = async (): Promise<void> => {
  const { values } = parseArgs({
    options: {
      repo: { type: "string" },
      "log-level": { type: "string", default: "info" },
      version: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.version) {
    writeOut(`loomd ${LOOM_VERSION}\n`);
    return;
  }
  if (values.help) {
    writeOut(
      "usage: loomd [--repo <path>] [--log-level debug|info|warn|error]\n\n" +
        "Starts the Loom daemon in the foreground. Normally launched automatically\n" +
        "by the `loom` client; run directly for development or under a supervisor.\n",
    );
    return;
  }

  setLogLevel((values["log-level"] as "debug" | "info" | "warn" | "error") ?? "info");
  const repoRoot = findRepoRoot(values.repo);

  await relaunchForIpc(fileURLToPath(import.meta.url), loomPaths(repoRoot).sock);
  let daemon: Daemon;
  try {
    daemon = await Daemon.start({ repoRoot, connectors: CONNECTORS });
  } catch (err) {
    if (err instanceof DaemonAlreadyRunning) {
      writeErr(`${err.message}\n`);
      Deno.exit(3);
    }
    throw err;
  }

  await daemon.whenClosed();
  Deno.exit(0);
};

main().catch((err) => {
  writeErr(`loomd: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  Deno.exit(1);
});
