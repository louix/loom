/** Synthetic TLS/permission fixture; no production credentials. */
import { createOAuthFetch } from "../../backend/daemon/src/daemon/mcp-oauth-transport.ts";
import { prepareOAuthEndpoint } from "../../backend/daemon/src/daemon/mcp-oauth-endpoint.ts";

const input = JSON.parse(await new Response(Deno.stdin.readable).text()) as {
  url: string;
  addresses: string[];
  forbidden: string;
};
const pinned = createOAuthFetch([input], { allowLoopback: true, timeoutMs: 3000 });
try {
  const response = await pinned(input.url, { method: "POST", body: "fixture-secret" });
  const text = await response.text();
  let denied = false;
  try {
    await fetch(input.forbidden);
  } catch (e) {
    denied = e instanceof Deno.errors.NotCapable;
  }
  console.log(
    JSON.stringify({
      ok: true,
      status: response.status,
      text,
      denied,
      net: prepareOAuthEndpoint(input, true).net,
    }),
  );
} catch (error) {
  console.log(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : "" }));
  Deno.exitCode = 1;
}
