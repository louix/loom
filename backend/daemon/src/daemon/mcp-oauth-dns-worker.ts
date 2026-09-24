import { lookup } from "node:dns/promises";
import { oauthRecord, readOAuthJson, writeOAuthJson } from "./mcp-oauth-helper-io.ts";

// This worker receives only a hostname: never a URL, headers or credentials.
try {
  const { hostname } = oauthRecord(await readOAuthJson(Deno.stdin.readable, 2048));
  if (typeof hostname !== "string" || !hostname || hostname.length > 253)
    throw new Error("invalid hostname");
  const answers = await lookup(hostname, { all: true, verbatim: true });
  if (!answers.length || answers.length > 16) throw new Error("invalid answers");
  await writeOAuthJson(Deno.stdout.writable, { addresses: answers.map((a) => a.address) });
} catch {
  Deno.exit(1);
}
