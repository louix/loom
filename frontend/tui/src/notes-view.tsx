import { PASTE_KEY } from "./terminal-focus.ts";
import { mouseReport } from "./mouse.ts";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Box, useInput, usePaste } from "ink";
import { Header } from "./components.tsx";
import type { HeaderView } from "./views.ts";
import { Line, Panel, StyledText } from "./ui.tsx";
import { markdownText } from "./markdown.ts";
import { applyKey, buffer, type Buffer } from "./editor.ts";
import {
  createNote,
  deleteNote,
  listNotes,
  moveNote,
  noteLinks,
  noteTree,
  notePath,
  readNote,
  resolveNoteLink,
  type Note,
} from "./notes.ts";

export const Notes = ({
  active,
  root,
  width,
  height,
  header,
  edit,
  quit,
}: {
  active: boolean;
  root: string | null;
  width: number;
  height: number;
  header: HeaderView;
  edit: (path: string) => Promise<void>;
  quit: () => void;
}): ReactNode => {
  const [notes, setNotes] = useState<Note[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [archived, setArchived] = useState(false);
  const [scroll, setScroll] = useState(0);
  const [full, setFull] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState<{ kind: "new" | "find"; value: Buffer } | null>(null);
  const [query, setQuery] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [linkIndex, setLinkIndex] = useState<number | null>(null);
  const [history, setHistory] = useState<{ path: string; scroll: number }[]>([]);
  const refresh = () => {
    if (!root) return;
    try {
      setNotes(listNotes(root, archived));
    } catch (e) {
      setError(String(e));
    }
  };
  useEffect(() => {
    setSelected(null);
    setCollapsed(new Set());
    setScroll(0);
    setHistory([]);
    setQuery("");
  }, [root]);
  useEffect(() => {
    if (!active) return;
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [root, active, archived]);
  const filtered = notes.filter((n) =>
    (n.path + "\n" + n.body).toLowerCase().includes(query.toLowerCase()),
  );
  const tree = noteTree(filtered, query ? new Set() : collapsed);
  const row = tree.find((r) => r.path === selected) ?? tree.find((r) => r.note) ?? tree[0];
  const note = row?.note;
  const index = tree.findIndex((r) => r.path === row?.path);
  const listStart = Math.max(0, index - Math.max(1, height - 8) + 1);
  useEffect(() => {
    setSelected(row?.path ?? null);
  }, [row?.path]);
  const reveal = (path: string) => {
    setCollapsed((current) => new Set([...current].filter((dir) => !path.startsWith(dir + "/"))));
    setSelected(path);
  };
  const toggleFolder = (path: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  const left = Math.min(40, Math.max(20, Math.floor(width * 0.3)));
  const showList = !full && width >= 60;
  const contentWidth = Math.max(1, width - (showList ? left + 1 : 0) - 4);
  const rows = useMemo(
    () =>
      markdownText(
        note?.body ??
          (row
            ? "Select a note, or press n to create one in this folder."
            : "No notes yet. Press n to create one."),
      ).layout(contentWidth),
    [note?.body, row?.path, contentWidth],
  );
  const capacity = Math.max(1, height - 9);
  const offset = Math.min(scroll, Math.max(0, rows.length - capacity));
  const links = useMemo(
    () => noteLinks(note?.body ?? "").filter((l) => resolveNoteLink(note?.path ?? "", l.href)),
    [note?.body, note?.path],
  );
  const run = (fn: () => void) => {
    try {
      fn();
      setError("");
    } catch (e) {
      setError(String(e));
    }
  };
  const openEditor = async (path: string) => {
    if (!root) return;
    setBusy(true);
    try {
      await edit(notePath(root, path));
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const follow = () =>
    run(() => {
      if (!root || !note || linkIndex === null || !links[linkIndex]) return;
      const target = resolveNoteLink(note.path, links[linkIndex]!.href);
      if (!target) return;
      const next = readNote(root, target.path);
      setHistory((h) => [...h, { path: note.path, scroll: offset }]);
      if (next.archived) setArchived(true);
      setNotes((ns) => [...ns.filter((n) => n.path !== next.path), next]);
      setQuery("");
      reveal(next.path);
      setLinkIndex(null);
      const slug = (s: string) =>
        s
          .toLowerCase()
          .replace(/[^\p{L}\p{N}\s_-]/gu, "")
          .replace(/\s/g, "-");
      const rendered = markdownText(next.body).layout(contentWidth);
      const heading = target.anchor
        ? rendered.findIndex(
            (r) => r.spans.some((s) => s.role === "heading") && slug(r.text) === target.anchor,
          )
        : 0;
      setScroll(Math.max(0, heading));
    });
  useInput(
    (input, key) => {
      if (!active || busy) return;
      if (key.ctrl && input === "c") return quit();
      const mouse = mouseReport(input);
      if (mouse) {
        if (mouse.kind === "wheel")
          setScroll(
            Math.max(0, Math.min(rows.length - capacity, offset + (mouse.button === 64 ? -3 : 3))),
          );
        if (
          mouse.kind === "button" &&
          mouse.pressed &&
          mouse.button === 0 &&
          showList &&
          mouse.x <= left &&
          mouse.y >= 4 &&
          !prompt &&
          !confirm &&
          !menu
        ) {
          const hit = tree[listStart + mouse.y - 4];
          if (hit) {
            setSelected(hit.path);
            if (!hit.note) toggleFolder(hit.path);
            setScroll(0);
            setLinkIndex(null);
          }
        }
        return;
      }
      if (input === "[I" || input === "[O") return;
      if (confirm) {
        if (key.escape) setConfirm(null);
        else if (key.return)
          run(() => {
            if (root) deleteNote(root, confirm);
            setConfirm(null);
            refresh();
          });
        return;
      }
      if (prompt) {
        const result = applyKey(prompt.value, input, key, { multiline: false });
        if (result.kind === "cancel") {
          setPrompt(null);
          if (prompt.kind === "find") setQuery("");
        }
        if (result.kind === "buffer") {
          setPrompt({ ...prompt, value: result.buffer });
          if (prompt.kind === "find") {
            setQuery(result.buffer.text);
            setSelected(null);
            setScroll(0);
          }
        }
        if (result.kind === "submit") {
          if (prompt.kind === "find") setPrompt(null);
          else
            run(() => {
              if (!root || !prompt.value.text.trim()) return;
              const path = createNote(root, prompt.value.text.trim());
              setPrompt(null);
              setQuery("");
              reveal(path);
              if (path.startsWith("archive/")) setArchived(true);
              setScroll(0);
              refresh();
              void openEditor(path);
            });
        }
        return;
      }
      if (menu) {
        if (key.escape) setMenu(false);
        if (key.return) {
          setArchived((v) => !v);
          setMenu(false);
        }
        return;
      }
      if (linkIndex !== null) {
        if (key.escape || key.leftArrow) setLinkIndex(null);
        else if (key.return || key.rightArrow) follow();
        else if (key.downArrow || input === "j")
          setLinkIndex((i) => Math.min(links.length - 1, (i ?? 0) + 1));
        else if (key.upArrow || input === "k") setLinkIndex((i) => Math.max(0, (i ?? 0) - 1));
        return;
      }
      if (key.meta && input === "e") {
        if (note) void openEditor(note.path);
        return;
      }
      if (key.ctrl || key.meta) return;
      if (key.pageUp) return setScroll(Math.max(0, offset - capacity + 1));
      if (key.pageDown)
        return setScroll(Math.min(Math.max(0, rows.length - capacity), offset + capacity - 1));
      if (key.home) return setScroll(0);
      if (key.end) return setScroll(Math.max(0, rows.length - capacity));
      if (key.tab) return setFull((v) => !v);
      if ((key.leftArrow || input === "h") && row) {
        if (!note && !collapsed.has(row.path)) {
          toggleFolder(row.path);
          return;
        }
        if (!history.length || !note) {
          const parent = row.path.split("/").slice(0, -1).join("/");
          if (parent) {
            setSelected(parent);
            setScroll(0);
            return;
          }
        }
      }
      if (key.escape || key.leftArrow || input === "h") {
        const previous = history.at(-1);
        if (previous) {
          reveal(previous.path);
          setScroll(previous.scroll);
          setHistory((h) => h.slice(0, -1));
        } else {
          setFull(false);
          setQuery("");
        }
        return;
      }
      if (key.return || key.rightArrow || input === "l") {
        if (row && !note) {
          if (key.return || collapsed.has(row.path)) toggleFolder(row.path);
          else if ((tree[index + 1]?.depth ?? -1) > row.depth) setSelected(tree[index + 1]!.path);
        } else if (links.length) setLinkIndex(0);
        return;
      }
      if (key.upArrow || key.downArrow || input === "j" || input === "k") {
        const next =
          tree[
            Math.max(0, Math.min(tree.length - 1, index + (key.upArrow || input === "k" ? -1 : 1)))
          ];
        if (next) {
          setSelected(next.path);
          setScroll(0);
        }
        return;
      }
      if (input === "n") {
        let folder = row?.path ?? "";
        if (note) folder = folder.split("/").slice(0, -1).join("/");
        setPrompt({ kind: "new", value: buffer(folder ? folder + "/" : "") });
      }
      if (input === "/") setPrompt({ kind: "find", value: buffer(query) });
      if (input === " ") setMenu(true);
      if (input === "X" && note) setConfirm(note.path);
      if (input === "x" && note && root)
        run(() => {
          moveNote(root, note.path);
          refresh();
          setSelected(null);
          setScroll(0);
        });
    },
    { isActive: active },
  );
  usePaste((input) => {
    if (!active || !prompt || busy) return;
    const result = applyKey(prompt.value, input, PASTE_KEY, { multiline: false });
    if (result.kind === "buffer") {
      setPrompt({ ...prompt, value: result.buffer });
      if (prompt.kind === "find") {
        setQuery(result.buffer.text);
        setSelected(null);
        setScroll(0);
      }
    }
  });
  let footer = "n new · x archive/restore · X delete · ⌥e edit · / find · space more";
  if (menu)
    footer =
      (archived ? "Hide archived notes" : "Show archived notes") + " · Enter select · Esc cancel";
  if (prompt)
    footer = (prompt.kind === "new" ? "New note path: " : "Find: ") + prompt.value.text + "▏";
  if (confirm) footer = "Delete " + confirm + "? Enter confirm · Esc cancel";
  if (busy) footer = "Editor open…";
  if (!active) return null;
  return (
    <Box width={width} height={height} flexDirection="column" overflow="hidden">
      <Header view={header} width={width} active="notes" />
      <Box height={Math.max(1, height - 3)} gap={1}>
        {showList && (
          <Panel width={left} title={archived ? "NOTES · including archive" : "NOTES"}>
            {tree.slice(listStart, listStart + Math.max(1, height - 6)).map((n) => (
              <Line
                key={n.path}
                tone={n.path === row?.path ? "accent" : "dim"}
                bold={n.path === row?.path}
              >
                {n.path === row?.path ? "▸ " : "  "}
                {"  ".repeat(n.depth)}
                {n.note?.archived && "□ "}
                {!n.note && (collapsed.has(n.path) && !query ? "▸ " : "▾ ")}
                {n.name}
                {n.note ? "" : "/"}
              </Line>
            ))}
            {!filtered.length && <Line tone="dim">No matching notes</Line>}
          </Panel>
        )}
        <Panel width={width - (showList ? left + 1 : 0)}>
          <Line bold>{note?.title ?? (row ? row.path + "/" : "Project notes")}</Line>
          <Line tone="dim">
            {note
              ? note.path + (note.archived ? " · Archived" : "")
              : (root ?? "Project files unavailable")}
          </Line>
          <Line tone="faint">
            {note ? new Date(note.modified).toLocaleString() + " · " : ""}
            {offset + 1}–{Math.min(rows.length, offset + capacity)}/{rows.length}
          </Line>
          {linkIndex !== null ? (
            <>
              <Line tone="accent">Links · ↑↓ select · enter follow · esc back</Line>
              {links
                .slice(Math.max(0, linkIndex - capacity + 2), linkIndex + capacity)
                .slice(0, capacity - 1)
                .map((l, i) => (
                  <Line key={i} tone={links[linkIndex] === l ? "accent" : "dim"}>
                    {links[linkIndex] === l ? "▸ " : "  "}
                    {l.label} → {l.href}
                  </Line>
                ))}
            </>
          ) : (
            rows.slice(offset, offset + capacity).map((r, i) => (
              <Line key={i}>
                <StyledText spans={r.spans} />
              </Line>
            ))
          )}
        </Panel>
      </Box>
      <Line tone={error ? "warn" : "accent"}>{error || footer}</Line>
      <Line tone="dim">
        ↑↓ select · PgUp/PgDn scroll · ⇥ toggle list · → open/links · ← close/back · F1 fleet · F4
        notes
      </Line>
    </Box>
  );
};
