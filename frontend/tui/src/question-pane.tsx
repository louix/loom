/**
 * The answer sheet on screen. Only presentation: the rows and
 * geometry come from {@link sheetLayout}, the same numbers the keymap scrolls
 * with, and the request it answers is the handle's to send.
 */
import type { ReactNode } from "react";
import { Box } from "ink";
import { buffer } from "./editor.ts";
import { InputLine } from "./components.tsx";
import type { AskUserQuestionItem } from "./interactions.ts";
import { plainText } from "./markdown.ts";
import { sheetEditing, sheetLayout, type QNav } from "./question-sheet.ts";
import { Line, Panel, StyledText } from "./ui.tsx";

export const QuestionSheetPane = ({
  questions,
  nav,
  width,
  height,
  queued = 1,
}: {
  questions: readonly AskUserQuestionItem[];
  nav: QNav;
  width: number;
  /** Rows for the whole pane, border included. */
  height: number;
  /** Requests the session has outstanding, this one included. */
  queued?: number;
}): ReactNode => {
  const sheet = sheetLayout(questions, nav, width, height);
  const room = Math.max(1, width - 4);
  const start = Math.min(nav.offset, Math.max(0, sheet.lines.length - sheet.room));
  const shown = sheet.lines.slice(start, start + sheet.room);
  const title = sheet.title + (queued > 1 ? ` (1 of ${queued})` : "");
  const notice = plainText(nav.notice).layout(room)[0]?.text ?? "";
  const free = questions[nav.idx]?.freeText === true;
  const captions = free
    ? { compact: "⏎: review · ⌥⏎: new line", full: "Your answer · ⏎ reviews it · ⌥⏎ new line" }
    : { compact: "⏎: choices", full: "Editing the custom answer · ⏎ returns to choices" };
  const caption = sheet.compact ? captions.compact : captions.full;
  return (
    <Panel width={width} height={height} tone="await_" title={title} overflow="hidden">
      <Box height={sheet.room} flexDirection="column" overflow="hidden">
        {shown.map((row, i) => (
          // An empty row still takes its line, so the geometry the keymap
          // scrolls with is the one on screen.
          <Line key={start + i} tone="text">
            {row.text ? <StyledText spans={row.spans} /> : " "}
          </Line>
        ))}
      </Box>
      {sheetEditing(questions, nav) && (
        <Box flexDirection="column" flexShrink={0}>
          <Line tone="dim">{caption}</Line>
          <InputLine
            buf={nav.drafts[nav.idx] ?? buffer()}
            room={Math.max(1, room - 2)}
            maxRows={sheet.editorRows}
            {...(free ? { placeholder: "type your answer…" } : {})}
          />
        </Box>
      )}
      {(!sheet.compact || nav.notice !== "") && <Line tone="bad">{notice || " "}</Line>}
      {nav.busy && <Line tone="warn">Submitting…</Line>}
    </Panel>
  );
};
