import { createOAuthFetch } from "./mcp-oauth-transport.ts";
import { OAuthTransportError } from "./mcp-oauth-endpoint.ts";
import { oauthRecord, readOAuthJson, writeOAuthJson } from "./mcp-oauth-helper-io.ts";

// One exact destination, private stdin, no DNS, credential-store, env or subprocess grants.
try {
  const input = oauthRecord(await readOAuthJson(Deno.stdin.readable, 512 * 1024));
  if (
    typeof input.url !== "string" ||
    typeof input.body !== "string" ||
    !Array.isArray(input.addresses) ||
    !input.addresses.every((a) => typeof a === "string") ||
    !Array.isArray(input.headers) ||
    !input.headers.every(
      (h) => Array.isArray(h) && h.length === 2 && h.every((v) => typeof v === "string"),
    ) ||
    typeof input.allowLoopback !== "boolean"
  )
    throw new OAuthTransportError("invalid_request");
  const fetch = createOAuthFetch([{ url: input.url, addresses: input.addresses }], {
    allowLoopback: input.allowLoopback,
  });
  const response = await fetch(input.url, {
    method: "POST",
    headers: input.headers as [string, string][],
    body: input.body,
  });
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
