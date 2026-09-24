import { createOAuthFetch } from "./mcp-oauth-transport.ts";
import { OAuthTransportError } from "./mcp-oauth-endpoint.ts";
import { oauthRecord, readOAuthJson, writeOAuthJson } from "./mcp-oauth-helper-io.ts";

// Deliberately GET-only and credential-free. Exchange/refresh need their own protocol.
try {
  const input = oauthRecord(await readOAuthJson(Deno.stdin.readable, 16384));
  if (
    typeof input.url !== "string" ||
    !Array.isArray(input.addresses) ||
    !input.addresses.every((a) => typeof a === "string") ||
    typeof input.allowLoopback !== "boolean"
  )
    throw new OAuthTransportError("invalid_request");
  const fetch = createOAuthFetch([{ url: input.url, addresses: input.addresses }], {
    allowLoopback: input.allowLoopback,
  });
  const response = await fetch(input.url, { headers: { accept: "application/json" } });
  await writeOAuthJson(Deno.stdout.writable, {
    status: response.status,
    headers: [...response.headers],
    body: await response.text(),
  });
} catch (error) {
  await writeOAuthJson(Deno.stdout.writable, {
    error: error instanceof OAuthTransportError ? error.code : "network_error",
  });
}
