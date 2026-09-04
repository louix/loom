import assert from "node:assert/strict";
import { test } from "node:test";
import { createChatGPTModels } from "@loom/connector-chatgpt/oauth";

test("ChatGPT OAuth connector constructs a v5 model without reading credentials eagerly", () => {
  // Constructing the provider must not touch ~/.codex/auth.json: a user should
  // be able to configure Loom before running `codex login`, then get the
  // provider's actionable auth error only when starting a session.
  const { makeModel } = createChatGPTModels({ authPath: "/definitely/not/a/credential.json" });
  const model = makeModel("gpt-5.6-terra");
  assert.equal(model.specificationVersion, "v2");
  assert.equal(model.provider, "chatgpt");
  assert.equal(model.modelId, "gpt-5.6-terra");
});
