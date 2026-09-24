import { oauthKeychainNative } from "./mcp-oauth-keychain.ts";
import { readOAuthJson, writeOAuthJson, oauthRecord } from "./mcp-oauth-helper-io.ts";
try {
  const input = oauthRecord(await readOAuthJson(Deno.stdin.readable, 2 * 1024 * 1024));
  if (
    typeof input.service !== "string" ||
    !/^loom\.mcp-oauth\.[a-f0-9]{64}\.[a-f0-9]{64}$/.test(input.service) ||
    (input.value !== undefined && typeof input.value !== "string")
  )
    throw new Error();
  const value = oauthKeychainNative(input.service, input.value as string | undefined);
  await writeOAuthJson(Deno.stdout.writable, {
    ok: true,
    ...(value === undefined ? {} : { value }),
  });
} catch {
  Deno.exitCode = 1;
  await writeOAuthJson(Deno.stdout.writable, { ok: false });
}
