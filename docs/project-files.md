# Project files

Project files are persistent plain files shared by all Loom sessions of one repository.
By default they live outside the checkout at `$XDG_DATA_HOME/loom/projects/<repo-key>/`
(default `~/.local/share/loom/projects/<repo-key>/`). Loom reuses its existing repository
key: sessions created by the same repository daemon share files, including host sessions,
worktrees, and private clones. Separately registered checkouts keep separate directories.

Run `loom project-files` to print the path, or use
`loom --repo /path/to/repository project-files` from elsewhere. This creates the
directory if needed, without starting the daemon. The TUI's Space palette offers
**Open project files**, opening the directory in `$VISUAL`, then `$EDITOR`, then `vi`.
Use an editor with directory browsing support.

Agents receive `LOOM_PROJECT_DIR` and brief usage instructions. Loom never loads all
project files into the prompt. Agents can read relevant files on demand and save reports,
reproduction scripts, or other useful artifacts. Any format is accepted; Markdown is
suggested for reports. Group investigations naturally, with no required layout.

Files are live shared storage, including across private-clone sessions. Only this
repository's directory is mounted into its VMs. Packaged MCP tools receive it subject
to their existing workspace grants (read-only stays read-only; no-workspace tools
receive no project files). Shared files have no Git undo, branch isolation, or automatic
conflict resolution. Use distinct investigation directories for concurrent agents,
coordinate edits to common files, and keep backups where appropriate. Archiving sessions,
removing worktrees, and cleaning session VM state retain project files.

## Configuration

Use the existing global and per-repository configuration inheritance:

```jsonc
{
  "session": {
    "projects_root": "~/loom-projects",
    "project_files_instructions": "Record the tested commit and exact reproduction steps.",
  },
  "repos": [
    {
      "path": "/path/to/repository",
      "session": {
        "project_dir": "~/notes/repository",
        "project_files_instructions": "Group reports by issue number and include reproduction steps.",
      },
    },
  ],
}
```

All fields are optional. `session.projects_root` is a **storage root** holding one
directory per repository: Loom appends the repository key, here giving
`~/loom-projects/<repo-key>/` for every repository without its own directory.
`session.project_dir` names one repository's **exact** directory, used as is, and is only
accepted in a `repos[]` entry; it takes precedence over `projects_root`. A matching
repository's instruction replaces the global instruction; it is one freeform string.

Absolute paths, `~/`, and paths relative to the repository are accepted, but the
resulting directory must be outside the checkout. Restart the daemon after changes.
Changing the location does not move existing files. Project directories must not contain
symlinks in their resolved path. `session.project_files_dir`, the former name of
`projects_root`, still works and is reported as renamed.

After moving a checkout, stop its daemon and VMs and run
`loom repo move <old> <new>`. This migrates default project files to the new key.
An occupied destination is refused before any migration; existing project files are
never merged or overwritten. Directories under a custom `projects_root` must be moved
manually to the new key; a `project_dir` stays put, but its `repos[]` entry's `path`
needs updating, as does any other configuration naming the old path. File contents and
embedded absolute paths are not rewritten.

## Running scripts

Run scripts from the **current session workspace and environment**, including the
session's VM for private clones. For example, from a session shell:

```sh
python "$LOOM_PROJECT_DIR/issue-123/reproduce.py"
```

The script's working directory is the session workspace, but language import resolution
can still start at the script's storage directory. Node resolves modules relative to the
script, Python adds its directory to the import path, and Deno may need explicit config
or import-map arguments. Use the session's installed environment and appropriate runtime
flags or dependency paths; Loom provides no bespoke runner and does not install dependencies
in shared storage. Reports should identify the tested commit, relevant environment, exact
reproduction commands, and observed results.
