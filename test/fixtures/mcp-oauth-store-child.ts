import { createMcpOAuthStore } from "../../backend/daemon/src/daemon/mcp-oauth-store.ts";
import {
  McpOAuthError,
  type McpOAuthCredential,
} from "../../backend/daemon/src/daemon/mcp-oauth-model.ts";
import { readOAuthJson } from "../../backend/daemon/src/daemon/mcp-oauth-helper-io.ts";
const credential = (await readOAuthJson(Deno.stdin.readable, 262144)) as McpOAuthCredential;
try {
  const result = await createMcpOAuthStore(credential.identity.name, Deno.args[0]!).commit(
    0,
    credential,
  );
  console.log(JSON.stringify({ generation: result.generation }));
} catch (e) {
  if (!(e instanceof McpOAuthError)) throw e;
  console.log(JSON.stringify({ error: e.code }));
}
