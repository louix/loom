import type { ReactNode } from "react";
import type { SessionTab } from "../../../core/src/session-inspection.ts";
import { Line, Text, Panel } from "./ui.tsx";
import { ChangeLine } from "./changes-pane.tsx";
export const SESSION_TABS = [
  { tab: "chat", label: "1 CHAT" },
  { tab: "changes", label: "2 CHANGES" },
  { tab: "monitor", label: "3 VM MONITOR" },
] as const;

export const SessionTabs = ({ active }: { active: SessionTab }): ReactNode => (
  <Line>
    {SESSION_TABS.map(({ tab, label }, index) => (
      <Text key={tab} tone={active === tab ? "accent" : "dim"} bold={active === tab}>
        {index ? "  " : ""}
        {active === tab ? "[" : " "}
        {label}
        {active === tab ? "]" : " "}
      </Text>
    ))}
  </Line>
);

export const InspectionPane = ({
  tab,
  text,
  scroll,
  width,
  height,
}: {
  tab: SessionTab;
  text: string;
  scroll: number;
  width: number;
  height: number;
}): ReactNode => {
  const lines = text.split("\n");
  const room = Math.max(1, height - 4);
  const start = Math.min(scroll, Math.max(0, lines.length - room));
  return (
    <Panel width={width} height={height} flexShrink={0} overflow="hidden">
      <SessionTabs active={tab} />
      <Line tone="faint">{`o editor · PgUp/PgDn scroll${lines.length > room ? ` · ${start + 1}–${Math.min(lines.length, start + room)}/${lines.length}` : ""}`}</Line>
      {lines
        .slice(start, start + room)
        .map((line, i) =>
          tab === "changes" ? (
            <ChangeLine key={i} line={line} />
          ) : (
            <Line key={i}>{line || " "}</Line>
          ),
        )}
    </Panel>
  );
};
