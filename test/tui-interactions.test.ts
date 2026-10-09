import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionInteraction } from "@loom/core/interaction";
import {
  decisionCall,
  formatQuestionsForEditor,
  parseAskUserQuestions,
} from "@loom/tui/interactions";
import { askQuestionLines } from "@loom/tui/components";

const input = {
  questions: [
    {
      question: "Which store?",
      options: [{ label: "SQLite" }, { label: "Postgres" }, { label: "Memory" }],
      multiSelect: true,
    },
    { question: "Which scope?", options: [{ label: "Local" }, { label: "Global" }] },
  ],
};
const request: SessionInteraction = {
  kind: "user_question",
  id: "q1",
  tool: "AskUserQuestion",
  input,
  at: 1,
};

test("displayed option numbers match the sheet and answers ride the permission wire", () => {
  const qs = parseAskUserQuestions(input);
  assert.equal(qs[0]?.multiSelect, true);
  assert.equal(qs[1]?.multiSelect, false);
  assert.ok(askQuestionLines(qs, 0, 80).some((line) => line.trim() === "2) Postgres"));
  assert.ok(formatQuestionsForEditor(qs).includes("2) Postgres"));
  const answers = { "Which store?": "Postgres, Memory", "Which scope?": "Local" };
  assert.deepEqual(decisionCall("s1", "q1", { t: "answers", request, answers }, "me"), {
    method: "session.respondPermission",
    params: {
      id: "s1",
      requestId: "q1",
      by: "me",
      decision: "allow",
      updatedInput: { ...input, answers },
    },
  });
  assert.deepEqual(answers, { "Which store?": "Postgres, Memory", "Which scope?": "Local" });
});

// The answer sheet resolves choices to labels itself, so whatever reaches the
// wire — including a custom answer that happens to look like an option tag —
// is sent exactly as given. (The old typed prompt mapped `a`, `b, c` … onto
// lettered options; the sheet chooses by number and never needs that.)
test("answers, including letter-like custom text, travel verbatim", () => {
  const cases = ["b", "a, c", "Postgres", "b, but only locally", "  custom answer  ", ""];
  for (const answer of cases) {
    const call = decisionCall(
      "s1",
      "q1",
      {
        t: "answers",
        request,
        answers: { "Which store?": answer, "Unknown question": "a" },
      },
      "me",
    );
    assert.deepEqual(call.params["updatedInput"], {
      ...input,
      answers: { "Which store?": answer, "Unknown question": "a" },
    });
  }
});

test("malformed questions and free-text ask_user answers are preserved", () => {
  for (const malformed of [undefined, {}, { questions: [null, { question: "Which store?" }] }]) {
    const call = decisionCall(
      "s1",
      "q1",
      {
        t: "answers",
        request: { ...request, input: malformed },
        answers: { "Which store?": "a" },
      },
      "me",
    );
    assert.deepEqual(call.params["updatedInput"], {
      ...malformed,
      answers: { "Which store?": "a" },
    });
  }
  assert.equal(decisionCall("s1", "q1", { t: "answer", text: "b" }, "me").params["text"], "b");
});
