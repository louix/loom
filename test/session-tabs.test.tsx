import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToString } from "ink";
import { stripVTControlCharacters } from "node:util";
import { InspectionPane } from "../frontend/tui/src/session-tabs.tsx";

test("Changes presents labelled file states and line counts with uppercase tabs", () => {
  const text = [
    "Branch  loom/demo",
    "Base    main",
    "",
    "WORKING TREE",
    " M edited.ts",
    "A  staged.ts",
    "MM both.ts",
    "?? new.ts",
    "UU conflict.ts",
    "",
    "SESSION DIFF · since branching from main",
    "12\t3\tedited.ts",
    "-\t-\timage.png",
    " 2 files changed, 12 insertions(+), 3 deletions(-)",
  ].join("\n");
  const output = stripVTControlCharacters(
    renderToString(
      createElement(InspectionPane, {
        tab: "changes",
        text,
        scroll: 0,
        width: 100,
        height: 24,
      }),
    ),
  );
  for (const label of [
    "1 CHAT",
    "[2 CHANGES]",
    "3 VM MONITOR",
    "BRANCH",
    "MODIFIED",
    "ADDED",
    "UNTRACKED",
    "CONFLICT",
    "staged + working",
    "+12",
    "−3",
    "binary",
  ])
    assert.ok(output.includes(label), label + "\n" + output);
  assert.ok(!output.includes("??"));
});
