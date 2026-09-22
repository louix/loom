# Markdown in EVENTS

Assistant text, expanded thinking, questions (including context and choice descriptions),
and plan reviews render as Markdown. User messages, queued echoes, and answers
remain literal, preserving line breaks and indentation. Tool output retains literal
text and existing diff colours. Stored events and editor exports retain their original source.

Document colors are independent of UI status colors in each theme. Headings use bold
body text, links use a document accent, and inline code uses a subtle background.
Code blocks have dedicated syntax colors; comments and destinations use readable muted
text. Thinking uses a uniform subdued foreground without code backgrounds.
Question/plan previews measure and paint the same formatted rows, capped at 14 body
rows; the full plan overlay scrolls through formatted rows.

## Replacement boundary

- `frontend/tui/src/text-layout.ts` contains only the public types:
  formatter → document → rows of styled spans.
- `frontend/tui/src/markdown.ts` owns Marked, Lowlight, entity decoding, terminal
  width measurement, block layout, and code highlighting. No parser types escape.
- `StyledText` in `ui.tsx` is the small Ink adapter. Semantic colours resolve
  against the current theme when drawing.
- `transcript.ts` caches documents by immutable event identity and uses the same
  layout for row counts and viewport selection.

To replace Markdown, change the formatter imported by `transcript.ts`. The
replacement implements `TextFormatter`; no event schema, scrolling, or Ink
changes are required. `plainText` is an interchangeable fallback. Removing the
Markdown implementation also permits removing its parser/highlighter dependencies.

## Presentation

Marked supplies CommonMark parsing with GitHub-style tables, task lists,
strikethrough, and autolinks. The terminal renderer supports nested emphasis and
lists, quotes, headings, rules, links, images as alt text plus URL, code fences,
indented code, and reference links. Raw HTML is displayed literally. Links show
their destination as text.

Tables use wrapped, aligned columns when each column has enough room; narrower
panes show labelled cells. Wrapping measures terminal cells and preserves
graphemes. Code preserves indentation and blank lines.

Lowlight highlights explicitly labelled fences using its common languages; it
does not guess languages. Unknown languages and code blocks over 20,000 UTF-16
code units stay plain. Events over 200,000 code units bypass Markdown parsing.
Parser/layout errors also fall back to literal text without truncation.

## Caching and streaming

Documents cache their most recent width. Resizing reuses the parse and cached
code highlighting; scrolling reuses complete layouts. WeakMap caches release
entries when the transcript releases the corresponding events. A changed event
gets a new document, allowing later Markdown to reinterpret earlier text (for
example, when a table separator arrives). Only visible rows become React nodes.

## Validation and performance

`test/markdown.test.ts` covers formatting, narrow tables, Unicode wrapping,
streaming prefixes, fallback, explicit code highlighting, raw exports, and
viewport/measurement agreement. Existing TUI tests cover paging and scroll anchors.

Run `deno bench -A test/markdown.bench.ts` to reproduce the layout benchmark.
A run on an i9-13980HX / Deno 2.9.6 measured about 0.33 ms to count
10,000 cached review events and select the last 40 rows, and 0.46 ms to append
one review and select the viewport. These are warmed layout measurements, not
terminal painting or cold history loading. Resizing must still lay out retained
events at the new width.
