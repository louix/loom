import type { ReactNode } from "react";
import type { ThemeColor } from "./theme.ts";
import { Line, Text } from "./ui.tsx";

const statusLook = (status: string): [string, ThemeColor] => {
  if (status === "??") return ["UNTRACKED", "accent"];
  if (status.includes("U") || status === "AA" || status === "DD") return ["CONFLICT", "bad"];
  if (status.includes("D")) return ["DELETED", "bad"];
  if (status.includes("R")) return ["RENAMED", "accent"];
  if (status.includes("C")) return ["COPIED", "good"];
  if (status.includes("A")) return ["ADDED", "good"];
  return ["MODIFIED", "warn"];
};

/** One source line per visual row keeps inspection scrolling and editor output aligned. */
export const ChangeLine = ({ line }: { line: string }): ReactNode => {
  const file = line.match(/^([ MADRCUT?!]{2}) (.+)$/);
  if (file && file[1] !== "  ") {
    const status = file[1]!;
    const [label, tone] = statusLook(status);
    let stage = "";
    if (label === "CONFLICT") stage = "resolve";
    else if (status !== "??") {
      if (status[0] !== " " && status[1] !== " ") stage = "staged + working";
      else stage = status[0] !== " " ? "staged" : "working";
    }
    return (
      <Line>
        <Text tone={tone} bold>
          {label.padEnd(10)}
        </Text>
        <Text>{file[2]}</Text>
        {stage && <Text tone="dim">{"  · " + stage}</Text>}
      </Line>
    );
  }
  const stat = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
  if (stat)
    return (
      <Line>
        <Text tone="good">{(stat[1] === "-" ? "" : "+" + stat[1]).padStart(6)}</Text>
        <Text tone="bad">{(stat[2] === "-" ? "" : "−" + stat[2]).padStart(7)}</Text>
        <Text>{"  " + stat[3]}</Text>
        {stat[1] === "-" && <Text tone="dim">{"  · binary"}</Text>}
      </Line>
    );
  const field = line.match(/^(Branch|Base)\s+(.+)$/);
  if (field)
    return (
      <Line>
        <Text tone="dim">{field[1]!.toUpperCase().padEnd(8)}</Text>
        <Text tone="accent" bold>
          {field[2]}
        </Text>
      </Line>
    );
  if (/^(WORKING TREE|SESSION DIFF|diff --git|@@)/.test(line))
    return (
      <Line tone="accent" bold>
        {line}
      </Line>
    );
  if (/^\s*\d+ files? changed/.test(line)) {
    return (
      <Line bold>
        {line
          .trim()
          .split(/(\d+ insertions?\(\+\)|\d+ deletions?\(-\))/)
          .map((part, i) => {
            let tone: ThemeColor = "text";
            if (part.includes("(+)")) tone = "good";
            if (part.includes("(-)")) tone = "bad";
            return (
              <Text key={i} tone={tone}>
                {part}
              </Text>
            );
          })}
      </Line>
    );
  }
  if (line === "Working tree clean") return <Line tone="good">✓ Working tree clean</Line>;
  if (line.startsWith("+")) return <Line tone="good">{line}</Line>;
  if (line.startsWith("-")) return <Line tone="bad">{line}</Line>;
  if (/^\d+ ahead/.test(line)) return <Line tone="dim">{line}</Line>;
  if (/^(Unavailable:|fatal:|error:)/.test(line)) return <Line tone="bad">{line}</Line>;
  return <Line>{line || " "}</Line>;
};
