/** Explicit live refresh: lets Claude update the selected host profile normally. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { homedir } from "node:os";
import { ClaudeAuthOwner } from "../backend/daemon/src/daemon/claude-auth.ts";
const cli = Deno.args[0];
assert(cli, "Pass the pinned Claude executable");
const profile = Deno.args[1] ?? Deno.env.get("CLAUDE_CONFIG_DIR") ?? join(homedir(), ".claude");
const before = JSON.parse(
  await Deno.readTextFile(join(profile, ".credentials.json")),
).claudeAiOauth;
const owner = new ClaudeAuthOwner({
  profile,
  cli,
  report: (code) => console.error(JSON.stringify({ auth: code })),
});
try {
  const fresh = await owner.current(true);
  assert(fresh.claudeAiOauth.accessToken !== before.accessToken, "Access token did not change");
  assert(fresh.claudeAiOauth.expiresAt > Date.now(), "Refreshed token is expired");
  assert(!("refreshToken" in fresh.claudeAiOauth));
  console.log(
    JSON.stringify({
      refreshed: true,
      hoursRemaining: Math.round((fresh.claudeAiOauth.expiresAt - Date.now()) / 36000) / 100,
      snapshotHasRefreshToken: false,
    }),
  );
} finally {
  await owner.close();
}
