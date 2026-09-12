/** Opt-in live check: native Codex turns, fresh-VM resume and shell/worktree writes. */
import assert from "node:assert/strict";
import { gitFixture } from "./lib/git-fixture.ts";
import { withVmSessions } from "../backend/daemon/src/daemon/vm-provider.ts";
import { createProvider } from "../connectors/chatgpt/src/index.ts";
import { makeLogger } from "../core/src/logger.ts";
import type { AgentSession } from "../core/src/types.ts";
const [artifact, smolvm, cli, profile] = Deno.args;
assert(
  artifact && smolvm && cli && profile,
  "Usage: test-codex-session-vm.ts ARTIFACT SMOLVM HOST_CODEX PROFILE",
);
const f = await gitFixture();
const state = await Deno.makeTempDir({ prefix: "loom-codex-vm-test-" });
Deno.env.set("XDG_STATE_HOME", state);
const ctx = {
  id: "chatgpt",
  config: {
    sdk: "chatgpt" as const,
    configDir: profile,
    codexCliPath: cli,
    sessionVm: { artifact, smolvm, repoRoot: f.repo },
  },
  logger: makeLogger("smoke"),
};
const provider = await withVmSessions(createProvider(ctx), ctx, "codex");
let session: AgentSession | undefined;
const turn = async () => {
  let text = "";
  for await (const event of session!.events()) {
    if (event.type === "assistant_text") text += JSON.stringify(event);
    if (event.type === "error") throw new Error("provider error");
    if (event.type === "result") {
      assert.equal(event.kind, "ok");
      return text;
    }
  }
  throw new Error("stream ended");
};
const timeout = setTimeout(() => {
  console.error("Codex VM timeout");
  Deno.exit(1);
}, 90000);
try {
  session = await provider.createSession({
    sessionId: "smoke",
    cwd: f.workspace,
    prompt: "Remember cobalt. Reply with exactly OK. Do not use tools.",
    mode: "default",
    mcpServers: [],
  });
  await turn();
  console.log("Codex VM first turn passed");
  const ref = session.providerRef!;
  await session.close();
  session = await provider.resumeSession({
    sessionId: "smoke",
    providerRef: ref,
    cwd: f.workspace,
    mode: "default",
    mcpServers: [],
  });
  await session.send(
    "What word did I ask you to remember? Reply only with that word. Do not use tools.",
  );
  const text = await turn();
  assert(text.toLowerCase().includes("cobalt"));
  console.log("Codex fresh VM resume passed");
  await session.setMode("auto");
  await session.send(
    "Use the shell to write VM_OK to native-tool-check.txt in the working directory, then run git status --short. Do not commit anything.",
  );
  await turn();
  assert((await Deno.readTextFile(f.workspace + "/native-tool-check.txt")).includes("VM_OK"));
  console.log("Codex VM shell and worktree write passed");
} finally {
  clearTimeout(timeout);
  await session?.close();
  await provider.close?.();
  await f.close();
  await Deno.remove(state, { recursive: true });
}
