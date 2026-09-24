import { discoverMcpOAuth } from "../../backend/daemon/src/daemon/mcp-oauth-discovery.ts";
import { createOAuthDiscoveryNetwork } from "../../backend/daemon/src/daemon/mcp-oauth-network.ts";

const resource = Deno.args[0]!;
let denied = false;
try {
  await fetch(resource);
} catch (e) {
  denied = e instanceof Deno.errors.NotCapable;
}
const dns = await createOAuthDiscoveryNetwork({ allowLoopback: true }).resolve(
  "https://localhost/meta",
);
const result = await discoverMcpOAuth(resource);
console.log(JSON.stringify({ denied, resolved: dns.addresses.length > 0, result }));
