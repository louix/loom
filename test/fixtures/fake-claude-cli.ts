/** Real SDK transport fixture: no API calls or real credentials. */
import { readFrames } from "../../runtime/src/worker/transport.ts";

const emit = (v: unknown) =>
  Deno.stdout.writeSync(new TextEncoder().encode(JSON.stringify(v) + "\n"));
const profile = Deno.env.get("CLAUDE_CONFIG_DIR")!;
const argv = Deno.args;
const resumeAt = argv.indexOf("--resume");
const thread =
  argv.find((a) => a.startsWith("--resume="))?.slice("--resume=".length) ??
  (resumeAt >= 0 ? argv[resumeAt + 1]! : crypto.randomUUID());
const modelAt = argv.indexOf("--model");
let model = modelAt >= 0 ? argv[modelAt + 1]! : "fixture-model";
let initialized = false;
let initialization: Record<string, unknown> = {};
let turn = 0;
const pending = new Map<string, string>();
const native = new Deno.Command(Deno.execPath(), {
  args: ["eval", "setInterval(() => {}, 1000)"],
  stdin: "null",
  stdout: "inherit",
  stderr: "inherit",
}).spawn();
await Deno.writeTextFile(`${profile}/pids`, `${Deno.pid} ${native.pid}\n`, { append: true });

const reply = (text: string) => {
  if (!initialized) {
    emit({ type: "system", subtype: "init", session_id: thread, model });
    initialized = true;
  }
  const uuid = crypto.randomUUID();
  ++turn;
  const message = {
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    usage: { input_tokens: 10, output_tokens: 5 },
  };
  const transcript = `${profile}/projects/fixture`;
  Deno.mkdirSync(transcript, { recursive: true });
  Deno.writeTextFileSync(
    `${transcript}/${thread}.jsonl`,
    JSON.stringify({
      type: "assistant",
      sessionId: thread,
      uuid,
      parentUuid: null,
      cwd: Deno.cwd(),
      timestamp: new Date().toISOString(),
      isSidechain: false,
      message,
    }) + "\n",
    { append: true },
  );
  emit({ type: "assistant", uuid, session_id: thread, parent_tool_use_id: null, message });
  emit({
    type: "result",
    subtype: "success",
    session_id: thread,
    is_error: false,
    result: text,
    num_turns: turn,
    total_cost_usd: 0,
    modelUsage: { [model]: { inputTokens: 10, outputTokens: 5, contextWindow: 100000 } },
  });
  if (argv.includes("--max-turns")) Deno.exit(0);
};
for await (const raw of readFrames(Deno.stdin.readable, (v) => v as Record<string, any>)) {
  if (raw.type === "control_request") {
    const request = raw.request;
    let response: unknown = {};
    switch (request.subtype) {
      case "initialize":
        initialization = request;
        response = {
          models: [
            {
              value: "fixture-model",
              displayName: "Fixture model",
              supportsEffort: true,
              supportedEffortLevels: ["low", "high"],
            },
          ],
          commands: [],
          account: {},
        };
        break;
      case "set_model":
        model = request.model;
        break;
      case "get_usage":
        response = {
          rate_limits_available: true,
          rate_limits: { five_hour: { utilization: 12, resets_at: "2030-01-01T00:00:00Z" } },
        };
        break;
    }
    emit({
      type: "control_response",
      response: { subtype: "success", request_id: raw.request_id, response },
    });
  } else if (raw.type === "control_response") {
    const id = raw.response.request_id;
    const tool = pending.get(id);
    if (!tool) continue;
    pending.delete(id);
    if (tool === "mcp") {
      reply(JSON.stringify(raw.response.response));
      continue;
    }
    const decision = raw.response.response;
    if (tool === "Write" && decision?.behavior === "allow")
      await Deno.writeTextFile("worker-file.txt", "approved\n");
    reply(`decision:${decision?.behavior}`);
  } else if (raw.type === "user") {
    const content = raw.message.content;
    const text =
      typeof content === "string"
        ? content
        : content.map((b: { text?: string }) => b.text ?? "").join("");
    if (text === "crash") Deno.exit(19);
    if (text === "hold") continue;
    if (text.startsWith("/compact")) {
      if (text.includes("wait")) continue;
      emit({
        type: "system",
        subtype: "compact_boundary",
        session_id: thread,
        compact_metadata: { trigger: "manual", pre_tokens: 1000, post_tokens: 100 },
      });
      reply("compacted");
    } else if (text === "write" || text === "plan") {
      const id = crypto.randomUUID();
      const tool = text === "write" ? "Write" : "ExitPlanMode";
      pending.set(id, tool);
      emit({
        type: "control_request",
        request_id: id,
        request: {
          subtype: "can_use_tool",
          tool_name: tool,
          input:
            tool === "Write"
              ? { file_path: `${Deno.cwd()}/worker-file.txt`, content: "approved" }
              : { plan: "Fixture plan" },
          tool_use_id: id,
        },
      });
    } else if (text === "status" || text === "commit" || text === "question") {
      const id = crypto.randomUUID();
      pending.set(id, "mcp");
      const argumentsByTool = {
        question: { question: "Continue?" },
        commit: { message: "fixture commit" },
        status: {},
      };
      emit({
        type: "control_request",
        request_id: id,
        request: {
          subtype: "mcp_message",
          server_name: "loom",
          message: {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: text === "question" ? "ask_user" : text,
              arguments: argumentsByTool[text as keyof typeof argumentsByTool],
            },
          },
        },
      });
    } else if (text === "details") {
      reply(
        JSON.stringify({
          cwd: Deno.cwd(),
          profile,
          argv,
          initialization,
          inheritedSearchKey: Deno.env.get("KAGI_API_KEY") ?? null,
        }),
      );
    } else
      reply(text.startsWith("Title for this task") ? "A fixture session title" : `echo:${text}`);
  }
}
// Deliberately leave the grandchild alive. Loom must reap the worker group.
Deno.exit(0);
