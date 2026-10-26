import type { BackgroundTaskInfo, HarnessEvent } from "@loom/core/events";
import { createHash } from "node:crypto";

type RecordValue = Record<string, unknown>;
const record = (v: unknown): RecordValue | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as RecordValue) : undefined;

const outputText = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (Array.isArray(v))
    return v
      .flatMap((c) => {
        const item = record(c);
        return item?.type === "input_text" && typeof item.text === "string" ? [item.text] : [];
      })
      .join("\n");
  return "";
};

interface Call {
  name: "exec" | "wait";
  input: string;
  cell?: string;
}
interface Cell {
  task: BackgroundTaskInfo;
}

/**
 * Code Mode's outer exec/wait calls have no ThreadItem in Codex 0.160.
 * Only these raw calls are handled here: inner MCP/dynamic tools retain their
 * existing dispatch owner. Cell membership is LAST OBSERVED, not a scheduler
 * or a liveness probe. Only a correlated runtime result may end a cell.
 */
export class CodeCells {
  readonly #calls = new Map<string, Call>();
  readonly #results = new Map<string, string>();
  readonly #cells = new Map<string, Cell>();

  readonly sessionId: string;
  readonly emit: (event: HarnessEvent) => void;

  constructor(sessionId: string, emit: (event: HarnessEvent) => void) {
    this.sessionId = sessionId;
    this.emit = emit;
  }

  accept(value: unknown, ts: number): void {
    const item = record(value);
    if (!item || typeof item.call_id !== "string") return;
    const id = item.call_id;
    const type = item.type;
    if (type === "custom_tool_call" || type === "function_call") {
      const name = item.name;
      if (name !== "exec" && name !== "wait") return;
      if (item.namespace !== undefined && item.namespace !== "functions") return;
      if (this.#calls.has(id)) return;
      const input = type === "custom_tool_call" ? item.input : item.arguments;
      if (typeof input !== "string") return;
      const call: Call = { name, input };
      if (name === "wait") {
        try {
          const args = record(JSON.parse(input));
          if (typeof args?.cell_id === "string") call.cell = args.cell_id;
        } catch {
          /* The failed invocation still belongs in history. */
        }
      }
      this.#calls.set(id, call);
      // Bound history needed to correlate duplicate RPC/file observations.
      if (this.#calls.size > 2048) {
        const oldest = this.#calls.keys().next().value!;
        this.#calls.delete(oldest);
        this.#results.delete(oldest);
      }
      this.emit({ type: "tool_call", sessionId: this.sessionId, ts, id, name, input });
      return;
    }
    if (type !== "custom_tool_call_output" && type !== "function_call_output") return;
    const call = this.#calls.get(id);
    if (!call) return;
    const output = outputText(item.output);
    const digest = createHash("sha256").update(output).digest("hex");
    if (this.#results.get(id) === digest) return;
    this.#results.set(id, digest);
    // Read only the runtime's first line, never user-script output further down.
    const header = output.split("\n", 1)[0] ?? "";
    const running = /^Script running with cell ID (\S+)$/.exec(header)?.[1];
    const ended = /^Script (completed|failed|terminated)(?:\b|$)/.exec(header)?.[1];
    this.emit({
      type: "tool_result",
      sessionId: this.sessionId,
      ts,
      id,
      ok: ended !== "failed" && !/^Error\b/.test(header),
      output,
    });
    const cellId = running ?? call.cell;
    if (!cellId) return;
    if (running) {
      call.cell = running;
      if (!this.#cells.has(running)) {
        const task: BackgroundTaskInfo = {
          id: `codex-cell:${running}`,
          kind: "other",
          title: `Code cell ${running} · last reported running`,
          outputSource: "events",
        };
        this.#cells.set(running, { task });
        this.#membership(ts);
        this.#notice(
          task.id,
          ts,
          `Code cell ${running}\nStarted/first observed: ${new Date(ts).toISOString()}\n` +
            "Status is based on exec/wait results; there is no live cell status or cancel API.\n\n" +
            `${call.name}\n${call.input}`,
        );
      }
    }
    const cell = this.#cells.get(cellId);
    if (!cell) return;
    this.#notice(cell.task.id, ts, output);
    if (ended && !running) {
      this.#cells.delete(cellId);
      let status: "completed" | "failed" | "stopped" = "completed";
      if (ended === "failed") status = "failed";
      if (ended === "terminated") status = "stopped";
      this.emit({
        type: "background_task_ended",
        sessionId: this.sessionId,
        ts,
        taskId: cell.task.id,
        kind: cell.task.kind,
        title: cell.task.title,
        status,
      });
      this.#membership(ts);
    }
  }

  close(ts: number): void {
    for (const { task } of this.#cells.values())
      this.#notice(task.id, ts, "Provider connection closed; cell status is no longer available.");
    if (this.#cells.size) {
      this.#cells.clear();
      this.#membership(ts);
    }
    this.#calls.clear();
    this.#results.clear();
  }

  #membership(ts: number): void {
    this.emit({
      type: "background_tasks",
      sessionId: this.sessionId,
      ts,
      tasks: [...this.#cells.values()].map(({ task }) => task),
    });
  }

  #notice(agentId: string, ts: number, message: string): void {
    this.emit({ type: "notice", sessionId: this.sessionId, agentId, ts, level: "info", message });
  }
}
