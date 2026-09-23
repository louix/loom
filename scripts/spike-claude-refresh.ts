/** Explicit live renewal, asserting that account configuration is preserved. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { homedir } from "node:os";
import { ClaudeAuthOwner } from "../backend/daemon/src/daemon/claude-auth.ts";
import { readClaudeCredentials } from "../backend/daemon/src/daemon/claude-credentials.ts";

const profile = Deno.args[0] ?? Deno.env.get("CLAUDE_CONFIG_DIR") ?? join(homedir(), ".claude");
const before = (await readClaudeCredentials(profile)) as Record<string, any>;
const config = join(profile, ".claude.json");
const configBefore = await Deno.readTextFile(config).catch(() => undefined);
const owner = new ClaudeAuthOwner({
  profile,
  report: (code, detail) => console.error(JSON.stringify({ auth: code, detail })),
});
try {
  const fresh = await owner.current(true);
  assert(
    fresh.claudeAiOauth.accessToken !== before.claudeAiOauth.accessToken,
    "Access token did not change",
  );
  assert(fresh.claudeAiOauth.expiresAt > Date.now(), "Refreshed token is expired");
  assert(!("refreshToken" in fresh.claudeAiOauth));
  assert(
    (await Deno.readTextFile(config).catch(() => undefined)) === configBefore,
    "Account configuration changed",
  );
  const after = (await readClaudeCredentials(profile)) as Record<string, any>;
  const metadata = (value: Record<string, any>) => {
    const {
      accessToken: _access,
      refreshToken: _refresh,
      expiresAt: _expires,
      scopes: _scopes,
      ...rest
    } = value.claudeAiOauth;
    return { ...value, claudeAiOauth: rest };
  };
  assert(
    JSON.stringify(metadata(after)) === JSON.stringify(metadata(before)),
    "Unrelated credential metadata changed",
  );
  console.log(
    JSON.stringify({
      refreshed: true,
      hoursRemaining: Math.round((fresh.claudeAiOauth.expiresAt - Date.now()) / 36000) / 100,
      snapshotHasRefreshToken: false,
      accountAndMetadataPreserved: true,
    }),
  );
} finally {
  await owner.close();
}
