/**
 * One session's message queue (`q`), adapted from main-new's
 * `ConversationQueue`: the entries the daemon reports on the snapshot, in its
 * two groups, each with the daemon's word on when it goes. Pure: the keys are
 * the A2 command model's (`queue` surface), the selection is the overlay's —
 * by id, so an arrival never moves it.
 */
import type { ReactNode } from "react";
import { Box } from "ink";
import { describeDequeue, type QueueEntryView, type SessionQueue } from "@loom/core/message-queue";
import { Line, Panel, Text } from "./ui.tsx";
import { truncate, wrapText } from "./theme.ts";
import type { QueueText } from "./overlay.ts";

const GROUPS = [
  { delivery: "next_boundary", title: "Next tool boundary" },
  { delivery: "end_of_turn", title: "When the agent finishes" },
] as const;

const HOLDS: Record<NonNullable<SessionQueue["hold"]>, string> = {
  interrupt: "held after an interrupt",
  restart: "held after a daemon restart",
  crash: "held after the agent stopped unexpectedly",
  rejected: "held: a hand-over may not have arrived",
};

/** What an entry is doing, in a word or three. */
export const entryState = (e: QueueEntryView): string => {
  if (e.uncertain) return "uncertain";
  return e.state === "queued" ? "queued" : "handed over";
};

const rowTone = (e: QueueEntryView): "warn" | "text" | "dim" => {
  if (e.uncertain) return "warn";
  return e.state === "queued" ? "text" : "dim";
};

/** You, or the other client that queued it. */
export const entryAuthor = (e: QueueEntryView, clientId: string): string =>
  e.author === clientId ? "you" : "other client";

/** The rows, grouped, in dispatch order — what ↑↓ walks. */
export const queueRows = (queue: SessionQueue | undefined): QueueEntryView[] =>
  GROUPS.flatMap((g) => (queue?.entries ?? []).filter((e) => e.delivery === g.delivery));

export const QueueView = ({
  queue,
  selected,
  full,
  clientId,
  width,
  height,
}: {
  queue: SessionQueue | undefined;
  /** The overlay's selection; the first row when it names none still here. */
  selected: string | null;
  /** The selected entry's full text, once fetched. */
  full: QueueText | null;
  clientId: string;
  width: number;
  height: number;
}): ReactNode => {
  const rows = queueRows(queue);
  const current = rows.find((e) => e.id === selected) ?? rows[0] ?? null;
  const inner = Math.max(8, width - 6);
  const line = (text: string) => truncate(text.replace(/\s+/g, " ").trim(), inner);
  const title = `queue${queue?.hold ? ` — ${HOLDS[queue.hold]}` : ""}`;
  // The list takes what the selected entry's details leave.
  const fetched = current && full?.id === current.id && full.revision === current.revision;
  const text = fetched ? full.text : (current?.preview ?? "");
  const detail = current ? wrapText(text, inner).slice(0, Math.max(1, Math.floor(height / 3))) : [];
  const room = Math.max(1, height - detail.length - 10);
  const index = current ? rows.indexOf(current) : 0;
  const start = Math.max(0, index - room + 1);
  const shown = new Set(rows.slice(start, start + room).map((e) => e.id));
  return (
    <Panel width={width} tone={queue?.hold ? "warn" : "accent"} overlay title={title}>
      {rows.length === 0 ? (
        <Line tone="faint">No queued messages.</Line>
      ) : (
        GROUPS.map((g) => {
          const group = rows.filter((e) => e.delivery === g.delivery && shown.has(e.id));
          if (group.length === 0) return null;
          return (
            <Box key={g.delivery} flexDirection="column">
              <Line tone="dim" bold>
                {g.title}
              </Line>
              {group.map((e) => (
                <Line key={e.id} tone={rowTone(e)} inverse={e.id === current?.id}>
                  {line(`${entryState(e)} · ${entryAuthor(e, clientId)} · ${e.preview}`)}
                </Line>
              ))}
            </Box>
          );
        })
      )}
      {current && (
        <Box flexDirection="column" marginTop={1}>
          <Line tone="accentDim">
            {line(
              current.uncertain ? "may have reached the agent" : describeDequeue(current.dequeue),
            )}
          </Line>
          <Text tone="text">{detail.join("\n") || " "}</Text>
          {current.uncertain && (
            <Line tone="warn">
              {line(
                "Held work may have reached the agent. Review the chat before sending it again.",
              )}
            </Line>
          )}
        </Box>
      )}
    </Panel>
  );
};
