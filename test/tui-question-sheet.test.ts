import { fleet, snap } from "./tui-fixtures.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToString } from "ink";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import type { SessionInteraction } from "@loom/core/interaction";
import { parseAskUserQuestions } from "@loom/tui/interactions";
import { initialState, reduce } from "@loom/tui/model";
import { QuestionSheetPane } from "@loom/tui/question-pane";
import {
  qnav,
  sheetAnswers,
  sheetKey,
  sheetLayout,
  type QNav,
  type SheetKey,
  type SheetResult,
} from "@loom/tui/question-sheet";

const input = {
  questions: [
    {
      question: "**Choose two**",
      header: "Many",
      multiSelect: true,
      options: [{ label: "First", description: "the **first** one" }, { label: "Second" }],
    },
    {
      question: "Which scope?",
      header: "Scope",
      options: [{ label: "Local" }, { label: "Global" }],
    },
  ],
};
const qs = parseAskUserQuestions(input);
const request: SessionInteraction = {
  kind: "user_question",
  id: "q1",
  tool: "AskUserQuestion",
  input,
  at: 1,
};

const ESC: SheetKey = { escape: true };
const RET: SheetKey = { return: true };
const TAB: SheetKey = { tab: true };
const LEFT: SheetKey = { leftArrow: true };
const RIGHT: SheetKey = { rightArrow: true };
const DOWN: SheetKey = { downArrow: true };

const press = (nav: QNav, input: string, key: SheetKey = {}, size = { w: 80, h: 24 }) =>
  sheetKey(qs, nav, input, key, sheetLayout(qs, nav, size.w, size.h));

/** Apply keys that only move the sheet; anything else fails the test. */
const drive = (nav: QNav, ...keys: Array<string | SheetKey>): QNav =>
  keys.reduce<QNav>((at, k) => {
    const r = typeof k === "string" ? press(at, k) : press(at, "", k);
    assert.equal(r.t, "nav", `expected the sheet to move on ${JSON.stringify(k)}`);
    return (r as Extract<SheetResult, { t: "nav" }>).nav;
  }, nav);

const render = (nav: QNav, width = 80, height = 24): string =>
  stripAnsi(
    renderToString(createElement(QuestionSheetPane, { questions: qs, nav, width, height }), {
      columns: width,
    }),
  );

test("multi-question navigation reaches a review that only an explicit enter submits", () => {
  let nav = drive(qnav("s1", "q1"), "1", "2");
  assert.deepEqual(nav.selected[0], [0, 1], "multi-select keeps both choices");
  nav = drive(nav, RIGHT);
  assert.equal(nav.idx, 1);
  nav = drive(nav, LEFT, LEFT);
  assert.equal(nav.idx, 0, "← stops at the first question");
  nav = drive(nav, RET);
  assert.equal(nav.idx, 1, "an answered question continues");
  // ⏎ on a single-select option with nothing chosen picks it and moves on.
  nav = drive(nav, DOWN, RET);
  assert.equal(nav.idx, 2);
  assert.match(render(nav), /REVIEW ANSWERS/);
  assert.match(render(nav), /→ First, Second/);
  assert.match(render(nav), /→ Global/);
  const back = drive(nav, ESC);
  assert.equal(back.idx, 1, "esc on the review steps back to the last question");
  const done = press(nav, "", RET);
  assert.equal(done.t, "submit");
  assert.deepEqual((done as Extract<SheetResult, { t: "submit" }>).answers, {
    "**Choose two**": "First, Second",
    "Which scope?": "Global",
  });
});

test("single selection replaces, toggles off, and excludes a custom answer", () => {
  let nav = drive(qnav("s1", "q1"), RIGHT, "1");
  assert.deepEqual(nav.selected[1], [0]);
  nav = drive(nav, "2");
  assert.deepEqual(nav.selected[1], [1], "a second choice replaces the first");
  nav = drive(nav, "2");
  assert.deepEqual(nav.selected[1], [], "choosing it again clears it");
  nav = drive(nav, "1", TAB, "my own");
  assert.equal(nav.editing, true);
  assert.deepEqual(nav.selected[1], [], "typing a custom answer clears the choice");
  nav = drive(nav, RET);
  assert.equal(nav.editing, false, "⏎ while editing returns to the choices");
  assert.match(render(nav), /Custom answer · my own/);
  nav = drive(nav, "1");
  assert.equal(nav.drafts[1]?.text, "", "a choice clears the custom answer");
});

test("multiple selection combines choices with custom text in option order", () => {
  const nav = drive(qnav("s1", "q1"), "2", "3", "and more", RET, "1", RIGHT, "1");
  assert.deepEqual(sheetAnswers(qs, nav), {
    "**Choose two**": "First, Second, and more",
    "Which scope?": "Local",
  });
});

test("custom answers: the custom row opens the editor, esc only stops editing", () => {
  let nav = drive(qnav("s1", "q1"), RIGHT, RET);
  assert.equal(nav.idx, 2, "sanity: ⏎ on a single-select picks the highlighted option");
  nav = drive(qnav("s1", "q1"), RIGHT, "3");
  assert.equal(nav.editing, true, "the custom row's number opens its editor");
  assert.match(render(nav), /Editing the custom answer/);
  nav = drive(nav, "\x1b[200~pasted\nscope\x1b[201~");
  assert.equal(nav.drafts[1]?.text, "pasted\nscope");
  nav = drive(nav, ESC);
  assert.equal(nav.editing, false);
  assert.equal(nav.idx, 1, "esc while editing keeps the sheet open");
  assert.equal(press(nav, "", ESC).t, "close", "a second esc closes it");
  // ⏎ on an empty custom row starts editing instead of continuing.
  nav = drive(qnav("s1", "q1"), RIGHT, DOWN, DOWN, RET);
  assert.equal(nav.editing, true);
});

test("validation: an unanswered question blocks continuing and submitting", () => {
  let nav = drive(qnav("s1", "q1"), RET);
  assert.equal(nav.idx, 0, "a multi-select question with nothing chosen does not continue");
  assert.match(nav.notice, /Choose an answer or enter text/);
  assert.match(render(nav), /Choose an answer or enter text/);
  nav = drive(nav, RIGHT, RIGHT);
  assert.equal(nav.idx, 2);
  nav = drive(nav, RET);
  assert.match(nav.notice, /question 1/);
  nav = drive(nav, LEFT, LEFT, "1");
  assert.equal(nav.notice, "", "a choice clears the notice");
  nav = drive(nav, RIGHT, RIGHT, RET);
  assert.match(nav.notice, /question 2/);
});

test("a submitting sheet takes no edits but can still close", () => {
  const nav = { ...drive(qnav("s1", "q1"), "1", RIGHT, "1", RIGHT), busy: true };
  assert.equal(press(nav, "", RET).t, "ignore");
  assert.equal(press(nav, "", LEFT).t, "ignore");
  assert.equal(press(nav, "", ESC).t, "nav", "esc on the review steps back");
  assert.match(render(nav), /Submitting…/);
});

test("small terminals keep the sheet within its rows and the cursor in view", () => {
  const long = parseAskUserQuestions({
    questions: [
      {
        question: "Pick one of many",
        header: "Many",
        options: Array.from({ length: 9 }, (_, i) => ({
          label: `option ${i + 1}`,
          description: `why option ${i + 1} might be right`,
        })),
      },
    ],
  });
  const size = { w: 40, h: 10 };
  const layout = (nav: QNav) => sheetLayout(long, nav, size.w, size.h);
  let nav = qnav("s1", "q1");
  assert.equal(layout(nav).compact, true);
  for (let i = 0; i < 8; i++) {
    const r = sheetKey(long, nav, "", DOWN, layout(nav));
    assert.equal(r.t, "nav");
    nav = (r as Extract<SheetResult, { t: "nav" }>).nav;
    const row = layout(nav).choiceRows[nav.cursor]!;
    assert.ok(
      row >= nav.offset && row < nav.offset + layout(nav).room,
      `the cursor row stays visible at option ${nav.cursor + 1}`,
    );
  }
  const out = stripAnsi(
    renderToString(
      createElement(QuestionSheetPane, { questions: long, nav, width: size.w, height: size.h }),
      { columns: size.w },
    ),
  );
  assert.equal(out.split("\n").length, size.h, "the pane fills exactly its rows");
  assert.match(out, /> 9: \( \) option 9/);
  // ⇟ pages without running past the last row.
  const paged = sheetKey(long, { ...nav, offset: 0 }, "", { pageDown: true }, layout(nav));
  assert.equal(paged.t, "nav");
  const offset = (paged as Extract<SheetResult, { t: "nav" }>).nav.offset;
  assert.ok(offset > 0 && offset <= layout(nav).lines.length - layout(nav).room);
});

test("the sheet formats prompts and descriptions and marks single vs multiple choice", () => {
  const out = render(qnav("s1", "q1"));
  assert.match(out, /\? QUESTION 1\/2 · Many/);
  assert.match(out, /Choose two/);
  assert.doesNotMatch(out, /\*\*/, "prompts and descriptions are formatted Markdown");
  assert.match(out, /> 1: \[ \] First/);
  assert.match(out, /the first one/);
  assert.match(out, /3: Custom answer…/);
  assert.match(render(drive(qnav("s1", "q1"), RIGHT)), /1: \( \) Local/);
  assert.equal(render(qnav("s1", "q1")).split("\n").length, 24);
});

test("the open sheet stays on its request while others queue, and goes when it resolves", () => {
  const other: SessionInteraction = {
    kind: "permission",
    id: "p2",
    tool: "Bash",
    input: {},
    at: 2,
  };
  const blocked = (requests: SessionInteraction[]) =>
    snap({ id: "a", status: "awaiting_input", awaitReason: "permission", requests });
  let s = reduce(initialState(), fleet([blocked([request])]));
  s = reduce(s, { t: "overlay", overlay: { t: "questions", sessionId: "a", requestId: "q1" } });
  s = reduce(s, { t: "qnavSet", nav: drive(qnav("a", "q1"), "1") });
  // A concurrent permission arrives, and is what the session now reports
  // itself blocked on — the sheet is not re-aimed at it.
  s = reduce(s, fleet([blocked([request, other])]));
  assert.deepEqual(s.overlay, { t: "questions", sessionId: "a", requestId: "q1" });
  assert.deepEqual(s.qnav?.selected[0], [0], "progress survives the new request");
  // Answered elsewhere: the stale sheet and its progress both go.
  s = reduce(s, fleet([blocked([other])]));
  assert.equal(s.overlay.t, "browse");
  assert.equal(s.qnav, null);
  assert.match(s.notice?.text ?? "", /resolved elsewhere/);
});
