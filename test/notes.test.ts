import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  chmodSync,
  existsSync,
  linkSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNote,
  listNotes,
  moveNote,
  notePath,
  noteLinks,
  resolveNoteLink,
  rewriteNoteLinks,
} from "../frontend/tui/src/notes.ts";
import { programTabDecoder } from "../frontend/tui/src/program-tabs.ts";

test("archive/restore preserves inbound, outbound, reference and image links", () => {
  const root = mkdtempSync(join(tmpdir(), "loom-notes-"));
  try {
    mkdirSync(join(root, "research"));
    writeFileSync(
      join(root, "index.md"),
      "[note](research/result.md#findings)\n\n[ref]: research/result.md\n\n`[example](research/result.md)`\n",
    );
    const original = "# Findings\n[home](../index.md)\n![image](plot.png)\n[here](#findings)\n";
    writeFileSync(join(root, "research/result.md"), original);
    assert.equal(moveNote(root, "research/result.md"), "archive/research/result.md");
    assert.deepEqual(
      listNotes(root).map((n) => n.path),
      ["index.md"],
    );
    assert.equal(listNotes(root, true).length, 2);
    assert.match(
      readFileSync(join(root, "index.md"), "utf8"),
      /\[note\]\(archive\/research\/result.md#findings\)/,
    );
    assert.match(
      readFileSync(join(root, "index.md"), "utf8"),
      /\[ref\]: archive\/research\/result.md/,
    );
    assert.match(
      readFileSync(join(root, "index.md"), "utf8"),
      /`\[example\]\(research\/result.md\)`/,
    );
    assert.match(
      readFileSync(join(root, "archive/research/result.md"), "utf8"),
      /\(\.\.\/\.\.\/research\/plot.png\)/,
    );
    moveNote(root, "archive/research/result.md");
    assert.equal(readFileSync(join(root, "research/result.md"), "utf8"), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("notes reject overwrite, traversal, archive collisions and symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "loom-notes-"));
  try {
    createNote(root, "one");
    assert.throws(() => createNote(root, "one.md"));
    assert.throws(() => notePath(root, "../outside.md"));
    symlinkSync("/tmp", join(root, "linked"));
    assert.throws(() => createNote(root, "linked/out.md"));
    symlinkSync(join(root, "absent.md"), join(root, "dangling.md"));
    assert.throws(() => notePath(root, "dangling.md"));
    createNote(root, "archive/one.md");
    assert.throws(() => moveNote(root, "one.md"));
    assert.equal(listNotes(root).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("Markdown navigation resolves references and ignores code and external URLs", () => {
  assert.deepEqual(noteLinks("[Next][n]\n\n[n]: ../b.md#heading\n\n`[code](bad.md)`"), [
    { label: "Next", href: "../b.md#heading" },
  ]);
  assert.deepEqual(resolveNoteLink("dir/a.md", "../b.md#heading"), {
    path: "b.md",
    anchor: "heading",
  });
  assert.equal(resolveNoteLink("a.md", "https://example.com/a.md"), null);
  assert.equal(resolveNoteLink("a.md", "%ZZ.md"), null);
});
test("function keys survive split reads and ignore pasted escape sequences", () => {
  const seen: string[] = [];
  const decode = programTabDecoder((tab) => seen.push(tab));
  decode("\x1bO");
  decode("S");
  decode("\x1b[11~");
  decode("\x1b[200~\x1bOS");
  decode("\x1b[201~");
  decode("\x1b[57367u");
  assert.deepEqual(seen, ["notes", "fleet", "notes"]);
});

test("archiving preserves links with parentheses and assets outside the project directory", () => {
  const root = mkdtempSync(join(tmpdir(), "loom-note-links-"));
  try {
    writeFileSync(join(root, "index.md"), "[note](result(final).md)\n");
    writeFileSync(join(root, "result(final).md"), "[asset](../shared.png)\n");
    moveNote(root, "result(final).md");
    assert.equal(
      readFileSync(join(root, "index.md"), "utf8"),
      "[note](archive/result%28final%29.md)\n",
    );
    assert.equal(
      readFileSync(join(root, "archive/result(final).md"), "utf8"),
      "[asset](../../shared.png)\n",
    );
    assert.equal(resolveNoteLink("a.md", "../outside.md"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("archive rewriting preserves all code forms and only touches parsed links", () => {
  const examples = [
    "    [example](target.md)\n",
    "\t[example](target.md)\n",
    "`` [example](target.md) ` inside ``\n",
    "````md\n```\n[example](target.md)\n```\n````\n",
    "~~~~~md\n~~~\n[example](target.md)\n~~~~~\n",
    ">     [example](target.md)\n",
    "- example\n\n      [example](target.md)\n",
    "<pre>\n[example](target.md)\n</pre>\n",
    "\\[example](target.md)\n",
  ];
  for (const code of examples) {
    const body = code + "\n[real](target.md)\n";
    assert.equal(
      rewriteNoteLinks(body, "index.md", "index.md", "target.md", "archive/target.md"),
      code + "\n[real](archive/target.md)\n",
    );
  }
});

test("archive and restore resolve escaped destinations, nested labels, definitions and images", () => {
  const root = mkdtempSync(join(tmpdir(), "loom-note-markdown-"));
  try {
    const body =
      [
        '[escaped](target\\(v1\\).md "keep title")',
        "[a [b]](target(v1).md)",
        "[entity](target&#40;v1&#41;.md)",
        "[reference][r]",
        "",
        "[r]: <target\\(v1\\).md> 'keep reference title'",
        "",
        "![a [b]](target\\(v1\\).md)",
        "> [quoted](target\\(v1\\).md)",
        "- [listed](target\\(v1\\).md)",
      ].join("\r\n") + "\r\n";
    writeFileSync(join(root, "index.md"), body);
    writeFileSync(join(root, "target(v1).md"), "# Target\n");
    for (const path of ["target(v1).md", "archive/target(v1).md"]) {
      moveNote(root, path);
      const text = readFileSync(join(root, "index.md"), "utf8");
      const links = noteLinks(text);
      assert.equal(links.length, 6);
      for (const link of links) {
        const target = resolveNoteLink("index.md", link.href);
        assert.ok(target);
        assert.ok(existsSync(notePath(root, target.path)), link.href);
      }
      assert.match(text, /"keep title"/);
      assert.match(text, /'keep reference title'/);
      assert.equal(text.split("\r\n").length, body.split("\r\n").length);
      assert.match(text, /!\[a \[b\]\]\((?:archive\/)?target%28v1%29.md\)/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const moveFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "loom-note-transaction-"));
  const originals = {
    "a.md": "[target](z.md)\n",
    "b.md": "[target](z.md)\n",
    "z.md": "[home](a.md)\n",
  };
  for (const [path, body] of Object.entries(originals)) writeFileSync(join(root, path), body);
  return { root, originals };
};
const unchanged = (root: string, originals: Record<string, string>) => {
  for (const [path, body] of Object.entries(originals))
    assert.equal(readFileSync(join(root, path), "utf8"), body, path);
  assert.equal(existsSync(join(root, "archive/z.md")), false);
  assert.equal(
    readdirSync(root).some((name) => name.startsWith(".loom-note-")),
    false,
  );
};

test("read-only referrer rejects archive without changing any note", (t) => {
  // Root bypasses Unix file mode checks; injected failures below cover that runtime.
  if (process.getuid?.() === 0) return t.skip("Root bypasses Unix file mode checks");
  const { root, originals } = moveFixture();
  try {
    chmodSync(join(root, "b.md"), 0o444);
    assert.throws(() => moveNote(root, "z.md"), /EACCES|permission/i);
    unchanged(root, originals);
  } finally {
    chmodSync(join(root, "b.md"), 0o600);
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed publication restores earlier referrers and the source", () => {
  const { root, originals } = moveFixture();
  let replacements = 0;
  try {
    assert.throws(
      () =>
        moveNote(root, "z.md", {
          linkSync,
          unlinkSync,
          renameSync: (from, to) => {
            if (String(from).endsWith("/replacement") && ++replacements === 2)
              throw new Error("injected publication failure");
            renameSync(from, to);
          },
        }),
      /injected publication failure/,
    );
    assert.equal(replacements, 2);
    unchanged(root, originals);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed source removal rolls back the published destination and all links", () => {
  const { root, originals } = moveFixture();
  try {
    assert.throws(
      () =>
        moveNote(root, "z.md", {
          linkSync,
          renameSync,
          unlinkSync: (file) => {
            if (file === join(root, "z.md")) throw new Error("injected removal failure");
            unlinkSync(file);
          },
        }),
      /injected removal failure/,
    );
    unchanged(root, originals);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed rollback retains original backups and reports how to recover them", () => {
  const { root, originals } = moveFixture();
  try {
    assert.throws(
      () =>
        moveNote(root, "z.md", {
          linkSync,
          unlinkSync,
          renameSync: (from, to) => {
            if (to === join(root, "b.md") || String(from).endsWith("/original"))
              throw new Error("injected disk failure");
            renameSync(from, to);
          },
        }),
      /recovery backups retained/,
    );
    const backups = readdirSync(root).filter((name) => name.startsWith(".loom-note-"));
    assert.equal(backups.length, 3);
    assert.deepEqual(
      backups.map((dir) => readFileSync(join(root, dir, "original"), "utf8")).sort(),
      Object.values(originals).sort(),
    );
    assert.equal(readFileSync(join(root, "z.md"), "utf8"), originals["z.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("nested notes sort by modification time with stable ties and collapsible ancestors", async () => {
  const { utimesSync } = await import("node:fs");
  const { noteTree } = await import("../frontend/tui/src/notes.ts");
  const root = mkdtempSync(join(tmpdir(), "loom-note-tree-"));
  try {
    for (const [path, time] of [
      ["old.md", 10],
      ["ideas/old.md", 20],
      ["ideas/deep/new.md", 50],
      ["recent.md", 40],
      ["ideas/a.md", 30],
      ["ideas/b.md", 30],
      ["archive/hidden.md", 60],
    ] as const) {
      createNote(root, path);
      utimesSync(join(root, path), time, time);
    }
    const notes = listNotes(root);
    assert.deepEqual(
      notes.map((n) => n.path),
      ["ideas/deep/new.md", "recent.md", "ideas/a.md", "ideas/b.md", "ideas/old.md", "old.md"],
    );
    assert.deepEqual(
      noteTree(notes).map((r) => [r.path, r.depth]),
      [
        ["ideas", 0],
        ["ideas/deep", 1],
        ["ideas/deep/new.md", 2],
        ["ideas/a.md", 1],
        ["ideas/b.md", 1],
        ["ideas/old.md", 1],
        ["recent.md", 0],
        ["old.md", 0],
      ],
    );
    assert.deepEqual(
      noteTree(notes, new Set(["ideas"])).map((r) => r.path),
      ["ideas", "recent.md", "old.md"],
    );
    assert.equal(noteTree(listNotes(root, true))[0]!.path, "archive");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
