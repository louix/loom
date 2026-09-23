/** Narrow network-enabled subprocess; the daemon itself retains --deny-net. */
import { refreshClaudeProfile } from "./claude-refresh.ts";
import { CredentialAuthError } from "./credential-owner.ts";

if (import.meta.main) {
  try {
    const input = await new Response(Deno.stdin.readable).json();
    if (typeof input.profile !== "string" || typeof input.accessToken !== "string")
      throw new Error();
    await refreshClaudeProfile(input.profile, input.accessToken, AbortSignal.timeout(55_000));
    console.log(JSON.stringify({ ok: true }));
  } catch (error) {
    const failure =
      error instanceof CredentialAuthError ? error : new CredentialAuthError("refresh_failed");
    console.log(JSON.stringify({ ok: false, code: failure.code, detail: failure.detail }));
    Deno.exitCode = 1;
  }
}
