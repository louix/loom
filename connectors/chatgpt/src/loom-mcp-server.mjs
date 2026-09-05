#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

const cwd = process.env.LOOM_WORKTREE;

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const error = (id, message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32602, message } })}\n`);

const git = (args) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 15_000 });
const text = (result) => ({ content: [{ type: "text", text: result }] });

for await (const line of createInterface({ input: process.stdin })) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    continue;
  }
  if (request.method === "notifications/initialized") continue;
  if (!cwd) {
    error(request.id, "LOOM_WORKTREE is required");
    continue;
  }
  if (request.method === "initialize") {
    reply(request.id, {
      protocolVersion: request.params?.protocolVersion ?? "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "loom", version: "0.0.1" },
    });
  } else if (request.method === "tools/list") {
    reply(request.id, {
      tools: [
        {
          name: "commit",
          description: "Commit this Loom worktree. Stages all changes by default and never prompts for GPG signing.",
          inputSchema: {
            type: "object",
            properties: {
              message: { type: "string", description: "Commit message." },
              stage_all: { type: "boolean", description: "Stage all changes first; defaults to true." },
            },
            required: ["message"],
          },
        },
      ],
    });
  } else if (request.method === "tools/call" && request.params?.name === "commit") {
    const message = String(request.params.arguments?.message ?? "").trim();
    if (!message) {
      reply(request.id, { ...text("commit aborted: the message is empty"), isError: true });
      continue;
    }
    if (request.params.arguments?.stage_all !== false) {
      const add = git(["add", "-A"]);
      if (add.status !== 0) {
        reply(request.id, { ...text(`git add failed: ${add.stderr || add.stdout}`), isError: true });
        continue;
      }
    }
    const staged = git(["diff", "--cached", "--name-only"]);
    if (staged.status !== 0 || !staged.stdout.trim()) {
      reply(request.id, { ...text("nothing to commit — no changes are staged"), isError: true });
      continue;
    }
    const commit = git(["-c", "commit.gpgsign=false", "commit", "-m", message]);
    if (commit.status !== 0) {
      reply(request.id, { ...text(`git commit failed: ${commit.stderr || commit.stdout}`), isError: true });
      continue;
    }
    const sha = git(["rev-parse", "--short", "HEAD"]).stdout.trim();
    reply(request.id, text(`committed ${sha} ${message}`));
  } else {
    error(request.id, `unsupported method: ${request.method}`);
  }
}
