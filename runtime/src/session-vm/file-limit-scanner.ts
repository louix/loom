import { fileLimitPattern } from "./file-limit.ts";

/** Bounded lookahead prevents a chunk boundary from hiding a word or ENFILE suffix. */
export const fileLimitScanner = () => {
  let tail = "";
  let found = false;
  let truncated = false;
  return (chunk: string, end = false): boolean => {
    if (found) return true;
    const text = tail + chunk;
    for (const match of text.matchAll(new RegExp(fileLimitPattern.source, "gi"))) {
      if (truncated && match.index === 0) continue;
      if (end || match.index + match[0].length <= text.length - 16) {
        found = true;
        break;
      }
    }
    truncated = text.length > 128;
    tail = text.slice(-128);
    return found;
  };
};
