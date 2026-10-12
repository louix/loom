import { fleet, snap } from "./tui-fixtures.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToString } from "ink";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import type { SessionInteraction } from "@loom/core/interaction";
import {
  decisionCall,
  parseAskUserQuestions,
  sheetDecision,
  sheetQuestions,
} from "@loom/tui/interactions";
import { initialState, reduce } from "@loom/tui/model";
import { QuestionSheetPane } from "@loom/tui/question-pane";
import {
  qnav,
  sheetAnswers,
  sheetEditing,
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

test("multi-question Enter advances and submits without a review step", () => {
  let nav = drive(qnav("s1", "q1"), "1", "2", RIGHT, "1");
  assert.equal(nav.idx, 1);
  const done = press(nav, "", RET);
  assert.equal(done.t, "submit");
  assert.deepEqual((done as Extract<SheetResult, { t: "submit" }>).answers, {
    "**Choose two**": "First, Second",
    "Which scope?": "Local",
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
  const result = press(nav, "", RET);
  assert.equal(result.t, "nav");
  assert.equal((result as Extract<SheetResult, { t: "nav" }>).nav.idx, 0);
  assert.equal(nav.drafts[1]?.text, "my own");
});

test("multiple selection combines choices with custom text in option order", () => {
  const nav = drive(qnav("s1", "q1"), "1", "2", "3", "and more", RET, "1");
  assert.deepEqual(sheetAnswers(qs, nav), {
    "**Choose two**": "First, Second, and more",
    "Which scope?": "Local",
  });
});

test("custom answers: the custom row opens the editor, esc only stops editing", () => {
  let nav = drive(qnav("s1", "q1"), RIGHT, RET);
  assert.equal(nav.idx, 0, "Enter on the last answer focuses the unanswered question");
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

test("validation focuses an unanswered question instead of submitting", () => {
  let nav = drive(qnav("s1", "q1"), RET);
  assert.equal(nav.idx, 0);
  assert.match(nav.notice, /Choose an answer or enter text/);
  nav = drive(nav, RIGHT, "1", RET);
  assert.equal(nav.idx, 0, "the unanswered question receives focus");
  assert.equal(press(nav, "", RET).t, "nav");
});

test("a submitting sheet takes no edits but can still close", () => {
  const nav = { ...drive(qnav("s1", "q1"), "1", RIGHT, "1", RIGHT), busy: true };
  assert.equal(press(nav, "", RET).t, "ignore");
  assert.equal(press(nav, "", LEFT).t, "ignore");
  assert.equal(press(nav, "", ESC).t, "close", "esc closes the busy sheet");
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

// ---- a free-text question (Loom's own `ask_user`) -------------------------

const ask: SessionInteraction = {
  kind: "question",
  id: "u1",
  question: "Which **store** should the cache use?",
  context: "Redis is already deployed; SQLite needs no service.",
  at: 1,
};
const free = sheetQuestions(ask)!;
const ALT_RET: SheetKey = { return: true, meta: true };

const freePress = (nav: QNav, input: string, key: SheetKey = {}, size = { w: 80, h: 24 }) =>
  sheetKey(free, nav, input, key, sheetLayout(free, nav, size.w, size.h));
const freeDrive = (nav: QNav, ...keys: Array<string | SheetKey>): QNav =>
  keys.reduce<QNav>((at, k) => {
    const r = typeof k === "string" ? freePress(at, k) : freePress(at, "", k);
    assert.equal(r.t, "nav", `expected the sheet to move on ${JSON.stringify(k)}`);
    return (r as Extract<SheetResult, { t: "nav" }>).nav;
  }, nav);
const freeRender = (nav: QNav, width = 80, height = 24): string =>
  stripAnsi(
    renderToString(createElement(QuestionSheetPane, { questions: free, nav, width, height }), {
      columns: width,
    }),
  );

test("a free-text question opens straight into a multi-line answer editor", () => {
  assert.deepEqual(free, [
    {
      question:
        "Which **store** should the cache use?\n\nRedis is already deployed; SQLite needs no service.",
      header: "",
      options: [],
      freeText: true,
    },
  ]);
  const nav = qnav("s1", "u1");
  assert.equal(sheetEditing(free, nav), true, "there are no choices to start on");
  const out = freeRender(nav);
  assert.match(out, /\? QUESTION/);
  assert.match(out, /Which store should the cache use\?/);
  assert.match(out, /Redis is already deployed/, "the context sits under the question");
  assert.match(out, /Your answer · ⏎ submits · ⌥⏎ new line/);
  assert.doesNotMatch(out, /Custom answer|1:/, "no choices, no custom row");
  assert.equal(out.split("\n").length, 24);
});

test("free text: Enter submits and Alt+Enter inserts a newline", () => {
  let nav = freeDrive(qnav("s1", "u1"), "SQLite", ALT_RET, "  then Redis");
  assert.equal(nav.drafts[0]?.text, "SQLite\n  then Redis");
  const done = freePress(nav, "", RET);
  assert.equal(done.t, "submit");
  const { answers } = done as Extract<SheetResult, { t: "submit" }>;
  const call = decisionCall("s1", "u1", sheetDecision(ask, answers), "me");
  assert.deepEqual(call.params, {
    id: "s1",
    requestId: "u1",
    by: "me",
    text: "SQLite\n  then Redis",
  });
});

test("free text: an empty answer does not submit", () => {
  const result = freePress(qnav("s1", "u1"), "   ", RET);
  assert.equal(result.t, "nav");
  assert.match((result as Extract<SheetResult, { t: "nav" }>).nav.notice, /Write an answer/);
  assert.equal(freePress(qnav("s1", "u1"), "", RET).t, "nav");
});

test("free text: esc in the editor leaves the sheet with the draft kept", () => {
  const nav = freeDrive(qnav("s1", "u1"), "half", ALT_RET, "written");
  const closed = freePress(nav, "", ESC);
  assert.equal(closed.t, "close");
  const kept = (closed as Extract<SheetResult, { t: "close" }>).nav;
  assert.equal(kept.drafts[0]?.text, "half\nwritten");
  // Resumed, it is still the editor, with the text.
  assert.equal(sheetEditing(free, kept), true);
  assert.equal(freeDrive(kept, "!").drafts[0]?.text, "half\nwritten!");
  assert.match(freeRender(kept), /written/);
});

test("free text: a long question wraps and scrolls in a small terminal", () => {
  const paragraphs = Array.from(
    { length: 4 },
    (_, i) => `Paragraph ${i + 1} explains one more consideration about the migration at length.`,
  );
  const long = sheetQuestions({ ...ask, question: paragraphs.join("\n\n"), context: "end" })!;
  const size = { w: 40, h: 12 };
  const layout = (nav: QNav) => sheetLayout(long, nav, size.w, size.h);
  const draw = (nav: QNav) =>
    stripAnsi(
      renderToString(
        createElement(QuestionSheetPane, { questions: long, nav, width: size.w, height: size.h }),
        { columns: size.w },
      ),
    );
  let nav = freeDrive(qnav("s1", "u1"), "ok");
  assert.equal(layout(nav).compact, true);
  assert.ok(layout(nav).lines.length > layout(nav).room, "the question needs scrolling");
  for (const row of draw(nav).split("\n"))
    assert.ok(row.length <= size.w, `no row runs past the pane: ${JSON.stringify(row)}`);
  assert.equal(draw(nav).split("\n").length, size.h, "the pane fills exactly its rows");
  assert.match(draw(nav), /Paragraph 1/);
  assert.match(draw(nav), /⏎: submit · ⌥⏎: new line/, "the editor stays on screen");
  // ⇟ pages while the editor has the keys, and stops at the last row.
  for (let i = 0; i < 10; i++) {
    const r = sheetKey(long, nav, "", { pageDown: true }, layout(nav));
    assert.equal(r.t, "nav");
    nav = (r as Extract<SheetResult, { t: "nav" }>).nav;
  }
  assert.equal(nav.offset, layout(nav).lines.length - layout(nav).room);
  assert.match(draw(nav), /end/, "the context at the bottom is reachable");
  assert.doesNotMatch(draw(nav), /Paragraph 1/);
  assert.equal(nav.drafts[0]?.text, "ok", "paging did not type");
});

test("an open free-text sheet goes when its question is resolved elsewhere", () => {
  const blocked = (requests: SessionInteraction[]) =>
    snap({ id: "a", status: "awaiting_input", awaitReason: "question", requests });
  let s = reduce(initialState(), fleet([blocked([ask])]));
  s = reduce(s, { t: "overlay", overlay: { t: "questions", sessionId: "a", requestId: "u1" } });
  s = reduce(s, { t: "qnavSet", nav: freeDrive(qnav("a", "u1"), "draft") });
  // A second question queues behind it; the sheet stays on its own.
  const next: SessionInteraction = { ...ask, id: "u2", question: "And the TTL?" };
  s = reduce(s, fleet([blocked([ask, next])]));
  assert.deepEqual(s.overlay, { t: "questions", sessionId: "a", requestId: "u1" });
  assert.equal(s.qnav?.drafts[0]?.text, "draft");
  s = reduce(s, fleet([blocked([next])]));
  assert.equal(s.overlay.t, "browse");
  assert.equal(s.qnav, null, "the draft for the resolved question goes with it");
  assert.match(s.notice?.text ?? "", /resolved elsewhere/);
});
