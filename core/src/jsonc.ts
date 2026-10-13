import { type Node, parseTree } from "jsonc-parser";

const lineNumber = (text: string, offset: number) => text.slice(0, offset).split("\n").length;

const keyPath = (parts: Array<string | number>) =>
  parts.reduce((path, part) => {
    if (typeof part === "number") return `${path}[${part}]`;
    return path ? `${path}.${part}` : part;
  }, "");

/** Reject duplicate keys while retaining JSONC comments and trailing commas. */
export const assertNoDuplicateJsoncKeys = (text: string, source: string): void => {
  const tree = parseTree(text, [], { allowTrailingComma: true });
  if (!tree) return;

  const visit = (node: Node, path: Array<string | number>): void => {
    if (node.type === "object") {
      const seen = new Map<string, number>();
      for (const property of node.children ?? []) {
        const key = property.children?.[0];
        const value = property.children?.[1];
        if (!key || typeof key.value !== "string") continue;
        const firstOffset = seen.get(key.value);
        if (firstOffset !== undefined) {
          const firstLine = lineNumber(text, firstOffset);
          const secondLine = lineNumber(text, key.offset);
          throw new Error(
            `${source}: duplicate key ${keyPath([...path, key.value])} ` +
              `(lines ${firstLine} and ${secondLine}); JSON keeps only the last`,
          );
        }
        seen.set(key.value, key.offset);
        if (value) visit(value, [...path, key.value]);
      }
    } else if (node.type === "array") {
      for (const [index, child] of (node.children ?? []).entries()) {
        visit(child, [...path, index]);
      }
    }
  };

  visit(tree, []);
};
