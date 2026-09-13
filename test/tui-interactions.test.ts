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

test("displayed question letters become option labels on the permission wire", () => {
  const qs = parseAskUserQuestions(input);
  assert.ok(askQuestionLines(qs, 0, 80).some((line) => line.trim() === "b) Postgres"));
  assert.ok(formatQuestionsForEditor(qs).includes("b) Postgres"));
  const answers = { "Which store?": "b", "Which scope?": "a)" };
  assert.deepEqual(decisionCall("s1", "q1", { t: "answers", request, answers }, "me"), {
    method: "session.respondPermission",
    params: {
      id: "s1",
      requestId: "q1",
      by: "me",
      decision: "allow",
      updatedInput: { ...input, answers: { "Which store?": "Postgres", "Which scope?": "Local" } },
    },
  });
  assert.deepEqual(answers, { "Which store?": "b", "Which scope?": "a)" });
});

test("letter selections resolve while free text and unknown choices remain verbatim", () => {
  const cases: Array<[string, string]> = [
    [" B) ", "Postgres"],
    ["c.", "Memory"],
    ["a, c", "SQLite, Memory"],
    ["A) and B)", "SQLite, Postgres"],
    ["b/c", "Postgres, Memory"],
    ...["Postgres", "b, but only locally", "a, z", "z", "  custom answer  ", ""].map(
      (answer): [string, string] => [answer, answer],
    ),
  ];
  for (const [answer, expected] of cases) {
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
      answers: { "Which store?": expected, "Unknown question": "a" },
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
