import assert from "node:assert/strict";
import { test } from "node:test";
import { lintConfig, normalizeConfig } from "../backend/daemon/src/config/config.ts";

test("doctor only probes host hook executables, including mixed lifecycle notifications", () => {
  const config = normalizeConfig({
    hooks: [
      { name: "start", on: "workspace_start", run: "missing-project-tool" },
      { name: "prepare", on: "workspace_prepare", run: "missing-project-tool" },
      {
        name: "format",
        kind: "check",
        on: ["file_write", "turn_end"],
        run: "missing-project-tool",
      },
      { name: "toast", on: "waiting", run: "missing-host-tool" },
      { name: "mixed", on: ["workspace_start", "waiting"], run: "missing-host-tool" },
    ],
  });
  const warnings = lintConfig(config, { PATH: "" }).filter((line) => line.startsWith("hook "));
  assert.equal(warnings.length, 2);
  assert.match(warnings[0]!, /hook "toast".*daemon's PATH/);
  assert.match(warnings[1]!, /hook "mixed".*daemon's PATH/);
});

test("doctor respects provider only and disabled for models, credentials and Claude profiles", () => {
  const config = normalizeConfig({
    providers: {
      codex: { profiles: { personal: {} } },
      claude: { profiles: { work: { config_dir: "/missing-doctor-test-profile" } } },
      openai_compatible: {
        profiles: {
          sference: { base_url: "https://api.sference.com/v1/", api_key_env: "MISSING_KEY" },
          llmbase: { base_url: "https://api.llmbase.ai/v1" },
        },
      },
    },
  });
  config.providerAccess = { only: ["mock"], disabled: [] };
  assert.deepEqual(lintConfig(config, {}), []);
  config.providerAccess = { only: ["mock", "sference"], disabled: ["sference"] };
  assert.deepEqual(lintConfig(config, {}), []);
  config.providerAccess = { only: ["sference"], disabled: [] };
  const enabled = lintConfig(config, {}).join("\n");
  assert.match(enabled, /MISSING_KEY/);
  assert.match(enabled, /https:\/\/api.sference.com\/v1\/models/);
  assert.doesNotMatch(enabled, /llmbase|claude profile|v1\/\/models/);
  config.providerAccess = { disabled: ["sference", "llmbase", "codex:personal"] };
  assert.ok(lintConfig(config, {}).some((line) => line.startsWith("claude profile")));
});

test("Codex model warnings refer to its authenticated catalog", () => {
  const config = normalizeConfig({ providers: { codex: { profiles: { personal: {} } } } });
  config.providerAccess = { only: ["codex:personal"], disabled: [] };
  const warnings = lintConfig(config, {}).join("\n");
  assert.match(warnings, /authenticated Codex catalog/);
  assert.doesNotMatch(warnings, /\/models/);
});
