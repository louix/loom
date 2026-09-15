/** Terminal text layout contract. No parser, renderer, or event dependencies. */
export interface TextStyle {
  readonly background?: "code";
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strikethrough?: boolean;
  readonly role?: "heading" | "code" | "link" | "muted" | "keyword" | "string" | "number";
}
export interface TextSpan extends TextStyle {
  readonly text: string;
}
export interface TextRow {
  readonly text: string;
  readonly spans: readonly TextSpan[];
}
export interface TextDocument {
  layout(width: number): readonly TextRow[];
}
export type TextFormatter = (source: string) => TextDocument;
