import { startOAuthMcp } from "../../backend/daemon/src/daemon/mcp-oauth-owner.ts";
const mounted = await startOAuthMcp("work", Deno.args[0]!, {});
if (mounted.kind === "unavailable") throw new Error(mounted.message);
const worker = mounted.worker;
try {
  console.log(JSON.stringify(worker.handle.spec));
  await Deno.stdin.read(new Uint8Array(1));
} finally {
  await worker.close();
}
