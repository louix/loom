import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loomPaths, loomPathsOfState, projectDirectory, repoKey } from "@loom/core/paths";
import { loadConfig } from "@loom/daemon/config/config";
import {
  ensureProjectDirectory,
  projectFilesInstructions,
} from "../backend/daemon/src/daemon/project-files.ts";

test("project files use the existing repository key under default or configured storage", () => {
  const env = { HOME: "/home/test", XDG_DATA_HOME: "/data" };
  const key = repoKey("/repos/app");
  const root = { projectsRoot: "~/notes" };
  assert.equal(projectDirectory("/repos/app", {}, env), "/data/loom/projects/" + key);
  assert.equal(projectDirectory("/repos/app", root, env), "/home/test/notes/" + key);
  assert.notEqual(
    projectDirectory("/repos/other", root, env),
    projectDirectory("/repos/app", root, env),
  );
  assert.equal(
    projectDirectory("/repos/app", {}, { HOME: "/home/test" }),
    "/home/test/.local/share/loom/projects/" + key,
  );
  // An exact directory takes no key and wins over the root.
  assert.equal(
    projectDirectory("/repos/app", { ...root, projectDir: "~/app-notes" }, env),
    "/home/test/app-notes",
  );
  assert.equal(projectDirectory("/repos/app", { projectDir: "../notes" }, env), "/repos/notes");
  assert.equal(loomPaths("/repos/app", "", env).projects, projectDirectory("/repos/app", {}, env));
  assert.equal(
    loomPathsOfState("/repos/moved", "/state/original-key", env).projects,
    "/data/loom/projects/original-key",
  );
});

test("project files inherit settings, preserve content, and are read only on demand", () => {
  const root = mkdtempSync(join(tmpdir(), "loom-project-files-"));
  try {
    const repo = join(root, "repo");
    const storage = join(root, "storage");
    mkdirSync(repo);
    const configFile = join(root, "config.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        session: {
          projects_root: storage,
          project_files_instructions: "Global instruction",
        },
        repos: [
          {
            path: repo,
            session: { project_files_instructions: "Record reproductions" },
          },
        ],
      }),
    );
    const config = loadConfig(repo, configFile);
    assert.equal(config.projectsRoot, storage);
    assert.equal(config.projectFilesInstructions, "Record reproductions");
    assert.equal(
      loadConfig(join(root, "other"), configFile).projectFilesInstructions,
      "Global instruction",
    );
    const dir = ensureProjectDirectory(repo, config);
    writeFileSync(join(dir, "report.md"), "FILE CONTENT MUST NOT ENTER PROMPT");
    assert.equal(ensureProjectDirectory(repo, { projectsRoot: storage }), dir);
    const instructions = projectFilesInstructions(dir, config.projectFilesInstructions);
    assert.match(instructions, /Record reproductions/);
    assert.match(instructions, /private clones/);
    assert.match(instructions, /LOOM_PROJECT_DIR/);
    assert.doesNotMatch(instructions, /FILE CONTENT/);
    assert.equal(
      readFileSync(join(dir, "report.md"), "utf8"),
      "FILE CONTENT MUST NOT ENTER PROMPT",
    );
    assert.throws(
      () => ensureProjectDirectory(repo, { projectsRoot: join(repo, "files") }),
      /outside/,
    );
    assert.throws(
      () => ensureProjectDirectory(repo, { projectDir: join(repo, "notes") }),
      /outside/,
    );
    rmSync(dir, { recursive: true });
    symlinkSync(repo, dir);
    assert.throws(() => ensureProjectDirectory(repo, { projectsRoot: storage }), /symlink/);
    const alias = join(root, "alias");
    symlinkSync(repo, alias);
    assert.throws(() => ensureProjectDirectory(repo, { projectsRoot: alias }), /symlink/);
    assert.throws(() => ensureProjectDirectory(repo, { projectDir: alias }), /symlink/);
    assert.equal(existsSync(join(repo, repoKey(repo))), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a repository's project_dir is exact, and only a repos entry may set it", () => {
  const root = mkdtempSync(join(tmpdir(), "loom-project-dir-"));
  try {
    const repo = join(root, "repo");
    const other = join(root, "other");
    mkdirSync(repo);
    mkdirSync(other);
    const notes = join(root, "notes");
    const configFile = join(root, "config.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        session: { projects_root: join(root, "storage") },
        repos: [{ path: repo, session: { project_dir: notes } }],
      }),
    );
    const config = loadConfig(repo, configFile);
    assert.equal(config.projectDir, notes);
    assert.equal(ensureProjectDirectory(repo, config), notes);
    assert.equal(
      ensureProjectDirectory(other, loadConfig(other, configFile)),
      join(root, "storage", repoKey(other)),
    );

    writeFileSync(configFile, JSON.stringify({ session: { project_dir: notes } }));
    assert.throws(() => loadConfig(repo, configFile), /repos\[\] entry/);

    // The former name keeps its storage-root meaning in either layer.
    writeFileSync(
      configFile,
      JSON.stringify({
        session: { project_files_dir: join(root, "old") },
        repos: [
          {
            path: other,
            session: { project_files_dir: join(root, "older") },
          },
        ],
      }),
    );
    assert.equal(loadConfig(repo, configFile).projectsRoot, join(root, "old"));
    assert.equal(loadConfig(other, configFile).projectsRoot, join(root, "older"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project-files CLI prints its configured path without starting a daemon or modifying the checkout", async () => {
  const root = mkdtempSync(join(tmpdir(), "loom-project-cli-"));
  try {
    const repo = join(root, "repo");
    execFileSync("git", ["init", "-q", repo]);
    const env = {
      ...Deno.env.toObject(),
      XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_RUNTIME_DIR: join(root, "run"),
    };
    mkdirSync(join(root, "config/loom"), { recursive: true });
    writeFileSync(
      join(root, "config/loom/config.jsonc"),
      JSON.stringify({ session: { projects_root: join(root, "custom") } }),
    );
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        fileURLToPath(new URL("../cli/src/loom.ts", import.meta.url)),
        "--repo",
        repo,
        "project-files",
        "--json",
      ],
      env,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
    const path = JSON.parse(new TextDecoder().decode(result.stdout)).path;
    assert.equal(path, projectDirectory(repo, { projectsRoot: join(root, "custom") }, env));
    assert.equal(
      execFileSync("git", ["-C", repo, "status", "--porcelain"], {
        encoding: "utf8",
      }),
      "",
    );
    assert.throws(() => readFileSync(loomPaths(repo, "", env).sock));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
