import type { HistoryPage } from "@loom/core/wire";

/** Portable conversation context; deliberately not a native provider transcript. */
export const forkContext = (id: string, page: HistoryPage): string => {
  const entries = page.items
    .flatMap(({ event }) => {
      switch (event.type) {
        case "user_message":
          return [`User: ${event.text}`];
        case "assistant_text":
          return [`Assistant: ${event.text}`];
        case "tool_call":
          return [`Tool call ${event.name}: ${JSON.stringify(event.input)}`];
        case "tool_result":
          return [`Tool result (${event.ok ? "ok" : "error"}): ${JSON.stringify(event.output)}`];
        default:
          return [];
      }
    })
    .join("\n");
  const limit = 120_000;
  return [
    `This is a continuation fork of Loom session ${id}, with a separate copy of its worktree.`,
    "The following is saved conversation context, not a native provider history. Tool calls are historical; do not replay them.",
    ...(page.olderCursor || entries.length > limit
      ? ["Earlier context was omitted to fit the continuation budget."]
      : []),
    "<previous-conversation>",
    entries.slice(-limit) || "No conversation text was saved.",
    "</previous-conversation>",
    "Acknowledge the continuation briefly, then wait for the user's next instruction. Do not change files yet.",
  ].join("\n\n");
};
