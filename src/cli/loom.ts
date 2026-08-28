#!/usr/bin/env node
import { parseArgs } from "node:util";
import { findRepoRoot, loomPaths } from "../util/paths.ts";
import { LoomClient } from "../client/client.ts";
import type { PushFrame, SessionSnapshot } from "../protocol/wire.ts";
import type { HarnessEvent } from "../protocol/events.ts";
import { LOOM_VERSION } from "../version.ts";

const HELP = `loom ${LOOM_VERSION} — control the per-repo agent daemon

usage: loom [--repo <path>] <command> [args]

commands:
  status                 daemon health and counts
  ls                     list sessions in fleet-view order
  get <id>               one session's snapshot
  history <id>           status history for a session
  ping                   round-trip latency to the daemon
  tail                   stream the live event feed (Ctrl-C to stop)

  run <prompt...>        start a session   [--provider P] [--model M] [--mode default|plan|acceptEdits|auto]
  send <id> <text...>    send a follow-up turn / answer
  interrupt <id>         stop a session mid-turn
  approve <id> <reqId>   allow an outstanding permission request
  deny <id> <reqId>      deny it                          [--text reason]
  answer <id> <reqId> <text...>   answer an ask_user question
  mode <id> <mode>       change a session's permission mode
  resume <id>            resume an interrupted session
  done <id>              mark a session complete (worktree kept)
  gc                     remove worktrees for done sessions   [--id ONE] [--force]

  stub <prompt...>       create a placeholder session     [--status S] [--provider P] [--model M]
  set-status <id> <S>    drive a session's status         [--reason R]
  emit <id> <type>       inject a synthetic event         [--text T]
  stop                   shut the daemon down

The daemon starts automatically on first use.`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      status: { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      mode: { type: "string" },
      reason: { type: "string" },
      text: { type: "string" },
      id: { type: "string" },
      force: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
      version: { type: "boolean", default: false },
    },
  });

  if (values.version) return void process.stdout.write(`loom ${LOOM_VERSION}\n`);
  const cmd = positionals[0];
  if (values.help || !cmd) return void process.stdout.write(HELP + "\n");

  const repoRoot = values.repo ? values.repo : findRepoRoot();
  const { sock } = loomPaths(repoRoot);

  // `tail` is the only long-lived command and the only one wanting reconnect.
  const reconnect = cmd === "tail";
  const client = await LoomClient.connect({ repoRoot, sockPath: sock, reconnect });

  try {
    switch (cmd) {
      case "status": {
        const s = await client.request("daemon.status");
        process.stdout.write(JSON.stringify(s, null, 2) + "\n");
        break;
      }
      case "ls": {
        const rows = await client.request<SessionSnapshot[]>("session.list");
        if (values.json) process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
        else printSessions(rows);
        break;
      }
      case "get": {
        const id = need(positionals[1], "get <id>");
        const s = await client.request("session.get", { id });
        process.stdout.write(JSON.stringify(s, null, 2) + "\n");
        break;
      }
      case "history": {
        const id = need(positionals[1], "history <id>");
        const h = await client.request("session.history", { id });
        process.stdout.write(JSON.stringify(h, null, 2) + "\n");
        break;
      }
      case "run": {
        const prompt = positionals.slice(1).join(" ");
        if (!prompt) need(undefined, "run <prompt...>");
        const r = await client.request<SessionSnapshot>("session.create", {
          prompt,
          by: client.clientId,
          ...(values.provider ? { provider: values.provider } : {}),
          ...(values.model ? { model: values.model } : {}),
          ...(values.mode ? { mode: values.mode } : {}),
        });
        process.stdout.write(`started ${r.id}  provider=${r.provider}  status=${r.status}\n`);
        break;
      }
      case "send": {
        const id = need(positionals[1], "send <id> <text...>");
        const text = positionals.slice(2).join(" ");
        if (!text) need(undefined, "send <id> <text...>");
        const r = await client.request<SessionSnapshot>("session.send", { id, text });
        process.stdout.write(`${r.id} -> ${r.status}\n`);
        break;
      }
      case "interrupt": {
        const id = need(positionals[1], "interrupt <id>");
        const r = await client.request<SessionSnapshot>("session.interrupt", { id });
        process.stdout.write(`${r.id} -> ${r.status}\n`);
        break;
      }
      case "approve":
      case "deny": {
        const id = need(positionals[1], `${cmd} <id> <requestId>`);
        const requestId = need(positionals[2], `${cmd} <id> <requestId>`);
        const r = await client.request<{ ok: boolean; alreadyResolved: boolean }>(
          "session.respondPermission",
          {
            id,
            requestId,
            decision: cmd === "approve" ? "allow" : "deny",
            by: client.clientId,
            ...(cmd === "deny" && values.text ? { message: values.text } : {}),
          },
        );
        process.stdout.write(
          r.alreadyResolved ? `${requestId} was already resolved\n` : `${requestId} ${cmd}d\n`,
        );
        break;
      }
      case "answer": {
        const id = need(positionals[1], "answer <id> <requestId> <text...>");
        const requestId = need(positionals[2], "answer <id> <requestId> <text...>");
        const text = positionals.slice(3).join(" ");
        if (!text) need(undefined, "answer <id> <requestId> <text...>");
        const r = await client.request<{ ok: boolean; alreadyResolved: boolean }>("session.answer", {
          id,
          requestId,
          text,
          by: client.clientId,
        });
        process.stdout.write(
          r.alreadyResolved ? `${requestId} was already answered\n` : `${requestId} answered\n`,
        );
        break;
      }
      case "mode": {
        const id = need(positionals[1], "mode <id> <mode>");
        const mode = need(positionals[2], "mode <id> <mode>");
        const r = await client.request<SessionSnapshot>("session.setMode", { id, mode, by: client.clientId });
        process.stdout.write(`${r.id} mode -> ${r.mode}\n`);
        break;
      }
      case "resume": {
        const id = need(positionals[1], "resume <id>");
        const r = await client.request<SessionSnapshot>("session.resume", { id, by: client.clientId });
        process.stdout.write(`${r.id} -> ${r.status}\n`);
        break;
      }
      case "done": {
        const id = need(positionals[1], "done <id>");
        const r = await client.request<SessionSnapshot>("session.markDone", { id, by: client.clientId });
        process.stdout.write(`${r.id} -> ${r.status}\n`);
        break;
      }
      case "gc": {
        const r = await client.request<{ removed: string[]; failed: Array<{ id: string; error: string }> }>(
          "session.gc",
          { ...(values.id ? { id: values.id } : {}), ...(values.force ? { force: true } : {}) },
        );
        process.stdout.write(`removed ${r.removed.length} worktree(s)\n`);
        for (const f of r.failed) process.stderr.write(`  ${f.id.slice(0, 8)}: ${f.error}\n`);
        break;
      }
      case "ping": {
        const t0 = performance.now();
        const r = await client.request<{ uptimeMs: number }>("ping", { nonce: t0 });
        const rtt = (performance.now() - t0).toFixed(1);
        process.stdout.write(`pong  rtt=${rtt}ms  daemon-uptime=${(r.uptimeMs / 1000).toFixed(1)}s\n`);
        break;
      }
      case "stub": {
        const prompt = positionals.slice(1).join(" ");
        const r = await client.request<SessionSnapshot>("session.createStub", {
          prompt: prompt || null,
          ...(values.status ? { status: values.status } : {}),
          ...(values.provider ? { provider: values.provider } : {}),
          ...(values.model ? { model: values.model } : {}),
          ...(values.reason ? { reason: values.reason } : {}),
        });
        process.stdout.write(`created ${r.id}  status=${r.status}\n`);
        break;
      }
      case "set-status": {
        const id = need(positionals[1], "set-status <id> <status>");
        const status = need(positionals[2], "set-status <id> <status>");
        const r = await client.request<SessionSnapshot>("session.setStatus", {
          id,
          status,
          by: client.clientId,
          ...(values.reason ? { reason: values.reason } : {}),
        });
        process.stdout.write(`${r.id} -> ${r.status}${r.awaitReason ? ` (${r.awaitReason})` : ""}\n`);
        break;
      }
      case "emit": {
        const sessionId = need(positionals[1], "emit <id> <type>");
        const type = need(positionals[2], "emit <id> <type>");
        const event: Record<string, unknown> = { sessionId, type };
        if (values.text) event["text"] = values.text;
        const r = await client.request<{ seq: number }>("dev.emit", { event });
        process.stdout.write(`emitted seq=${r.seq}\n`);
        break;
      }
      case "tail": {
        await runTail(client);
        return; // runTail owns the lifetime
      }
      case "stop": {
        await client.request("daemon.shutdown");
        process.stdout.write("daemon shutting down\n");
        break;
      }
      default:
        process.stderr.write(`unknown command: ${cmd}\n\n${HELP}\n`);
        process.exitCode = 2;
    }
  } finally {
    if (cmd !== "tail") await client.close();
  }
}

function need(v: string | undefined, usage: string): string {
  if (!v) {
    process.stderr.write(`usage: loom ${usage}\n`);
    process.exit(2);
  }
  return v;
}

function printSessions(rows: SessionSnapshot[]): void {
  if (rows.length === 0) {
    process.stdout.write("(no sessions)\n");
    return;
  }
  let group = "";
  for (const s of rows) {
    if (s.status !== group) {
      group = s.status;
      process.stdout.write(`\n${group.toUpperCase()}\n`);
    }
    const id = s.id.slice(0, 8);
    const cost = s.costUsd ? `$${s.costUsd.toFixed(2)}` : "—";
    const title = s.title ? s.title.slice(0, 44) : "(untitled)";
    const reason = s.awaitReason ? ` · ${s.awaitReason}` : "";
    process.stdout.write(`  ${id}  ${s.provider.padEnd(7)} ${title.padEnd(46)} ${cost}${reason}\n`);
    const g = s.git;
    if (g) {
      const bits = [
        g.branch ?? s.branch ?? "(detached)",
        `${g.commits} commit${g.commits === 1 ? "" : "s"}`,
        g.aheadOfBase ? `+${g.aheadOfBase}` : null,
        g.behindBase ? `-${g.behindBase} behind base` : null,
        g.dirty ? "dirty" : "clean",
      ].filter(Boolean);
      process.stdout.write(`            ${bits.join(" · ")}\n`);
      if (g.lastCommitSubject) process.stdout.write(`            “${g.lastCommitSubject.slice(0, 60)}”\n`);
    }
  }
}

async function runTail(client: LoomClient): Promise<void> {
  process.stdout.write(`tailing ${client.daemonInfo?.repoRoot ?? "daemon"} — Ctrl-C to stop\n`);
  client.on("reconnect", (i) => process.stdout.write(`[reconnected @ seq ${(i as { lastSeq: number }).lastSeq}]\n`));
  client.on("resync", (i) => process.stdout.write(`[resync: ${(i as { reason: string }).reason}]\n`));
  client.on("close", () => {
    process.stdout.write("[connection closed]\n");
    process.exit(0);
  });
  client.onPush((f: PushFrame) => {
    if (f.type === "event") {
      const e = f.event;
      process.stdout.write(`#${f.seq} ${e.type.padEnd(16)} ${e.sessionId.slice(0, 8)} ${summarize(e)}\n`);
    } else if (f.type === "session_updated") {
      process.stdout.write(`#${f.seq} session_updated  ${f.session.id.slice(0, 8)} -> ${f.session.status} (v${f.version})\n`);
    } else if (f.type === "session_removed") {
      process.stdout.write(`#${f.seq} session_removed   ${f.sessionId.slice(0, 8)}\n`);
    }
  });
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      void client.close().then(resolve);
    });
  });
}

function summarize(ev: HarnessEvent): string {
  const e = ev as unknown as Record<string, unknown>;
  if (ev.type === "question") return `${JSON.stringify(ev.question.slice(0, 60))}  req=${ev.id}  (answer)`;
  if (ev.type === "answer") return `#${ev.id} ${JSON.stringify(ev.text.slice(0, 60))}`;
  if (typeof e["text"] === "string") return JSON.stringify((e["text"] as string).slice(0, 60));
  if (ev.type === "status_changed") return `${ev.status}${ev.reason ? ` (${ev.reason})` : ""}`;
  if (ev.type === "tool_call") return `${ev.name} #${ev.id}`;
  if (ev.type === "tool_result") return `#${ev.id} ${ev.ok ? "ok" : "error"}`;
  if (ev.type === "permission_request") return `${ev.tool}  req=${ev.id}  (approve/deny)`;
  if (ev.type === "usage") return `+${ev.tokens.input}in/+${ev.tokens.output}out  ctx ${ev.contextUsed}/${ev.contextLimit}`;
  if (ev.type === "result") return ev.ok ? "ok" : "failed";
  if (ev.type === "error") return ev.message.slice(0, 80);
  return "";
}

main().catch((err) => {
  const code = (err as { code?: string }).code;
  if (code === "ENOENT" || code === "ECONNREFUSED") {
    process.stderr.write("loom: could not reach the daemon (and autospawn failed)\n");
  } else {
    process.stderr.write(`loom: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  process.exit(1);
});
