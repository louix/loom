import {
  existsSync,
  accessSync,
  constants,
  chmodSync,
  linkSync,
  mkdtempSync,
  rmSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Marked } from "marked";
import { parse, postprocess, preprocess } from "micromark";
import { decodeString } from "micromark-util-decode-string";

export interface Note {
  path: string;
  title: string;
  body: string;
  modified: number;
  archived: boolean;
}
const parser = new Marked();
export const archivedNote = (path: string): boolean => path.startsWith("archive/");
/** Refuse traversal and symlink components, including for paths not yet created. */
export const notePath = (root: string, path: string): string => {
  const base = resolve(root),
    target = resolve(base, path);
  if (!target.startsWith(base + sep) || !/\.md$/i.test(target))
    throw new Error("Choose a Markdown file inside the project directory");
  let current = base;
  for (const part of relative(base, target).split(sep)) {
    current = resolve(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error("Notes cannot follow symlinks");
    } catch (e) {
      if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
    }
  }
  return target;
};
export const readNote = (root: string, path: string): Note => {
  const file = notePath(root, path),
    body = readFileSync(file, "utf8");
  return {
    path,
    body,
    title: /^#\s+(.+)$/m.exec(body)?.[1] ?? path,
    modified: statSync(file).mtimeMs,
    archived: archivedNote(path),
  };
};
export const listNotes = (root: string, archived = false): Note[] => {
  const notes: Note[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(resolve(root, dir), { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const path = dir ? dir + "/" + entry.name : entry.name;
      if (entry.isDirectory()) {
        if (archived || path !== "archive") walk(path);
      } else if (entry.isFile() && /\.md$/i.test(path)) notes.push(readNote(root, path));
    }
  };
  if (existsSync(root)) walk("");
  return notes.sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path));
};

export interface NoteRow {
  path: string;
  name: string;
  depth: number;
  modified: number;
  note?: Note;
}

/** Folders inherit their newest descendant's timestamp; siblings sort newest first. */
export const noteTree = (notes: Note[], collapsed: ReadonlySet<string> = new Set()): NoteRow[] => {
  const children = new Map<string, NoteRow[]>();
  const folders = new Map<string, NoteRow>();
  const add = (parent: string, row: NoteRow) => {
    const siblings = children.get(parent) ?? [];
    siblings.push(row);
    children.set(parent, siblings);
  };
  for (const note of notes) {
    const parts = note.path.split("/");
    let parent = "";
    for (let depth = 0; depth < parts.length - 1; depth++) {
      const name = parts[depth]!;
      const path = parent ? parent + "/" + name : name;
      let folder = folders.get(path);
      if (!folder) {
        folder = { path, name, depth, modified: note.modified };
        folders.set(path, folder);
        add(parent, folder);
      }
      folder.modified = Math.max(folder.modified, note.modified);
      parent = path;
    }
    add(parent, {
      path: note.path,
      name: parts.at(-1)!,
      depth: parts.length - 1,
      modified: note.modified,
      note,
    });
  }
  const rows: NoteRow[] = [];
  const visit = (parent: string) => {
    for (const row of (children.get(parent) ?? []).sort(
      (a, b) => b.modified - a.modified || a.path.localeCompare(b.path),
    )) {
      rows.push(row);
      if (!row.note && !collapsed.has(row.path)) visit(row.path);
    }
  };
  visit("");
  return rows;
};

export const createNote = (root: string, path: string): string => {
  if (!/\.md$/i.test(path)) path += ".md";
  const file = notePath(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "# " + path.split("/").at(-1)!.replace(/\.md$/i, "") + "\n\n", {
    flag: "wx",
  });
  return path;
};
export const deleteNote = (root: string, path: string): void => unlinkSync(notePath(root, path));
export const resolveNoteLink = (
  from: string,
  href: string,
): { path: string; anchor: string } | null => {
  if (/^[a-z][a-z\d+.-]*:|^\/\//i.test(href)) return null;
  if (href.startsWith("/")) return null;
  const [file, ...fragment] = href.split("#");
  try {
    const path = file
      ? relative(
          "/__loom_notes__",
          resolve("/__loom_notes__", dirname(from), decodeURIComponent(file)),
        )
      : from;
    if (path.startsWith("../") || !/\.md$/i.test(path)) return null;
    return { path, anchor: decodeURIComponent(fragment.join("#")) };
  } catch {
    return null;
  }
};
export const noteLinks = (body: string): { label: string; href: string }[] => {
  const links: { label: string; href: string }[] = [];
  parser.walkTokens(parser.lexer(body), (token) => {
    if (token.type === "link") links.push({ label: token.text, href: token.href });
  });
  return links;
};

/** Change only parsed destination ranges. The parser handles code, nested labels,
 * escapes, references and images; all surrounding Markdown stays byte-for-byte intact. */
export const rewriteNoteLinks = (
  body: string,
  from: string,
  to: string,
  moved: string,
  destination: string,
): string => {
  const events = postprocess(
    parse()
      .document()
      .write(preprocess()(body, "utf8", true)),
  );
  const edits: { start: number; end: number; text: string }[] = [];
  const encode = (s: string) =>
    encodeURIComponent(s).replace(/[()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  for (const [event, token] of events) {
    if (
      event !== "enter" ||
      (token.type !== "resourceDestinationString" && token.type !== "definitionDestinationString")
    )
      continue;
    const start = token.start.offset,
      end = token.end.offset;
    const href = decodeString(body.slice(start, end));
    if (/^[a-z][a-z\d+.-]*:|^\/|^#/i.test(href)) continue;
    const hash = href.indexOf("#");
    const file = hash < 0 ? href : href.slice(0, hash);
    try {
      let target = relative(
        "/__loom_notes__",
        resolve("/__loom_notes__", dirname(from), decodeURIComponent(file)),
      );
      if (target !== moved && from === to) continue;
      if (target === moved) target = destination;
      const fragment = hash < 0 ? "" : "#" + encode(decodeURIComponent(href.slice(hash + 1)));
      const text =
        relative(resolve("/__loom_notes__", dirname(to)), resolve("/__loom_notes__", target))
          .split(sep)
          .map(encode)
          .join("/") + fragment;
      edits.push({ start, end, text });
    } catch {
      // A malformed URI is not a resolvable local destination.
    }
  }
  // Offsets refer to the original source, including CRLF and container prefixes.
  for (const edit of edits.sort((a, b) => b.start - a.start))
    body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
  return body;
};

type MoveOperations = Pick<typeof import("node:fs"), "renameSync" | "linkSync" | "unlinkSync">;

/** Stage every write and retain the original inodes before publishing any change.
 * Roll back synchronous failures. If recovery itself fails, keep backups and report
 * their locations rather than discarding the only copies of the original notes.
 * This is not a crash-atomic transaction across multiple files. */
export const moveNote = (
  root: string,
  path: string,
  operations: MoveOperations = { renameSync, linkSync, unlinkSync },
): string => {
  const destination = archivedNote(path) ? path.slice("archive/".length) : "archive/" + path;
  const source = notePath(root, path),
    target = notePath(root, destination);
  if (existsSync(target)) throw new Error("A note already exists at " + destination);
  const updates = listNotes(root, true)
    .map((note) => ({
      note,
      body: rewriteNoteLinks(
        note.body,
        note.path,
        note.path === path ? destination : note.path,
        path,
        destination,
      ),
    }))
    .filter(({ note, body }) => note.path === path || body !== note.body);
  if (!updates.some(({ note }) => note.path === path)) throw new Error("Note not found: " + path);

  const staged: {
    file: string;
    dest: string;
    original: string;
    body: string;
    directory: string;
    backup: string;
    replacement: string;
    moved: boolean;
    applied: boolean;
  }[] = [];
  let keepBackups = false;
  try {
    // Renaming a staged file would otherwise bypass a referring note's read-only mode.
    for (const { note, body } of updates) {
      const file = notePath(root, note.path);
      if (body !== note.body) accessSync(file, constants.W_OK);
      if (readFileSync(file, "utf8") !== note.body)
        throw new Error("Notes changed during archive; try again");
    }
    mkdirSync(dirname(target), { recursive: true });
    for (const { note, body } of updates) {
      const file = notePath(root, note.path);
      const directory = mkdtempSync(join(dirname(file), ".loom-note-"));
      const entry = {
        file,
        dest: note.path === path ? target : file,
        original: note.body,
        body,
        directory,
        backup: join(directory, "original"),
        replacement: join(directory, "replacement"),
        moved: note.path === path,
        applied: false,
      };
      staged.push(entry);
      linkSync(file, entry.backup);
      writeFileSync(entry.replacement, body, { flag: "wx", mode: 0o600 });
      chmodSync(entry.replacement, statSync(file).mode & 0o777);
    }
    // Check the whole plan before publication, then again at each replacement.
    for (const entry of staged)
      if (readFileSync(entry.file, "utf8") !== entry.original)
        throw new Error("Notes changed during archive; try again");
    for (const entry of staged) {
      notePath(root, relative(root, entry.dest));
      if (readFileSync(entry.file, "utf8") !== entry.original)
        throw new Error("Notes changed during archive; try again");
      // Exclusive publication: a concurrently created destination must never be overwritten.
      if (entry.moved) operations.linkSync(entry.replacement, entry.dest);
      else operations.renameSync(entry.replacement, entry.dest);
      entry.applied = true;
    }
    const moving = staged.find((entry) => entry.moved)!;
    if (readFileSync(source, "utf8") !== moving.original)
      throw new Error("Note changed during archive; try again");
    // Leave the source in place until every destination and referrer is published.
    operations.unlinkSync(source);
    return destination;
  } catch (error) {
    const recoveryErrors: unknown[] = [];
    for (const entry of [...staged].reverse()) {
      if (!entry.applied) continue;
      try {
        // Do not overwrite a concurrent edit while recovering our own changes.
        if (readFileSync(entry.dest, "utf8") !== entry.body)
          throw new Error("Note changed during rollback: " + entry.dest);
        if (entry.moved) operations.unlinkSync(entry.dest);
        else operations.renameSync(entry.backup, entry.file);
      } catch (recoveryError) {
        recoveryErrors.push(recoveryError);
      }
    }
    if (recoveryErrors.length) {
      keepBackups = true;
      throw new AggregateError(
        [error, ...recoveryErrors],
        "Archive failed; recovery backups retained in: " +
          staged.map((entry) => entry.directory).join(", "),
      );
    }
    throw error;
  } finally {
    if (!keepBackups)
      for (const entry of staged) {
        try {
          rmSync(entry.directory, { recursive: true, force: true });
        } catch {
          /* Cleanup failure must not turn a completed archive into a reported failure. */
        }
      }
  }
};
