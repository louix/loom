import assert from "node:assert/strict";
import { test } from "node:test";
import { cheapModelFor, cleanTitle, generateTitle } from "@loom/daemon/daemon/titler";
import { FakeProvider } from "@loom/connector-mock";
import { makeLogger, setLogLevel } from "@loom/core/logger";

setLogLevel("error");
const log = makeLogger("titler-test");

test("cleanTitle strips quotes, labels, and trailing punctuation", () => {
  assert.equal(cleanTitle('"Add a JSON flag to the CLI"'), "Add a JSON flag to the CLI");
  assert.equal(cleanTitle("Title: Refactor the auth module."), "Refactor the auth module");
  assert.equal(cleanTitle("*Fix the parser*!"), "Fix the parser");
});

test("cleanTitle takes the first non-blank line and collapses whitespace", () => {
  assert.equal(
    cleanTitle("\n\n  Fix   the   flaky   test  \nand some rambling after"),
    "Fix the flaky test",
  );
});

test("cleanTitle returns null when there's nothing usable", () => {
  assert.equal(cleanTitle(""), null);
  assert.equal(cleanTitle("   \n  "), null);
  assert.equal(cleanTitle('"" '), null);
});

test("cleanTitle caps very long replies", () => {
  const t = cleanTitle("word ".repeat(40));
  assert.ok(t && t.length <= 72);
  assert.ok(t?.endsWith("…"));
});

test("cleanTitle rejects a chat turn instead of a label", () => {
  // the model tried to converse (real case: the prompt was just "hi")
  assert.equal(cleanTitle("What task would you like me to label? Please describe it"), null);
  assert.equal(cleanTitle("Sorry, I need more detail to give a good title"), null);
  assert.equal(cleanTitle("Could you tell me what this project does?"), null);
  assert.equal(cleanTitle("I'm not sure what to title this"), null);
  // …but a normal label that merely starts with a stop-word-ish token is fine
  assert.equal(cleanTitle("Wire up the websocket layer"), "Wire up the websocket layer");
});

test("generateTitle skips a one-word prompt (nothing to summarise)", async () => {
  const provider = new FakeProvider();
  provider.titleReply = "should never be used";
  assert.equal(await generateTitle({ provider, prompt: "hi", cwd: "/tmp", log }), null);
  assert.equal(await generateTitle({ provider, prompt: "   help  ", cwd: "/tmp", log }), null);
});

test("cheapModelFor knows claude, shrugs at the rest", () => {
  assert.equal(cheapModelFor("claude"), "claude-haiku-4-5-20251001");
  assert.equal(cheapModelFor("fake"), undefined);
});

test("generateTitle runs a one-shot through the provider and cleans the reply", async () => {
  const provider = new FakeProvider();
  provider.titleReply = "Wire up the websocket layer";
  const title = await generateTitle({
    provider,
    prompt: "please make the realtime stuff work over websockets",
    cwd: "/tmp",
    log,
  });
  assert.equal(title, "Wire up the websocket layer");
});
