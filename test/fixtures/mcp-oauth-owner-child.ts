import { startOAuthMcp } from "../../backend/daemon/src/daemon/mcp-oauth-owner.ts";
const worker = await startOAuthMcp("work", Deno.args[0]!, {});
try {
  console.log(JSON.stringify(worker.handle.spec));
  await Deno.stdin.read(new Uint8Array(1));
} finally {
  await worker.close();
}
