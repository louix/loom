#!/usr/bin/env node
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { findRepoRoot, loomPaths } from "@loom/core/paths";
import { LoomClient } from "@loom/client";
import type { PushFrame, SessionSnapshot } from "@loom/core/wire";
import type { HarnessEvent } from "@loom/core/events";
import { LOOM_VERSION } from "@loom/core/version";

const HELP = `loom ${LOOM_VERSION} — control the per-repo agent daemon

usage: loom [--repo <path>] <command> [args]

commands:
  tui                    open the full-screen fleet UI (default with no command in a TTY)
  status                 daemon health and counts
  ls                     list sessions in fleet-view order
  get <id>               one session's snapshot
  history <id>           status history for a session
  providers              list configured providers
  models <provider>      list a provider's models (claude CLI catalog, or an aisdk /models probe)
  config                 lint the loaded config (exit 1 if there are warnings)
  ping                   round-trip latency to the daemon
  tail                   stream the live event feed (Ctrl-C to stop)

  run <prompt...>        start a session   [--provider P] [--model M] [--mode manual|plan|acceptEdits|auto]
                         [--in-place | --worktree]  override [worktree] enabled for this session
  send <id> <text...>    send a follow-up turn / answer
  compact <id> [text...] compact the context window (optional steer for the summary)
  interrupt <id>         stop a session mid-turn
  approve <id> <reqId>   allow an outstanding permission request
  deny <id> <reqId>      deny it                          [--text reason]
  answer <id> <reqId> <text...>   answer an ask_user question
  plan <id> <reqId> <what> [text...]  resolve a plan review
                         what: implement | fresh | revise <plan…> | discuss <msg…>
  mode <id> <mode>       change a session's permission mode
  resume <id>            resume an interrupted session
  done <id>              mark a session complete (worktree kept)
  rm <id>                delete a session for good (worktree + transcript)   [--delete-branch]
  gc                     remove worktrees for done sessions   [--id ONE] [--force]

  stub <prompt...>       create a placeholder session     [--status S] [--provider P] [--model M]
  set-status <id> <S>    drive a session's status         [--reason R]
  emit <id> <type>       inject a synthetic event         [--text T]
  stop                   shut the daemon down

The daemon starts automatically on first use.
Run 'loom <command> --help' for detail on one command.`;

/** Longer per-command help, shown by `loom <cmd> --help`. Commands not listed
 *  here fall back to the top-level HELP. */
const USAGE: Record<string, string> = {
  run: `loom run <prompt...>  — start a session

  --provider P                 provider id (see \`loom providers\`); default from config
  --model M                    model id; default from the provider
  --mode manual|plan|acceptEdits|auto
  --in-place                   work in the repo, no worktree (overrides [worktree] enabled)
  --worktree                   force an isolated worktree + branch
  --repo <path>                act on the daemon for another repo`,
  providers: `loom providers  — list configured providers

  one row per [providers.*] / [custom-provider.*] / [anthropic] / [google] table:
  "<id> [default]  <model>  (N models)". The model shown is what a new session
  gets without --model — the last one run on that provider, else a config pin,
  else the first auto-detected id.
  --json                       machine-readable`,
  models: `loom models <provider>  — list a provider's available models

  \`claude\` asks the Claude CLI for its catalog; openai-compatible providers
  ([custom-provider.*] and the built-in openai profile) are probed at
  {base_url}/models. Prints one model id per line.  --json for an array.`,
  config: `loom config  — lint the loaded config

  reports unset api_key_env vars, providers with no key, keyless search
  backends, and model auto-detection notes. Exit 1 if there are any warnings.`,
  send: `loom send <id> <text...>  — send a follow-up turn, or answer a question

  if the session is mid-turn the text is injected after the current tool call.`,
  plan: `loom plan <id> <reqId> <what> [text...]  — resolve a plan review

  what:
    implement                  proceed in the current context
    fresh                      compact to the plan + goal, then implement
    revise <plan...>           replace the plan and implement it
    discuss <msg...>           reply; the agent stays in plan mode`,
  gc: `loom gc  — remove worktrees for done sessions (branches kept)

  --id ONE                     just this session (may also target an error row)
  --force                      remove even a dirty worktree`,
  rm: `loom rm <id>  — delete a session for good

  closes any live run, removes the worktree (not the repo root for an in-place
  session), drops the row and its stored transcript. The branch is left unless:
  --delete-branch              also \`git branch -D\` the session's branch`,
};

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
      "in-place": { type: "boolean", default: false },
      worktree: { type: "boolean", default: false },
      "delete-branch": { type: "boolean", default: false },
    },
  });

  if (values.version) return void process.stdout.write(`loom ${LOOM_VERSION}\n`);
  const cmd = positionals[0];
  if (values.help) {
    return void process.stdout.write((cmd && USAGE[cmd] ? USAGE[cmd] : HELP) + "\n");
  }

  const isTty = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  const wantTui = cmd === "tui" || (!cmd && isTty);
  if (!cmd && !wantTui) return void process.stdout.write(HELP + "\n");
  if (cmd === "tui" && !isTty) {
    process.stderr.write("loom tui needs an interactive terminal (stdin/stdout must be a TTY)\n");
    process.exitCode = 2;
    return;
  }

  const repoRoot = values.repo ? values.repo : findRepoRoot();
  const { sock } = loomPaths(repoRoot);

  // `tail` and the TUI are the long-lived commands that want reconnect; the TUI
  // also replays the daemon's buffered history so re-opening it isn't a blank log.
  const reconnect = cmd === "tail" || wantTui;
  const client = await LoomClient.connect({
    repoRoot,
    sockPath: sock,
    daemonEntry: fileURLToPath(new URL("./loomd.ts", import.meta.url)),
    reconnect,
    ...(wantTui ? { replayHistory: true } : {}),
  });

  if (wantTui) {
    const { runTui } = await import("@loom/tui/run");
    await runTui(client);
    return;
  }

  try {
    // `loom ls` prints 8-char ids; every id-taking command accepts a unique
    // prefix and expands it to the full session id here.
    if (cmd && ID_CMDS.has(cmd) && positionals[1]) {
      positionals[1] = await resolveSid(client, positionals[1]);
    }

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
      case "providers": {
        const rows = await client.request<
          Array<{
            id: string;
            models: string[];
            defaultModel: string;
            color: string;
            isDefault: boolean;
          }>
        >("providers.list");
        if (values.json) process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
        else
          for (const p of rows)
            process.stdout.write(
              `  ${p.id}${p.isDefault ? " [default]" : ""}` +
                `${p.defaultModel ? `  ${p.defaultModel}` : ""}` +
                `${p.models.length ? `  (${p.models.length} models)` : ""}\n`,
            );
        break;
      }
      case "models": {
        const id = need(positionals[1], "models <provider>");
        const r = await client.request<{ models: string[] }>("providers.probeModels", { id });
        if (values.json) process.stdout.write(JSON.stringify(r.models, null, 2) + "\n");
        else process.stdout.write(r.models.join("\n") + "\n");
        break;
      }
      case "config": {
        const r = await client.request<{ warnings: string[] }>("config.check");
        if (values.json) process.stdout.write(JSON.stringify(r, null, 2) + "\n");
        else if (r.warnings.length === 0) process.stdout.write("config looks good\n");
        else {
          process.stdout.write(
            `${r.warnings.length} warning${r.warnings.length === 1 ? "" : "s"}:\n`,
          );
          for (const line of r.warnings) process.stdout.write(`  ! ${line}\n`);
          process.exitCode = 1;
        }
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
        if (values["in-place"] && values.worktree) {
          need(undefined, "run: --in-place and --worktree are mutually exclusive");
        }
        const worktree = values.worktree ? true : values["in-place"] ? false : undefined;
        const r = await client.request<SessionSnapshot>("session.create", {
          prompt,
          by: client.clientId,
          ...(values.provider ? { provider: values.provider } : {}),
          ...(values.model ? { model: values.model } : {}),
          ...(values.mode ? { mode: values.mode } : {}),
          ...(worktree !== undefined ? { worktree } : {}),
        });
        const where = r.inPlace ? "  in-place" : "";
        process.stdout.write(
          `started ${r.id}  provider=${r.provider}  status=${r.status}${where}\n`,
        );
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
      case "compact": {
        const id = need(positionals[1], "compact <id> [text...]");
        const instructions = positionals.slice(2).join(" ");
        const r = await client.request<SessionSnapshot>("session.compact", {
          id,
          ...(instructions ? { instructions } : {}),
        });
        process.stdout.write(`${r.id} compacting (ctx ${r.contextUsed}/${r.contextLimit})\n`);
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
        const r = await client.request<{ ok: boolean; alreadyResolved: boolean }>(
          "session.answer",
          {
            id,
            requestId,
            text,
            by: client.clientId,
          },
        );
        process.stdout.write(
          r.alreadyResolved ? `${requestId} was already answered\n` : `${requestId} answered\n`,
        );
        break;
      }
      case "plan": {
        const id = need(positionals[1], "plan <id> <reqId> <what> [text...]");
        const reqId = need(positionals[2], "plan <id> <reqId> <what> [text...]");
        const what = need(positionals[3], "plan <id> <reqId> <what> [text...]");
        const rest = positionals.slice(4).join(" ");
        const params: Record<string, unknown> = { id, requestId: reqId, by: client.clientId };
        if (what === "implement") params["action"] = "implement";
        else if (what === "fresh") params["action"] = "implement_fresh";
        else if (what === "revise") {
          if (!rest) need(undefined, "plan <id> <reqId> revise <plan...>");
          params["action"] = "revise";
          params["plan"] = rest;
        } else if (what === "discuss") {
          if (!rest) need(undefined, "plan <id> <reqId> discuss <msg...>");
          params["action"] = "discuss";
          params["message"] = rest;
        } else {
          need(undefined, "plan <what> must be implement | fresh | revise | discuss");
        }
        const r = await client.request<{ alreadyResolved: boolean }>("session.respondPlan", params);
        process.stdout.write(
          r.alreadyResolved ? `${reqId} was already resolved\n` : `${reqId} ${what}\n`,
        );
        break;
      }
      case "mode": {
        const id = need(positionals[1], "mode <id> <mode>");
        const mode = need(positionals[2], "mode <id> <mode>");
        const r = await client.request<SessionSnapshot>("session.setMode", {
          id,
          mode,
          by: client.clientId,
        });
        process.stdout.write(`${r.id} mode -> ${r.mode}\n`);
        break;
      }
      case "resume": {
        const id = need(positionals[1], "resume <id>");
        const r = await client.request<SessionSnapshot>("session.resume", {
          id,
          by: client.clientId,
        });
        process.stdout.write(`${r.id} -> ${r.status}\n`);
        break;
      }
      case "done": {
        const id = need(positionals[1], "done <id>");
        const r = await client.request<SessionSnapshot>("session.markDone", {
          id,
          by: client.clientId,
        });
        process.stdout.write(`${r.id} -> ${r.status}\n`);
        break;
      }
      case "rm": {
        const id = need(positionals[1], "rm <id>");
        const r = await client.request<{ removed: string; branchDeleted?: boolean }>(
          "session.remove",
          {
            id,
            by: client.clientId,
            ...(values["delete-branch"] ? { deleteBranch: true } : {}),
          },
        );
        process.stdout.write(
          `removed ${r.removed.slice(0, 8)}${r.branchDeleted ? " + branch" : ""}\n`,
        );
        break;
      }
      case "gc": {
        const r = await client.request<{
          removed: string[];
          failed: Array<{ id: string; error: string }>;
        }>("session.gc", {
          ...(values.id ? { id: values.id } : {}),
          ...(values.force ? { force: true } : {}),
        });
        process.stdout.write(`removed ${r.removed.length} worktree(s)\n`);
        for (const f of r.failed) process.stderr.write(`  ${f.id.slice(0, 8)}: ${f.error}\n`);
        break;
      }
      case "ping": {
        const t0 = performance.now();
        const r = await client.request<{ uptimeMs: number }>("ping", { nonce: t0 });
        const rtt = (performance.now() - t0).toFixed(1);
        process.stdout.write(
          `pong  rtt=${rtt}ms  daemon-uptime=${(r.uptimeMs / 1000).toFixed(1)}s\n`,
        );
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
        process.stdout.write(
          `${r.id} -> ${r.status}${r.awaitReason ? ` (${r.awaitReason})` : ""}\n`,
        );
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

const ID_CMDS = new Set([
  "get",
  "history",
  "send",
  "compact",
  "interrupt",
  "approve",
  "deny",
  "answer",
  "plan",
  "mode",
  "resume",
  "done",
  "rm",
  "set-status",
  "emit",
]);

/** Expand a unique session-id prefix (as printed by `loom ls`) to the full id. */
async function resolveSid(client: LoomClient, raw: string): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(raw)) return raw; // already a full uuid
  const sessions = await client.request<SessionSnapshot[]>("session.list");
  const hits = sessions.filter((s) => s.id.startsWith(raw));
  if (hits.length === 1) return hits[0]!.id;
  if (hits.length === 0) throw new Error(`no session id starts with "${raw}"`);
  throw new Error(`"${raw}" is ambiguous — matches ${hits.length} sessions`);
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
      if (g.lastCommitSubject)
        process.stdout.write(`            “${g.lastCommitSubject.slice(0, 60)}”\n`);
    }
  }
}

async function runTail(client: LoomClient): Promise<void> {
  process.stdout.write(`tailing ${client.daemonInfo?.repoRoot ?? "daemon"} — Ctrl-C to stop\n`);
  client.on("reconnect", (i) =>
    process.stdout.write(`[reconnected @ seq ${(i as { lastSeq: number }).lastSeq}]\n`),
  );
  client.on("resync", (i) =>
    process.stdout.write(`[resync: ${(i as { reason: string }).reason}]\n`),
  );
  client.on("close", () => {
    process.stdout.write("[connection closed]\n");
    process.exit(0);
  });
  client.onPush((f: PushFrame) => {
    if (f.type === "event") {
      const e = f.event;
      process.stdout.write(
        `#${f.seq} ${e.type.padEnd(16)} ${e.sessionId.slice(0, 8)} ${summarize(e)}\n`,
      );
    } else if (f.type === "session_updated") {
      process.stdout.write(
        `#${f.seq} session_updated  ${f.session.id.slice(0, 8)} -> ${f.session.status} (v${f.version})\n`,
      );
    } else if (f.type === "session_removed") {
      process.stdout.write(`#${f.seq} session_removed   ${f.sessionId.slice(0, 8)}\n`);
    } else if (f.type === "notice") {
      process.stdout.write(`#${f.seq} notice           ${f.tone}: ${f.text}\n`);
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
  if (ev.type === "question")
    return `${JSON.stringify(ev.question.slice(0, 60))}  req=${ev.id}  (answer)`;
  if (ev.type === "answer") return `#${ev.id} ${JSON.stringify(ev.text.slice(0, 60))}`;
  if (typeof e["text"] === "string") return JSON.stringify((e["text"] as string).slice(0, 60));
  if (ev.type === "status_changed") return `${ev.status}${ev.reason ? ` (${ev.reason})` : ""}`;
  if (ev.type === "tool_call") return `${ev.name} #${ev.id}`;
  if (ev.type === "tool_result") return `#${ev.id} ${ev.ok ? "ok" : "error"}`;
  if (ev.type === "permission_request") return `${ev.tool}  req=${ev.id}  (approve/deny)`;
  if (ev.type === "plan_review")
    return `plan  req=${ev.id}  (plan <id> ${ev.id} implement|fresh|revise|discuss)`;
  if (ev.type === "usage")
    return `+${ev.tokens.input}in/+${ev.tokens.output}out  ctx ${ev.contextUsed}/${ev.contextLimit}`;
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
