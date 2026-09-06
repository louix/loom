#!/usr/bin/env -S deno run -A
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { ensureLoomDir, findRepoRoot, loomPaths } from "@loom/core/paths";
import { setLogFile, setLogStderr } from "@loom/core/logger";
import { LoomClient, showConnectionError, type ConnectionError } from "@loom/client";
import { cacheHitRate } from "@loom/core/cache";
import { foldLoadable } from "@loom/core/loadable";
import type { DaemonSnapshot, ModelUsage, PushFrame, SessionSnapshot } from "@loom/core/wire";
import type { HarnessEvent } from "@loom/core/events";
import { isLiveState, sessionStateLabel } from "@loom/core/session-state";
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
  cache [id]             prompt-cache hit rate + observed TTL, per provider/model
  config                 lint the loaded config (exit 1 if there are warnings)
  relink-provider <old> <new>  repoint sessions stuck on a renamed/removed provider id
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
  done <id>              archive a session: stop it, drop its worktree, keep the branch + chat   [--force]
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

  \`claude\` asks the Claude CLI for its catalog; \`chatgpt\` asks Codex's
  authenticated subscription catalog; openai-compatible providers
  ([custom-provider.*] and the built-in openai profile) are probed at
  {base_url}/models. Prints one model id per line.  --json for an array.`,
  cache: `loom cache [id]  — prompt-cache effectiveness per provider/model

  one row per provider+model that has spent tokens: the share of prompt tokens
  served from cache, the read/write split behind it, the prompt-cache TTL the
  provider was last observed writing at ("-" if it never reported one), and the
  longest idle gap it has still been seen hitting after ("≥Nm warm").
  That gap is a lower bound, not a TTL: a hit proves the entry survived it,
  while a miss may be expiry or may be prefix invalidation, so misses are not
  counted. For endpoints that report no TTL it is the only lifetime signal.
  With an id, only that session's models. Low hit rate on a long session means
  something is invalidating the prefix between turns.
  --json                       machine-readable`,
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
    discuss <msg...>           reply; the agent stays in plan mode

  --mode manual|acceptEdits|auto  the permission mode the implementation runs
                                  in (implement / fresh / revise only)`,
  done: `loom done <id>  — archive a session

  stops the run and removes its worktree, so in git the branch just looks like
  any other branch. The row, the branch, and the stored transcript are kept —
  \`loom send <id>\` later checks the branch back out into a fresh worktree and
  resumes. The branch has to be clean unless:
  --force                      archive even a dirty worktree (discards changes)`,
  gc: `loom gc  — remove worktrees for done sessions (branches kept)

  --id ONE                     just this session (may also target an error row)
  --force                      remove even a dirty worktree`,
  rm: `loom rm <id>  — delete a session for good

  closes any live run, removes the worktree (not the repo root for an in-place
  session), drops the row and its stored transcript. The branch is left unless:
  --delete-branch              also \`git branch -D\` the session's branch`,
};

const encoder = new TextEncoder();

// `loom tail | head` (or any consumer that closes early) makes a later write
// throw BrokenPipe — exit cleanly there, not with a stack trace. Unlike
// Node's stdout, Deno.stdout has no async 'error' event to intercept once for
// every write; each write site checks for itself.
const writeOut = (s: string): void => {
  try {
    Deno.stdout.writeSync(encoder.encode(s));
  } catch (err) {
    if (err instanceof Deno.errors.BrokenPipe) Deno.exit(0);
    throw err;
  }
};
const writeErr = (s: string): void => {
  try {
    Deno.stderr.writeSync(encoder.encode(s));
  } catch (err) {
    if (err instanceof Deno.errors.BrokenPipe) Deno.exit(0);
    throw err;
  }
};

const main = async (): Promise<void> => {
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

  if (values.version) return void writeOut(`loom ${LOOM_VERSION}\n`);
  const cmd = positionals[0];
  if (values.help) {
    return void writeOut((cmd && USAGE[cmd] ? USAGE[cmd] : HELP) + "\n");
  }

  const isTty = Deno.stdout.isTerminal() && Deno.stdin.isTerminal();
  const wantTui = cmd === "tui" || (!cmd && isTty);
  if (!cmd && !wantTui) return void writeOut(HELP + "\n");
  if (cmd === "tui" && !isTty) {
    writeErr("loom tui needs an interactive terminal (stdin/stdout must be a TTY)\n");
    Deno.exitCode = 2;
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
    // React (via Ink) chooses its dev or prod build off NODE_ENV when it's first
    // imported. The dev build records a `performance.measure()` entry on every
    // commit for the DevTools render track, and Node keeps every PerformanceEntry
    // for the life of the process — so a long-lived TUI rendering many times a
    // second grows the timeline without bound until it OOMs. Pin the prod build
    // unless a developer has asked for dev explicitly. Must run before the import
    // below, which is the first thing to pull in React.
    if (!Deno.env.get("NODE_ENV")) Deno.env.set("NODE_ENV", "production");

    // The TUI owns the screen, so its logs go to a file only — a fresh
    // <repo>/.loom/tui.log per launch, in the daemon's own .loom/ so both logs
    // sit together. Never stderr: a stray line would corrupt the frame.
    const logRoot = client.daemonInfo?.repoRoot ?? repoRoot;
    const paths = loomPaths(logRoot);
    ensureLoomDir(paths);
    try {
      writeFileSync(paths.tuiLog, "");
    } catch {
      /* best effort — logging must never block the UI */
    }
    setLogStderr(false);
    setLogFile(paths.tuiLog);

    const { runTui } = await import("@loom/tui/run");
    await runTui(client, {
      logs: { daemon: paths.log, tui: paths.tuiLog },
      themeState: paths.tuiState,
    });
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
        writeOut(JSON.stringify(s, null, 2) + "\n");
        break;
      }
      case "ls": {
        const rows = await client.request<SessionSnapshot[]>("session.list");
        if (values.json) writeOut(JSON.stringify(rows, null, 2) + "\n");
        else printSessions(rows);
        break;
      }
      case "get": {
        const id = need(positionals[1], "get <id>");
        const s = await client.request("session.get", { id });
        writeOut(JSON.stringify(s, null, 2) + "\n");
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
            account?: { loginMethod: string; org: string };
          }>
        >("providers.list");
        if (values.json) writeOut(JSON.stringify(rows, null, 2) + "\n");
        else
          for (const p of rows) {
            const acct = p.account
              ? [p.account.loginMethod, p.account.org ? `(${p.account.org})` : ""]
                  .filter(Boolean)
                  .join(" ")
              : "";
            writeOut(
              `  ${p.id}${p.isDefault ? " [default]" : ""}` +
                `${p.defaultModel ? `  ${p.defaultModel}` : ""}` +
                `${p.models.length ? `  (${p.models.length} models)` : ""}` +
                `${acct ? `  ${acct}` : ""}\n`,
            );
          }
        break;
      }
      case "models": {
        const id = need(positionals[1], "models <provider>");
        const r = await client.request<{ models: string[] }>("providers.probeModels", { id });
        if (values.json) writeOut(JSON.stringify(r.models, null, 2) + "\n");
        else writeOut(r.models.join("\n") + "\n");
        break;
      }
      case "cache": {
        const id = positionals[1];
        const r = await client.request<{ models: ModelUsage[] }>("stats.models", id ? { id } : {});
        if (values.json) {
          writeOut(JSON.stringify(r.models, null, 2) + "\n");
          break;
        }
        if (r.models.length === 0) {
          writeOut("no token spend recorded yet\n");
          break;
        }
        const pad = Math.max(...r.models.map((m) => `${m.provider}/${m.model}`.length));
        for (const m of r.models) {
          const rate = cacheHitRate(m);
          // Two different lifetimes, and they mean different things: `ttl` is
          // what the provider said it wrote (exact, Anthropic only), `≥` is the
          // longest idle gap we've seen it still hit after (a lower bound, and
          // the only signal for endpoints that report no TTL).
          const ttl = m.ttlMinutes > 0 ? `${m.ttlMinutes}m ttl` : "- ttl";
          const seen = m.maxHitGapSec > 0 ? `  ≥${Math.round(m.maxHitGapSec / 60)}m warm` : "";
          writeOut(
            `${`${m.provider}/${m.model}`.padEnd(pad)}  ` +
              `${(rate == null ? "n/a" : `${Math.round(rate * 100)}%`).padStart(4)} cached  ` +
              `${String(m.cacheRead).padStart(9)} cr  ${String(m.cacheWrite).padStart(9)} cw  ` +
              `${String(m.input).padStart(9)} in  ${ttl}${seen}\n`,
          );
        }
        break;
      }
      case "config": {
        const r = await client.request<{ warnings: string[] }>("config.check");
        if (values.json) writeOut(JSON.stringify(r, null, 2) + "\n");
        else if (r.warnings.length === 0) writeOut("config looks good\n");
        else {
          writeOut(`${r.warnings.length} warning${r.warnings.length === 1 ? "" : "s"}:\n`);
          for (const line of r.warnings) writeOut(`  ! ${line}\n`);
          Deno.exitCode = 1;
        }
        break;
      }
      case "relink-provider": {
        const from = need(positionals[1], "relink-provider <old-id> <new-id>");
        const to = need(positionals[2], "relink-provider <old-id> <new-id>");
        const r = await client.request<{ relinked: number }>("daemon.relinkProvider", { from, to });
        process.stdout.write(`relinked ${r.relinked} session(s) from "${from}" to "${to}"\n`);
        break;
      }
      case "history": {
        const id = need(positionals[1], "history <id>");
        const h = await client.request("session.history", { id });
        writeOut(JSON.stringify(h, null, 2) + "\n");
        break;
      }
      case "run": {
        const prompt = positionals.slice(1).join(" ");
        if (!prompt) need(undefined, "run <prompt...>");
        if (values["in-place"] && values.worktree) {
          need(undefined, "run: --in-place and --worktree are mutually exclusive");
        }
        let worktree: boolean | undefined;
        if (values.worktree) worktree = true;
        else if (values["in-place"]) worktree = false;
        const r = await client.request<SessionSnapshot>("session.create", {
          prompt,
          by: client.clientId,
          ...(values.provider ? { provider: values.provider } : {}),
          ...(values.model ? { model: values.model } : {}),
          ...(values.mode ? { mode: values.mode } : {}),
          ...(worktree !== undefined ? { worktree } : {}),
        });
        const where = r.inPlace ? "  in-place" : "";
        writeOut(`started ${r.id}  provider=${r.provider}  status=${r.status}${where}\n`);
        break;
      }
      case "send": {
        const id = need(positionals[1], "send <id> <text...>");
        const text = positionals.slice(2).join(" ");
        if (!text) need(undefined, "send <id> <text...>");
        const r = await client.request<SessionSnapshot>("session.send", { id, text });
        writeOut(`${r.id} -> ${r.status}\n`);
        break;
      }
      case "interrupt": {
        const id = need(positionals[1], "interrupt <id>");
        const r = await client.request<SessionSnapshot>("session.interrupt", { id });
        writeOut(`${r.id} -> ${r.status}\n`);
        break;
      }
      case "compact": {
        const id = need(positionals[1], "compact <id> [text...]");
        const instructions = positionals.slice(2).join(" ");
        const r = await client.request<SessionSnapshot>("session.compact", {
          id,
          ...(instructions ? { instructions } : {}),
        });
        writeOut(`${r.id} compacting (ctx ${r.contextUsed}/${r.contextLimit})\n`);
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
        writeOut(
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
        writeOut(
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
        // The permission mode the implementation runs in (ignored by discuss).
        if (values.mode) params["mode"] = values.mode;
        const r = await client.request<{ alreadyResolved: boolean }>("session.respondPlan", params);
        writeOut(r.alreadyResolved ? `${reqId} was already resolved\n` : `${reqId} ${what}\n`);
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
        writeOut(`${r.id} mode -> ${r.mode}\n`);
        break;
      }
      case "resume": {
        const id = need(positionals[1], "resume <id>");
        const r = await client.request<SessionSnapshot>("session.resume", {
          id,
          by: client.clientId,
        });
        writeOut(`${r.id} -> ${r.status}\n`);
        break;
      }
      case "done": {
        const id = need(positionals[1], "done <id>");
        const r = await client.request<SessionSnapshot>("session.markDone", {
          id,
          by: client.clientId,
          ...(values.force ? { force: true } : {}),
        });
        writeOut(`${r.id} -> ${r.status}\n`);
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
            ...(values["force"] ? { force: true } : {}),
          },
        );
        writeOut(`removed ${r.removed.slice(0, 8)}${r.branchDeleted ? " + branch" : ""}\n`);
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
        writeOut(`removed ${r.removed.length} worktree(s)\n`);
        for (const f of r.failed) writeErr(`  ${f.id.slice(0, 8)}: ${f.error}\n`);
        break;
      }
      case "ping": {
        const t0 = performance.now();
        const r = await client.request<{ uptimeMs: number }>("ping", { nonce: t0 });
        const rtt = (performance.now() - t0).toFixed(1);
        writeOut(`pong  rtt=${rtt}ms  daemon-uptime=${(r.uptimeMs / 1000).toFixed(1)}s\n`);
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
        writeOut(`created ${r.id}  status=${r.status}\n`);
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
        writeOut(`${r.id} -> ${sessionStateLabel(r.status)}\n`);
        break;
      }
      case "emit": {
        const sessionId = need(positionals[1], "emit <id> <type>");
        const type = need(positionals[2], "emit <id> <type>");
        const event: Record<string, unknown> = { sessionId, type };
        if (values.text) event["text"] = values.text;
        const r = await client.request<{ seq: number }>("dev.emit", { event });
        writeOut(`emitted seq=${r.seq}\n`);
        break;
      }
      case "tail": {
        await runTail(client);
        return; // runTail owns the lifetime
      }
      case "stop": {
        await client.request("daemon.shutdown");
        writeOut("daemon shutting down\n");
        break;
      }
      default:
        writeErr(`unknown command: ${cmd}\n\n${HELP}\n`);
        Deno.exitCode = 2;
    }
  } finally {
    if (cmd !== "tail") await client.close();
  }
};

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
const resolveSid = async (client: LoomClient, raw: string): Promise<string> => {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(raw)) return raw; // already a full uuid
  const sessions = await client.request<SessionSnapshot[]>("session.list");
  const hits = sessions.filter((s) => s.id.startsWith(raw));
  if (hits.length === 1) return hits[0]!.id;
  if (hits.length === 0) throw new Error(`no session id starts with "${raw}"`);
  throw new Error(`"${raw}" is ambiguous — matches ${hits.length} sessions`);
};

const need = (v: string | undefined, usage: string): string => {
  if (!v) {
    writeErr(`usage: loom ${usage}\n`);
    Deno.exit(2);
  }
  return v;
};

const printSessions = (rows: SessionSnapshot[]): void => {
  if (rows.length === 0) {
    writeOut("(no sessions)\n");
    return;
  }
  let group = "";
  for (const s of rows) {
    if (s.status.kind !== group) {
      group = s.status.kind;
      writeOut(`\n${group.toUpperCase()}\n`);
    }
    const id = s.id.slice(0, 8);
    const cost = s.costUsd ? `$${s.costUsd.toFixed(2)}` : "—";
    const title = s.title ? s.title.slice(0, 44) : "(untitled)";
    const reason = s.status.kind === "awaiting_input" ? ` · ${s.status.on}` : "";
    writeOut(`  ${id}  ${s.provider.padEnd(7)} ${title.padEnd(46)} ${cost}${reason}\n`);
    const g = s.git;
    if (g) {
      const bits = [
        g.branch ?? s.branch ?? "(detached)",
        `${g.commits} commit${g.commits === 1 ? "" : "s"}`,
        g.aheadOfBase ? `+${g.aheadOfBase}` : null,
        g.behindBase ? `-${g.behindBase} behind base` : null,
        g.dirty ? "dirty" : "clean",
      ].filter(Boolean);
      writeOut(`            ${bits.join(" · ")}\n`);
      if (g.lastCommitSubject) writeOut(`            “${g.lastCommitSubject.slice(0, 60)}”\n`);
    }
  }
};

const runTail = async (client: LoomClient): Promise<void> => {
  writeOut(`tailing ${client.daemonInfo?.repoRoot ?? "daemon"} — Ctrl-C to stop\n`);
  client.on("reconnect", (i) =>
    writeOut(`[reconnected @ seq ${(i as { lastSeq: number }).lastSeq}]\n`),
  );
  client.on("resync", (i) => writeOut(`[resync: ${(i as { reason: string }).reason}]\n`));
  client.on("close", () => {
    writeOut("[connection closed]\n");
    Deno.exit(0);
  });
  client.onPush((f: PushFrame) => {
    if (f.type === "event") {
      const e = f.event;
      writeOut(`#${f.seq} ${e.type.padEnd(16)} ${e.sessionId.slice(0, 8)} ${summarize(e)}\n`);
    } else if (f.type === "notice") {
      writeOut(`#${f.seq} notice           ${f.tone}: ${f.text}\n`);
    }
  });
  // State arrives as whole-fleet snapshots with no seq of their own, so report
  // what each one *says* rather than pretending it's a position in the stream.
  // The raw event replay above is the point of `tail`; this is context for it.
  client.subscribe(
    foldLoadable<ConnectionError, DaemonSnapshot, void>({
      onIdle: () => {},
      onPending: () => writeOut("[state: waiting for a snapshot]\n"),
      onError: (e) => writeOut(`[state: ${showConnectionError(e)}]\n`),
      onData: (snap) => {
        const live = snap.sessions.filter((s) => isLiveState(s.status)).length;
        writeOut(`[state: ${snap.sessions.length} session(s), ${live} live]\n`);
      },
    }),
  );
  await new Promise<void>((resolve) => {
    Deno.addSignalListener("SIGINT", () => {
      void client.close().then(resolve);
    });
  });
};

const summarize = (ev: HarnessEvent): string => {
  const e = ev as unknown as Record<string, unknown>;
  if (ev.type === "question")
    return `${JSON.stringify(ev.question.slice(0, 60))}  req=${ev.id}  (answer)`;
  if (ev.type === "answer") return `#${ev.id} ${JSON.stringify(ev.text.slice(0, 60))}`;
  if (typeof e["text"] === "string") return JSON.stringify((e["text"] as string).slice(0, 60));
  if (ev.type === "status_changed")
    return `${sessionStateLabel(ev.status)}${ev.note ? ` (${ev.note})` : ""}`;
  if (ev.type === "tool_call") return `${ev.name} #${ev.id}`;
  if (ev.type === "tool_result") return `#${ev.id} ${ev.ok ? "ok" : "error"}`;
  if (ev.type === "permission_request") return `${ev.tool}  req=${ev.id}  (approve/deny)`;
  if (ev.type === "plan_review")
    return `plan  req=${ev.id}  (plan <id> ${ev.id} implement|fresh|revise|discuss)`;
  if (ev.type === "usage")
    return `+${ev.tokens.input}in/+${ev.tokens.output}out  ctx ${ev.contextUsed}/${ev.contextLimit}`;
  if (ev.type === "result") return ev.kind === "ok" ? "ok" : "failed";
  if (ev.type === "error") return ev.message.slice(0, 80);
  return "";
};

main().catch((err) => {
  const code = (err as { code?: string }).code;
  let msg: string;
  if (code === "ENOENT" || code === "ECONNREFUSED") {
    msg = "could not reach the daemon (and autospawn failed)";
  } else {
    msg = err instanceof Error ? err.message : String(err);
  }
  // Keep --json consumers on one format: a JSON error object on stdout rather
  // than plain text on stderr.
  if (Deno.args.includes("--json")) {
    writeOut(JSON.stringify({ error: msg }) + "\n");
  } else {
    writeErr(`loom: ${msg}\n`);
  }
  Deno.exit(1);
});
