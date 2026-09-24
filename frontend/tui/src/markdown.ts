/**
 * Replaceable terminal document layout. No React, event types, or parser types
 * cross this boundary. Keep source text in the caller; prepared documents own
 * parsing and their most recent width-dependent layout.
 */
import { stripVTControlCharacters } from "node:util";
import { Marked, type Token, type Tokens } from "marked";
import { decodeHTML } from "entities";
import stringWidth from "string-width";
import { common, createLowlight } from "lowlight";

import type { TextDocument, TextFormatter, TextRow, TextSpan, TextStyle } from "./text-layout.ts";

const parser = new Marked({ gfm: true });
const highlighter = createLowlight(common);
const codeCache = new WeakMap<Tokens.Code, readonly TextSpan[]>();

/** Explicit languages only; expensive highlighting runs once per code block. */
const codeSpans = (code: Tokens.Code): readonly TextSpan[] => {
  const hit = codeCache.get(code);
  if (hit) return hit;
  let spans: TextSpan[] = [{ text: clean(code.text), role: "code" }];
  const language = code.lang?.split(/\s+/)[0];
  if (language && code.text.length <= 20_000 && highlighter.registered(language)) {
    try {
      const tree = highlighter.highlight(language, clean(code.text));
      spans = [];
      const visit = (nodes: typeof tree.children, style: TextStyle): void => {
        for (const node of nodes) {
          if (node.type === "text") append(spans, node.value, style);
          else if (node.type === "element") {
            const classes = String(node.properties.className ?? "");
            let role = style.role;
            if (/comment|quote/.test(classes)) role = "muted";
            else if (/keyword|selector|tag/.test(classes)) role = "keyword";
            else if (/string|regexp/.test(classes)) role = "string";
            else if (/number|literal/.test(classes)) role = "number";
            visit(node.children, { ...style, ...(role ? { role } : {}) });
          }
        }
      };
      visit(tree.children, {});
    } catch {
      spans = [{ text: clean(code.text), role: "code" }];
    }
  }
  codeCache.set(code, spans);
  return spans;
};
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
// Treat control sequences as text, never as instructions to the terminal.
const clean = (s: string): string =>
  stripVTControlCharacters(s)
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex -- terminal input must not carry control codes
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
const row = (spans: readonly TextSpan[]): TextRow => ({
  text: spans.map((s) => s.text).join(""),
  spans,
});
const sameStyle = (a: TextStyle, b: TextStyle): boolean =>
  a.bold === b.bold &&
  a.italic === b.italic &&
  a.underline === b.underline &&
  a.strikethrough === b.strikethrough &&
  a.role === b.role &&
  a.background === b.background;
const append = (out: TextSpan[], text: string, style: TextStyle = {}): void => {
  if (!text) return;
  const last = out.at(-1);
  if (last && sameStyle(last, style)) {
    out[out.length - 1] = { ...last, text: last.text + text };
  } else out.push({ ...style, text });
};

/** Word wrapping preserves styles and measures terminal cells, not UTF-16 units.
 * Long words split only at grapheme boundaries. Code keeps its whitespace. */
const wrap = (spans: readonly TextSpan[], width: number, literal = false): TextRow[] => {
  const out: TextRow[] = [];
  let line: TextSpan[] = [];
  let cells = 0;
  let pending: TextSpan[] = [];
  const flush = () => {
    out.push(row(line));
    line = [];
    cells = 0;
  };
  for (const span of spans) {
    for (const part of span.text.match(/\n|[^\S\n]+|[^\s]+/gu) ?? []) {
      if (part === "\n") {
        pending = [];
        flush();
        continue;
      }
      const whitespace = /^\s+$/u.test(part);
      if (whitespace && !literal) {
        pending = [{ ...span, text: " " }];
        continue;
      }
      const text = part.replace(/\t/g, "    ");
      const size = stringWidth(text);
      if (!literal && cells && cells + (pending.length ? 1 : 0) + size > width) flush();
      if (cells && pending.length) {
        append(line, " ", pending[0]!);
        cells++;
      }
      pending = [];
      if (cells + size <= width) {
        append(line, text, span);
        cells += size;
      } else {
        for (const { segment } of graphemes.segment(text)) {
          const n = stringWidth(segment);
          if (cells && cells + n > width) flush();
          // A glyph wider than the entire pane cannot be drawn intact.
          append(line, n > width ? "�" : segment, span);
          cells += Math.min(n, width);
        }
      }
    }
  }
  if (line.length || !out.length) flush();
  return out;
};

const inline = (tokens: readonly Token[], style: TextStyle = {}, depth = 0): TextSpan[] => {
  const out: TextSpan[] = [];
  for (const t of tokens) {
    if (depth > 64) {
      append(out, clean(t.raw), style);
      continue;
    }
    switch (t.type) {
      case "strong":
      case "em":
      case "del": {
        const nested = t as Tokens.Strong | Tokens.Em | Tokens.Del;
        const property = {
          strong: "bold",
          em: "italic",
          del: "strikethrough",
        } as const;
        out.push(...inline(nested.tokens, { ...style, [property[t.type]]: true }, depth + 1));
        break;
      }
      case "codespan":
        append(out, clean((t as Tokens.Codespan).text), {
          ...style,
          role: "code",
          background: "code",
        });
        break;
      case "link":
      case "image": {
        const link = t as Tokens.Link | Tokens.Image;
        const label = inline(
          link.tokens ?? [],
          {
            ...style,
            role: "link",
            underline: true,
          },
          depth + 1,
        );
        out.push(...label);
        const href = clean(decodeHTML(link.href));
        if (href && label.map((s) => s.text).join("") !== href) {
          append(out, " (" + href + ")", { ...style, role: "muted" });
        }
        break;
      }
      case "br":
        append(out, "\n", style);
        break;
      case "escape":
        append(out, clean((t as Tokens.Escape).text), style);
        break;
      case "text": {
        const text = t as Tokens.Text;
        if (text.tokens) out.push(...inline(text.tokens, style, depth + 1));
        else {
          append(out, clean(decodeHTML(text.text)).replace(/\n/g, " "), style);
        }
        break;
      }
      case "checkbox":
        // Task markers are rendered in the list prefix, including loose lists.
        break;
      default:
        // HTML stays literal; extensions we don't understand remain readable.
        append(out, clean(t.raw), style);
    }
  }
  return out;
};

const prefixRows = (rows: readonly TextRow[], first: string, rest = first): TextRow[] =>
  rows.map((r, i) => row([{ text: i === 0 ? first : rest, role: "muted" }, ...r.spans]));

/** Paint the full code block width, including blank lines, without rewrapping. */
const shadeCode = (rows: readonly TextRow[], width: number): TextRow[] =>
  rows.map((r) =>
    row([
      ...r.spans.map((s) => ({ ...s, background: "code" as const })),
      {
        text: " ".repeat(Math.max(0, width - stringWidth(r.text))),
        background: "code",
      },
    ]),
  );

const tableRows = (table: Tokens.Table, width: number): TextRow[] => {
  const headers = table.header.map((c) => inline(c.tokens, { bold: true }));
  const body = table.rows.map((r) => r.map((c) => inline(c.tokens)));
  const count = headers.length;
  const room = width - (count - 1) * 3;
  if (!count) return [];
  // Narrow panes show labelled cells; no sideways scrolling or lost evidence.
  if (room < count * 10) {
    const out: TextRow[] = [];
    for (const cells of body) {
      if (out.length) out.push(row([]));
      cells.forEach((cell, i) =>
        out.push(...wrap([...headers[i]!, { text: ": " }, ...cell], width)),
      );
    }
    return out.length ? out : headers.flatMap((h) => wrap(h, width));
  }
  const all = [headers, ...body];
  const desired = headers.map((_, i) =>
    Math.max(3, ...all.map((r) => stringWidth(row(r[i] ?? []).text))),
  );
  const widths = desired.map(() => 3);
  let spare = room - count * 3;
  while (spare > 0) {
    let changed = false;
    for (let i = 0; i < count && spare > 0; i++) {
      if (widths[i]! < desired[i]!) {
        widths[i]!++;
        spare--;
        changed = true;
      }
    }
    if (!changed) break;
  }
  const out: TextRow[] = [];
  all.forEach((cells, index) => {
    const wrapped = headers.map((_, i) => wrap(cells[i] ?? [], widths[i]!));
    const height = Math.max(...wrapped.map((r) => r.length));
    for (let y = 0; y < height; y++) {
      const spans: TextSpan[] = [];
      wrapped.forEach((lines, i) => {
        if (i) spans.push({ text: " │ ", role: "muted" });
        const cell = lines[y] ?? row([]);
        const pad = widths[i]! - stringWidth(cell.text);
        const align = table.align[i];
        let left = 0;
        if (align === "right") left = pad;
        else if (align === "center") left = Math.floor(pad / 2);
        spans.push({ text: " ".repeat(left) }, ...cell.spans, {
          text: " ".repeat(pad - left),
        });
      });
      out.push(row(spans));
    }
    if (index === 0 || index < all.length - 1) {
      const spans: TextSpan[] = [];
      widths.forEach((n, i) => {
        if (i) spans.push({ text: "┼", role: "muted" });
        spans.push({
          text: "─".repeat(n + (i > 0 ? 1 : 0) + (i < count - 1 ? 1 : 0)),
          role: index === 0 ? "muted" : "faint",
        });
      });
      out.push(row(spans));
    }
  });
  return out;
};

const blocks = (tokens: readonly Token[], width: number, depth = 0): TextRow[] => {
  const out: TextRow[] = [];
  const gap = () => {
    if (out.length && out.at(-1)!.text !== "") out.push(row([]));
  };
  for (const t of tokens) {
    if (depth > 32) {
      out.push(...wrap([{ text: clean(t.raw) }], width, true));
      continue;
    }
    switch (t.type) {
      case "space":
        gap();
        break;
      case "heading":
        gap();
        out.push(
          ...wrap(
            inline((t as Tokens.Heading).tokens, {
              bold: true,
              role: "heading",
            }),
            width,
          ),
        );
        gap();
        break;
      case "paragraph":
      case "text": {
        const p = t as Tokens.Paragraph | Tokens.Text;
        out.push(
          ...wrap(p.tokens ? inline(p.tokens) : [{ text: clean(decodeHTML(p.text)) }], width),
        );
        break;
      }
      case "blockquote": {
        gap();
        const prefix = width > 2 ? "│ " : "";
        out.push(
          ...prefixRows(
            blocks((t as Tokens.Blockquote).tokens, width - prefix.length, depth + 1),
            prefix,
          ),
        );
        gap();
        break;
      }
      case "list": {
        const list = t as Tokens.List;
        list.items.forEach((item, i) => {
          if (list.loose && i) gap();
          let marker = list.ordered ? String(Number(list.start) + i) + ". " : "• ";
          if (item.task) marker += item.checked ? "[x] " : "[ ] ";
          const prefix = marker.length < width ? marker : "";
          const content = blocks(item.tokens, width - prefix.length, depth + 1);
          out.push(
            ...prefixRows(content.length ? content : [row([])], prefix, " ".repeat(prefix.length)),
          );
        });
        break;
      }
      case "code": {
        const code = t as Tokens.Code;
        gap();
        const codeRows: TextRow[] = [];
        if (code.lang) {
          codeRows.push(...wrap([{ text: clean(code.lang), role: "muted" }], width));
        }
        codeRows.push(...wrap(codeSpans(code), width, true));
        out.push(...shadeCode(codeRows, width));
        gap();
        break;
      }
      case "table":
        gap();
        out.push(...tableRows(t as Tokens.Table, width));
        gap();
        break;
      case "hr":
        gap();
        out.push(row([{ text: "─".repeat(Math.min(width, 40)), role: "muted" }]));
        gap();
        break;
      case "checkbox":
      // Marked emits a block checkbox for tight task lists.
      case "def":
        break;
      default:
        out.push(...wrap([{ text: clean(t.raw) }], width, true));
    }
  }
  while (out.at(-1)?.text === "") out.pop();
  return out;
};

const document = (layout: (width: number) => readonly TextRow[]): TextDocument => {
  let lastWidth = -1;
  let lastRows: readonly TextRow[] = [];
  return {
    layout(width) {
      width = Math.max(1, Math.floor(width) || 1);
      if (width !== lastWidth) {
        lastRows = layout(width);
        lastWidth = width;
      }
      return lastRows;
    },
  };
};

export const plainText: TextFormatter = (source) =>
  document((width) => wrap([{ text: clean(source) }], width, true));

// Bound parser work on unusually large events; retain all text in the fallback.
const MAX_MARKDOWN_LENGTH = 200_000;
export const markdownText: TextFormatter = (source) => {
  if (source.length > MAX_MARKDOWN_LENGTH) return plainText(source);
  try {
    const tokens = parser.lexer(clean(source));
    return document((width) => {
      try {
        const rows = blocks(tokens, width);
        return rows.length ? rows : [row([])];
      } catch {
        return plainText(source).layout(width);
      }
    });
  } catch {
    return plainText(source);
  }
};
